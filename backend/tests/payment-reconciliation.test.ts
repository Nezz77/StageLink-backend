import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessPayment, makePayHereObserver, observeStripe } from '../shared/payments/reconciliation.js';

const id = 'e4a51ba1-3863-44b9-ac18-19f036c75d09';
const expiresAt = new Date('2030-01-01T00:35:00Z');
const stripeAttempt = { id, sessionId: 'cs_test_fixture', amountMinor: 175001, expiresAt };
const session = {
  object: 'checkout.session', id: stripeAttempt.sessionId, livemode: false, mode: 'payment',
  client_reference_id: id, amount_total: stripeAttempt.amountMinor, currency: 'lkr',
  expires_at: expiresAt.getTime() / 1000, status: 'complete', payment_status: 'paid', url: null,
};

test('Stripe reconciliation checks the exact test checkout and classifies missing or changed evidence', async () => {
  const status = (body: unknown) => observeStripe('sk_test_fixture', stripeAttempt, async (url, init) => {
    assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions/cs_test_fixture');
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer sk_test_fixture');
    return Response.json(body);
  });
  assert.deepEqual(await status(session), { status: 'captured' });
  assert.deepEqual(await status({ ...session, status: 'expired', payment_status: 'unpaid' }), { status: 'expired' });
  assert.deepEqual(await status({ ...session, payment_status: 'unpaid' }), { status: 'pending' });
  for (const patch of [
    { amount_total: 175000 }, { livemode: true }, { id: 'cs_test_other' }, { client_reference_id: 'invalid' },
    { currency: 'usd' }, { expires_at: session.expires_at + 1 },
  ]) {
    assert.deepEqual(await status({ ...session, ...patch }), { status: 'mismatch' });
  }
  assert.deepEqual(await observeStripe('sk_test_fixture', stripeAttempt, async () => new Response(null, { status: 404 })), { status: 'not_found' });
  assert.deepEqual(await observeStripe('sk_test_fixture', stripeAttempt, async () => new Response(null, { status: 403 })), { status: 'unavailable' });
  assert.deepEqual(await observeStripe(undefined, stripeAttempt, async () => assert.fail('Unexpected request')), { status: 'unavailable' });
});

test('PayHere checks exact minor units, reuses sandbox credentials and reports duplicate or reversed payments', async () => {
  const payment = {
    payment_id: 320025071278, order_id: id, status: 'RECEIVED', currency: 'LKR', amount: '1750.01',
    customer: { email: 'private@example.test' },
  };
  let data: unknown = { status: 1, data: [payment] };
  let tokenRequests = 0;
  const options = { id, amountMinor: 175001 };
  const observer = makePayHereObserver('fixture-app', 'fixture-secret', async (url, init) => {
    const request = new Request(url, init);
    if (request.url.endsWith('/oauth/token')) {
      tokenRequests++;
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('Authorization'), 'Basic ' + Buffer.from('fixture-app:fixture-secret').toString('base64'));
      assert.equal(await request.text(), 'grant_type=client_credentials');
      return Response.json({ scope: 'SANDBOX', token_type: 'bearer', access_token: 'fixture-token', expires_in: 599 });
    }
    assert.equal(request.url, 'https://sandbox.payhere.lk/merchant/v1/payment/search?order_id=' + id);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.get('Authorization'), 'Bearer fixture-token');
    return Response.json(data);
  });
  const captured = { status: 'captured', paymentReference: '320025071278' };
  assert.deepEqual(await Promise.all([observer(options), observer(options)]), [captured, captured]);
  assert.equal(tokenRequests, 1);
  data = { status: 1, data: [payment, { ...payment, payment_id: 320025071279 }] };
  assert.deepEqual(await observer(options), { status: 'multiple_payments' });
  data = { status: 1, data: [{ ...payment, amount: 1750 }] };
  assert.deepEqual(await observer(options), { status: 'mismatch' });
  data = { status: 1, data: [{ ...payment, status: 'REFUNDED' }] };
  assert.deepEqual(await observer(options), { status: 'refunded', paymentReference: '320025071278' });
  data = { status: -1, data: null };
  assert.deepEqual(await observer(options), { status: 'not_found' });
  data = { status: -2, data: null };
  assert.deepEqual(await observer(options), { status: 'unavailable' });
  assert.equal(tokenRequests, 1);
});

test('reconciliation distinguishes absent evidence from capture and posting discrepancies', () => {
  assert.equal(assessPayment('pending', false, null, { status: 'captured' }), 'needs_review');
  assert.equal(assessPayment('review', true, null, { status: 'captured' }), 'needs_review');
  assert.equal(assessPayment('paid', true, null, { status: 'captured' }), 'consistent');
  assert.equal(assessPayment('paid', true, '1', { status: 'captured', paymentReference: '2' }), 'needs_review');
  assert.equal(assessPayment('pending', false, null, { status: 'expired' }), 'needs_review');
  assert.equal(assessPayment('cancelled', false, null, { status: 'expired' }), 'consistent');
  assert.equal(assessPayment('paid', true, '1', { status: 'chargeback' }), 'needs_review');
  assert.equal(assessPayment('pending', false, null, { status: 'not_found' }), 'inconclusive');
});
