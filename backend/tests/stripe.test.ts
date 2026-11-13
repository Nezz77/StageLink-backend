import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createStripeCheckout, validStripeSignature } from '../shared/payments/stripe.js';

const secret = 'whsec_fixture';
const attempt = {
  id: 'e4a51ba1-3863-44b9-ac18-19f036c75d09', amountMinor: 175001,
  returnUrl: 'https://stage.test/?paymentOrder=fixture', expiresAt: new Date('2030-01-01T00:35:00Z'),
};
const session = {
  id: 'cs_test_fixture', object: 'checkout.session', livemode: false, mode: 'payment',
  client_reference_id: attempt.id, amount_total: attempt.amountMinor, currency: 'lkr',
  expires_at: attempt.expiresAt.getTime() / 1000, status: 'open', payment_status: 'unpaid',
  url: 'https://checkout.stripe.com/c/pay/cs_test_fixture',
};

test('Stripe validates the exact signed bytes and rejects stale signatures', () => {
  const now = 1_900_000_000;
  const raw = Buffer.from('{"id":"evt_fixture", "livemode":false}');
  const digest = createHmac('sha256', secret).update(now + '.').update(raw).digest('hex');
  const header = `t=${now},v1=${'0'.repeat(64)},v1=${digest}`;
  assert.equal(validStripeSignature(raw, header, secret, now), true);
  assert.equal(validStripeSignature(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), header, secret, now), false);
  assert.equal(validStripeSignature(raw, header, secret, now + 301), false);
  assert.equal(validStripeSignature(raw, header, 'whsec_other', now), false);
  assert.equal(validStripeSignature(raw, header + ',t=' + now, secret, now), false);
});

test('Stripe requests stable idempotency and exact LKR minor units and checks the session', async () => {
  const requests: Request[] = [];
  const send: typeof fetch = async (url, init) => {
    requests.push(new Request(url, init));
    return Response.json(session);
  };
  assert.deepEqual(await createStripeCheckout('sk_test_fixture', attempt, send), session);
  await createStripeCheckout('sk_test_fixture', attempt, send);
  const [first, second] = requests;
  assert.equal(first?.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(first?.headers.get('Idempotency-Key'), 'stagelink-checkout-' + attempt.id);
  assert.equal(second?.headers.get('Idempotency-Key'), first?.headers.get('Idempotency-Key'));
  const fields = new URLSearchParams(await first!.text());
  assert.equal(fields.get('line_items[0][price_data][unit_amount]'), '175001');
  assert.equal(fields.get('line_items[0][price_data][currency]'), 'lkr');
  assert.equal(fields.get('adaptive_pricing[enabled]'), 'false');
  assert.equal(await second!.text(), fields.toString());
  for (const response of [
    { ...session, livemode: true },
    { ...session, amount_total: 100 },
    { ...session, currency: 'usd' },
    { ...session, url: 'https://checkout.stripe.com.evil.example' },
  ]) {
    await assert.rejects(createStripeCheckout('sk_test_fixture', attempt, async () => Response.json(response)));
  }
});
