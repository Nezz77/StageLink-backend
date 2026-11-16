import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { assessPayment, makePayHereObserver, observeStripe, providerStatus } from '../../../shared/payments/reconciliation.js';
import { parse, schema, uuid } from './orders.js';

const result = z.object({
  orderId: uuid,
  gateway: z.enum(['stripe', 'payhere']).nullable(),
  localStatus: z.enum(['open', 'pending', 'failed', 'cancelled', 'paid', 'review']),
  localCaptureRecorded: z.boolean(),
  providerStatus,
  assessment: z.enum(['consistent', 'needs_review', 'inconclusive']),
  checkedAt: z.iso.datetime(),
});

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

  async function checkout(id: string) {
    const order = await db.paymentOrder.findUnique({
      where: { id },
      select: {
        status: true, amountMinor: true,
        stripeAttempt: { select: { id: true, sessionId: true, expiresAt: true, journalId: true } },
        payhereAttempt: { select: {
          id: true, events: { where: { statusCode: '2' }, select: { journalId: true, reportedPaymentId: true } },
        } },
      },
    });
    if (!order) throw new PublicError(404, 'PAYMENT_ORDER_NOT_FOUND', 'This payment order is unavailable.');
    if (order.stripeAttempt && order.payhereAttempt) {
      throw new PublicError(409, 'PAYMENT_GATEWAY_CONFLICT', 'This order needs manual review for conflicting checkout attempts.');
    }
    return order;
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
      const order = await checkout(orderId);
      const gateway = order.stripeAttempt ? 'stripe' : order.payhereAttempt ? 'payhere' : null;
      if (gateway) {
        await auth.limits.check('reconciliation-admin', actor.user.id, 10, 60);
        await auth.limits.check('reconciliation-gateway', gateway, 4, 10);
      }
      const observed = order.stripeAttempt
        ? await observeStripe(config.STRIPE_TEST_SECRET_KEY, { ...order.stripeAttempt, amountMinor: order.amountMinor })
        : order.payhereAttempt
          ? await payHere({ id: order.payhereAttempt.id, amountMinor: order.amountMinor })
          : { status: 'not_started' as const };
      await assertAdmin(req);
      const current = await checkout(orderId);
      const localPayHere = current.payhereAttempt?.events[0];
      const localCaptureRecorded = Boolean(current.stripeAttempt?.journalId || localPayHere?.journalId);
      const sameReference = order.stripeAttempt?.sessionId === current.stripeAttempt?.sessionId &&
        order.payhereAttempt?.id === current.payhereAttempt?.id && order.stripeAttempt?.id === current.stripeAttempt?.id;
      const evidence = sameReference ? observed : { status: 'unavailable' as const };
      return {
        orderId, gateway: current.stripeAttempt ? 'stripe' : current.payhereAttempt ? 'payhere' : null, localStatus: current.status, localCaptureRecorded,
        providerStatus: evidence.status,
        assessment: assessPayment(current.status, localCaptureRecorded, localPayHere?.reportedPaymentId ?? null, evidence),
        checkedAt: new Date().toISOString(),
      };
    }
  }
  return PaymentReconciliationController;
}
