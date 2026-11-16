import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { PaymentRecoveryAction, Prisma } from '../../../generated/prisma/client.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { lockBooking } from '../bookings/lifecycle.js';
import { ProfileService } from '../profiles/service.js';
import { assessPayment, makePayHereObserver, observeStripe, providerStatus } from '../../../shared/payments/reconciliation.js';
import { lockPaymentOrder, recordCapture, updatePaymentStatus } from './capture.js';
import { parse, schema, uuid } from './orders.js';

const gateway = z.enum(['stripe', 'payhere']);
const status = z.enum(['open', 'pending', 'failed', 'cancelled', 'paid', 'review']);
const outcome = z.enum(['captured', 'expired']);
const reason = z.string().trim().min(10).max(500);
const result = z.object({
  orderId: uuid, gateway: gateway.nullable(), localStatus: status, localCaptureRecorded: z.boolean(),
  providerStatus, assessment: z.enum(['consistent', 'needs_review', 'inconclusive']), checkedAt: z.iso.datetime(),
});
const recoveryCommand = z.object({ requestKey: uuid, expectedOutcome: outcome, reason }).strict();
const recoveryResult = z.object({
  id: uuid, orderId: uuid, actorId: uuid, gateway, reason, previousStatus: status, outcome,
  journalId: uuid.nullable(), observedAt: z.iso.datetime(), createdAt: z.iso.datetime(),
});

const relations = {
  stripeAttempt: { select: { id: true, sessionId: true, expiresAt: true, journalId: true } },
  payhereAttempt: { select: {
    id: true, events: { where: { statusCode: '2' }, select: { journalId: true, reportedPaymentId: true } },
  } },
} satisfies Prisma.PaymentOrderInclude;
type Order = Prisma.PaymentOrderGetPayload<{ include: typeof relations }>;

function present(row: PaymentRecoveryAction) {
  const { id, orderId, actorId, gateway, reason, previousStatus, outcome, journalId, observedAt, createdAt } = row;
  return {
    id, orderId, actorId, gateway, reason, previousStatus, outcome, journalId,
    observedAt: observedAt.toISOString(), createdAt: createdAt.toISOString(),
  };
}

function gatewayFor(order: Order) {
  return order.stripeAttempt ? 'stripe' : order.payhereAttempt ? 'payhere' : null;
}

function sameProviderReference(before: Order, current: Order) {
  return before.bookingId === current.bookingId && before.currency === current.currency &&
    before.amountMinor === current.amountMinor && before.purpose === current.purpose &&
    before.stripeAttempt?.id === current.stripeAttempt?.id &&
    before.stripeAttempt?.sessionId === current.stripeAttempt?.sessionId &&
    before.stripeAttempt?.expiresAt.getTime() === current.stripeAttempt?.expiresAt.getTime() &&
    before.payhereAttempt?.id === current.payhereAttempt?.id;
}

async function checkout(tx: Prisma.TransactionClient, id: string) {
  const order = await tx.paymentOrder.findUnique({ where: { id }, include: relations });
  if (!order) throw new PublicError(404, 'PAYMENT_ORDER_NOT_FOUND', 'This payment order is unavailable.');
  if (order.stripeAttempt && order.payhereAttempt) {
    throw new PublicError(409, 'PAYMENT_GATEWAY_CONFLICT', 'This order needs manual review for conflicting checkout attempts.');
  }
  return order;
}

function unavailableRecovery() {
  return new PublicError(409, 'PAYMENT_RECOVERY_NOT_ELIGIBLE', 'This outcome requires manual review or has already been recorded.');
}

