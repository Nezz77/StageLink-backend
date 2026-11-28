import { z } from 'zod';
import { canSubmitStripeAttempt } from './stripe.js';

const refundId = z.string().max(150).regex(/^re_[A-Za-z0-9_]+$/);
const metadataField = 'stagelink_refund_execution';
const refund = z.object({
  id: refundId, object: z.literal('refund'), amount: z.number().int().positive(), currency: z.literal('lkr'),
  payment_intent: z.string(),
  metadata: z.object({ [metadataField]: z.uuid() }),
  status: z.enum(['pending', 'requires_action', 'succeeded', 'failed', 'canceled']),
});
const page = z.object({ object: z.literal('list'), has_more: z.boolean(), data: z.array(z.unknown()).max(100) });
const taggedRefund = z.object({ metadata: z.object({ [metadataField]: z.string() }).nullable() });
const api = 'https://api.stripe.com/v1/refunds';

type Execution = {
  id: string; paymentIntentId: string; amountMinor: number; providerRefundId: string | null;
  createdAt: Date; leaseUntil: Date | null;
};

function checked(raw: unknown, execution: Execution) {
  const value = refund.safeParse(raw);
  if (!value.success || value.data.metadata[metadataField] !== execution.id ||
    value.data.payment_intent !== execution.paymentIntentId || value.data.amount !== execution.amountMinor ||
    (execution.providerRefundId !== null && value.data.id !== execution.providerRefundId)) return null;
  return value.data;
}

export async function processStripeRefund(
  key: string, execution: Execution, allowSubmit: boolean, firstAttempt: boolean,
  readClock: () => Promise<Date>, send = fetch,
) {
  if (!key.startsWith('sk_test_')) return null;
  async function stripe(url: string, init?: { method: 'POST'; headers: Record<string, string>; body: URLSearchParams }) {
    const response = await send(url, {
      method: init?.method ?? 'GET', redirect: 'error', signal: AbortSignal.timeout(8000), body: init?.body,
      headers: { Authorization: 'Bearer ' + key, ...init?.headers },
    });
    if (!response.ok) throw new Error('Stripe refund request failed.');
    return response.json();
  }

  try {
    if (execution.providerRefundId) {
      return checked(await stripe(api + '/' + encodeURIComponent(execution.providerRefundId)), execution);
    }
    if (!firstAttempt) {
      const query = new URLSearchParams({ payment_intent: execution.paymentIntentId, limit: '100' });
      const refunds = page.parse(await stripe(api + '?' + query.toString()));
      const matches = refunds.data.filter(raw => taggedRefund.safeParse(raw).data?.metadata?.[metadataField] === execution.id);
      if (matches.length > 1 || refunds.has_more) return null;
      if (matches.length === 1) return checked(matches[0], execution);
    }
    if (!allowSubmit || !canSubmitStripeAttempt(execution, await readClock())) return null;
    return checked(await stripe(api, {
      method: 'POST', headers: { 'Idempotency-Key': 'stagelink-refund-' + execution.id },
      body: new URLSearchParams({
        payment_intent: execution.paymentIntentId, amount: String(execution.amountMinor),
        reason: 'requested_by_customer', ['metadata[' + metadataField + ']']: execution.id,
      }),
    }), execution);
  } catch {
    return null;
  }
}
