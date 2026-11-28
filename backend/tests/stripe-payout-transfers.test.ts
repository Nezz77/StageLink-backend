import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectStripeTransferCapture, processStripePayoutTransfer, verifyStripeTransferCapture } from '../shared/payments/stripe-transfers.js';

const now = new Date('2026-11-28T00:00:00Z');
const readClock = async () => now;
const expected = {
  id: '21ad5369-80f7-406c-a018-c2650a0f032a', amountMinor: 95000, providerTransferId: null,
  createdAt: now, leaseUntil: new Date(now.getTime() + 30_000), stripeAccountId: 'acct_destination',
};
const group = 'stagelink_payout_' + expected.id;
const response = {
  id: 'tr_fixture', object: 'transfer', amount: 95000, currency: 'lkr', livemode: false,
  destination: expected.stripeAccountId, transfer_group: group, metadata: { stagelink_payout_transfer: expected.id },
  reversed: false, amount_reversed: 0,
};

test('a payout capture requires the exact approved refunded total and matching payment intent', async () => {
  const capture = { id: expected.id, sessionId: 'cs_test_fixture', amountMinor: 150000, expiresAt: new Date(1800000000000) };
  let refundedMinor = 0;
  let disputed = false;
  let unavailable = false;
  const send: typeof fetch = async url => {
    if (unavailable) return new Response(null, { status: 503 });
    if (String(url).includes('/checkout/sessions/')) return Response.json({
      id: capture.sessionId, object: 'checkout.session', client_reference_id: capture.id,
      livemode: false, mode: 'payment', amount_total: capture.amountMinor, currency: 'lkr',
      expires_at: capture.expiresAt.getTime() / 1000, status: 'complete', payment_status: 'paid', url: null,
      payment_intent: 'pi_deposit',
    });
    return Response.json({
      id: 'pi_deposit', object: 'payment_intent', livemode: false, currency: 'lkr', status: 'succeeded', amount_received: 150000,
      latest_charge: {
        object: 'charge', payment_intent: 'pi_deposit', livemode: false, currency: 'lkr', paid: true, captured: true,
        disputed, amount_captured: 150000, amount_refunded: refundedMinor,
      },
    });
  };
  assert.equal(await verifyStripeTransferCapture('sk_test_fixture', capture, send), true);
  refundedMinor = 55000;
  assert.equal(await verifyStripeTransferCapture('sk_test_fixture', capture, send), false);
  const deposit = { ...capture, refundMinor: 55000, refundPaymentIntentId: 'pi_deposit' };
  assert.equal(await verifyStripeTransferCapture('sk_test_fixture', deposit, send), true);
  assert.equal(await verifyStripeTransferCapture('sk_test_fixture', { ...deposit, refundPaymentIntentId: 'pi_other' }, send), false);
  for (const amount of [0, 54999, 55001, 150000]) {
    refundedMinor = amount;
    assert.equal(await verifyStripeTransferCapture('sk_test_fixture', deposit, send), false);
    assert.equal(await inspectStripeTransferCapture('sk_test_fixture', deposit, send), 'review_required');
  }
  refundedMinor = 55000;
  disputed = true;
  assert.equal(await inspectStripeTransferCapture('sk_test_fixture', deposit, send), 'review_required');
  assert.equal(await verifyStripeTransferCapture('sk_test_fixture', deposit, send), false);
  unavailable = true;
  assert.equal(await inspectStripeTransferCapture('sk_test_fixture', deposit, send), 'unavailable');
});

test('Stripe test transfers reuse the same idempotency key within its retry window', async () => {
  const requests: Request[] = [];
  const send: typeof fetch = async (url, init) => {
    requests.push(new Request(url, init));
    return init?.method === 'GET'
      ? Response.json({ object: 'list', has_more: false, data: [] })
      : new Response(null, { status: 500 });
  };
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'first', readClock, send), null);
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'retry', readClock, send), null);
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', { ...expected, createdAt: new Date(now.getTime() - 24 * 3600_000) }, 'retry', readClock, send), null);
  assert.deepEqual(requests.map(value => value.method), ['POST', 'GET', 'POST', 'GET']);
  const posted = requests.filter(value => value.method === 'POST');
  assert.ok(posted.every(value => value.headers.get('Idempotency-Key') === 'stagelink-payout-' + expected.id));
  assert.equal(await posted[0]!.text(), await posted[1]!.text());
  assert.equal(new URL(requests[1]!.url).searchParams.get('transfer_group'), group);
  assert.equal(await processStripePayoutTransfer('sk_live_fixture', expected, 'first', readClock, send), null);
  assert.equal(requests.length, 4);
});

