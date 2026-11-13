import { Body, Controller, HttpCode, Param, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { Config } from '../../../shared/config.js';
import { openAccount, postJournal } from '../../../shared/payments/journal.js';
import { createStripeCheckout, stripeEvent, stripeSession, stripeSessionReference, validStripeSignature } from '../../../shared/payments/stripe.js';
import { checkoutExpiry, lockBooking, paidAdvance, paymentBlocked } from '../bookings/lifecycle.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, paymentAccess, readOrder, schema, uuid } from './orders.js';

const empty = z.object({}).strict();
const checkout = z.object({ url: z.url(), expiresAt: z.iso.datetime() });
const acknowledged = z.object({ received: z.literal(true) });
const eventTypes = new Set([
  'checkout.session.completed', 'checkout.session.expired',
  'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
]);
const checkoutLifetimeMs = 35 * 60_000;
const minimumLifetimeMs = 30 * 60_000;

function settings(config: Config) {
  const { STRIPE_TEST_SECRET_KEY: key, STRIPE_TEST_WEBHOOK_SECRET: signingSecret } = config;
  if (!key || !signingSecret) throw new PublicError(503, 'STRIPE_UNAVAILABLE', 'Stripe test checkout is unavailable.');
  return { key, signingSecret };
}

async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw`SELECT id FROM payment_orders WHERE id=${orderId}::uuid FOR UPDATE`;
}

function checkoutUnavailable(): never {
  throw new PublicError(409, 'CHECKOUT_NOT_ELIGIBLE', 'This order is unavailable for Stripe checkout.');
}

