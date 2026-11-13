import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PaymentOrderStatus } from '../../generated/prisma/client.js';

const md5 = (value: string) => createHash('md5').update(value, 'utf8').digest('hex').toUpperCase();

export const payHereCheckoutUrl = 'https://sandbox.payhere.lk/pay/checkout';

export function formatPayHereAmount(minor: number) {
  return (minor / 100).toFixed(2);
}

export function checkoutHash(merchantId: string, attemptId: string, amount: string, secret: string) {
  return md5(merchantId + attemptId + amount + 'LKR' + md5(secret));
}

export const payHereNotification = z.object({
  merchant_id: z.string().regex(/^\d{1,30}$/),
  order_id: z.string().uuid(),
  payment_id: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  payhere_amount: z.string().regex(/^\d{1,8}\.\d{2}$/),
  payhere_currency: z.literal('LKR'),
  status_code: z.enum(['2', '0', '-1', '-2', '-3']),
  md5sig: z.string().regex(/^[a-fA-F0-9]{32}$/),
});

export function verifyNotification(input: z.infer<typeof payHereNotification>, merchantId: string, secret: string) {
  if (input.merchant_id !== merchantId) return false;
  const expected = md5(input.merchant_id + input.order_id + input.payhere_amount +
    input.payhere_currency + input.status_code + md5(secret));
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.md5sig, 'hex'));
}

export function notificationStatus(
  current: PaymentOrderStatus,
  statusCode: z.infer<typeof payHereNotification>['status_code'],
  expired: boolean,
): PaymentOrderStatus {
  if (statusCode === '2') return !expired && current === 'pending' ? 'paid' : 'review';
  if (statusCode === '-3') return 'review';
  if (current === 'pending' && statusCode !== '0') return statusCode === '-1' ? 'cancelled' : 'failed';
  return current;
}
