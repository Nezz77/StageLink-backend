import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const id = (prefix: string) => z.string().max(150).regex(new RegExp('^' + prefix + '[A-Za-z0-9_]+$'));
const replayWindowMs = 23 * 60 * 60_000;

export function canSubmitStripeAttempt(attempt: { createdAt: Date; leaseUntil: Date | null }, now: Date) {
  const age = now.getTime() - attempt.createdAt.getTime();
  return attempt.leaseUntil !== null && now < attempt.leaseUntil && age >= 0 && age < replayWindowMs;
}

export const stripeSessionReference = z.object({
  object: z.literal('checkout.session'), client_reference_id: z.string().uuid(),
});

export const stripeSession = stripeSessionReference.extend({
  id: id('cs_test_'), livemode: z.literal(false), mode: z.literal('payment'),
  amount_total: z.number().int().positive(),
  payment_intent: id('pi_').nullable().optional(),
  currency: z.literal('lkr'), expires_at: z.number().int().positive(),
  status: z.enum(['open', 'complete', 'expired']), payment_status: z.enum(['paid', 'unpaid', 'no_payment_required']),
  url: z.url().max(2048).refine(value => {
    const url = new URL(value);
    return url.origin === 'https://checkout.stripe.com' && !url.username && !url.password;
  }).nullable(),
});

export const stripeEvent = z.object({
  id: id('evt_'), object: z.literal('event'), livemode: z.literal(false),
  created: z.number().int().min(1).max(8_640_000_000_000), type: z.string().max(80),
  data: z.object({ object: z.unknown() }),
});

export function validStripeSignature(raw: Buffer, header: string, secret: string, nowSeconds: number) {
  if (header.length > 4096) return false;
  const values = header.split(',').map(part => part.trim());
  const times = values.filter(part => /^t=\d{1,12}$/.test(part));
  if (times.length !== 1) return false;
  const timestamp = times[0]!.slice(2);
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(timestamp + '.').update(raw).digest();
  return values.some(part => /^v1=[a-fA-F0-9]{64}$/.test(part) &&
    timingSafeEqual(expected, Buffer.from(part.slice(3), 'hex')));
}

type StripeCheckout = { id: string; amountMinor: number; returnUrl: string; expiresAt: Date };

export async function createStripeCheckout(secret: string, attempt: StripeCheckout, send = fetch) {
  const expiresAt = Math.floor(attempt.expiresAt.getTime() / 1000);
  const body = new URLSearchParams({
    mode: 'payment', client_reference_id: attempt.id, success_url: attempt.returnUrl, cancel_url: attempt.returnUrl,
    expires_at: String(expiresAt), 'payment_method_types[0]': 'card', 'adaptive_pricing[enabled]': 'false',
    'line_items[0][price_data][currency]': 'lkr',
    'line_items[0][price_data][unit_amount]': String(attempt.amountMinor),
    'line_items[0][price_data][product_data][name]': 'StageLink booking payment',
    'line_items[0][quantity]': '1',
  });
  const response = await send('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), body,
    headers: { Authorization: 'Bearer ' + secret, 'Idempotency-Key': 'stagelink-checkout-' + attempt.id },
  });
  if (!response.ok) throw new Error('Stripe Checkout request failed.');
  const session = stripeSession.parse(await response.json());
  if (session.client_reference_id !== attempt.id || session.amount_total !== attempt.amountMinor || session.expires_at !== expiresAt) {
    throw new Error('Stripe Checkout response differs from the payment order.');
  }
  return session;
}
