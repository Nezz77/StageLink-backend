import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkStripeBankPayout } from '../shared/payments/stripe-bank-payouts.js';

const expected = {
  id: 'd3c97918-c08b-4ce8-bde7-67c951b3d6c1', amountMinor: 95000, providerTransferId: 'tr_fixture',
  stripeAccountId: 'acct_connected', platformAccountId: 'acct_platform',
};
const transfer = {
  id: expected.providerTransferId, object: 'transfer', livemode: false, currency: 'lkr', amount: expected.amountMinor,
  destination: expected.stripeAccountId, destination_payment: 'py_fixture',
  transfer_group: 'stagelink_payout_' + expected.id, metadata: { stagelink_payout_transfer: expected.id },
  reversed: false, amount_reversed: 0,
};
const payout = {
  id: 'po_fixture', object: 'payout', livemode: false, status: 'paid', automatic: true, method: 'standard',
  type: 'bank_account', currency: 'lkr', amount: 105000, destination: 'ba_fixture', reconciliation_status: 'completed',
};
const entry = {
  id: 'txn_fixture', object: 'balance_transaction', source: 'py_fixture',
  currency: 'lkr', amount: 95000, net: 95000, status: 'available',
};

function fixture(patch: { payout?: object; transfer?: object; list?: object; platformAccountId?: string } = {}) {
  const paths: string[] = [];
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(init?.method, 'GET');
    const headers = new Headers(init?.headers);
    if (url.pathname === '/v1/account' || url.pathname === '/v1/transfers/tr_fixture') {
      assert.equal(headers.get('Stripe-Account'), null);
      return url.pathname === '/v1/account'
        ? Response.json({ object: 'account', id: patch.platformAccountId ?? 'acct_platform', country: 'US', charges_enabled: true, payouts_enabled: true })
        : Response.json({ ...transfer, ...patch.transfer });
    }
    assert.equal(headers.get('Stripe-Account'), 'acct_connected');
    if (url.pathname === '/v1/payouts/po_fixture') return Response.json({ ...payout, ...patch.payout });
    assert.equal(url.pathname, '/v1/balance_transactions');
    assert.equal(url.searchParams.get('payout'), 'po_fixture');
    assert.equal(url.searchParams.get('source'), 'py_fixture');
    return Response.json({ object: 'list', has_more: false, data: [entry], ...patch.list });
  };
  return { send, paths };
}

test('Stripe bank payout confirmation proves exact inclusion in a reconciled batch', async () => {
  assert.deepEqual(await checkStripeBankPayout('sk_test_fixture', expected, 'po_fixture', fixture().send), {
    status: 'included', stripePayoutStatus: 'paid', balanceTransactionId: 'txn_fixture',
  });
  for (const [list, status] of [
    [{ data: [] }, 'not_included'],
    [{ data: [{ ...entry, source: 'py_other' }] }, 'review_required'],
    [{ data: [{ ...entry, net: 94000 }] }, 'review_required'],
    [{ has_more: true }, 'review_required'],
  ] as const) {
    assert.equal((await checkStripeBankPayout('sk_test_fixture', expected, 'po_fixture', fixture({ list }).send)).status, status);
  }
});

test('Stripe bank payout confirmation requires fresh test evidence on the linked account', async () => {
  for (const [patch, status] of [
    [{ payout: { automatic: false } }, 'unsupported'],
    [{ payout: { currency: 'usd' } }, 'unsupported'],
    [{ payout: { reconciliation_status: 'in_progress' } }, 'pending'],
    [{ payout: { status: 'failed', reconciliation_status: 'not_applicable' } }, 'review_required'],
    [{ payout: { reversed_by: 'po_reversal' } }, 'review_required'],
    [{ payout: { livemode: true } }, 'unavailable'],
    [{ platformAccountId: 'acct_other' }, 'unavailable'],
    [{ transfer: { amount_reversed: 1000 } }, 'review_required'],
  ] as const) {
    const { send, paths } = fixture(patch);
    assert.equal((await checkStripeBankPayout('sk_test_fixture', expected, 'po_fixture', send)).status, status);
    assert.equal(paths.includes('/v1/balance_transactions'), false);
  }
  const { send, paths } = fixture();
  assert.equal((await checkStripeBankPayout('sk_live_fixture', expected, 'po_fixture', send)).status, 'unavailable');
  assert.deepEqual(paths, []);
});
