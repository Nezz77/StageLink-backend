import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma, RefundRequest } from '../../../generated/prisma/client.js';
import { hasJournalSqlState, openAccount, postJournal } from '../../../shared/payments/journal.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';
import { lockBooking } from './lifecycle.js';
import { member } from './requests.js';

const timestamp = z.iso.datetime();
const cancellation = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const cancelled = z.object({ bookingId: uuid, cancelledAt: timestamp, reason: z.string() });
const reason = z.string().trim().min(10).max(2000);
const request = z.object({ reason }).strict();
const decision = z.object({ decision: z.enum(['approved', 'declined']), reason }).strict();
const view = z.object({
  id: uuid, bookingId: uuid, reason, createdAt: timestamp,
  status: z.enum(['requested', 'declined', 'approved']), decidedAt: timestamp.nullable(),
  decisionReason: reason.nullable(), currency: z.literal('LKR'),
  items: z.array(z.object({ orderId: uuid, amountMinor: z.number().int().positive(), reserved: z.boolean(),
    stripeExecutionStatus: z.enum(['uncertain', 'pending', 'failed', 'succeeded']).nullable(),
    payHereExecutionStatus: z.enum(['uncertain', 'pending', 'failed', 'succeeded']).nullable(),
  })),
});
const queue = z.object({ items: z.array(view), nextCursor: uuid.nullable() });
const pageSize = 30;

const refundInclude = { items: { orderBy: { orderId: 'asc' }, include: { stripeExecution: { select: { status: true } }, payHereExecution: { select: { status: true } } } } } as const;
type Refund = Prisma.RefundRequestGetPayload<{ include: typeof refundInclude }>;

function present(row: Refund) {
  const { decidedBy: _reviewer, items, ...details } = row;
  return {
    ...details, createdAt: row.createdAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null,
    currency: 'LKR' as const,
    items: items.map(({ orderId, amountMinor, reservationId, stripeExecution, payHereExecution }) => ({
      orderId, amountMinor, reserved: Boolean(reservationId), stripeExecutionStatus: stripeExecution?.status ?? null,
      payHereExecutionStatus: payHereExecution?.status ?? null,
    })),
  };
}

function customerOnly(customerId: string, actorId: string) {
  if (actorId !== customerId) throw new PublicError(403, 'BOOKING_CUSTOMER_REQUIRED', 'Only the booking customer can request this change.');
}

function unavailable(): never {
  throw new PublicError(409, 'REFUND_NOT_ELIGIBLE', 'The booking payments need reconciliation before a refund can be approved.');
}

const orderSelection = {
  id: true, bookingId: true, amountMinor: true, currency: true, purpose: true, status: true,
  payhereAttempt: { select: { events: { where: { statusCode: '2' }, select: { journalId: true } } } },
  stripeAttempt: { select: { journalId: true } },
} satisfies Prisma.PaymentOrderSelect;

type RefundOrder = Prisma.PaymentOrderGetPayload<{ select: typeof orderSelection }>;

async function capturedOrders(tx: Prisma.TransactionClient, bookingId: string) {
  const orders = await tx.paymentOrder.findMany({
    where: { bookingId, status: { in: ['paid', 'review'] } }, select: orderSelection, orderBy: { id: 'asc' },
  });
  if (!orders.length || orders.some(order => order.status !== 'paid' ||
    !(order.payhereAttempt?.events[0]?.journalId || order.stripeAttempt?.journalId))) unavailable();
  return orders;
}

async function reserveRefund(tx: Prisma.TransactionClient, refund: RefundRequest, order: RefundOrder) {
  const purpose = order.purpose === 'deposit' ? 'deposit' : 'service';
  const fund = { currency: order.currency, purpose } as const;
  const available = await openAccount(tx, { ...fund, scope: 'sandbox:booking:' + refund.bookingId, kind: 'available' });
  const reserved = await openAccount(tx, { ...fund, scope: 'sandbox:refund:' + refund.id + ':' + order.id, kind: 'reserved' });
  const amount = BigInt(order.amountMinor);
  const reservationId = await postJournal(tx, {
    ...fund, source: 'refund.sandbox.reserve', reference: refund.id + ':' + order.id,
  }, [
    { accountId: available.id, amountMinor: -amount },
    { accountId: reserved.id, amountMinor: amount },
  ]);
  await tx.refundItem.update({
    where: { requestId_orderId: { requestId: refund.id, orderId: order.id } }, data: { reservationId },
  });
}

