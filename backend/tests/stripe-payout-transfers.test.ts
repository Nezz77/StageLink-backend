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
    { amount_reversed: 95001 }, { amount_reversed: 95000 }, { reversed: true },
  ]) {
    assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, false, async (_url, init) => {
      assert.equal(init?.method, 'GET');
      return Response.json({ object: 'list', has_more: false, data: [{ ...response, ...patch }] });
    }), null);
  }
  assert.deepEqual(await processStripePayoutTransfer('sk_test_fixture', expected, false, async () =>
    Response.json({ object: 'list', has_more: false, data: [response] })), { id: response.id, reversedMinor: 0 });
  assert.deepEqual(await processStripePayoutTransfer('sk_test_fixture', { ...expected, providerTransferId: response.id }, false, async url => {
    assert.equal(String(url), 'https://api.stripe.com/v1/transfers/tr_fixture');
    return Response.json({ ...response, amount_reversed: 1000 });
  }), { id: response.id, reversedMinor: 1000 });
  assert.deepEqual(await processStripePayoutTransfer('sk_test_fixture', { ...expected, providerTransferId: response.id }, false, async () =>
    Response.json({ ...response, reversed: true, amount_reversed: expected.amountMinor })),
    { id: response.id, reversedMinor: expected.amountMinor });
});

test('only a first submission with a documented balance rejection and request ID is terminal', async () => {
  const error = { error: { code: 'balance_insufficient', type: 'invalid_request_error' } };
  const requestId = 'req_balanceFixture';
  const headers = { 'Request-Id': requestId };
  const rejection = { rejection: { code: 'balance_insufficient', requestId } };
  for (const status of [400, 402]) {
    assert.deepEqual(await processStripePayoutTransfer('sk_test_fixture', expected, 'first',
      async () => Response.json(error, { status, headers })), rejection);
  }

  for (const status of [409, 429, 500]) {
    assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'first',
      async () => Response.json(error, { status, headers })), null);
  }
  for (const [name, value] of [['Request-Id', ''], ['Idempotent-Replayed', 'true'], ['Stripe-Should-Retry', 'true']] as const) {
    const flaggedHeaders = new Headers(headers);
    flaggedHeaders.set(name, value);
    assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'first',
      async () => Response.json(error, { status: 400, headers: flaggedHeaders })), null);
  }
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'first',
    async () => Response.json({ error: { code: 'transfers_not_allowed', type: 'invalid_request_error' } },
      { status: 400, headers })), null);
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'retry', async (_url, init) =>
    init?.method === 'GET'
      ? Response.json({ object: 'list', has_more: false, data: [] })
      : Response.json(error, { status: 400, headers })), null);
});
