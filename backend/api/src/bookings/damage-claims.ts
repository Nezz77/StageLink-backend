import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Booking, DamageClaim, Prisma } from '../../../generated/prisma/client.js';
import { hasJournalSqlState, openAccount, postJournal } from '../../../shared/payments/journal.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';
import { hasDiscrepancy } from './inspection-state.js';
import { agreementAmounts, lockBooking, maxMinor, paymentBlocked } from './lifecycle.js';
import { member } from './requests.js';

const timestamp = z.iso.datetime();
const minor = z.number().int().min(0).max(maxMinor);
const reason = z.string().trim().min(10).max(2000);
const proposed = z.object({ bookingId: uuid, amountMinor: minor, reason }).strict();
const response = z.object({
  response: z.enum(['accepted', 'disputed']), reason: z.string().trim().max(2000).default(''),
}).strict().refine(input => input.response !== 'disputed' || input.reason.length >= 10);
const resolution = z.object({ approveDeduction: z.boolean(), reason }).strict();
const view = z.object({
  id: uuid, bookingId: uuid, inspectionId: uuid, reportRevision: z.number().int(),
  depositMinor: minor, proposedMinor: minor, reason, createdAt: timestamp,
  response: z.enum(['accepted', 'disputed']).nullable(), responseReason: z.string().nullable(),
  respondedAt: timestamp.nullable(), deductionMinor: minor.nullable(), refundMinor: minor.nullable(),
  resolvedAt: timestamp.nullable(), resolutionReason: reason.nullable(), currency: z.literal('LKR'),
  status: z.enum(['awaiting_customer', 'awaiting_admin', 'reserved', 'resolved_zero_deposit']),
});
const queue = z.object({ items: z.array(view), nextCursor: uuid.nullable() });
const discrepancyEvidence = z.object({
  units: z.array(z.object({ condition: z.enum(['good', 'worn', 'damaged', 'missing']) })),
  accessories: z.array(z.boolean()),
});

function present(row: DamageClaim) {
  const { depositOrderId: _order, reservationId: _reservation, resolvedBy: _reviewer, ...record } = row;
  return {
    ...record, createdAt: row.createdAt.toISOString(), respondedAt: row.respondedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null, currency: 'LKR' as const,
    status: row.resolvedAt ? row.depositMinor ? 'reserved' : 'resolved_zero_deposit'
      : row.respondedAt ? 'awaiting_admin' : 'awaiting_customer',
  };
}

function unavailable(): never {
  throw new PublicError(409, 'DEPOSIT_NOT_ELIGIBLE', 'A verified return and eligible collected deposit are required for this decision.');
}

async function collectedDeposit(tx: Prisma.TransactionClient, bookingId: string, depositMinor: number) {
  if (!depositMinor) return null;
  const order = await tx.paymentOrder.findUnique({
    where: { bookingId_purpose: { bookingId, purpose: 'deposit' } },
    include: {
      payhereAttempt: { select: { events: { where: { statusCode: '2' }, select: { journalId: true } } } },
      stripeAttempt: { select: { journalId: true } },
    },
  });
  if (!order || order.currency !== 'LKR' || order.amountMinor !== depositMinor || order.status !== 'paid' ||
    !(order.payhereAttempt?.events[0]?.journalId || order.stripeAttempt?.journalId)) unavailable();
  return order;
}

