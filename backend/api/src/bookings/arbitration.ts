import { notifyUsers } from '../../../shared/notifications.js';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { ArbitrationDecision, ArbitrationMode, Booking, Prisma } from '../../../generated/prisma/client.js';
import { hasJournalSqlState, openAccount, postedBalance, postJournal } from '../../../shared/payments/journal.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { assertPayoutProvider } from '../payments/payout-eligibility.js';
import { ProfileService } from '../profiles/service.js';
import { agreementAmounts, completionAmounts, lockBooking, maxMinor } from './lifecycle.js';
import { member } from './requests.js';

const timestamp = z.iso.datetime();
const minor = z.number().int().min(0).max(maxMinor);
const mode = z.enum(['refund', 'provider', 'split']);
const reason = z.string().trim().min(10).max(2000);
const create = z.object({
  subject: z.string().trim().min(3).max(140), body: z.string().trim().min(20).max(2000),
  assetIds: z.array(uuid).max(5).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length).optional(),
}).strict();
const decide = z.object({
  mode, expectedHeldMinor: minor.positive(), refundMinor: minor, reason, evidenceReviewed: z.literal(true),
  destinationRevision: z.number().int().positive().max(maxMinor).nullable(),
}).strict();
const dismissal = z.object({ reason }).strict();
const allocation = z.object({
  id: uuid, disputeId: uuid, mode, heldMinor: minor, refundMinor: minor, feeMinor: minor, payoutMinor: minor,
  reason, createdAt: timestamp, currency: z.literal('LKR'), execution: z.literal('awaiting_gateway'),
});
const dispute = z.object({
  id: uuid, bookingId: uuid, openedBy: uuid, subject: z.string(), body: z.string(),
  assetIds: z.array(uuid), createdAt: timestamp, dismissedAt: timestamp.nullable(), dismissalReason: reason.nullable(),
  decision: allocation.nullable(),
});
const adminDispute = dispute.extend({ eligibleHeldMinor: minor.nullable() });
const page = z.object({ items: z.array(adminDispute), nextCursor: uuid.nullable() });
const include = {
  attachments: { orderBy: { position: 'asc' }, select: { assetId: true } },
  decision: true,
} satisfies Prisma.BookingDisputeInclude;
type Dispute = Prisma.BookingDisputeGetPayload<{ include: typeof include }>;

function presentDecision(row: ArbitrationDecision) {
  const { id, disputeId, mode, heldMinor, refundMinor, feeMinor, payoutMinor, reason, createdAt } = row;
  return { id, disputeId, mode, heldMinor, refundMinor, feeMinor, payoutMinor, reason, createdAt: createdAt.toISOString(),
    currency: 'LKR' as const, execution: 'awaiting_gateway' as const };
}

function present(row: Dispute, evidence: boolean) {
  const { id, bookingId, openedBy, subject, body, createdAt, dismissedAt, dismissalReason, decision } = row;
  return { id, bookingId, openedBy, subject, body, createdAt: createdAt.toISOString(),
    dismissedAt: dismissedAt?.toISOString() ?? null, dismissalReason,
    assetIds: evidence ? row.attachments.map(item => item.assetId) : [], decision: decision && presentDecision(decision) };
}

function unavailable(): never {
  throw new PublicError(409, 'ARBITRATION_FUNDS_UNAVAILABLE', 'Eligible service funds or the payout destination need reconciliation.');
}

function closed(): never {
  throw new PublicError(409, 'ARBITRATION_ALREADY_DECIDED', 'This dispute already has a decision.');
}

export function arbitrationAmounts(mode: ArbitrationMode, heldMinor: number, refundMinor: number, feeLimit: number) {
  const providerGross = heldMinor - refundMinor;
  if (mode === 'refund' && providerGross !== 0 || mode === 'provider' && refundMinor !== 0 ||
    mode === 'split' && (refundMinor < 1 || providerGross < 1)) {
    throw new PublicError(400, 'INVALID_ARBITRATION_ALLOCATION', 'The refund amount must match the selected allocation mode.');
  }
  const feeMinor = Math.min(feeLimit, providerGross);
  return { heldMinor, refundMinor, feeMinor, payoutMinor: providerGross - feeMinor };
}

