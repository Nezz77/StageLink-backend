import assert from 'node:assert/strict';
import { test } from 'node:test';
import { payHerePartialRefundProbeConfig, runPayHerePartialRefundProbe } from '../scripts/payhere-partial-refund-probe.js';

const env = {
  PAYHERE_SANDBOX_RETRIEVAL_APP_ID: 'test-app-id',
  PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET: 'test-app-secret',
  STAGELINK_PROBE_PAYHERE_ORDER_ID: 'partial-refund-1',
  STAGELINK_PROBE_PAYHERE_PAYMENT_ID: '538015026987',
  STAGELINK_PROBE_PAYHERE_CAPTURE_MINOR: '50000',
  STAGELINK_PROBE_PAYHERE_REFUND_MINOR: '10050',
};
const config = payHerePartialRefundProbeConfig(env);

function fixture(options: { payment?: Record<string, unknown>; scope?: string; submissionLost?: boolean } = {}) {
  const calls: string[] = [];
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://sandbox.payhere.lk');
    assert.equal(init?.redirect, 'error');
    calls.push(init?.method + ' ' + url.pathname);
    if (url.pathname.endsWith('/oauth/token')) {
      return Response.json({ access_token: 'test-bearer', token_type: 'bearer', scope: options.scope ?? 'SANDBOX', expires_in: 300 });
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-bearer');
    if (url.pathname.endsWith('/payment/search')) {
      assert.equal(url.searchParams.get('order_id'), config.orderId);
      return Response.json({ status: 1, data: [{
        payment_id: config.paymentId, order_id: config.orderId, currency: 'LKR', amount: '500.00', status: 'RECEIVED',
        payment_method: { method: 'VISA', card_customer_name: 'Private example', card_no: 'Masked fixture' },
        refund_details: { amount: 'Private value' }, ...options.payment,
      }] });
    }
    assert.equal(url.pathname, '/merchant/v1/payment/refund');
    const submission = JSON.parse(String(init?.body));
    assert.equal(submission.payment_id, config.paymentId);
    assert.equal(submission.amount, '100.50');
    assert.match(submission.description, /^StageLink sandbox partial refund probe [\w-]+$/);
    if (options.submissionLost) throw new Error('Transport lost private response');
    return Response.json({ status: 1, data: 560034010257 });
  };
  return { calls, send };
}

test('PayHere probe observes a sandbox card test payment and reports field names without leaking values', async () => {
  const { calls, send } = fixture();
  const report = await runPayHerePartialRefundProbe(config, 'observe', send);
  assert.equal(report.passed, true);
  assert.deepEqual(report.refundFields, ['refund_details']);
  assert.deepEqual(calls, ['POST /merchant/v1/oauth/token', 'GET /merchant/v1/payment/search']);
  assert.doesNotMatch(JSON.stringify(report), /Private|Masked|test-bearer|test-app-secret|538015026987/);
});

test('PayHere probe submits the exact partial amount for the matching captured sandbox card once', async () => {
  for (const submissionLost of [false, true]) {
    const { calls, send } = fixture({ submissionLost });
    const report = await runPayHerePartialRefundProbe(config, 'submit', send);
    assert.equal(report.passed, !submissionLost);
    assert.deepEqual(report.submission, submissionLost
      ? { status: 'uncertain', providerRefundId: null }
      : { status: 'pending', providerRefundId: '560034010257' });
    assert.deepEqual(calls, ['POST /merchant/v1/oauth/token', 'GET /merchant/v1/payment/search', 'POST /merchant/v1/payment/refund']);
  }
});

test('PayHere probe rejects an ineligible capture, unexpected payment or non-sandbox token before submitting', async () => {
  for (const options of [
    { payment: { payment_id: '12345' } }, { payment: { amount: '700.00' } }, { payment: { status: 'REFUNDED' } },
    { payment: { payment_method: { method: 'ezcash' } } }, { scope: 'LIVE' },
  ]) {
    const { calls, send } = fixture(options);
    assert.equal((await runPayHerePartialRefundProbe(config, 'submit', send)).passed, false);
    assert.ok(!calls.some(call => call.endsWith('/payment/refund')));
  }
  assert.throws(() => payHerePartialRefundProbeConfig({ ...env, STAGELINK_PROBE_PAYHERE_REFUND_MINOR: '50000' }));
});
