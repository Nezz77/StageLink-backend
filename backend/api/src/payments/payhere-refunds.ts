import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { PayHereRefundExecution } from '../../../generated/prisma/client.js';
import { makePayHereSandboxClient } from '../../../shared/payments/reconciliation.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { lockBooking } from '../bookings/lifecycle.js';
import { ProfileService } from '../profiles/service.js';
import { lockPaymentOrder } from './capture.js';
import { parse, schema, uuid } from './orders.js';
import { refundItem, requireRecentIndependentAdmin, reservedFunds, settleRefund, validApprovedRefund, type Item } from './refund-reservations.js';

const empty = z.object({}).strict();
const view = z.object({
  id: uuid, orderId: uuid, requestId: uuid, amountMinor: z.number().int().positive(),
  state: z.enum(['pending', 'uncertain', 'failed', 'succeeded']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});

function present(row: PayHereRefundExecution) {
  const { id, orderId, requestId, status, amountMinor, createdAt, updatedAt } = row;
  return { id, orderId, requestId, amountMinor, state: status, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() };
}

function notEligible() {
  return new PublicError(409, 'PAYHERE_REFUND_NOT_ELIGIBLE', 'The approved PayHere refund reservation needs review.');
}

function capture(item: Item) {
  const payHere = item.order.payhereAttempt;
  const event = payHere?.events[0];
  if (!validApprovedRefund(item) || item.order.stripeAttempt || !payHere || !event?.journal?.postedAt ||
    event.journal.source !== 'payhere.sandbox.capture' || event.journal.reference !== payHere.id) throw notEligible();
  return { attemptId: payHere.id, paymentId: event.reportedPaymentId };
}

export function makePayHereRefundExecutionController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const config = auth.config;
  const payHere = makePayHereSandboxClient(config.PAYHERE_SANDBOX_RETRIEVAL_APP_ID, config.PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET);

  async function admin(req: Request) {
    const actor = await auth.authenticate(req.get('Authorization'));
    if (actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    profiles.verified(actor);
    return actor;
  }

  @ApiTags('PayHere sandbox refund execution')
  @ApiBearerAuth()
  @Controller('admin/refund-requests/:id/items/:orderId/payhere-execution')
  class PayHereRefundExecutionController {
    @Get()
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiParam({ name: 'orderId', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ execution: view.nullable() })) })
    async status(@Req() req: Request, @Param('id') rawId: string, @Param('orderId') rawOrderId: string) {
      await admin(req);
      const item = await refundItem(db, parse(uuid, rawId), parse(uuid, rawOrderId));
      return { execution: item.payHereExecution ? present(item.payHereExecution) : null };
    }

    @Post()
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiParam({ name: 'orderId', format: 'uuid' })
    @ApiBody({ schema: schema(empty) })
    @ApiOkResponse({ schema: schema(view) })
    async execute(@Req() req: Request, @Param('id') rawId: string, @Param('orderId') rawOrderId: string, @Body() body: unknown) {
      if (req.get('Origin') !== config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
      }
      const actor = await admin(req);
      profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
      parse(empty, body);
      if (config.PAYHERE_SANDBOX_REFUND_EXECUTION !== 'true') {
        throw new PublicError(503, 'PAYHERE_REFUNDS_DISABLED', 'PayHere sandbox refund execution is unavailable.');
      }
      const requestId = parse(uuid, rawId);
      const orderId = parse(uuid, rawOrderId);
      const source = await refundItem(db, requestId, orderId);
      requireRecentIndependentAdmin(actor, source.request.booking);
      const { attemptId, paymentId } = capture(source);
      const prior = source.payHereExecution;
      if (prior && prior.status !== 'pending') return present(prior);
      if (!prior && (source.order.status !== 'paid' || !source.reservationId)) throw notEligible();

      await auth.limits.check('reconciliation-admin', actor.user.id, 10, 60);
      await auth.limits.check('reconciliation-gateway', 'payhere', 4, 10);
      const observation = await payHere.observe({ id: attemptId, amountMinor: source.amountMinor });
      if (prior && (observation.status !== 'refunded' || observation.paymentReference !== paymentId)) return present(prior);
      if (!prior) {
        if (observation.status !== 'captured' || observation.paymentReference !== paymentId) throw notEligible();
        await auth.limits.check('reconciliation-gateway', 'payhere', 4, 10);
      }

      const decision = await db.$transaction(async tx => {
        const currentAdmin = await profiles.actor(tx, actor, undefined, true);
        profiles.verified(currentAdmin);
        await lockBooking(tx, source.request.bookingId);
        await lockPaymentOrder(tx, orderId);
        const item = await refundItem(tx, requestId, orderId);
        requireRecentIndependentAdmin(currentAdmin, item.request.booking);
        const currentCapture = capture(item);
        if (currentCapture.attemptId !== attemptId || currentCapture.paymentId !== paymentId ||
          item.reservationId !== source.reservationId || item.amountMinor !== source.amountMinor) throw notEligible();

        const current = item.payHereExecution;
        if (current) {
          if (current.id !== prior?.id || current.status !== 'pending') return { response: present(current) };
          const reserved = await reservedFunds(tx, item);
          if (!reserved || current.paymentId !== paymentId || !current.providerRefundId || current.amountMinor !== item.amountMinor) {
            throw notEligible();
          }
          const settlementId = await settleRefund(
            tx, { id: item.request.bookingId, ...item.request.booking }, reserved, 'payhere', current.providerRefundId, current.id, current.amountMinor,
          );
          return { response: present(await tx.payHereRefundExecution.update({
            where: { id: current.id }, data: { status: 'succeeded', settlementId, updatedAt: new Date() },
          })) };
        }

        if (prior || item.order.status !== 'paid' || !await reservedFunds(tx, item)) throw notEligible();
        const claim = await tx.payHereRefundExecution.createMany({
          data: { requestId, orderId, actorId: currentAdmin.user.id, paymentId, amountMinor: item.amountMinor },
          skipDuplicates: true,
        });
        if (!claim.count) throw notEligible();
        return { row: await tx.payHereRefundExecution.findUniqueOrThrow({ where: { requestId_orderId: { requestId, orderId } } }) };
      });
      if (decision.response) return decision.response;

      // PayHere does not document a refund idempotency key. Only the original claim submits.
      const submission = await payHere.refund(paymentId, decision.row.id);
      return present(await db.payHereRefundExecution.update({
        where: { id: decision.row.id }, data: { ...submission, updatedAt: new Date() },
      }));
    }
  }
  return PayHereRefundExecutionController;
}
