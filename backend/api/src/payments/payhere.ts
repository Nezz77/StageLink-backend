import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Config } from '../../../shared/config.js';
import { databaseNow } from '../../../shared/database-clock.js';
import { checkoutHash, formatPayHereAmount, notificationStatus, payHereCheckoutUrl, payHereNotification, verifyNotification } from '../../../shared/payments/payhere.js';
import type { AuthService } from '../auth/service.js';
import { checkoutExpiry, lockBooking, paidAdvance, paymentBlocked } from '../bookings/lifecycle.js';
import { PublicError } from '../auth/errors.js';
import { lockPaymentOrder, recordCapture, updatePaymentStatus } from './capture.js';
import { parse, paymentAccess, readOrder, schema, uuid } from './orders.js';

const billing = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  phone: z.string().trim().regex(/^\+?[0-9][0-9 ()-]{5,24}[0-9]$/),
  address: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  country: z.string().trim().min(2).max(80),
}).strict();
const checkout = z.object({
  action: z.literal(payHereCheckoutUrl), method: z.literal('POST'), expiresAt: z.iso.datetime(),
  fields: z.object({
    merchant_id: z.string(), order_id: uuid, amount: z.string(), currency: z.literal('LKR'), hash: z.string(),
    items: z.string(), return_url: z.string(), cancel_url: z.string(), notify_url: z.string(),
    first_name: z.string(), last_name: z.string(), email: z.email(), phone: z.string(),
    address: z.string(), city: z.string(), country: z.string(),
  }),
});
const acknowledged = z.object({ received: z.literal(true) });
const attemptLifetimeMs = 15 * 60_000;

function settings(config: Config) {
  const { PAYHERE_SANDBOX_MERCHANT_ID: merchantId, PAYHERE_SANDBOX_MERCHANT_SECRET: secret, PAYHERE_SANDBOX_NOTIFY_URL: notifyUrl } = config;
  if (!merchantId || !secret || !notifyUrl) throw new PublicError(503, 'PAYHERE_UNAVAILABLE', 'PayHere sandbox checkout is unavailable.');
  return { merchantId, secret, notifyUrl };
}