const fund = { currency: 'LKR', purpose: 'service' } as const;

async function eligibleFunds(tx: Prisma.TransactionClient, bookingId: string) {
  const [account, orders, payout, refund] = await Promise.all([
    tx.financialAccount.findUnique({
      where: { scope_currency_purpose_kind: { ...fund, scope: 'sandbox:booking:' + bookingId, kind: 'available' } },
    }),
    tx.paymentOrder.findMany({
      where: { bookingId, purpose: { in: ['advance', 'balance'] }, status: { in: ['paid', 'review', 'pending'] } },
      orderBy: [{ purpose: 'asc' }, { id: 'asc' }],
      include: {
        payhereAttempt: { select: { events: { where: { statusCode: '2' }, select: { journalId: true } } } },
        stripeAttempt: { select: { journalId: true } },
      },
    }),
    tx.payoutOrder.findFirst({ where: { bookingId, damageClaimId: null }, select: { id: true } }),
    tx.refundRequest.findUnique({ where: { bookingId }, select: { status: true } }),
  ]);
  if (!account || payout || (refund && refund.status !== 'declined') || !orders.length || orders.some(order =>
    order.status !== 'paid' || order.currency !== fund.currency ||
    !(order.stripeAttempt?.journalId || order.payhereAttempt?.events[0]?.journalId))) return null;
  const total = orders.reduce((sum, order) => sum + order.amountMinor, 0);
  if (total > maxMinor || await postedBalance(tx, account.id) !== BigInt(total)) return null;
  return { accountId: account.id, total, orders };
}

