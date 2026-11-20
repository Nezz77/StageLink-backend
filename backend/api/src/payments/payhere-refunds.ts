import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { PayHereRefundExecution, PayHereRefundRecovery } from '../../../generated/prisma/client.js';
import { makePayHereSandboxClient } from '../../../shared/payments/reconciliation.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { lockBooking, paymentBlocked } from '../bookings/lifecycle.js';
import { ProfileService } from '../profiles/service.js';
import { lockPaymentOrder } from './capture.js';
import { parse, schema, uuid } from './orders.js';
import { findReservedFunds, refundTarget, requireRecentIndependentAdmin, settleRefund, type RefundKey, type RefundTarget } from './refund-reservations.js';

const empty = z.object({}).strict();
const execution = z.object({
  id: uuid, orderId: uuid, amountMinor: z.number().int().positive(),
  state: z.enum(['pending', 'uncertain', 'failed', 'succeeded']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const view = execution.extend({ requestId: uuid });
const depositView = execution.extend({ claimId: uuid });
const arbitrationView = execution.extend({ arbitrationId: uuid });
const recoveryCommand = z.object({ requestKey: uuid, expectedUpdatedAt: z.iso.datetime(), reason: z.string().trim().min(10).max(500) }).strict();
const recoveryView = z.object({
  id: uuid, executionId: uuid, actorId: uuid, reason: z.string(), paymentId: z.string(), amountMinor: z.number().int().positive(),
  journalId: uuid, observedAt: z.iso.datetime(), createdAt: z.iso.datetime(),
});

function presentRecovery(row: PayHereRefundRecovery) {
  const { id, executionId, actorId, reason, paymentId, amountMinor, journalId, observedAt, createdAt } = row;
  return { id, executionId, actorId, reason, paymentId, amountMinor, journalId,
    observedAt: observedAt.toISOString(), createdAt: createdAt.toISOString() };
}

function replayRecovery(row: PayHereRefundRecovery, actorId: string, command: z.infer<typeof recoveryCommand>) {
  if (row.requestKey !== command.requestKey || row.actorId !== actorId || row.reason !== command.reason ||
    row.previousUpdatedAt.toISOString() !== command.expectedUpdatedAt) {
    throw new PublicError(409, 'REQUEST_KEY_REUSED', 'This refund recovery has already been recorded with a different command.');
  }
  return presentRecovery(row);
}

function recoveryKey(row: PayHereRefundExecution): RefundKey {
  if (row.arbitrationId) return { arbitrationId: row.arbitrationId, orderId: row.orderId };
  if (row.damageClaimId) return { claimId: row.damageClaimId };
  return { requestId: row.requestId!, orderId: row.orderId };
}

function requireUncertain(row: PayHereRefundExecution, expectedUpdatedAt: string) {
  if (row.status !== 'uncertain' || row.providerRefundId || row.settlementId || row.updatedAt.toISOString() !== expectedUpdatedAt) {
    throw new PublicError(409, 'PAYHERE_RECOVERY_NOT_ELIGIBLE', 'Reload this refund execution before reviewing its uncertain outcome.');
  }
}

function present(row: PayHereRefundExecution) {
  const { id, orderId, requestId, damageClaimId, arbitrationId, status, amountMinor, createdAt, updatedAt } = row;
  const target = arbitrationId ? { arbitrationId } : damageClaimId ? { claimId: damageClaimId } : { requestId };
  return { id, orderId, ...target, amountMinor,
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
    throw new PublicError(409, 'PAYHERE_PARTIAL_REFUND_UNAVAILABLE', 'This approved PayHere refund is partial and needs separate review.');
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
      if ((source.damageClaimId || source.arbitrationId) && !observation.payHereCardPayment) {
        throw new PublicError(409, 'PAYHERE_CARD_PAYMENT_REQUIRED', 'PayHere must confirm a card payment for this refund.');
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
        target.reserveAmountMinor !== source.reserveAmountMinor ||
        refreshed.order.id !== order.id || refreshed.attemptId !== attemptId || refreshed.paymentId !== paymentId) throw notEligible();

      const current = target.payHereExecution;
      if (current && (current.id !== prior?.id || current.status !== 'pending')) return { response: present(current) };
      const reserved = await findReservedFunds(tx, target.reservationId, target.reserve, target.amountMinor, target.reserveAmountMinor);
      if (!reserved) throw notEligible();
      if (current) {
        if (current.paymentId !== paymentId || !current.providerRefundId || current.amountMinor !== target.amountMinor) throw notEligible();
        const settlementId = await settleRefund(tx, target.booking, reserved, 'payhere', current.providerRefundId, current.id, current.amountMinor);
        return { response: present(await tx.payHereRefundExecution.update({
          where: { id: current.id }, data: { status: 'succeeded', settlementId, updatedAt: new Date() },
        })) };
      }

      if (prior || refreshed.order.status !== 'paid' ||
        (target.requestId === null && await paymentBlocked(tx, target.booking.id, false))) throw notEligible();
      const claim = await tx.payHereRefundExecution.createMany({
        data: {
          requestId: target.requestId, damageClaimId: target.damageClaimId, arbitrationId: target.arbitrationId, orderId: order.id,
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
    await db.payHereRefundExecution.updateMany({
      where: { id: decision.row.id, status: 'uncertain', settlementId: null }, data: { ...submission, updatedAt: new Date() },
    });
    return present(await db.payHereRefundExecution.findUniqueOrThrow({ where: { id: decision.row.id } }));
  }

  async function executionById(id: string) {
    const row = await db.payHereRefundExecution.findUnique({ where: { id } });
    if (!row) throw new PublicError(404, 'PAYHERE_REFUND_NOT_FOUND', 'This PayHere refund execution is unavailable.');
    return row;
  }

  @ApiTags('PayHere sandbox refund execution')
  @ApiBearerAuth()
  @Controller()
  class PayHereRefundExecutionController {
    @Get('admin/payhere-refund-executions/:id/recovery')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ recovery: recoveryView.nullable() })) })
    async recoveryStatus(@Req() req: Request, @Param('id') rawId: string) {
      await admin(req);
      const executionId = parse(uuid, rawId);
      await executionById(executionId);
      const row = await db.payHereRefundRecovery.findUnique({ where: { executionId } });
      return { recovery: row ? presentRecovery(row) : null };
    }

    @Post('admin/payhere-refund-executions/:id/recover')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(recoveryCommand) })
    @ApiOkResponse({ schema: schema(recoveryView) })
    async recover(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      if (req.get('Origin') !== config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
      }
      const actor = await admin(req);
      profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
      const executionId = parse(uuid, rawId);
      const command = parse(recoveryCommand, raw);
      if (config.PAYHERE_SANDBOX_REFUND_EXECUTION !== 'true') {
        throw new PublicError(503, 'PAYHERE_REFUNDS_DISABLED', 'PayHere sandbox refund execution is unavailable.');
      }
      const row = await executionById(executionId);
      const key = recoveryKey(row);
      const source = await refundTarget(db, key);
      requireRecentIndependentAdmin(actor, source.booking);
      const previous = await db.payHereRefundRecovery.findUnique({ where: { executionId } });
      if (previous) return replayRecovery(previous, actor.user.id, command);
      requireUncertain(row, command.expectedUpdatedAt);
      const { order, attemptId, paymentId } = capture(source);
      if (source.payHereExecution?.id !== row.id || row.paymentId !== paymentId || row.amountMinor !== source.amountMinor) throw notEligible();

      await auth.limits.check('reconciliation-admin', actor.user.id, 10, 60);
      await auth.limits.check('reconciliation-gateway', 'payhere', 4, 10);
      const observation = await payHere.observe({ id: attemptId, amountMinor: order.amountMinor });
      const observedAt = new Date();
      if (observation.status !== 'refunded' || observation.paymentReference !== paymentId || !observation.payHereCardPayment) {
        throw new PublicError(409, 'PAYHERE_REFUND_NOT_CONFIRMED', 'PayHere must confirm this full card payment as refunded before recovery.');
      }

      return db.$transaction(async tx => {
        const currentAdmin = await profiles.actor(tx, actor, undefined, true);
        profiles.verified(currentAdmin);
        await lockBooking(tx, source.booking.id);
        await lockPaymentOrder(tx, order.id);
        const target = await refundTarget(tx, key);
        requireRecentIndependentAdmin(currentAdmin, target.booking);
        const recorded = await tx.payHereRefundRecovery.findUnique({ where: { executionId } });
        if (recorded) return replayRecovery(recorded, currentAdmin.user.id, command);
        const current = target.payHereExecution;
        const refreshed = capture(target);
        if (!current || current.id !== row.id || !target.reservationId || target.reservationId !== source.reservationId ||
          target.amountMinor !== row.amountMinor || target.reserveAmountMinor !== source.reserveAmountMinor ||
          current.amountMinor !== target.amountMinor || current.paymentId !== paymentId ||
          refreshed.order.id !== order.id || refreshed.attemptId !== attemptId || refreshed.paymentId !== paymentId) throw notEligible();
        requireUncertain(current, command.expectedUpdatedAt);
        const reserved = await findReservedFunds(tx, target.reservationId, target.reserve, target.amountMinor, target.reserveAmountMinor);
        if (!reserved) throw notEligible();
        const journalId = await settleRefund(tx, target.booking, reserved, 'payhere', 'recovery:' + current.id, current.id, current.amountMinor);
        const updated = await tx.payHereRefundExecution.updateMany({
          where: { id: current.id, status: 'uncertain', updatedAt: current.updatedAt, providerRefundId: null, settlementId: null },
          data: { status: 'succeeded', settlementId: journalId, updatedAt: new Date() },
        });
        if (updated.count !== 1) throw notEligible();
        return presentRecovery(await tx.payHereRefundRecovery.create({ data: {
          executionId, requestKey: command.requestKey, actorId: currentAdmin.user.id, reason: command.reason,
          attemptId, paymentId, amountMinor: current.amountMinor, previousUpdatedAt: current.updatedAt, observedAt, journalId,
        } }));
      });
    }

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

    @Get('admin/arbitrations/:id/items/:orderId/payhere-refund')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiParam({ name: 'orderId', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ execution: arbitrationView.nullable() })) })
    async arbitrationStatus(@Req() req: Request, @Param('id') id: string, @Param('orderId') orderId: string) {
      await admin(req);
      const target = await refundTarget(db, { arbitrationId: parse(uuid, id), orderId: parse(uuid, orderId) });
      return { execution: target.payHereExecution ? present(target.payHereExecution) : null };
    }

    @Post('admin/arbitrations/:id/items/:orderId/payhere-refund')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiParam({ name: 'orderId', format: 'uuid' })
    @ApiBody({ schema: schema(empty) })
    @ApiOkResponse({ schema: schema(arbitrationView) })
    executeArbitration(@Req() req: Request, @Param('id') id: string, @Param('orderId') orderId: string, @Body() body: unknown) {
      return runRefund(req, body, () => ({ arbitrationId: parse(uuid, id), orderId: parse(uuid, orderId) }));
    }
  }
  return PayHereRefundExecutionController;
}