export function makePaymentReconciliationController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const config = auth.config;
  const payHere = makePayHereObserver(config.PAYHERE_SANDBOX_RETRIEVAL_APP_ID, config.PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET);

  async function assertAdmin(req: Request) {
    const actor = await auth.authenticate(req.get('Authorization'));
    if (actor.session.activeRole !== 'admin') {
      throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    }
    profiles.verified(actor);
    return actor;
  }

  async function observe(order: Order, adminId: string) {
    const provider = gatewayFor(order);
    if (!provider) return { status: 'not_started' as const };
    await auth.limits.check('reconciliation-admin', adminId, 10, 60);
    await auth.limits.check('reconciliation-gateway', provider, 4, 10);
    if (order.currency !== 'LKR') return { status: 'mismatch' as const };
    if (order.stripeAttempt) {
      return observeStripe(config.STRIPE_TEST_SECRET_KEY, { ...order.stripeAttempt, amountMinor: order.amountMinor });
    }
    return payHere({ id: order.payhereAttempt!.id, amountMinor: order.amountMinor });
  }

  async function prior(
    tx: Prisma.TransactionClient, orderId: string, actorId: string, command: z.infer<typeof recoveryCommand>,
  ) {
    const row = await tx.paymentRecoveryAction.findUnique({
      where: { orderId_requestKey: { orderId, requestKey: command.requestKey } },
    });
    if (!row) return null;
    if (row.actorId !== actorId || row.outcome !== command.expectedOutcome || row.reason !== command.reason) {
      throw new PublicError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different recovery.');
    }
    return present(row);
  }

  @ApiTags('Payment reconciliation')
  @ApiBearerAuth()
  @Controller('admin/payment-orders')
  class PaymentReconciliationController {
    @Get(':id/reconciliation')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(result) })
    async check(@Req() req: Request, @Param('id') rawId: string) {
      const actor = await assertAdmin(req);
      const orderId = parse(uuid, rawId);
      const order = await checkout(db, orderId);
      const observed = await observe(order, actor.user.id);
      await assertAdmin(req);
      const current = await checkout(db, orderId);
      const localPayHere = current.payhereAttempt?.events[0];
      const localCaptureRecorded = Boolean(current.stripeAttempt?.journalId || localPayHere?.journalId);
      const evidence = sameProviderReference(order, current) ? observed : { status: 'unavailable' as const };
      return {
        orderId, gateway: gatewayFor(current), localStatus: current.status, localCaptureRecorded,
        providerStatus: evidence.status,
        assessment: assessPayment(current.status, localCaptureRecorded, localPayHere?.reportedPaymentId ?? null, evidence),
        checkedAt: new Date().toISOString(),
      };
    }

    @Get(':id/reconciliation/recoveries')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ items: z.array(recoveryResult) })) })
    async history(@Req() req: Request, @Param('id') rawId: string) {
      await assertAdmin(req);
      const orderId = parse(uuid, rawId);
      await checkout(db, orderId);
      const actions = await db.paymentRecoveryAction.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' }, take: 20 });
      return { items: actions.map(present) };
    }

    @Post(':id/reconciliation/recover')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(recoveryCommand) })
    @ApiOkResponse({ schema: schema(recoveryResult) })
    async recover(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      if (req.get('Origin') !== config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
      }
      const actor = await assertAdmin(req);
      profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
      const orderId = parse(uuid, rawId);
      const command = parse(recoveryCommand, raw);
      const previous = await prior(db, orderId, actor.user.id, command);
      if (previous) return previous;

      const order = await checkout(db, orderId);
      const observed = await observe(order, actor.user.id);
      const observedAt = new Date();
      if (observed.status !== command.expectedOutcome) throw unavailableRecovery();

      return db.$transaction(async tx => {
        const admin = await profiles.actor(tx, actor, undefined, true);
        profiles.verified(admin);
        await lockBooking(tx, order.bookingId);
        await lockPaymentOrder(tx, order.id);
        const duplicate = await prior(tx, orderId, admin.user.id, command);
        if (duplicate) return duplicate;
        const current = await checkout(tx, orderId);
        const stripe = current.stripeAttempt;
        const payhere = current.payhereAttempt;
        const provider = gatewayFor(current);
        const attemptId = stripe?.id ?? payhere?.id;
        const reference = stripe?.sessionId ?? ('paymentReference' in observed ? observed.paymentReference : undefined);
        if (!provider || !attemptId || !reference || !sameProviderReference(order, current) ||
          stripe?.journalId || payhere?.events.length || current.status === 'paid' || current.status === 'open') {
          throw unavailableRecovery();
        }

        let journalId: string | null = null;
        if (observed.status === 'captured') {
          journalId = await recordCapture(tx, current, provider, stripe?.sessionId ?? attemptId, 'review', observedAt);
          if (stripe) {
            await tx.stripeAttempt.update({ where: { id: attemptId }, data: { journalId, checkoutUrl: null } });
          } else {
            await tx.payHereEvent.create({
              data: { attemptId, statusCode: '2', reportedPaymentId: reference, journalId, source: 'retrieval' },
            });
          }
          await updatePaymentStatus(tx, current, 'review');
        } else {
          if (!stripe || current.status !== 'pending') throw unavailableRecovery();
          await tx.stripeAttempt.update({ where: { id: attemptId }, data: { checkoutUrl: null } });
          await updatePaymentStatus(tx, current, 'cancelled');
        }

        return present(await tx.paymentRecoveryAction.create({
          data: {
            orderId, actorId: admin.user.id, requestKey: command.requestKey, gateway: provider, attemptId,
            providerReference: reference, reason: command.reason, previousStatus: current.status,
            outcome: command.expectedOutcome, journalId, observedAt,
          },
        }));
      });
    }
  }
  return PaymentReconciliationController;
}
