import { z } from 'zod';
import type { PaymentOrderStatus } from '../../generated/prisma/client.js';
import { stripeSession } from './stripe.js';

export const providerStatus = z.enum([
  'not_started', 'unavailable', 'not_found', 'pending', 'expired', 'captured',
  'refund_pending', 'refunded', 'chargeback', 'mismatch', 'multiple_payments',
]);

type ProviderStatus = z.infer<typeof providerStatus>;
type Observation = { status: ProviderStatus; paymentReference?: string; paymentIntentId?: string };

export function assessPayment(
  localStatus: PaymentOrderStatus, captured: boolean, localReference: string | null, observation: Observation,
) {
  switch (observation.status) {
    case 'unavailable':
    case 'not_found':
      return 'inconclusive';
    case 'mismatch':
    case 'multiple_payments':
    case 'refund_pending':
    case 'refunded':
    case 'chargeback':
      return 'needs_review';
    case 'captured':
      return captured && localStatus === 'paid' &&
        (observation.paymentReference === undefined || observation.paymentReference === localReference)
        ? 'consistent' : 'needs_review';
    case 'expired':
      return !captured && localStatus === 'cancelled' ? 'consistent' : 'needs_review';
    case 'pending':
      return !captured && localStatus === 'pending' ? 'consistent' : 'needs_review';
    case 'not_started':
      return !captured && localStatus === 'open' ? 'consistent' : 'needs_review';
  }
}

type StripeExpectation = { id: string; sessionId: string | null; amountMinor: number; expiresAt: Date };

export async function observeStripe(secret: string | undefined, attempt: StripeExpectation, send = fetch): Promise<Observation> {
  if (!secret || !attempt.sessionId) return { status: 'unavailable' };
  try {
    const id = encodeURIComponent(attempt.sessionId);
    const response = await send('https://api.stripe.com/v1/checkout/sessions/' + id, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: 'Bearer ' + secret },
    });
    if (response.status === 404) return { status: 'not_found' };
    if (!response.ok) return { status: 'unavailable' };
    const { success, data } = stripeSession.safeParse(await response.json());
    if (!success || data.id !== attempt.sessionId || data.client_reference_id !== attempt.id ||
      data.amount_total !== attempt.amountMinor || data.expires_at !== Math.floor(attempt.expiresAt.getTime() / 1000)) {
      return { status: 'mismatch' };
    }
    if (data.status === 'complete' && data.payment_status === 'paid') {
      return { status: 'captured', ...(data.payment_intent ? { paymentIntentId: data.payment_intent } : {}) };
    }
    if (data.status === 'expired' && data.payment_status === 'unpaid') return { status: 'expired' };
    if (data.payment_status === 'unpaid') return { status: 'pending' };
    return { status: 'mismatch' };
  } catch {
    return { status: 'unavailable' };
  }
}

const sandbox = 'https://sandbox.payhere.lk/merchant/v1/';
const oauthToken = z.object({
  access_token: z.string().regex(/^[A-Za-z0-9._~-]{1,512}$/), token_type: z.string().regex(/^bearer$/i),
  scope: z.literal('SANDBOX'), expires_in: z.number().int().min(1).max(86_400),
});
const retrieval = z.object({ status: z.number().int(), data: z.array(z.unknown()).nullable() });
const payHereStatus = {
  RECEIVED: 'captured',
  'REFUND REQUESTED': 'refund_pending',
  'REFUND PROCESSING': 'refund_pending',
  REFUNDED: 'refunded',
  CHARGEBACKED: 'chargeback',
} as const;
const payHerePayment = z.object({
  payment_id: z.union([z.string().regex(/^\d{1,120}$/), z.number().int().positive()]).transform(String),
  order_id: z.string(), currency: z.literal('LKR'),
  amount: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/)),
  status: z.enum(['RECEIVED', 'REFUND REQUESTED', 'REFUND PROCESSING', 'REFUNDED', 'CHARGEBACKED']),
});

export function makePayHereObserver(appId: string | undefined, appSecret: string | undefined, send = fetch) {
  let cached: { token: string; reuseUntil: number } | undefined;
  let opening: Promise<string> | undefined;

  async function openToken() {
    const response = await send(sandbox + 'oauth/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: {
        Authorization: 'Basic ' + Buffer.from(appId + ':' + appSecret, 'utf8').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    if (!response.ok) throw new Error('PayHere sandbox authentication failed.');
    const result = oauthToken.parse(await response.json());
    cached = { token: result.access_token, reuseUntil: Date.now() + Math.max(0, result.expires_in - 10) * 1000 };
    return cached.token;
  }

  return async function observePayHere(attempt: { id: string; amountMinor: number }): Promise<Observation> {
    if (!appId || !appSecret) return { status: 'unavailable' };
    try {
      if (!cached || cached.reuseUntil <= Date.now()) opening ??= openToken().finally(() => { opening = undefined; });
      const token = opening ? await opening : cached!.token;
      const url = new URL(sandbox + 'payment/search');
      url.searchParams.set('order_id', attempt.id);
      const response = await send(url, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Authorization: 'Bearer ' + token },
      });
      if (response.status === 401 && cached?.token === token) cached = undefined;
      if (!response.ok) return { status: 'unavailable' };
      const payload = retrieval.parse(await response.json());
      if (payload.status !== 1) {
        if (payload.data?.length) return { status: 'mismatch' };
        if (payload.status === -1) return { status: 'not_found' };
        if (payload.status === 0) return { status: 'pending' };
        return { status: 'unavailable' };
      }
      if (!payload.data?.length) return { status: 'unavailable' };
      if (payload.data.length > 1) return { status: 'multiple_payments' };
      const payment = payHerePayment.safeParse(payload.data[0]);
      if (!payment.success || payment.data.order_id !== attempt.id) return { status: 'mismatch' };
      const [units, cents = ''] = payment.data.amount.split('.');
      if (Number(units) * 100 + Number(cents.padEnd(2, '0')) !== attempt.amountMinor) return { status: 'mismatch' };
      return { status: payHereStatus[payment.data.status], paymentReference: payment.data.payment_id };
    } catch {
      return { status: 'unavailable' };
    }
  };
}