export function makeArbitrationController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function mutation(req: Request) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return actor;
  }

  async function memberDispute(req: Request, id: string) {
    const actor = await identity(req);
    const booking = await member(db, parse(uuid, id), actor.user.id);
    const row = await db.bookingDispute.findUnique({ where: { bookingId: booking.id }, include });
    return { dispute: row && present(row, actor.user.id === row.openedBy) };
  }

  async function reviewCase(
    tx: Prisma.TransactionClient, actor: Awaited<ReturnType<typeof identity>>, disputeId: string,
  ) {
    if (actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    const original = await tx.bookingDispute.findUnique({
      where: { id: disputeId }, select: { bookingId: true, booking: { select: { providerId: true } } },
    });
    if (!original) throw new PublicError(404, 'BOOKING_DISPUTE_NOT_FOUND', 'This booking dispute is unavailable.');
    for (const id of [...new Set([actor.user.id, original.booking.providerId])].sort()) {
      await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${id}::uuid FOR UPDATE`;
    }
    const current = await profiles.actor(tx, actor, undefined, true);
    profiles.verified(current);
    if (current.session.createdAt.getTime() < Date.now() - 15 * 60_000) {
      throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before recording an arbitration decision.');
    }
    await lockBooking(tx, original.bookingId);
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: original.bookingId } });
    if ([booking.customerId, booking.providerId].includes(current.user.id)) {
      throw new PublicError(403, 'SELF_REVIEW_FORBIDDEN', 'Another administrator must review this dispute.');
    }
    return { booking, actorId: current.user.id };
  }

  @ApiTags('Booking disputes and arbitration')
  @ApiBearerAuth()
  @Controller()
  class ArbitrationController {
    @Post('bookings/:id/disputes')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(create) })
    @ApiOkResponse({ schema: schema(dispute) })
    async open(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const input = parse(create, raw);
      const assetIds = (input.assetIds ?? []).map(assetId => assetId.toLowerCase());
      const bookingId = parse(uuid, id);
      const actor = await mutation(req);
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, actor);
        profiles.verified(current);
        await member(tx, bookingId, current.user.id);
        await lockBooking(tx, bookingId);
        const booking = await member(tx, bookingId, current.user.id);
        const existing = await tx.bookingDispute.findUnique({ where: { bookingId }, include });
        if (existing) {
          if (existing.openedBy === current.user.id && existing.subject === input.subject && existing.body === input.body &&
            existing.attachments.length === assetIds.length && existing.attachments.every(({ assetId }, index) => assetId === assetIds[index])) {
            return present(existing, true);
          }
          throw new PublicError(409, 'BOOKING_DISPUTE_EXISTS', 'This booking already has a dispute.');
        }
        if (!booking.agreedAt || booking.cancelledAt) {
          throw new PublicError(409, 'DISPUTE_NOT_ELIGIBLE', 'An agreed active booking is required.');
        }
        if (await tx.refundRequest.count({ where: { bookingId, status: { in: ['requested', 'approved'] } } })) {
          throw new PublicError(409, 'REFUND_REVIEW_ACTIVE', 'The booking already has an active refund review.');
        }
        for (const assetId of [...assetIds].sort()) {
          await tx.$queryRaw`SELECT id FROM assets WHERE id=${assetId}::uuid FOR UPDATE`;
          const asset = await tx.asset.findFirst({
            where: { id: assetId, ownerId: current.user.id, purpose: 'evidence', status: 'ready' }, select: { variants: true },
          });
          if ((asset?.variants as { display?: { mime?: string } } | undefined)?.display?.mime !== 'image/webp') {
            throw new PublicError(409, 'DISPUTE_EVIDENCE_UNAVAILABLE', 'Choose validated private evidence images.');
          }
        }
        return present(await tx.bookingDispute.create({
          data: { bookingId, openedBy: current.user.id, subject: input.subject, body: input.body,
            attachments: { create: assetIds.map((assetId, position) => ({ assetId, position })) } }, include,
        }), true);
      });
    }

    @Get('bookings/:id/disputes')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ dispute: dispute.nullable() })) })
    read(@Req() req: Request, @Param('id') id: string) {
      return memberDispute(req, id);
    }

    @Get('admin/disputes')
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiOkResponse({ schema: schema(page) })
    async queue(@Req() req: Request, @Query('cursor') raw?: string) {
      const actor = await identity(req);
      const cursor = raw === undefined ? undefined : parse(uuid, raw);
      return db.$transaction(async tx => {
        profiles.verified(await profiles.actor(tx, actor, undefined, true));
        const rows = await tx.bookingDispute.findMany({
          where: { decision: null, dismissedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' }, take: 31, include,
        });
        const items = rows.slice(0, 30).map(row => ({ ...present(row, true), eligibleHeldMinor: null }));
        return { items, nextCursor: rows.length > 30 ? items[29]!.id : null };
      });
    }

    @Get('admin/disputes/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(adminDispute) })
    async detail(@Req() req: Request, @Param('id') id: string) {
      const actor = await identity(req);
      return db.$transaction(async tx => {
        profiles.verified(await profiles.actor(tx, actor, undefined, true));
        const row = await tx.bookingDispute.findUnique({ where: { id: parse(uuid, id) }, include });
        if (!row) throw new PublicError(404, 'BOOKING_DISPUTE_NOT_FOUND', 'This booking dispute is unavailable.');
        const eligible = row.decision || row.dismissedAt ? null : await eligibleFunds(tx, row.bookingId);
        return { ...present(row, true), eligibleHeldMinor: eligible?.total ?? null };
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Post('admin/disputes/:id/dismissals')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(dismissal) })
    @ApiOkResponse({ schema: schema(dispute) })
    async dismiss(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const input = parse(dismissal, raw);
      const disputeId = parse(uuid, id);
      const actor = await mutation(req);
      return db.$transaction(async tx => {
        const { booking, actorId } = await reviewCase(tx, actor, disputeId);
        const row = await tx.bookingDispute.findUniqueOrThrow({ where: { bookingId: booking.id }, include });
        if (row.dismissedAt && row.dismissedBy === actorId && row.dismissalReason === input.reason) return present(row, true);
        if (row.decision || row.dismissedAt) closed();
        return present(await tx.bookingDispute.update({
          where: { id: disputeId }, data: { dismissedAt: new Date(), dismissedBy: actorId, dismissalReason: input.reason }, include,
        }), true);
      });
    }

    @Post('admin/disputes/:id/decisions')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(decide) })
    @ApiOkResponse({ schema: schema(allocation) })
    async decide(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const input = parse(decide, raw);
      const disputeId = parse(uuid, id);
      const actor = await mutation(req);
      try {
        return await db.$transaction(async tx => {
          const { booking, actorId } = await reviewCase(tx, actor, disputeId);
          const row = await tx.bookingDispute.findUniqueOrThrow({ where: { id: disputeId } });
          if (row.dismissedAt) closed();
          const existing = await tx.arbitrationDecision.findUnique({ where: { disputeId } });
          if (existing) {
            if (existing.decidedBy === actorId && existing.mode === input.mode && existing.refundMinor === input.refundMinor &&
              existing.heldMinor === input.expectedHeldMinor && existing.reason === input.reason &&
              existing.destinationRevision === input.destinationRevision) return presentDecision(existing);
            throw new PublicError(409, 'ARBITRATION_ALREADY_DECIDED', 'This dispute already has a decision.');
          }
          if (booking.cancelledAt || !booking.agreedAt) unavailable();
          const eligible = await eligibleFunds(tx, booking.id);
          if (!eligible || eligible.total !== input.expectedHeldMinor) unavailable();
          const fee = completionAmounts(await agreementAmounts(tx, booking.id), 0).platformFeeMinor;
          const amounts = arbitrationAmounts(input.mode, eligible.total, input.refundMinor, fee);
          if (!amounts.payoutMinor && input.destinationRevision !== null) {
            throw new PublicError(400, 'INVALID_ARBITRATION_DESTINATION', 'Omit the destination revision when no payout is due.');
          }
          let destinationRevision = null;
          if (amounts.payoutMinor) {
            if (input.destinationRevision === null) unavailable();
            destinationRevision = await assertPayoutProvider(tx, booking, input.destinationRevision);
          }
          const decisionId = randomUUID();
          const entries = [{ accountId: eligible.accountId, amountMinor: -BigInt(eligible.total) }];
          for (const [recipient, amountMinor] of [['customer', amounts.refundMinor], ['fee', amounts.feeMinor], ['provider', amounts.payoutMinor]] as const) {
            if (!amountMinor) continue;
            const account = await openAccount(tx, { ...fund, scope: 'sandbox:arbitration:' + decisionId + ':' + recipient, kind: 'reserved' });
            entries.push({ accountId: account.id, amountMinor: BigInt(amountMinor) });
          }
          let remainingRefund = amounts.refundMinor;
          const sources = eligible.orders.map(order => {
            const refundMinor = Math.min(remainingRefund, order.amountMinor);
            remainingRefund -= refundMinor;
            return { orderId: order.id, capturedMinor: order.amountMinor, refundMinor };
          });
          const reservationId = await postJournal(tx, { ...fund, source: 'arbitration.sandbox.reserve', reference: disputeId }, entries);
          const decision = await tx.arbitrationDecision.create({
            data: {
              id: decisionId, disputeId, decidedBy: actorId, providerId: booking.providerId, destinationRevision,
              mode: input.mode, ...amounts, reason: input.reason, reservationId, sources: { create: sources },
            },
          });
          await notifyUsers(tx, [booking.customerId, booking.providerId], 'arbitration', booking.id, decision.id);
          return presentDecision(decision);
        });
      } catch (error) {
        if (error instanceof PublicError && error.code === 'DESTINATION_NOT_APPROVED') unavailable();
        if (hasJournalSqlState(error, 'SL001')) unavailable();
        throw error;
      }
    }

    @Get('arbitrations/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(allocation) })
    async allocation(@Req() req: Request, @Param('id') id: string) {
      const actor = await identity(req);
      const staff = actor.session.activeRole === 'admin' && Boolean(actor.user.emailVerifiedAt);
      const userId = actor.user.id;
      const row = await db.arbitrationDecision.findFirst({
        where: { id: parse(uuid, id), ...(staff ? {} : { dispute: { booking: { OR: [{ customerId: userId }, { providerId: userId }] } } }) },
      });
      if (!row) throw new PublicError(404, 'ARBITRATION_NOT_FOUND', 'This arbitration decision is unavailable.');
      return presentDecision(row);
    }
  }
  return ArbitrationController;
}
