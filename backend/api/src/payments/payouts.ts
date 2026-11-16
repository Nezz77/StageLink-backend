import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { Booking, BookingPayoutHold, PayoutDestinationRepair, PayoutOrder, Prisma } from '../../../generated/prisma/client.js';
import { issueDocument } from '../../../shared/booking-documents.js';
import { hasJournalSqlState, openAccount, postedBalance, postJournal } from '../../../shared/payments/journal.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { lockBooking, maxMinor, paymentBlocked } from '../bookings/lifecycle.js';
import { ProfileService } from '../profiles/service.js';
import { parse, schema, uuid } from './orders.js';
import { assertPayoutProvider, payoutReservationAccount, providerVerifiedForPayout } from './payout-eligibility.js';

const timestamp = z.iso.datetime();
const minor = z.number().int().min(0).max(maxMinor);
const revision = z.number().int().min(1).max(maxMinor);
const holdInput = z.object({
  expectedRevision: z.number().int().min(0).max(maxMinor - 1), held: z.boolean(), reason: z.string().trim().min(1).max(500),
}).strict();
const payoutInput = z.object({ bookingId: uuid, destinationRevision: revision }).strict();
const repairInput = z.object({
  requestKey: uuid, expectedDestinationRevision: revision, destinationRevision: revision, reason: z.string().trim().min(10).max(500),
}).strict().refine(input => input.destinationRevision > input.expectedDestinationRevision, 'Choose a newer approved destination revision.');
const repairView = z.object({
  id: uuid, payoutId: uuid, requestKey: uuid, previousDestinationRevision: revision, destinationRevision: revision,
  actorId: uuid, reason: z.string(), createdAt: timestamp,
});
const hold = z.object({
  bookingId: uuid, revision, held: z.boolean(), reason: z.string(), createdAt: timestamp,
});
const payout = z.object({
  id: uuid, bookingId: uuid, providerId: uuid, destinationRevision: revision, createdAt: timestamp,
  grossMinor: minor, platformFeeMinor: minor, netMinor: minor, currency: z.literal('LKR'),
  status: z.enum(['reserved', 'review_required']),
  stripeTransferStatus: z.enum(['uncertain', 'transferred', 'review_required']).nullable(),
});
const payment = z.object({
  id: uuid, purpose: z.enum(['advance', 'balance', 'deposit']), amountMinor: minor,
  status: z.enum(['open', 'pending', 'failed', 'cancelled', 'paid', 'review']),
});
const overview = z.object({
  bookingId: uuid, providerId: uuid, cancelled: z.boolean(), completionVerified: z.boolean(),
  held: z.boolean(), holdRevision: z.number().int().min(0).max(maxMinor), refundStatus: z.enum(['requested', 'approved', 'declined']).nullable(),
  payments: z.array(payment), payout: payout.nullable(), currency: z.literal('LKR'),
});
const earnings = z.object({
  items: z.array(overview.omit({ providerId: true })), nextCursor: uuid.nullable(),
});
const page = z.object({ items: z.array(overview), nextCursor: uuid.nullable() });
const pageSize = 30;

const activeHold = { orderBy: { revision: 'desc' }, take: 1 } satisfies Prisma.Booking$payoutHoldsArgs;
const serviceOrders = { purpose: { in: ['advance', 'balance'] } } satisfies Prisma.PaymentOrderWhereInput;
const overviewInclude = {
  completion: { select: { verifiedAt: true } },
  payoutHolds: activeHold,
  refundRequest: { select: { status: true } },
  dispute: { select: { dismissedAt: true } },
  provider: {
    select: {
      disabledAt: true, emailVerifiedAt: true, roles: true, payout: { select: { revision: true, status: true } },
      verificationCases: {
        where: { kind: { in: ['artist', 'renter'] } },
        orderBy: { version: 'desc' }, distinct: ['kind'], select: { kind: true, status: true },
      },
    },
  },
  paymentOrders: { orderBy: { purpose: 'asc' }, select: { id: true, purpose: true, amountMinor: true, status: true } },
  payoutOrder: { include: { stripeTransfers: { orderBy: { attempt: 'desc' }, take: 1, select: { status: true } } } },
} satisfies Prisma.BookingInclude;

function presentHold(row: BookingPayoutHold) {
  const { actorId: _actor, ...details } = row;
  return { ...details, createdAt: row.createdAt.toISOString() };
}

