import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { PayHereRefundExecution } from '../../../generated/prisma/client.js';
import { makePayHereSandboxClient } from '../../../shared/payments/reconciliation.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { lockBooking, paymentBlocked } from '../bookings/lifecycle.js';
import { ProfileService } from '../profiles/service.js';
import { lockPaymentOrder } from './capture.js';
import { parse, schema, uuid } from './orders.js';
import { findRefundReserve, refundTarget, requireRecentIndependentAdmin, settleRefund, type RefundKey, type RefundTarget } from './refund-reservations.js';

const empty = z.object({}).strict();
const execution = z.object({
  id: uuid, orderId: uuid, amountMinor: z.number().int().positive(),
  state: z.enum(['pending', 'uncertain', 'failed', 'succeeded']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const view = execution.extend({ requestId: uuid });
const depositView = execution.extend({ claimId: uuid });

function present(row: PayHereRefundExecution) {
  const { id, orderId, requestId, damageClaimId, status, amountMinor, createdAt, updatedAt } = row;
  return { id, orderId, ...(damageClaimId ? { claimId: damageClaimId } : { requestId }), amountMinor,
    state: status, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() };
}

function notEligible() {
  return new PublicError(409, 'PAYHERE_REFUND_NOT_ELIGIBLE', 'The approved PayHere refund reservation needs review.');
}

function capture(target: RefundTarget) {
  const order = target.order;
  const attempt = order?.payhereAttempt;
  const event = attempt?.events[0];
  if (!target.approved || !order || order.stripeAttempt || !attempt || !event?.journal?.postedAt ||
    event.journal.source !== 'payhere.sandbox.capture' || event.journal.reference !== attempt.id) throw notEligible();
  if (target.amountMinor !== order.amountMinor) {
    throw new PublicError(409, 'PAYHERE_PARTIAL_REFUND_UNAVAILABLE', 'This PayHere deposit refund needs a separate review because the approved amount is partial.');
  }
  return { order, attemptId: attempt.id, paymentId: event.reportedPaymentId };
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

  async function runRefund(req: Request, body: unknown, locate: () => RefundKey) {
    if (req.get('Origin') !== config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await admin(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    parse(empty, body);
    if (config.PAYHERE_SANDBOX_REFUND_EXECUTION !== 'true') {
      throw new PublicError(503, 'PAYHERE_REFUNDS_DISABLED', 'PayHere sandbox refund execution is unavailable.');
    }
    const key = locate();
    const source = await refundTarget(db, key);
    requireRecentIndependentAdmin(actor, source.booking);
    const { order, attemptId, paymentId } = capture(source);
    const prior = source.payHereExecution;
    if (prior && prior.status !== 'pending') return present(prior);
    if (!prior && (order.status !== 'paid' || !source.reservationId)) throw notEligible();

    await auth.limits.check('reconciliation-admin', actor.user.id, 10, 60);
    await auth.limits.check('reconciliation-gateway', 'payhere', 4, 10);
    const observation = await payHere.observe({ id: attemptId, amountMinor: order.amountMinor });
    if (prior && (observation.status !== 'refunded' || observation.paymentReference !== paymentId)) return present(prior);
    if (!prior) {
      if (observation.status !== 'captured' || observation.paymentReference !== paymentId) throw notEligible();
      if (source.damageClaimId && !observation.payHereCardPayment) {
        throw new PublicError(409, 'PAYHERE_CARD_PAYMENT_REQUIRED', 'PayHere must confirm a card payment for this deposit refund.');
      }
      await auth.limits.check('reconciliation-gateway', 'payhere', 4, 10);
    }

    const decision = await db.$transaction(async tx => {
      const currentAdmin = await profiles.actor(tx, actor, undefined, true);
      profiles.verified(currentAdmin);
      await lockBooking(tx, source.booking.id);
      await lockPaymentOrder(tx, order.id);
      const target = await refundTarget(tx, key);
      requireRecentIndependentAdmin(currentAdmin, target.booking);
      const refreshed = capture(target);
      if (!target.reservationId || target.reservationId !== source.reservationId || target.amountMinor !== source.amountMinor ||
        refreshed.order.id !== order.id || refreshed.attemptId !== attemptId || refreshed.paymentId !== paymentId) throw notEligible();

      const current = target.payHereExecution;
      if (current && (current.id !== prior?.id || current.status !== 'pending')) return { response: present(current) };
      const reserved = await findRefundReserve(tx, target.reservationId, target.reserve, target.amountMinor);
      if (!reserved) throw notEligible();
      if (current) {
        if (current.paymentId !== paymentId || !current.providerRefundId || current.amountMinor !== target.amountMinor) throw notEligible();
        const settlementId = await settleRefund(tx, target.booking, reserved, 'payhere', current.providerRefundId, current.id, current.amountMinor);
        return { response: present(await tx.payHereRefundExecution.update({
          where: { id: current.id }, data: { status: 'succeeded', settlementId, updatedAt: new Date() },
        })) };
      }

      if (prior || refreshed.order.status !== 'paid' ||
        (target.damageClaimId && await paymentBlocked(tx, target.booking.id, false))) throw notEligible();
      const claim = await tx.payHereRefundExecution.createMany({
        data: {
          requestId: target.requestId, damageClaimId: target.damageClaimId, orderId: order.id,
          actorId: currentAdmin.user.id, paymentId, amountMinor: target.amountMinor,
        },
        skipDuplicates: true,
      });
      if (!claim.count) throw notEligible();
      return { row: await tx.payHereRefundExecution.findUniqueOrThrow({ where: { paymentId } }) };
    });
    if (decision.response) return decision.response;

    // Only the administrator request that creates the execution can submit it to PayHere.
    const submission = await payHere.refund(paymentId, decision.row.id);
    return present(await db.payHereRefundExecution.update({
      where: { id: decision.row.id }, data: { ...submission, updatedAt: new Date() },
    }));
  }

  @ApiTags('PayHere sandbox refund execution')
  @ApiBearerAuth()
  @Controller()
  class PayHereRefundExecutionController {
    @Get('admin/refund-requests/:id/items/:orderId/payhere-execution')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiParam({ name: 'orderId', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ execution: view.nullable() })) })
    async status(@Req() req: Request, @Param('id') id: string, @Param('orderId') orderId: string) {
      await admin(req);
      const target = await refundTarget(db, { requestId: parse(uuid, id), orderId: parse(uuid, orderId) });
      return { execution: target.payHereExecution ? present(target.payHereExecution) : null };
    }

    @Post('admin/refund-requests/:id/items/:orderId/payhere-execution')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiParam({ name: 'orderId', format: 'uuid' })
    @ApiBody({ schema: schema(empty) })
    @ApiOkResponse({ schema: schema(view) })
    execute(@Req() req: Request, @Param('id') id: string, @Param('orderId') orderId: string, @Body() body: unknown) {
      return runRefund(req, body, () => ({ requestId: parse(uuid, id), orderId: parse(uuid, orderId) }));
    }

    @Get('admin/damage-claims/:id/payhere-refund')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ execution: depositView.nullable() })) })
    async depositStatus(@Req() req: Request, @Param('id') id: string) {
      await admin(req);
      const target = await refundTarget(db, { claimId: parse(uuid, id) });
      return { execution: target.payHereExecution ? present(target.payHereExecution) : null };
    }

    @Post('admin/damage-claims/:id/payhere-refund')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(empty) })
    @ApiOkResponse({ schema: schema(depositView) })
    executeDeposit(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      return runRefund(req, body, () => ({ claimId: parse(uuid, id) }));
    }
  }
  return PayHereRefundExecutionController;
}