export function makeStripeController(auth: AuthService) {
  const db = auth.deps.db;
  const access = paymentAccess(auth);

  @ApiTags('Stripe test checkout')
  @Controller()
  class StripeController {
    @Post('payment-orders/:id/sessions/stripe')
    @HttpCode(200)
    @ApiBearerAuth()
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(empty) })
    @ApiOkResponse({ schema: schema(checkout) })
    async createSession(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const orderId = parse(uuid, id);
      parse(empty, body);
      const config = settings(auth.config);
      const { attempt, amountMinor, bookingId } = await access.write(req, async (tx, actor) => {
        const { booking } = await readOrder(tx, orderId, actor.user.id);
        if (booking.customerId !== actor.user.id) {
          throw new PublicError(403, 'PAYMENT_CUSTOMER_REQUIRED', 'Only the booking customer can start checkout.');
        }
        await lockBooking(tx, booking.id);
        await lockOrder(tx, orderId);
        const order = await tx.paymentOrder.findUniqueOrThrow({
          where: { id: orderId }, include: { stripeAttempt: true, payhereAttempt: { select: { id: true } } },
        });
        if (order.payhereAttempt) throw new PublicError(409, 'CHECKOUT_GATEWAY_SELECTED', 'This order already has a PayHere checkout.');
        const now = new Date();
        const deadline = await checkoutExpiry(tx, booking, order.purpose, now, checkoutLifetimeMs);
        if (!deadline || !['open', 'pending'].includes(order.status)) checkoutUnavailable();
        if (order.stripeAttempt) {
          if (order.stripeAttempt.expiresAt <= now) checkoutUnavailable();
          return { attempt: order.stripeAttempt, amountMinor: order.amountMinor, bookingId: booking.id };
        }

        const expiresAt = new Date(Math.floor(deadline.getTime() / 1000) * 1000);
        if (expiresAt.getTime() - now.getTime() <= minimumLifetimeMs + 8000) checkoutUnavailable();
        const redirect = new URL(auth.config.WEB_ORIGIN);
        redirect.searchParams.set('paymentOrder', orderId);
        const attempt = await tx.stripeAttempt.create({
          data: { orderId, createdAt: now, expiresAt, returnUrl: redirect.href },
        });
        await tx.paymentOrder.update({ where: { id: orderId }, data: { status: 'pending' } });
        return { attempt, amountMinor: order.amountMinor, bookingId: booking.id };
      });
      if (attempt.checkoutUrl) return { url: attempt.checkoutUrl, expiresAt: attempt.expiresAt.toISOString() };

      // Retry the exact request with the same Stripe idempotency key after an ambiguous network response.
      let session;
      try { session = await createStripeCheckout(config.key, { ...attempt, amountMinor }); }
      catch { throw new PublicError(503, 'STRIPE_CHECKOUT_UNAVAILABLE', 'Stripe checkout could not be opened. Retry this order.'); }

      const checkoutSession = await db.$transaction(async tx => {
        await lockBooking(tx, bookingId);
        await lockOrder(tx, orderId);
        const current = await tx.stripeAttempt.findUniqueOrThrow({ where: { id: attempt.id }, include: { order: true } });
        if (current.sessionId && current.sessionId !== session.id) {
          throw new PublicError(409, 'STRIPE_SESSION_MISMATCH', 'This checkout needs reconciliation.');
        }
        const available = current.order.status === 'pending' && session.status === 'open' &&
          current.expiresAt > new Date() && !await paymentBlocked(tx, bookingId) &&
          (current.order.purpose !== 'balance' || await paidAdvance(tx, bookingId));
        const url = available ? session.url : null;
        if (current.sessionId !== session.id || current.checkoutUrl !== url) {
          await tx.stripeAttempt.update({
            where: { id: attempt.id }, data: { sessionId: session.id, checkoutUrl: url },
          });
        }
        return url ? { url, expiresAt: current.expiresAt.toISOString() } : null;
      });
      if (!checkoutSession) checkoutUnavailable();
      return checkoutSession;
    }

    @Post('payments/webhooks/stripe')
    @HttpCode(200)
    @ApiConsumes('application/json')
    @ApiOkResponse({ schema: schema(acknowledged) })
    notify(@Req() req: RawBodyRequest<Request>, @Body() body: unknown) {
      if (!req.is('application/json')) throw new PublicError(415, 'UNSUPPORTED_PAYMENT_EVENT', 'Use JSON for Stripe events.');
      const config = settings(auth.config);
      if (!req.rawBody || !validStripeSignature(req.rawBody, req.get('Stripe-Signature') ?? '', config.signingSecret, Math.floor(Date.now() / 1000))) {
        throw new PublicError(401, 'INVALID_PAYMENT_SIGNATURE', 'The payment notification could not be verified.');
      }
      const event = parse(stripeEvent, body);
      if (!eventTypes.has(event.type)) return { received: true };
      const reference = stripeSessionReference.safeParse(event.data.object);
      if (!reference.success) return { received: true };
      return db.$transaction(async tx => {
        // A Stripe account can also emit Checkout events for other integrations.
        const attempt = await tx.stripeAttempt.findUnique({ where: { id: reference.data.client_reference_id }, include: { order: { select: { bookingId: true } } } });
        if (!attempt) return { received: true };
        const session = parse(stripeSession, event.data.object);
        const captured = (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') &&
          session.status === 'complete' && session.payment_status === 'paid';
        await lockBooking(tx, attempt.order.bookingId);
        await lockOrder(tx, attempt.orderId);
        const current = await tx.stripeAttempt.findUniqueOrThrow({ where: { id: attempt.id }, include: { order: true } });
        const { order } = current;
        if ((current.sessionId && current.sessionId !== session.id) ||
          order.amountMinor !== session.amount_total || order.currency !== 'LKR' ||
          Math.floor(current.expiresAt.getTime() / 1000) !== session.expires_at) {
          throw new PublicError(409, 'STRIPE_SESSION_MISMATCH', 'The provider session differs from this payment order.');
        }
        const seen = await tx.stripeEvent.createMany({
          data: { id: event.id, attemptId: attempt.id, eventType: event.type, createdAt: new Date(event.created * 1000) },
          skipDuplicates: true,
        });
        if (!seen.count) return { received: true };

        let status = order.status;
        let journalId = current.journalId;
        if (captured && !journalId) {
          const captureNeedsReview = await paymentBlocked(tx, order.bookingId) ||
            (order.purpose === 'balance' && !await paidAdvance(tx, order.bookingId));
          status = event.created * 1000 >= current.expiresAt.getTime() || order.status !== 'pending' || captureNeedsReview ? 'review' : 'paid';
          const fund = { currency: order.currency, purpose: order.purpose === 'deposit' ? 'deposit' as const : 'service' as const };
          const clearing = await openAccount(tx, { ...fund, scope: 'gateway:stripe:test', kind: 'clearing' });
          const destination = await openAccount(tx, {
            ...fund, scope: status === 'paid' ? 'sandbox:booking:' + order.bookingId : 'sandbox:review:' + order.id,
            kind: 'available',
          });
          journalId = await postJournal(tx, { ...fund, source: 'stripe.test.capture', reference: session.id }, [
            { accountId: clearing.id, amountMinor: -BigInt(order.amountMinor) },
            { accountId: destination.id, amountMinor: BigInt(order.amountMinor) },
          ]);
        } else if (!journalId && status === 'pending' && event.type === 'checkout.session.expired' && session.status === 'expired') {
          status = 'cancelled';
        } else if (!journalId && status === 'pending' && event.type === 'checkout.session.async_payment_failed') {
          status = 'failed';
        }
        await tx.stripeAttempt.update({ where: { id: attempt.id }, data: { sessionId: session.id, journalId } });
        if (status !== order.status) await tx.paymentOrder.update({ where: { id: order.id }, data: { status } });
        return { received: true };
      });
    }
  }
  return StripeController;
}