export function makeRefundsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function write<T>(
    req: Request, bookingId: string, work: (tx: Prisma.TransactionClient, booking: Awaited<ReturnType<typeof member>>, actorId: string) => Promise<T>,
    admin = false,
  ) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    const original = admin ? undefined : await member(db, bookingId, actor.user.id);
    if (original) customerOnly(original.customerId, actor.user.id);
    return db.$transaction(async tx => {
      if (original) {
        for (const id of [original.customerId, original.providerId].sort()) {
          await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${id}::uuid FOR UPDATE`;
        }
      }
      const current = await profiles.actor(tx, actor, undefined, admin);
      profiles.verified(current);
      await lockBooking(tx, bookingId);
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw new PublicError(404, 'BOOKING_NOT_FOUND', 'This booking is unavailable.');
      if (admin) {
        if (current.user.id === booking.providerId || current.user.id === booking.customerId) {
          throw new PublicError(403, 'SELF_REVIEW_FORBIDDEN', 'Another administrator must review this refund.');
        }
        if (current.session.createdAt.getTime() < Date.now() - 15 * 60_000) {
          throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before reviewing the refund.');
        }
      } else if (!current.user.roles.includes('customer')) {
        throw new PublicError(403, 'ROLE_FORBIDDEN', 'A customer membership is required.');
      }
      return work(tx, booking, current.user.id);
    });
  }

  @ApiTags('Booking cancellations and refunds')
  @ApiBearerAuth()
  @Controller()
  class RefundsController {
    @Post('bookings/:id/cancellations')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(cancellation) })
    @ApiOkResponse({ schema: schema(cancelled) })
    cancel(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const input = parse(cancellation, body);
      return write(req, parse(uuid, id), async (tx, booking) => {
        if (booking.cancelledAt) {
          return { bookingId: booking.id, cancelledAt: booking.cancelledAt.toISOString(), reason: booking.cancellationReason };
        }
        if (await tx.bookingDispute.count({ where: { bookingId: booking.id, dismissedAt: null } })) {
          throw new PublicError(409, 'BOOKING_DISPUTED', 'The booking needs an arbitration review.');
        }
        const now = new Date();
        if (await tx.equipmentInspection.count({
          where: { bookingId: booking.id, stage: { in: ['out', 'return_draft', 'return_ack', 'quarantined', 'clearance_draft'] } },
        })) throw new PublicError(409, 'EQUIPMENT_IN_CUSTODY', 'Complete the equipment return before cancellation.');
        if (booking.startsAt <= now || booking.providerDecision === 'rejected') {
          throw new PublicError(409, 'CANCELLATION_NOT_ELIGIBLE', 'Only upcoming bookings can be cancelled here.');
        }
        const captured = await tx.paymentOrder.count({ where: { bookingId: booking.id, status: { in: ['paid', 'review'] } } });
        if (captured) throw new PublicError(409, 'PAYMENT_REVIEW_REQUIRED', 'Use refund review for a booking with captured or unreconciled payments.');
        await tx.booking.update({
          where: { id: booking.id },
          data: { cancelledAt: now, cancellationReason: input.reason, revision: { increment: 1 } },
        });
        await tx.equipmentInspectionUnit.updateMany({
          where: { releasedAt: null, inspection: { bookingId: booking.id } }, data: { releasedAt: now },
        });
        await tx.paymentOrder.updateMany({
          where: { bookingId: booking.id, status: { in: ['open', 'pending'] } }, data: { status: 'cancelled' },
        });
        return { bookingId: booking.id, cancelledAt: now.toISOString(), reason: input.reason };
      });
    }

    @Post('bookings/:id/refund-requests')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(request) })
    @ApiOkResponse({ schema: schema(view) })
    request(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const input = parse(request, body);
      return write(req, parse(uuid, id), async (tx, booking) => {
        const existing = await tx.refundRequest.findUnique({ where: { bookingId: booking.id }, include: refundInclude });
        if (existing) {
          if (existing.reason !== input.reason) throw new PublicError(409, 'REFUND_ALREADY_REQUESTED', 'This booking already has a refund request.');
          return present(existing);
        }
        if (await tx.bookingDispute.count({ where: { bookingId: booking.id, dismissedAt: null } })) {
          throw new PublicError(409, 'BOOKING_DISPUTED', 'The booking needs an arbitration review.');
        }
        const now = new Date();
        if (!booking.agreedAt || booking.cancelledAt || booking.startsAt <= now || await tx.equipmentInspection.count({
          where: { bookingId: booking.id, stage: { notIn: ['dispatch_draft', 'dispatch_ack', 'abandoned'] } },
        })) unavailable();
        const orders = await capturedOrders(tx, booking.id);
        return present(await tx.refundRequest.create({
          data: {
            bookingId: booking.id, reason: input.reason, createdAt: now,
            items: { create: orders.map(({ id, amountMinor }) => ({ orderId: id, amountMinor })) },
          },
          include: refundInclude,
        }));
      });
    }

    @Get('bookings/:id/refund-requests')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ request: view.nullable() })) })
    async read(@Req() req: Request, @Param('id') id: string) {
      const actor = await identity(req);
      const booking = await member(db, parse(uuid, id), actor.user.id);
      const refund = await db.refundRequest.findUnique({ where: { bookingId: booking.id }, include: refundInclude });
      return { request: refund && present(refund) };
    }

    @Get('admin/refund-requests')
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiOkResponse({ schema: schema(queue) })
    async queue(@Req() req: Request, @Query('cursor') raw?: string) {
      const actor = await identity(req);
      const cursor = raw === undefined ? undefined : parse(uuid, raw);
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, actor, undefined, true);
        profiles.verified(current);
        const rows = await tx.refundRequest.findMany({
          where: { status: 'requested', ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' }, take: pageSize + 1, include: refundInclude,
        });
        const items = rows.slice(0, pageSize).map(present);
        return { items, nextCursor: rows.length > pageSize ? items[pageSize - 1]!.id : null };
      });
    }

    @Post('admin/refund-requests/:id/decisions')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(decision) })
    @ApiOkResponse({ schema: schema(view) })
    async decide(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const actor = await identity(req);
      if (actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
      const input = parse(decision, body);
      const refundId = parse(uuid, id);
      const original = await db.refundRequest.findUnique({ where: { id: refundId }, select: { bookingId: true } });
      if (!original) throw new PublicError(404, 'REFUND_NOT_FOUND', 'This refund request is unavailable.');
      try {
        return await write(req, original.bookingId, async (tx, booking, actorId) => {
          const refund = await tx.refundRequest.findUniqueOrThrow({ where: { id: refundId }, include: refundInclude });
          if (refund.status === input.decision && refund.decisionReason === input.reason) return present(refund);
          if (refund.status !== 'requested') throw new PublicError(409, 'REFUND_ALREADY_DECIDED', 'This refund already has a decision.');
          if (input.decision === 'approved') {
            if (booking.cancelledAt) unavailable();
            const orders = await capturedOrders(tx, booking.id);
            if (orders.length !== refund.items.length || orders.some((order, index) => {
              const item = refund.items[index]!;
              return order.id !== item.orderId || order.amountMinor !== item.amountMinor;
            })) unavailable();
            for (const order of orders) await reserveRefund(tx, refund, order);
          }
          return present(await tx.refundRequest.update({
            where: { id: refundId },
            data: { status: input.decision, decidedBy: actorId, decidedAt: new Date(), decisionReason: input.reason },
            include: refundInclude,
          }));
        }, true);
      } catch (error) {
        if (hasJournalSqlState(error, 'SL001')) unavailable();
        throw error;
      }
    }
  }
  return RefundsController;
}