const presentRepair = (row: PayoutDestinationRepair) => ({ ...row, createdAt: row.createdAt.toISOString() });

type BookingFinance = Prisma.BookingGetPayload<{ include: typeof overviewInclude }>;

function presentPayout(row: PayoutOrder, booking: BookingFinance) {
  const destination = booking.provider.payout;
  const refund = booking.refundRequest?.status;
  const paymentReview = booking.paymentOrders.some(order => order.purpose !== 'deposit' && order.status !== 'paid');
  const needsReview = booking.cancelledAt || booking.dispute?.dismissedAt === null || refund === 'requested' || refund === 'approved' || booking.payoutHolds[0]?.held ||
    paymentReview || destination?.revision !== row.destinationRevision || destination.status !== 'approved' ||
    booking.provider.disabledAt || !booking.provider.emailVerifiedAt ||
    !providerVerifiedForPayout(booking.targetKind, booking.provider.roles, booking.provider.verificationCases);
  const { id, bookingId, providerId, destinationRevision, grossMinor, platformFeeMinor, netMinor, createdAt } = row;
  return {
    id, bookingId, providerId, destinationRevision, grossMinor, platformFeeMinor, netMinor,
    createdAt: createdAt.toISOString(), currency: 'LKR' as const, status: needsReview ? 'review_required' : 'reserved',
    stripeTransferStatus: booking.payoutOrder?.stripeTransfers[0]?.status ?? null,
  };
}

async function currentPayout(tx: Prisma.TransactionClient, row: PayoutOrder) {
  const booking = await tx.booking.findUniqueOrThrow({ where: { id: row.bookingId }, include: overviewInclude });
  return presentPayout(row, booking);
}

function notEligible(): never {
  throw new PublicError(409, 'PAYOUT_NOT_ELIGIBLE', 'The booking, payments or destination are unavailable for payout reservation.');
}

async function payoutAmounts(tx: Prisma.TransactionClient, booking: Booking, revision: number) {
  const [report, hold, orders] = await Promise.all([
    tx.bookingCompletion.findUnique({ where: { bookingId: booking.id } }),
    tx.bookingPayoutHold.findFirst({ where: { bookingId: booking.id }, orderBy: { revision: 'desc' } }),
    tx.paymentOrder.findMany({
      where: { bookingId: booking.id, ...serviceOrders },
      include: {
        payhereAttempt: { select: { events: { where: { statusCode: '2' }, select: { journalId: true } } } },
        stripeAttempt: { select: { journalId: true } },
      },
    }),
  ]);
  if (!report?.verifiedAt || hold?.held || await paymentBlocked(tx, booking.id)) notEligible();
  const destinationRevision = await assertPayoutProvider(tx, booking, revision);
  if (orders.some(order => !(order.payhereAttempt?.events[0]?.journalId || order.stripeAttempt?.journalId))) notEligible();
  const advance = orders.find(order => order.purpose === 'advance');
  const balance = orders.find(order => order.purpose === 'balance');
  if (advance?.status !== 'paid' || advance.amountMinor !== report.advanceMinor ||
    (report.balanceMinor > 0 ? balance?.status !== 'paid' || balance.amountMinor !== report.balanceMinor : Boolean(balance))) notEligible();
  const grossMinor = report.advanceMinor + report.balanceMinor;
  return { destinationRevision, grossMinor, platformFeeMinor: report.platformFeeMinor, netMinor: grossMinor - report.platformFeeMinor };
}

