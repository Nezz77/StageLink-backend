import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paymentSmokeConfig, runPaymentSmoke } from '../scripts/payment-smoke.js';

const env = {
  STAGELINK_SMOKE_ORIGIN: 'https://staging.example.test',
  STAGELINK_SMOKE_STRIPE_ORDER_ID: 'c51e2bc2-b18e-4e3a-975d-a0d8231af991',
  STAGELINK_SMOKE_PAYHERE_ORDER_ID: '241b384e-fbe5-4933-ba51-aa930776ee32',
  STAGELINK_SMOKE_STRIPE_ACCOUNT_ID: 'acct_fixture',
  STAGELINK_SMOKE_RECOVERY_ORDER_ID: 'acfd4cda-bbed-479c-9466-c11c24f12096',
};
const token = 'test.admin.signature';
const config = paymentSmokeConfig(env, token);
const checkedAt = '2026-11-20T16:30:00.000Z';
const readiness = { status: 'ready', dependencies: { postgres: 'up', redis: 'up' }, schemaVersion: 'fixture-migration' };
const order = (orderId: string, gateway: 'stripe' | 'payhere') => ({
  orderId, gateway, localStatus: 'paid', localCaptureRecorded: true, providerStatus: 'captured', assessment: 'consistent', checkedAt,
});
const capabilities = {
  status: 'checked', checkedAt,
  platform: { country: 'US', chargesEnabled: true, lkrChargeCurrencyListed: true, availableLkrMinor: '123456' },
  connectedAccount: {
    id: config.connectedAccountId, country: 'US', platformControlsAccount: true, transfersCapability: 'active',
    payoutsEnabled: true, lkrBankCurrencyListed: true, destinationCountryListed: true,
  },
};

test('payment smoke confirms matching fixtures and returns only selected evidence', async () => {
  const paths: string[] = [];
  const report = await runPaymentSmoke(config, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, config.origin);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    paths.push(url.pathname);
    const authorization = new Headers(init?.headers).get('Authorization');
    if (url.pathname.endsWith('/health/ready')) {
      assert.equal(authorization, null);
      return Response.json(readiness);
    }
    assert.equal(authorization, 'Bearer ' + token);
    if (url.pathname.endsWith('/stripe-capabilities')) {
      assert.equal(url.searchParams.get('connectedAccountId'), config.connectedAccountId);
      return Response.json(capabilities);
    }
    if (url.pathname.endsWith('/recoveries')) return Response.json({ items: [{
      orderId: config.recoveryOrder, gateway: 'payhere', outcome: 'captured', observedAt: checkedAt,
      journalId: '18ff5d5f-33d8-42a1-8a10-ee254c8c0f01', reason: 'private operator reason',
    }] });
    if (url.pathname.includes(config.stripeOrder)) return Response.json(order(config.stripeOrder, 'stripe'));
    assert.ok(url.pathname.includes(config.payHereOrder));
    return Response.json(order(config.payHereOrder, 'payhere'));
  });
  assert.equal(paths.length, 5);
  assert.equal(paths[0], '/api/v1/health/ready');
  assert.equal(report.passed, true);
  assert.deepEqual(report.checks.map(check => check.status), ['pass', 'pass', 'pass', 'pass', 'pass']);
  assert.doesNotMatch(JSON.stringify(report), /signature|private operator reason|acct_fixture|123456|c51e2bc2/);
});

test('payment smoke flags mismatched orders, missing country evidence and invalid recovery responses', async () => {
  const report = await runPaymentSmoke(config, async input => {
    const { pathname } = new URL(String(input));
    if (pathname.endsWith('/health/ready')) return Response.json(readiness);
    if (pathname.endsWith('/stripe-capabilities')) return Response.json({
      ...capabilities, connectedAccount: { ...capabilities.connectedAccount, destinationCountryListed: null },
    });
    if (pathname.endsWith('/recoveries')) return Response.json({ error: 'withheld response body' });
    if (pathname.includes(config.stripeOrder)) return Response.json(order(config.stripeOrder, 'payhere'));
    return Response.json({ code: 'withheld provider response' }, { status: 403 });
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks.map(check => check.status), ['pass', 'review', 'unavailable', 'review', 'unavailable']);
  assert.deepEqual(report.checks[2], { check: 'payhere_capture_reconciliation', status: 'unavailable', failure: 'http_error', httpStatus: 403 });
  assert.deepEqual(report.checks[4], { check: 'checkout_capture_recovery_audit', status: 'unavailable', failure: 'invalid_response' });
  assert.doesNotMatch(JSON.stringify(report), /withheld/);
});

test('a failed readiness request stops before sending credentials', async () => {
  let requests = 0;
  const report = await runPaymentSmoke(config, async (_input, init) => {
    requests++;
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    throw new Error('private network failure details');
  });
  assert.equal(requests, 1);
  assert.deepEqual(report, { passed: false, checks: [{ check: 'api_readiness', status: 'unavailable', failure: 'request_failed' }] });
  assert.throws(() => paymentSmokeConfig({ ...env, STAGELINK_SMOKE_ORIGIN: 'http://staging.example.test' }, token), /STAGELINK_SMOKE_ORIGIN/);
  assert.throws(() => paymentSmokeConfig({ ...env, STAGELINK_SMOKE_ORIGIN: 'https://user@staging.example.test' }, token), /STAGELINK_SMOKE_ORIGIN/);
  assert.throws(() => paymentSmokeConfig({ ...env, STAGELINK_SMOKE_PAYHERE_ORDER_ID: config.stripeOrder }, token), /distinct sandbox orders/);
});