test('Stripe transfer submission requires an active lease and replay window at send time', async () => {
  const boundary = { ...expected, createdAt: new Date(now.getTime() - 23 * 3600_000 + 1000) };
  let observedAt = now;
  const methods: string[] = [];
  const send: typeof fetch = async (_url, init) => {
    methods.push(init?.method ?? '');
    observedAt = new Date(now.getTime() + 1000);
    return Response.json({ object: 'list', has_more: false, data: [] });
  };
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', boundary, 'retry', async () => observedAt, send), null);
  assert.deepEqual(methods, ['GET']);

  assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'first', async () => expected.leaseUntil, send), null);
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'first', async () => {
    throw new Error('Database clock unavailable');
  }, send), null);
  assert.deepEqual(methods, ['GET']);
});

test('Stripe transfer reconciliation requires exact test evidence and reports partial reversals', async () => {
  for (const patch of [
    { livemode: true }, { amount: 95001 }, { currency: 'usd' }, { destination: 'acct_wrong' },
    { metadata: {} }, { transfer_group: 'unrelated' },
    { amount_reversed: 95001 }, { amount_reversed: 95000 }, { reversed: true },
  ]) {
    assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, false, readClock, async (_url, init) => {
      assert.equal(init?.method, 'GET');
      return Response.json({ object: 'list', has_more: false, data: [{ ...response, ...patch }] });
    }), null);
  }
  assert.deepEqual(await processStripePayoutTransfer('sk_test_fixture', expected, false, readClock, async () =>
    Response.json({ object: 'list', has_more: false, data: [response] })), { id: response.id, reversedMinor: 0 });
  assert.deepEqual(await processStripePayoutTransfer('sk_test_fixture', { ...expected, providerTransferId: response.id }, false, readClock, async url => {
    assert.equal(String(url), 'https://api.stripe.com/v1/transfers/tr_fixture');
    return Response.json({ ...response, amount_reversed: 1000 });
  }), { id: response.id, reversedMinor: 1000 });
  assert.deepEqual(await processStripePayoutTransfer('sk_test_fixture', { ...expected, providerTransferId: response.id }, false, readClock, async () =>
    Response.json({ ...response, reversed: true, amount_reversed: expected.amountMinor })),
    { id: response.id, reversedMinor: expected.amountMinor });
});

test('only a first submission with a documented balance rejection and request ID is terminal', async () => {
  const error = { error: { code: 'balance_insufficient', type: 'invalid_request_error' } };
  const requestId = 'req_balanceFixture';
  const headers = { 'Request-Id': requestId };
  const rejection = { rejection: { code: 'balance_insufficient', requestId } };
  for (const status of [400, 402]) {
    assert.deepEqual(await processStripePayoutTransfer('sk_test_fixture', expected, 'first', readClock,
      async () => Response.json(error, { status, headers })), rejection);
  }

  for (const status of [409, 429, 500]) {
    assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'first', readClock,
      async () => Response.json(error, { status, headers })), null);
  }
  for (const [name, value] of [['Request-Id', ''], ['Idempotent-Replayed', 'true'], ['Stripe-Should-Retry', 'true']] as const) {
    const flaggedHeaders = new Headers(headers);
    flaggedHeaders.set(name, value);
    assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'first', readClock,
      async () => Response.json(error, { status: 400, headers: flaggedHeaders })), null);
  }
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'first', readClock,
    async () => Response.json({ error: { code: 'transfers_not_allowed', type: 'invalid_request_error' } },
      { status: 400, headers })), null);
  assert.equal(await processStripePayoutTransfer('sk_test_fixture', expected, 'retry', readClock, async (_url, init) =>
    init?.method === 'GET'
      ? Response.json({ object: 'list', has_more: false, data: [] })
      : Response.json(error, { status: 400, headers })), null);
});
