import { z } from 'zod';
import type { PaymentOrderStatus } from '../../generated/prisma/client.js';
import { stripeSession } from './stripe.js';

export const providerStatus = z.enum([
  'not_started', 'unavailable', 'not_found', 'pending', 'expired', 'captured',
  'refund_pending', 'refunded', 'chargeback', 'mismatch', 'multiple_payments',
]);

type ProviderStatus = z.infer<typeof providerStatus>;
type Observation = { status: ProviderStatus; paymentReference?: string; paymentIntentId?: string; payHereCardPayment?: true };

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
const payHereReference = z.union([z.string().regex(/^\d{1,120}$/), z.number().int().positive()]).transform(String);
const payHereCard = z.object({
  method: z.string().trim().toUpperCase().pipe(
    z.enum(['VISA', 'MASTER', 'MASTERCARD', 'AMEX', 'AMERICAN EXPRESS', 'DISCOVER', 'DINERS', 'DINERS CLUB']),
  ),
});
const payHerePayment = z.object({
  payment_id: payHereReference,
  order_id: z.string(), currency: z.literal('LKR'),
  amount: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,10}(\.\d{1,2})?$/)),
  status: z.enum(['RECEIVED', 'REFUND REQUESTED', 'REFUND PROCESSING', 'REFUNDED', 'CHARGEBACKED']),
  payment_method: z.unknown().optional(),
});

export function makePayHereSandboxClient(appId: string | undefined, appSecret: string | undefined, send = fetch) {
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

  async function merchant(url: string | URL, body?: string) {
    if (!appId || !appSecret) throw new Error('PayHere sandbox credentials unavailable.');
    if (!cached || cached.reuseUntil <= Date.now()) opening ??= openToken().finally(() => { opening = undefined; });
    const token = opening ? await opening : cached!.token;
    const response = await send(url, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(8000), body,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (response.status === 401 && cached?.token === token) cached = undefined;
    if (!response.ok) throw new Error('PayHere sandbox request failed.');
    return response.json();
  }

  async function inspect(attempt: { id: string; amountMinor: number }): Promise<Observation & { refundFields?: string[] }> {
    try {
      const url = new URL(sandbox + 'payment/search');
      url.searchParams.set('order_id', attempt.id);
      const payload = retrieval.parse(await merchant(url));
      if (payload.status !== 1) {
        if (payload.data?.length) return { status: 'mismatch' };
        if (payload.status === -1) return { status: 'not_found' };
        if (payload.status === 0) return { status: 'pending' };
        return { status: 'unavailable' };
      }
      if (!payload.data?.length) return { status: 'unavailable' };
      if (payload.data.length > 1) return { status: 'multiple_payments' };
      const record = payload.data[0];
      const payment = payHerePayment.safeParse(record);
      if (!payment.success || payment.data.order_id !== attempt.id) return { status: 'mismatch' };
      const [units, cents = ''] = payment.data.amount.split('.');
      if (Number(units) * 100 + Number(cents.padEnd(2, '0')) !== attempt.amountMinor) return { status: 'mismatch' };
      return {
        status: payHereStatus[payment.data.status], paymentReference: payment.data.payment_id,
        ...(payHereCard.safeParse(payment.data.payment_method).success ? { payHereCardPayment: true } : {}),
        refundFields: Object.keys(record as object)
          .filter(key => /^[a-z][a-z0-9_]{0,47}$/i.test(key) && /refund/i.test(key)).sort().slice(0, 20),
      };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async function observe(attempt: { id: string; amountMinor: number }): Promise<Observation> {
    const { refundFields: _, ...observation } = await inspect(attempt);
    return observation;
  }

  async function refund(paymentId: string, executionId: string, amountMinor?: number) {
    try {
      const amount = amountMinor === undefined ? undefined : z.number().int().positive().max(2_147_483_647).parse(amountMinor);
      const response = z.object({ status: z.number().int(), data: payHereReference.nullable() }).parse(
        await merchant(sandbox + 'payment/refund', JSON.stringify({
          payment_id: payHereReference.parse(paymentId),
          description: (amount === undefined ? 'StageLink booking refund ' : 'StageLink sandbox partial refund probe ') + executionId,
          ...(amount === undefined ? {} : { amount: (amount / 100).toFixed(2) }),
        })),
      );
      if (response.status === 1 && response.data) return { status: 'pending' as const, providerRefundId: response.data };
      if ((response.status === 0 || response.status === -1) && response.data === null) {
        return { status: 'failed' as const, providerRefundId: null };
      }
    } catch { /* The request may have been accepted before the response was lost. */ }
    return { status: 'uncertain' as const, providerRefundId: null };
  }

  return { inspect, observe, refund };
}