export function makeDamageClaimsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function mutate<T>(
    req: Request, role: 'provider' | 'customer' | 'admin',
    locate: (tx: Prisma.TransactionClient, actorId: string) => Promise<string>,
    work: (tx: Prisma.TransactionClient, booking: Booking, actorId: string) => Promise<T>,
  ) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, actor, undefined, role === 'admin');
      profiles.verified(current);
      const actorId = current.user.id;
      const bookingId = await locate(tx, actorId);
      await lockBooking(tx, bookingId);
      const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
      if (role === 'admin') {
        if ([booking.customerId, booking.providerId].includes(actorId)) {
          throw new PublicError(403, 'SELF_REVIEW_FORBIDDEN', 'Another administrator must resolve this deposit claim.');
        }
        if (current.session.createdAt.getTime() < Date.now() - 15 * 60_000) {
          throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before resolving a deposit claim.');
        }
      } else if (role === 'provider' && booking.providerId === actorId) {
        profiles.providerRole(current, 'renter');
      } else if (role !== 'customer' || booking.customerId !== actorId || !current.user.roles.includes('customer')) {
        throw new PublicError(403, 'DAMAGE_CLAIM_ROLE_REQUIRED', 'The other booking party must perform this step.');
      }
      return work(tx, booking, actorId);
    });
  }

  async function locateClaim(tx: Prisma.TransactionClient, claimId: string, customerId?: string) {
    const claim = await tx.damageClaim.findFirst({
      where: { id: claimId, ...(customerId ? { booking: { OR: [{ customerId }, { providerId: customerId }] } } : {}) },
      select: { bookingId: true },
    });
    if (!claim) throw new PublicError(404, 'DAMAGE_CLAIM_NOT_FOUND', 'This deposit claim is unavailable.');
    return claim.bookingId;
  }

  @ApiTags('Equipment deposit claims')
  @ApiBearerAuth()
  @Controller()
  class DamageClaimsController {
    @Post('damage-claims')
    @HttpCode(200)
    @ApiBody({ schema: schema(proposed) })
    @ApiOkResponse({ schema: schema(view) })
    propose(@Req() req: Request, @Body() raw: unknown) {
      const input = parse(proposed, raw);
      return mutate(req, 'provider', async (tx, actorId) => (await member(tx, input.bookingId, actorId)).id, async (tx, booking) => {
        const existing = await tx.damageClaim.findUnique({ where: { bookingId: booking.id } });
        if (existing) {
          if (existing.proposedMinor !== input.amountMinor || existing.reason !== input.reason) {
            throw new PublicError(409, 'DAMAGE_CLAIM_EXISTS', 'This booking already has a deposit claim.');
          }
          return present(existing);
        }
        if (!booking.agreedAt || await paymentBlocked(tx, booking.id, false)) unavailable();
        const returned = await tx.equipmentInspectionReport.findFirst({
          where: { inspection: { bookingId: booking.id }, phase: 'return', decision: 'acknowledged' },
          orderBy: { revision: 'desc' }, include: { photos: { take: 1 } },
        });
        if (!returned) unavailable();
        const terms = await agreementAmounts(tx, booking.id);
        if (input.amountMinor > terms.depositMinor || (input.amountMinor > 0 &&
          (!returned.photos.length || !hasDiscrepancy(discrepancyEvidence.parse(returned.evidence))))) {
          throw new PublicError(409, 'DEDUCTION_NOT_ELIGIBLE', 'The deduction must fit the deposit and have supporting return evidence.');
        }
        const deposit = await collectedDeposit(tx, booking.id, terms.depositMinor);
        return present(await tx.damageClaim.create({
          data: {
            bookingId: booking.id, inspectionId: returned.inspectionId, reportRevision: returned.revision,
            depositOrderId: deposit?.id, depositMinor: terms.depositMinor, proposedMinor: input.amountMinor, reason: input.reason,
          },
        }));
      });
    }

    @Get('bookings/:id/damage-claim')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ claim: view.nullable() })) })
    async read(@Req() req: Request, @Param('id') id: string) {
      const actor = await identity(req);
      const booking = await member(db, parse(uuid, id), actor.user.id);
      const claim = await db.damageClaim.findUnique({ where: { bookingId: booking.id } });
      return { claim: claim && present(claim) };
    }

    @Post('damage-claims/:id/respond')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(response) })
    @ApiOkResponse({ schema: schema(view) })
    respond(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const input = parse(response, raw);
      const claimId = parse(uuid, id);
      return mutate(req, 'customer', (tx, actorId) => locateClaim(tx, claimId, actorId), async tx => {
        const claim = await tx.damageClaim.findUniqueOrThrow({ where: { id: claimId } });
        if (claim.response === input.response && claim.responseReason === input.reason) return present(claim);
        if (claim.response) throw new PublicError(409, 'DAMAGE_CLAIM_RESPONDED', 'A response is already recorded.');
        return present(await tx.damageClaim.update({
          where: { id: claimId }, data: { response: input.response, responseReason: input.reason, respondedAt: new Date() },
        }));
      });
    }

    @Get('admin/damage-claims')
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiOkResponse({ schema: schema(queue) })
    async queue(@Req() req: Request, @Query('cursor') raw?: string) {
      const actor = await identity(req);
      const cursor = raw === undefined ? undefined : parse(uuid, raw);
      return db.$transaction(async tx => {
        profiles.verified(await profiles.actor(tx, actor, undefined, true));
        const rows = await tx.damageClaim.findMany({
          where: { respondedAt: { not: null }, resolvedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' }, take: 31,
        });
        const items = rows.slice(0, 30).map(present);
        return { items, nextCursor: rows.length > 30 ? items[29]!.id : null };
      });
    }

    @Post('admin/damage-claims/:id/resolve')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(resolution) })
    @ApiOkResponse({ schema: schema(view) })
    async resolve(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const input = parse(resolution, raw);
      const claimId = parse(uuid, id);
      try {
        return await mutate(req, 'admin', tx => locateClaim(tx, claimId), async (tx, booking, actorId) => {
          const claim = await tx.damageClaim.findUniqueOrThrow({ where: { id: claimId } });
          const deductionMinor = input.approveDeduction ? claim.proposedMinor : 0;
          if (claim.resolvedAt && claim.deductionMinor === deductionMinor && claim.resolutionReason === input.reason) return present(claim);
          if (!claim.response || claim.resolvedAt || await paymentBlocked(tx, booking.id, false)) unavailable();
          const deposit = await collectedDeposit(tx, booking.id, claim.depositMinor);
          if ((deposit?.id ?? null) !== claim.depositOrderId) unavailable();
          const refundMinor = claim.depositMinor - deductionMinor;
          let reservationId: string | undefined;
          if (deposit) {
            const fund = { currency: deposit.currency, purpose: 'deposit' } as const;
            const available = await openAccount(tx, { ...fund, scope: 'sandbox:booking:' + booking.id, kind: 'available' });
            const entries = [{ accountId: available.id, amountMinor: -BigInt(claim.depositMinor) }];
            for (const [recipient, amountMinor] of [['customer', refundMinor], ['provider', deductionMinor]] as const) {
              if (amountMinor === 0) continue;
              const account = await openAccount(tx, { ...fund, scope: 'sandbox:damage:' + claim.id + ':' + recipient, kind: 'reserved' });
              entries.push({ accountId: account.id, amountMinor: BigInt(amountMinor) });
            }
            reservationId = await postJournal(tx, { ...fund, source: 'deposit.sandbox.reserve', reference: claim.id }, entries);
          }
          return present(await tx.damageClaim.update({
            where: { id: claimId }, data: {
              deductionMinor, refundMinor, reservationId, resolvedAt: new Date(),
              resolvedBy: actorId, resolutionReason: input.reason,
            },
          }));
        });
      } catch (error) {
        if (hasJournalSqlState(error, 'SL001')) unavailable();
        throw error;
      }
    }
  }
  return DamageClaimsController;
}