export function makePayHereController(auth: AuthService) {
  const db = auth.deps.db;
  const access = paymentAccess(auth);

  @ApiTags('PayHere sandbox')
  @Controller()
  class PayHereController {
    @Post('payment-orders/:id/sessions')
    @HttpCode(200)
    @ApiBearerAuth()
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(billing) })
    @ApiOkResponse({ schema: schema(checkout) })
    createSession(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const orderId = parse(uuid, id);
      const details = parse(billing, body);
      return access.write(req, async (tx, actor) => {
        const config = settings(auth.config);
        const { booking } = await readOrder(tx, orderId, actor.user.id);
        if (booking.customerId !== actor.user.id) throw new PublicError(403, 'PAYMENT_CUSTOMER_REQUIRED', 'Only the booking customer can start checkout.');
        await lockBooking(tx, booking.id);
        await lockPaymentOrder(tx, orderId);
        const order = await tx.paymentOrder.findUniqueOrThrow({
          where: { id: orderId }, include: {
            booking: { select: { id: true, agreedAt: true, startsAt: true } },
            payhereAttempt: true, stripeAttempt: { select: { id: true } },
          },
        });
        const now = await databaseNow(tx);
        if (order.stripeAttempt) throw new PublicError(409, 'CHECKOUT_GATEWAY_SELECTED', 'This order already has a Stripe checkout.');
        const expiresAt = await checkoutExpiry(tx, order.booking, order.purpose, now, attemptLifetimeMs);
        if (!expiresAt || !['open', 'pending'].includes(order.status)) {
          throw new PublicError(409, 'CHECKOUT_NOT_ELIGIBLE', 'This order is unavailable for checkout.');
        }
        if (order.payhereAttempt && order.payhereAttempt.expiresAt <= now) {
          throw new PublicError(409, 'CHECKOUT_EXPIRED', 'This checkout expired. Its provider outcome must be reconciled before retrying.');
        }
        const attempt = order.payhereAttempt ?? await tx.payHereAttempt.create({
          data: {
            orderId, createdAt: now, expiresAt,
          },
        });
        if (order.status === 'open') await tx.paymentOrder.update({ where: { id: orderId }, data: { status: 'pending' } });
        const amount = formatPayHereAmount(order.amountMinor);
        const redirect = new URL(auth.config.WEB_ORIGIN);
        redirect.searchParams.set('paymentOrder', orderId);
        return {
          action: payHereCheckoutUrl, method: 'POST', expiresAt: attempt.expiresAt.toISOString(),
          fields: {
            merchant_id: config.merchantId, order_id: attempt.id, amount, currency: 'LKR',
            hash: checkoutHash(config.merchantId, attempt.id, amount, config.secret),
            items: 'StageLink ' + order.purpose + ' ' + order.id,
            return_url: redirect.href, cancel_url: redirect.href, notify_url: config.notifyUrl,
            first_name: details.firstName, last_name: details.lastName, email: actor.user.email,
            phone: details.phone, address: details.address, city: details.city, country: details.country,
          },
        };
      });
    }

    @Post('payments/webhooks/payhere')
    @HttpCode(200)
    @ApiConsumes('application/x-www-form-urlencoded')
    @ApiBody({ schema: schema(payHereNotification) })
    @ApiOkResponse({ schema: schema(acknowledged) })
    notify(@Req() req: Request, @Body() body: unknown) {
      if (!req.is('application/x-www-form-urlencoded')) {
        throw new PublicError(415, 'UNSUPPORTED_PAYMENT_EVENT', 'Use the PayHere notification content type.');
      }
      const config = settings(auth.config);
      const event = parse(payHereNotification, body);
      if (!verifyNotification(event, config.merchantId, config.secret)) {
        throw new PublicError(401, 'INVALID_PAYMENT_SIGNATURE', 'The payment notification could not be verified.');
      }

      return db.$transaction(async tx => {
        const attempt = await tx.payHereAttempt.findUnique({ where: { id: event.order_id }, include: { order: { select: { bookingId: true } } } });
        if (!attempt) throw new PublicError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', 'This payment attempt is unavailable.');
        await lockBooking(tx, attempt.order.bookingId);
        await lockPaymentOrder(tx, attempt.orderId);
        const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: attempt.orderId } });
        const receivedAmount = Number(event.payhere_amount.replace('.', ''));
        if (receivedAmount !== order.amountMinor || order.currency !== event.payhere_currency) {
          throw new PublicError(409, 'PAYMENT_AMOUNT_MISMATCH', 'The provider amount or currency differs from this order.');
        }

        const key = { attemptId: attempt.id, statusCode: event.status_code };
        const existing = await tx.payHereEvent.findUnique({ where: { attemptId_statusCode: key } });
        if (existing) {
          // PayHere's checksum omits payment_id. A changed ID cannot justify a second credit.
          if (event.status_code === '2' && existing.reportedPaymentId !== event.payment_id && order.status !== 'review') {
            await updatePaymentStatus(tx, order, 'review');
          }
          return { received: true };
        }

        const now = await databaseNow(tx);
        const captureNeedsReview = event.status_code === '2' && (
          await paymentBlocked(tx, order.bookingId) ||
          (order.purpose === 'balance' && !await paidAdvance(tx, order.bookingId))
        );
        const status = notificationStatus(order.status, event.status_code, attempt.expiresAt <= now || captureNeedsReview);
        let journalId: string | undefined;
        if (event.status_code === '2') {
          journalId = await recordCapture(tx, order, 'payhere', attempt.id, status === 'paid' ? 'paid' : 'review', now);
        }
        await tx.payHereEvent.create({ data: { ...key, reportedPaymentId: event.payment_id, receivedAt: now, journalId } });
        await updatePaymentStatus(tx, order, status);
        return { received: true };
      });
    }
  }
  return PayHereController;
}
