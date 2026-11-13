import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../shared/config.js';
const valid = { AUTH_JWT_SECRET: '01'.repeat(32), AUTH_MAIL_KEY: '02'.repeat(32), PAYOUT_DATA_KEY: '03'.repeat(32), DATABASE_URL: 'postgresql://user:secret@localhost/db', REDIS_URL: 'redis://localhost:6379' };
test('configuration rejects missing, malformed and unsafe settings without leaking secrets', () => {
  assert.throws(() => readConfig({}), /DATABASE_URL, REDIS_URL/);
  for (const extra of [{ PORT: '0' }, { PORT: 'invalid' }, { DATABASE_URL: 'https://user:secret@example.com' }, { WEB_ORIGIN: '*' }, { WEB_ORIGIN: 'http://localhost:3000/path' }]) {
    assert.throws(() => readConfig({ ...valid, ...extra }), error =>
      error instanceof Error && error.message.startsWith('Invalid configuration:') && !error.message.includes('secret'));
  }
  assert.equal(readConfig(valid).PORT, 4000);
  assert.throws(()=>readConfig({...valid,PAYOUT_DATA_KEY:valid.AUTH_MAIL_KEY}));
  assert.throws(()=>readConfig({...valid,PAYOUT_DATA_KEY:valid.AUTH_JWT_SECRET}));
});

test('PayHere sandbox requires all three settings and an HTTPS webhook path', () => {
  const sandbox = {
    PAYHERE_SANDBOX_MERCHANT_ID: '1210000',
    PAYHERE_SANDBOX_MERCHANT_SECRET: 'test-only',
    PAYHERE_SANDBOX_NOTIFY_URL: 'https://stage.test/api/v1/payments/webhooks/payhere',
  };
  assert.equal(readConfig({ ...valid, ...sandbox }).PAYHERE_SANDBOX_MERCHANT_ID, '1210000');
  assert.throws(() => readConfig({ ...valid, ...sandbox, PAYHERE_SANDBOX_MERCHANT_SECRET: '' }));
  assert.throws(() => readConfig({ ...valid, ...sandbox, PAYHERE_SANDBOX_NOTIFY_URL: 'http://localhost:4000/api/v1/payments/webhooks/payhere' }));
  assert.equal(readConfig({ ...valid, PAYHERE_SANDBOX_MERCHANT_ID: '' }).PAYHERE_SANDBOX_MERCHANT_ID, undefined);
});

test('Stripe requires paired test-mode configuration', () => {
  const stripe = { STRIPE_TEST_SECRET_KEY: 'sk_test_fixture', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_fixture' };
  assert.equal(readConfig({ ...valid, ...stripe }).STRIPE_TEST_SECRET_KEY, stripe.STRIPE_TEST_SECRET_KEY);
  assert.throws(() => readConfig({ ...valid, ...stripe, STRIPE_TEST_SECRET_KEY: 'sk_live_fixture' }));
  assert.throws(() => readConfig({ ...valid, STRIPE_TEST_SECRET_KEY: 'sk_test_fixture' }));
});
