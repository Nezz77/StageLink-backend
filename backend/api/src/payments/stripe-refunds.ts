import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { StripeRefundExecution } from '../../../generated/prisma/client.js';
import { observeStripe } from '../../../shared/payments/reconciliation.js';
import { processStripeRefund } from '../../../shared/payments/stripe-refunds.js';
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
  state: z.enum(['processing', 'pending', 'uncertain', 'failed', 'succeeded']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const view = execution.extend({ requestId: uuid });
const depositView = execution.extend({ claimId: uuid });
function present(row: StripeRefundExecution) {
  const { id, orderId, requestId, damageClaimId, status, amountMinor, createdAt, updatedAt } = row;
  return { id, orderId, ...(damageClaimId ? { claimId: damageClaimId } : { requestId }), amountMinor,
    state: row.leaseUntil && row.leaseUntil > new Date() ? 'processing' : status,
    createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() };
}

function notEligible() {
  return new PublicError(409, 'STRIPE_REFUND_NOT_ELIGIBLE', 'The approved Stripe refund reservation needs review.');
}

function hasValidCapture(target: RefundTarget) {
  const stripe = target.order?.stripeAttempt;
  return target.approved && !target.order?.payhereAttempt && Boolean(stripe?.sessionId && stripe.journal?.postedAt &&
    stripe.journal.source === 'stripe.test.capture' && stripe.journal.reference === stripe.sessionId);
}

export function makeStripeRefundExecutionController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const config = auth.config;

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
    const key = config.STRIPE_TEST_SECRET_KEY;
    if (config.STRIPE_TEST_REFUND_EXECUTION !== 'true' || !key) {
      throw new PublicError(503, 'STRIPE_REFUNDS_DISABLED', 'Stripe test refund execution is unavailable.');
    }
    const targetKey = locate();
    const source = await refundTarget(db, targetKey);
    requireRecentIndependentAdmin(actor, source.booking);
    const order = source.order;
    if (!order || !hasValidCapture(source)) throw notEligible();
    const orderId = order.id;
    if (source.stripeExecution && ['succeeded', 'failed'].includes(source.stripeExecution.status)) return present(source.stripeExecution);

    await auth.limits.check('stripe-refund-admin', actor.user.id, 12, 60);
    await auth.limits.check('stripe-refund-shared', 'shared', 30, 60);

    const attempt = order.stripeAttempt!;
    let intentId = source.stripeExecution?.paymentIntentId;
    if (!intentId) {
      if (order.status !== 'paid' || !source.reservationId) throw notEligible();
      const probe = await observeStripe(key, { ...attempt, amountMinor: order.amountMinor });
      if (probe.status !== 'captured' || !probe.paymentIntentId) throw notEligible();
      intentId = probe.paymentIntentId;
    }

    const claim = await db.$transaction(async tx => {
      const currentAdmin = await profiles.actor(tx, actor, undefined, true);
      profiles.verified(currentAdmin);
      await lockBooking(tx, source.booking.id);
      await lockPaymentOrder(tx, orderId);
      const current = await refundTarget(tx, targetKey);
      requireRecentIndependentAdmin(currentAdmin, current.booking);
      if (!current.reservationId || current.order?.id !== orderId || !hasValidCapture(current) ||
        current.reservationId !== source.reservationId || current.amountMinor !== source.amountMinor ||
        current.order.stripeAttempt?.sessionId !== attempt.sessionId || current.order.stripeAttempt.journalId !== attempt.journalId) {
        throw notEligible();
      }
      const prior = current.stripeExecution;
      const now = new Date();
      if (prior && (['succeeded', 'failed'].includes(prior.status) || (prior.leaseUntil && prior.leaseUntil > now))) {
        return { response: present(prior) };
      }
      const reserved = await findRefundReserve(tx, current.reservationId, current.reserve, current.amountMinor);
      if (!reserved || (prior && (prior.amountMinor !== current.amountMinor || prior.paymentIntentId !== intentId))) throw notEligible();
      const allowSubmit = current.order.status === 'paid' &&
        (!current.damageClaimId || !await paymentBlocked(tx, current.booking.id, false));
      if (!prior && !allowSubmit) throw notEligible();
      const lease = { leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + 30_000), updatedAt: now };
      const row = prior
        ? await tx.stripeRefundExecution.update({ where: { id: prior.id }, data: lease })
        : await tx.stripeRefundExecution.create({ data: {
          requestId: current.requestId, damageClaimId: current.damageClaimId, orderId,
          actorId: currentAdmin.user.id, paymentIntentId: intentId!,
          amountMinor: current.amountMinor, ...lease,
        } });
      return { row, leaseId: lease.leaseId, reserved, allowSubmit, firstAttempt: !prior };
    });
    if (claim.response) return claim.response;

    const observation = await processStripeRefund(key, claim.row, claim.allowSubmit, claim.firstAttempt);
    return db.$transaction(async tx => {
      await lockBooking(tx, source.booking.id);
      await lockPaymentOrder(tx, orderId);
      const current = await tx.stripeRefundExecution.findUniqueOrThrow({ where: { id: claim.row.id } });
      if (current.leaseId !== claim.leaseId) return present(current);

      let settlementId: string | undefined;
      if (observation?.status === 'succeeded') {
        settlementId = await settleRefund(tx, source.booking, claim.reserved, 'stripe', observation.id, current.id, current.amountMinor);
      }
      const status = !observation ? 'uncertain' : settlementId ? 'succeeded'
        : observation.status === 'failed' || observation.status === 'canceled' ? 'failed' : 'pending';
      return present(await tx.stripeRefundExecution.update({
        where: { id: current.id },
        data: {
          status, ...(observation ? { providerRefundId: observation.id } : {}), settlementId,
          updatedAt: new Date(), leaseId: null, leaseUntil: null,
        },
      }));
    });
  }

  @ApiTags('Stripe test refund execution')
  @ApiBearerAuth()
  @Controller()
  class StripeRefundExecutionController {
    @Get('admin/refund-requests/:id/items/:orderId/stripe-execution')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiParam({ name: 'orderId', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ execution: view.nullable() })) })
    async status(@Req() req: Request, @Param('id') id: string, @Param('orderId') orderId: string) {
      await admin(req);
      const item = await refundTarget(db, { requestId: parse(uuid, id), orderId: parse(uuid, orderId) });
      return { execution: item.stripeExecution ? present(item.stripeExecution) : null };
    }

    @Post('admin/refund-requests/:id/items/:orderId/stripe-execution')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiParam({ name: 'orderId', format: 'uuid' })
    @ApiBody({ schema: schema(empty) })
    @ApiOkResponse({ schema: schema(view) })
    execute(@Req() req: Request, @Param('id') id: string, @Param('orderId') orderId: string, @Body() body: unknown) {
      return runRefund(req, body, () => ({ requestId: parse(uuid, id), orderId: parse(uuid, orderId) }));
    }

    @Get('admin/damage-claims/:id/stripe-refund')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ execution: depositView.nullable() })) })
    async depositStatus(@Req() req: Request, @Param('id') id: string) {
      await admin(req);
      const target = await refundTarget(db, { claimId: parse(uuid, id) });
      return { execution: target.stripeExecution ? present(target.stripeExecution) : null };
    }

    @Post('admin/damage-claims/:id/stripe-refund')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(empty) })
    @ApiOkResponse({ schema: schema(depositView) })
    executeDeposit(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      return runRefund(req, body, () => ({ claimId: parse(uuid, id) }));
    }
  }
  return StripeRefundExecutionController;
}
