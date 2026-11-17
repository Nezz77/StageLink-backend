import { z } from 'zod';
import { readStripeTestPlatform, stripeAccountId } from './stripe-capabilities.js';
import { retrieveStripePayoutTransferPayment } from './stripe-transfers.js';

export const stripeBankPayoutId = z.string().max(150).regex(/^po_[A-Za-z0-9_]+$/);
const transactionId = z.string().max(150).regex(/^txn_[A-Za-z0-9_]+$/);
const payoutStatus = z.enum(['pending', 'in_transit', 'paid', 'failed', 'canceled']);
const payout = z.object({
  id: stripeBankPayoutId, object: z.literal('payout'), livemode: z.literal(false), status: payoutStatus,
  automatic: z.boolean(), method: z.enum(['standard', 'instant']), type: z.enum(['bank_account', 'card']),
  amount: z.number().int(), currency: z.string().regex(/^[a-z]{3}$/),
  destination: z.string().nullable(), reconciliation_status: z.enum(['completed', 'in_progress', 'not_applicable']),
  failure_balance_transaction: transactionId.nullish(), original_payout: stripeBankPayoutId.nullish(),
  reversed_by: stripeBankPayoutId.nullish(),
});
const balanceTransactions = z.object({
  object: z.literal('list'), has_more: z.boolean(), data: z.array(z.object({
    id: transactionId, object: z.literal('balance_transaction'), source: z.string().nullable(),
    amount: z.number().int(), net: z.number().int(), currency: z.string(), status: z.enum(['available', 'pending']),
  })).max(2),
});

export const stripeBankPayoutEvidence = z.object({
  status: z.enum(['included', 'not_included', 'pending', 'review_required', 'unsupported', 'unavailable']),
  stripePayoutStatus: payoutStatus.nullable(),
  balanceTransactionId: transactionId.nullable(),
});

type Expected = Parameters<typeof retrieveStripePayoutTransferPayment>[1] & { platformAccountId: string };
type Evidence = z.infer<typeof stripeBankPayoutEvidence>;

export async function checkStripeBankPayout(key: string, expected: Expected, bankPayoutId: string, send = fetch): Promise<Evidence> {
  const unavailable = { status: 'unavailable', stripePayoutStatus: null, balanceTransactionId: null } as const;
  if (!key.startsWith('sk_test_') || !stripeAccountId.safeParse(expected.stripeAccountId).success ||
    !stripeBankPayoutId.safeParse(bankPayoutId).success) return unavailable;

  async function read<T>(path: string, schema: z.ZodType<T>) {
    const response = await send('https://api.stripe.com/v1/' + path, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { Authorization: 'Bearer ' + key, 'Stripe-Account': expected.stripeAccountId },
    });
    if (!response.ok) throw new Error('Stripe connected-account read failed.');
    return schema.parse(await response.json());
  }

  const [platform, transfer] = await Promise.all([
    readStripeTestPlatform(key, send), retrieveStripePayoutTransferPayment(key, expected, send),
  ]);
  if (!platform || platform.id !== expected.platformAccountId || !transfer) return unavailable;
  if (transfer.reversedMinor > 0) return { ...unavailable, status: 'review_required' };

  try {
    const actual = await read('payouts/' + bankPayoutId, payout);
    if (actual.id !== bankPayoutId) return unavailable;
    const observed = { stripePayoutStatus: actual.status, balanceTransactionId: null };
    if (!actual.automatic || actual.method !== 'standard' || actual.type !== 'bank_account' ||
      actual.currency !== 'lkr') return { ...observed, status: 'unsupported' };
    if (actual.status === 'failed' || actual.status === 'canceled' || actual.amount <= 0 ||
      actual.failure_balance_transaction || actual.reversed_by || actual.original_payout) return { ...observed, status: 'review_required' };
    if (actual.reconciliation_status === 'not_applicable') return { ...observed, status: 'unsupported' };
    if (!actual.destination || !/^ba_[A-Za-z0-9_]+$/.test(actual.destination)) return unavailable;
    if (actual.status !== 'paid' || actual.reconciliation_status !== 'completed') return { ...observed, status: 'pending' };

    const query = new URLSearchParams({ payout: bankPayoutId, source: transfer.paymentId, limit: '2' });
    const { data, has_more } = await read('balance_transactions?' + query, balanceTransactions);
    if (!has_more && data.length === 0) return { ...observed, status: 'not_included' };
    const entry = data[0];
    if (has_more || data.length !== 1 || !entry || entry.source !== transfer.paymentId || entry.currency !== 'lkr' ||
      entry.amount !== expected.amountMinor || entry.net !== expected.amountMinor || entry.status !== 'available') {
      return { ...observed, status: 'review_required' };
    }
    return { ...observed, status: 'included', balanceTransactionId: entry.id };
  } catch { return unavailable; }
}
