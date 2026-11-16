import { z } from 'zod';
import { observeStripe } from './reconciliation.js';
import { stripeAccountId } from './stripe-capabilities.js';

const stripe = 'https://api.stripe.com/v1/';
const transferId = z.string().max(150).regex(/^tr_[A-Za-z0-9_]+$/);
const transfer = z.object({
  id: transferId, object: z.literal('transfer'), livemode: z.literal(false), currency: z.literal('lkr'),
  amount: z.number().int().positive(), destination: stripeAccountId,
  transfer_group: z.string(), metadata: z.object({ stagelink_payout_transfer: z.uuid() }),
  reversed: z.boolean(), amount_reversed: z.number().int().nonnegative(),
}).refine(value => value.amount_reversed <= value.amount && value.reversed === (value.amount_reversed === value.amount));
const page = z.object({ object: z.literal('list'), has_more: z.boolean(), data: z.array(z.unknown()).max(2) });
const paymentIntent = z.object({
  object: z.literal('payment_intent'), id: z.string(), livemode: z.literal(false), currency: z.literal('lkr'),
  amount_received: z.number().int().positive(), status: z.literal('succeeded'),
  latest_charge: z.object({
    object: z.literal('charge'), payment_intent: z.string(), livemode: z.literal(false), currency: z.literal('lkr'),
    paid: z.literal(true), captured: z.literal(true), disputed: z.literal(false),
    amount_captured: z.number().int().positive(), amount_refunded: z.literal(0),
  }),
});
const replayWindowMs = 23 * 60 * 60_000;
export const stripeTransferRejection = z.object({
  code: z.literal('balance_insufficient'),
  requestId: z.string().max(150).regex(/^req_[A-Za-z0-9_]+$/),
});
const insufficientBalance = z.object({
  error: stripeTransferRejection.pick({ code: true }).extend({ type: z.literal('invalid_request_error') }),
});

type Capture = Parameters<typeof observeStripe>[1];
type Transfer = { id: string; amountMinor: number; providerTransferId: string | null; createdAt: Date; stripeAccountId: string };

function request(
  key: string, path: string, send: typeof fetch,
  post?: { body: URLSearchParams; idempotencyKey: string },
): Promise<Response> {
  if (!key.startsWith('sk_test_')) throw new Error('A Stripe test key is required.');
  return send(stripe + path, {
    method: post ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(8000), body: post?.body,
    headers: { Authorization: 'Bearer ' + key, ...(post ? { 'Idempotency-Key': post.idempotencyKey } : {}) },
  });
}

async function get(key: string, path: string, send: typeof fetch): Promise<unknown> {
  const response = await request(key, path, send);
  if (!response.ok) throw new Error('Stripe test transfer request failed.');
  return response.json();
}

export async function verifyStripeTransferCapture(key: string, attempt: Capture, send = fetch) {
  if (!key.startsWith('sk_test_')) return false;
  const observed = await observeStripe(key, attempt, send);
  if (observed.status !== 'captured' || !observed.paymentIntentId) return false;
  try {
    const id = observed.paymentIntentId;
    const raw = await get(key, 'payment_intents/' + encodeURIComponent(id) + '?expand%5B%5D=latest_charge', send);
    const data = paymentIntent.parse(raw);
    return data.id === id && data.latest_charge.payment_intent === id &&
      data.amount_received === attempt.amountMinor && data.latest_charge.amount_captured === attempt.amountMinor;
  } catch { return false; }
}

export async function processStripePayoutTransfer(
  key: string, expected: Transfer, submission: 'first' | 'retry' | false, send = fetch,
) {
  const group = 'stagelink_payout_' + expected.id;
  function match(raw: unknown) {
    const { success, data } = transfer.safeParse(raw);
    if (!success || data.transfer_group !== group || data.metadata.stagelink_payout_transfer !== expected.id ||
      data.destination !== expected.stripeAccountId || data.amount !== expected.amountMinor ||
      (expected.providerTransferId && data.id !== expected.providerTransferId)) return null;
    return { id: data.id, reversedMinor: data.amount_reversed };
  }
  try {
    if (expected.providerTransferId) {
      if (!transferId.safeParse(expected.providerTransferId).success) return null;
      return match(await get(key, 'transfers/' + expected.providerTransferId, send));
    }
    if (submission !== 'first') {
      const query = new URLSearchParams({ destination: expected.stripeAccountId, transfer_group: group, limit: '2' });
      const data = page.parse(await get(key, 'transfers?' + query.toString(), send));
      if (data.has_more || data.data.length > 1) return null;
      if (data.data.length === 1) return match(data.data[0]);
    }
    if (!submission || Date.now() - expected.createdAt.getTime() >= replayWindowMs) return null;
    const body = new URLSearchParams({
      amount: String(expected.amountMinor), currency: 'lkr', destination: expected.stripeAccountId,
      transfer_group: group, source_type: 'card', 'metadata[stagelink_payout_transfer]': expected.id,
    });
    const response = await request(key, 'transfers', send, { body, idempotencyKey: 'stagelink-payout-' + expected.id });
    if (response.ok) return match(await response.json());
    // A rejection on replay cannot resolve a previous response that was never received.
    if (submission !== 'first' || ![400, 402].includes(response.status) ||
      response.headers.get('Idempotent-Replayed') === 'true' || response.headers.get('Stripe-Should-Retry') === 'true') return null;
    const error = insufficientBalance.parse(await response.json()).error;
    const rejection = stripeTransferRejection.parse({ code: error.code, requestId: response.headers.get('Request-Id') });
    return { rejection };
  } catch { return null; }
}
