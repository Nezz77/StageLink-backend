import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processStripePayoutTransfer } from '../shared/payments/stripe-transfers.js';

const expected = {
  id: '21ad5369-80f7-406c-a018-c2650a0f032a', amountMinor: 95000, providerTransferId: null,
  createdAt: new Date(), stripeAccountId: 'acct_destination',
};
const group = 'stagelink_payout_' + expected.id;
const response = {
  id: 'tr_fixture', object: 'transfer', amount: 95000, currency: 'lkr', livemode: false,
  destination: expected.stripeAccountId, transfer_group: group, metadata: { stagelink_payout_transfer: expected.id },
  reversed: false, amount_reversed: 0,
};

test('Stripe test transfers reuse the same idempotency key within its retry window', async () => {
  const requests: Request[] = [];
  const send: typeof fetch = async (url, init) => {
    requests.push(new Request(url, init));
    return init?.method === 'GET'
      ? Response.json({ object: 'list', has_more: false, data: [] })
      : new Response(null, { status: 500 });
  };
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'first', send), null);
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'retry', send), null);
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', { ...expected, createdAt: new Date(Date.now() - 24 * 3600_000) }, 'retry', send), null);
  assert.deepEqual(requests.map(value => value.method), ['POST', 'GET', 'POST', 'GET']);
  const posted = requests.filter(value => value.method === 'POST');
  assert.ok(posted.every(value => value.headers.get('Idempotency-Key') === 'stagelink-payout-' + expected.id));
  assert.equal(await posted[0]!.text(), await posted[1]!.text());
  assert.equal(new URL(requests[1]!.url).searchParams.get('transfer_group'), group);
  assert.equal(await processStripePayoutTransfer('sk_live_fixture', expected, 'first', send), null);
  assert.equal(requests.length, 4);
});

test('Stripe transfer reconciliation requires exact test evidence and reports partial reversals', async () => {
  for (const patch of [
    { livemode: true }, { amount: 95001 }, { currency: 'usd' }, { destination: 'acct_wrong' },
    { metadata: {} }, { transfer_group: 'unrelated' },
  ]) {
    assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, false, async (_url, init) => {
      assert.equal(init?.method, 'GET');
      return Response.json({ object: 'list', has_more: false, data: [{ ...response, ...patch }] });
    }), null);
  }
  assert.deepEqual(await processStripePayoutTransfer('sk_test_fixture', expected, false, async () =>
    Response.json({ object: 'list', has_more: false, data: [response] })), { id: response.id, reversed: false });
  assert.deepEqual(await processStripePayoutTransfer('sk_test_fixture', { ...expected, providerTransferId: response.id }, false, async url => {
    assert.equal(String(url), 'https://api.stripe.com/v1/transfers/tr_fixture');
    return Response.json({ ...response, amount_reversed: 1000 });
  }), { id: response.id, reversed: true });
});