export function makePayoutsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function adminWrite<T>(
    req: Request, bookingId: string, work: (tx: Prisma.TransactionClient, booking: Booking, actorId: string) => Promise<T>,
  ) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    if (actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    const original = await db.booking.findUnique({ where: { id: bookingId }, select: { providerId: true } });
    if (!original) throw new PublicError(404, 'BOOKING_NOT_FOUND', 'This booking is unavailable.');
    return db.$transaction(async tx => {
      for (const id of [...new Set([actor.user.id, original.providerId])].sort()) {
        await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${id}::uuid FOR UPDATE`;
      }
      const current = await profiles.actor(tx, actor, undefined, true);
      profiles.verified(current);
      if (current.session.createdAt.getTime() < Date.now() - 15 * 60_000) {
        throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before changing payout controls.');
      }
      await lockBooking(tx, bookingId);
      const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
      if ([booking.customerId, booking.providerId].includes(current.user.id)) {
        throw new PublicError(403, 'SELF_REVIEW_FORBIDDEN', 'Another administrator must manage payouts for this booking.');
      }
      return work(tx, booking, current.user.id);
    });
  }

  async function list(req: Request, before: string | undefined, admin: boolean) {
    const actor = await identity(req);
    if (admin && actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    if (!admin) profiles.providerRole(actor);
    const cursor = before === undefined ? undefined : parse(uuid, before);
    return db.$transaction(async tx => {
      const rows = await tx.booking.findMany({
        where: {
          ...(admin ? {} : { providerId: actor.user.id }),
          paymentOrders: { some: { status: { in: ['paid', 'review'] } } },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' }, take: pageSize + 1, include: overviewInclude,
      });
      const items = rows.slice(0, pageSize).map(row => ({
        bookingId: row.id, providerId: row.providerId, cancelled: Boolean(row.cancelledAt),
        completionVerified: Boolean(row.completion?.verifiedAt), held: row.payoutHolds[0]?.held ?? false, holdRevision: row.payoutHolds[0]?.revision ?? 0,
        refundStatus: row.refundRequest?.status ?? null, payments: row.paymentOrders, currency: 'LKR' as const,
        payout: row.payoutOrder ? presentPayout(row.payoutOrder, row) : null,
      }));
      return { items, nextCursor: rows.length > pageSize ? items[pageSize - 1]!.bookingId : null };
    }, { isolationLevel: 'RepeatableRead' });
  }

  @ApiTags('Provider earnings and payout reservations')
  @ApiBearerAuth()
  @Controller()
  class PayoutsController {
    @Get('me/earnings')
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiOkResponse({ schema: schema(earnings) })
    async earnings(@Req() req: Request, @Query('cursor') cursor?: string) {
      const result = await list(req, cursor, false);
      return { ...result, items: result.items.map(({ providerId: _provider, ...row }) => row) };
    }

    @Get('admin/payments')
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiOkResponse({ schema: schema(page) })
    payments(@Req() req: Request, @Query('cursor') cursor?: string) {
      return list(req, cursor, true);
    }

    @Get('payouts/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(payout) })
    async read(@Req() req: Request, @Param('id') id: string) {
      const actor = await identity(req);
      const admin = actor.session.activeRole === 'admin' && actor.user.roles.includes('admin');
      return db.$transaction(async tx => {
        const order = await tx.payoutOrder.findFirst({
          where: { id: parse(uuid, id), ...(admin ? {} : { providerId: actor.user.id }) },
        });
        if (!order) throw new PublicError(404, 'PAYOUT_NOT_FOUND', 'This payout reservation is unavailable.');
        if (!admin) profiles.providerRole(actor);
        return currentPayout(tx, order);
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Post('admin/bookings/:id/holds')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(holdInput) })
    @ApiOkResponse({ schema: schema(hold) })
    hold(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const input = parse(holdInput, raw);
      return adminWrite(req, parse(uuid, id), async (tx, booking, actorId) => {
        const current = await tx.bookingPayoutHold.findFirst({ where: { bookingId: booking.id }, orderBy: { revision: 'desc' } });
        if (current && current.revision === input.expectedRevision + 1 && current.held === input.held &&
          current.reason === input.reason && current.actorId === actorId) return presentHold(current);
        if ((current?.revision ?? 0) !== input.expectedRevision) {
          throw new PublicError(409, 'PAYOUT_HOLD_CHANGED', 'Reload the current payout hold before changing it.');
        }
        return presentHold(await tx.bookingPayoutHold.create({
          data: {
            bookingId: booking.id, revision: input.expectedRevision + 1, actorId,
            held: input.held, reason: input.reason, createdAt: new Date(),
          },
        }));
      });
    }

    @Post('admin/payouts')
    @HttpCode(200)
    @ApiBody({ schema: schema(payoutInput) })
    @ApiOkResponse({ schema: schema(payout) })
    async reserve(@Req() req: Request, @Body() raw: unknown) {
      const input = parse(payoutInput, raw);
      try {
        return await adminWrite(req, input.bookingId, async (tx, booking, actorId) => {
          const existing = await tx.payoutOrder.findUnique({ where: { bookingId: booking.id } });
          if (existing) {
            if (existing.destinationRevision !== input.destinationRevision) {
              throw new PublicError(409, 'PAYOUT_ALREADY_RESERVED', 'The existing reservation needs review before changing its destination.');
            }
            return currentPayout(tx, existing);
          }
          const amounts = await payoutAmounts(tx, booking, input.destinationRevision);
          const id = randomUUID();
          const fund = { currency: 'LKR', purpose: 'service' } as const;
          const available = await openAccount(tx, { ...fund, scope: 'sandbox:booking:' + booking.id, kind: 'available' });
          const reserved = await openAccount(tx, { ...fund, scope: 'sandbox:payout:' + id, kind: 'reserved' });
          const reservationId = await postJournal(tx, { ...fund, source: 'payout.sandbox.reserve', reference: booking.id }, [
            { accountId: available.id, amountMinor: -BigInt(amounts.grossMinor) },
            { accountId: reserved.id, amountMinor: BigInt(amounts.grossMinor) },
          ]);
          const order = await tx.payoutOrder.create({
            data: {
              id, bookingId: booking.id, providerId: booking.providerId,
              createdBy: actorId, createdAt: new Date(), ...amounts, reservationId,
            },
          });
          await issueDocument(tx, booking.id, order.id, {
            version: 1, kind: 'settlement', issuedAt: order.createdAt.toISOString(),
            ...amounts,
          });
          return currentPayout(tx, order);
        });
      } catch (error) {
        if (error instanceof PublicError && error.code === 'DESTINATION_NOT_APPROVED') notEligible();
        if (hasJournalSqlState(error, 'SL001')) notEligible();
        throw error;
      }
    }

    @Post('admin/bookings/:id/payout-destination-repairs')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(repairInput) })
    @ApiOkResponse({ schema: schema(repairView) })
    repairDestination(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const input = parse(repairInput, raw);
      return adminWrite(req, parse(uuid, id), async (tx, booking, actorId) => {
        const order = await tx.payoutOrder.findUnique({
          where: { bookingId: booking.id },
          include: { stripeTransfers: { where: { retryAuthorizedAt: null }, select: { id: true }, take: 1 } },
        });
        if (!order) throw new PublicError(404, 'PAYOUT_NOT_FOUND', 'This payout reservation is unavailable.');
        const prior = await tx.payoutDestinationRepair.findUnique({
          where: { payoutId_requestKey: { payoutId: order.id, requestKey: input.requestKey } },
        });
        if (prior) {
          if (prior.actorId !== actorId || prior.previousDestinationRevision !== input.expectedDestinationRevision ||
            prior.destinationRevision !== input.destinationRevision || prior.reason !== input.reason) {
            throw new PublicError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different payout destination repair.');
          }
          return presentRepair(prior);
        }
        if (order.destinationRevision !== input.expectedDestinationRevision) {
          throw new PublicError(409, 'PAYOUT_DESTINATION_CHANGED', 'Reload the payout reservation and review its current destination.');
        }
        if (order.stripeTransfers.length) {
          throw new PublicError(409, 'PAYOUT_TRANSFER_STARTED', 'This payout is tied to a transfer attempt. Review it from the Stripe transfer endpoint.');
        }
        if (order.providerId !== booking.providerId) notEligible();
        const amounts = await payoutAmounts(tx, booking, input.destinationRevision);
        const account = await payoutReservationAccount(tx, order);
        if (amounts.grossMinor !== order.grossMinor || amounts.platformFeeMinor !== order.platformFeeMinor ||
          !account || await postedBalance(tx, account) !== BigInt(order.grossMinor)) notEligible();

        const repair = await tx.payoutDestinationRepair.create({
          data: {
            actorId, payoutId: order.id, requestKey: input.requestKey, reason: input.reason,
            previousDestinationRevision: order.destinationRevision, destinationRevision: amounts.destinationRevision,
          },
        });
        await tx.payoutOrder.update({ where: { id: order.id }, data: { destinationRevision: repair.destinationRevision } });
        await issueDocument(tx, booking.id, repair.id, { version: 1, kind: 'settlement', issuedAt: repair.createdAt.toISOString(), ...amounts });
        return presentRepair(repair);
      });
    }
  }
  return PayoutsController;
}
