import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processStripeRefund } from '../shared/payments/stripe-refunds.js';

const now = new Date('2026-11-28T00:00:00Z');
const readClock = async () => now;
const execution = {
  id: 'e7a51ba1-3863-44b9-ac18-19f036c75d09', paymentIntentId: 'pi_fixture', amountMinor: 150001,
  providerRefundId: null, createdAt: now, leaseUntil: new Date(now.getTime() + 30_000),
};
const refund = {
  id: 're_fixture', object: 'refund', currency: 'lkr', amount: execution.amountMinor,
  payment_intent: execution.paymentIntentId, metadata: { stagelink_refund_execution: execution.id }, status: 'succeeded',
};

test('Stripe refund submission uses a stable key and recovers a matched result without resubmission', async () => {
  const attempted: Request[] = [];
  const submit: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    attempted.push(request);
    assert.equal(request.headers.get('Idempotency-Key'), 'stagelink-refund-' + execution.id);
    assert.equal(new URLSearchParams(await request.text()).get('amount'), '150001');
    return Response.json({ error: 'unknown' }, { status: 500 });
  };
  assert.equal(await processStripeRefund('sk_test_fixture', execution, true, true, readClock, submit), null);
  assert.deepEqual(await processStripeRefund('sk_test_fixture', execution, true, false, readClock, async (url, init) => {
    assert.equal(new URL(String(url)).searchParams.get('payment_intent'), 'pi_fixture');
    assert.equal(init?.method, 'GET');
    return Response.json({ object: 'list', has_more: false, data: [refund] });
  }), refund);
  assert.equal(attempted.length, 1);

  const requests: string[] = [];
  const noMatch: typeof fetch = async (_url, init) => {
    requests.push(init!.method!);
    return Response.json({ object: 'list', has_more: false, data: [] });
  };
  const expired = { ...execution, createdAt: new Date(now.getTime() - 24 * 60 * 60_000) };
  assert.equal(await processStripeRefund('sk_test_fixture', expired, true, false, readClock, noMatch), null);
  assert.equal(await processStripeRefund('sk_test_fixture', execution, false, false, readClock, noMatch), null);
  assert.deepEqual(requests, ['GET', 'GET']);
});

test('Stripe refund submission checks the lease and replay window after reading Stripe', async () => {
  const boundary = { ...execution, createdAt: new Date(now.getTime() - 23 * 3600_000 + 1000) };
  let observedAt = now;
  const requests: string[] = [];
  const noMatch: typeof fetch = async (_url, init) => {
    requests.push(init?.method ?? '');
    observedAt = new Date(now.getTime() + 1000);
    return Response.json({ object: 'list', has_more: false, data: [] });
  };
  assert.equal(await processStripeRefund('sk_test_fixture', boundary, true, false, async () => observedAt, noMatch), null);
  assert.equal(await processStripeRefund('sk_test_fixture', execution, true, true, async () => execution.leaseUntil, noMatch), null);
  assert.equal(await processStripeRefund('sk_live_fixture', execution, true, true, readClock, noMatch), null);
  assert.deepEqual(requests, ['GET']);
});

test('Stripe refund settlement requires the exact provider ID, amount, currency, intent and metadata', async () => {
  const pending = { ...execution, providerRefundId: refund.id };
  const retrieve = (patch: Record<string, unknown>) => processStripeRefund('sk_test_fixture', pending, true, false, readClock, async (url, init) => {
    assert.equal(url, 'https://api.stripe.com/v1/refunds/re_fixture');
    assert.equal(init?.method, 'GET');
    return Response.json({ ...refund, ...patch });
  });
  for (const patch of [
    { id: 're_other' }, { amount: 150000 }, { currency: 'usd' }, { payment_intent: 'pi_other' }, { metadata: {} },
  ]) assert.equal(await retrieve(patch), null);
  assert.deepEqual(await retrieve({}), refund);
});
