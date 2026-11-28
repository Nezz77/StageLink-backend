import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { databaseNow } from '../shared/database-clock.js';
import { resources } from '../shared/resources.js';
import { serverClock } from './fixtures/server-clock.js';

const merchantId = '1210000';
const merchantSecret = 'fixture-checkout-secret';
const config = readConfig({
  ...process.env, AUTH_RATE_PREFIX: 'checkout-clock-test-' + randomUUID(),
  STRIPE_TEST_SECRET_KEY: 'sk_test_checkout_clock', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_checkout_clock',
  PAYHERE_SANDBOX_MERCHANT_ID: merchantId, PAYHERE_SANDBOX_MERCHANT_SECRET: merchantSecret,
  PAYHERE_SANDBOX_NOTIFY_URL: 'https://staging.test/api/v1/payments/webhooks/payhere',
});
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Checkout timing requires an isolated *_test database.');
}

test('checkout deadlines and PayHere capture timing follow PostgreSQL across API clocks', async t => {
  const localFetch = globalThis.fetch;
  const stripeExpiries: number[] = [];
  let beforeStripeResponse: (() => Promise<void>) | undefined;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== 'api.stripe.com') return localFetch(input, init);
    assert.equal(url.pathname, '/v1/checkout/sessions');
    assert.equal(init?.method, 'POST');
    const body = init?.body as URLSearchParams;
    const expiresAt = Number(body.get('expires_at'));
    stripeExpiries.push(expiresAt);
    await beforeStripeResponse?.();
    return Response.json({
      object: 'checkout.session', id: 'cs_test_' + randomUUID().replaceAll('-', ''), livemode: false,
      client_reference_id: body.get('client_reference_id'), amount_total: Number(body.get('line_items[0][price_data][unit_amount]')),
      currency: 'lkr', mode: 'payment', status: 'open', payment_status: 'unpaid',
      expires_at: expiresAt, url: 'https://checkout.stripe.com/pay/test_session',
    });
  });

  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const userIds: string[] = [];
  const bookingIds: string[] = [];
  const billing = {
    firstName: 'Test', lastName: 'Customer', phone: '0771234567',
    address: 'Main Street', city: 'Colombo', country: 'Sri Lanka',
  };
  const terms = { version: 1, currency: 'LKR', totalMinor: 10000, serviceAdvanceMinor: 5000, depositMinor: 2500 };

  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl() + '/api/v1/';
    async function member(role: 'customer' | 'artist') {
      const user = await deps.db.authUser.create({ data: {
        roles: [role], email: randomUUID() + '@stagelink.test', emailVerifiedAt: new Date(),
        displayName: 'Checkout clock fixture', passwordHash: 'unused',
      } });
      userIds.push(user.id);
      return user.id;
    }
    const customerId = await member('customer');
    const providerId = await member('artist');
    const session = await deps.db.authSession.create({ data: {
      userId: customerId, activeRole: 'customer', expiresAt: new Date(Date.now() + 600_000),
    } });
    const accessToken = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(customerId).setIssuer('stagelink-api').setAudience('stagelink-web')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 180).setExpirationTime('10m')
      .sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
    const headers = {
      Authorization: 'Bearer ' + accessToken, Origin: config.WEB_ORIGIN,
      'Content-Type': 'application/json', 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id),
    };
    async function request(path: string, body?: object) {
      const response = await fetch(base + path, {
        headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    }
    async function bookingAt(offsetMs: number) {
      const now = await databaseNow(deps.db);
      const startsAt = new Date(now.getTime() + offsetMs);
      const booking = await deps.db.booking.create({ data: {
        customerId, providerId, startsAt, endsAt: new Date(startsAt.getTime() + 3600_000),
        requestKey: randomUUID(), requestDigest: '0'.repeat(64), agreedAt: new Date(now.getTime() - 120_000),
        targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, holdExpiresAt: startsAt, snapshot: {},
      } });
      bookingIds.push(booking.id);
      const quotation = await deps.db.bookingQuotation.create({ data: {
        bookingId: booking.id, version: 1, authorId: providerId, lines: [], terms: 'Checkout clock fixture',
        totalMinor: terms.totalMinor, decidedAt: booking.agreedAt, decision: 'accepted', decidedBy: customerId,
      } });
      const artifact = JSON.stringify(terms);
      await deps.db.bookingAgreement.create({ data: {
        bookingId: booking.id, quotationId: quotation.id, artifact,
        digest: createHash('sha256').update(artifact).digest('hex'),
      } });
      return booking;
    }
    const orderPath = (bookingId: string) => 'bookings/' + bookingId + '/payment-orders';
    const paymentPath = (orderId: string) => 'payment-orders/' + orderId;
    const order = async (bookingId: string, purpose: 'advance' | 'deposit') => {
      const result = await request(orderPath(bookingId), { purpose });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body.id as string;
    };
    async function notify(fields: { order_id: string; amount: string }, providerId: string) {
      const md5 = (value: string) => createHash('md5').update(value).digest('hex').toUpperCase();
      const hashed = md5(merchantId + fields.order_id + fields.amount + 'LKR2' + md5(merchantSecret));
      const body = new URLSearchParams({
        merchant_id: merchantId, order_id: fields.order_id, payment_id: providerId, payhere_amount: fields.amount,
        payhere_currency: 'LKR', status_code: '2', md5sig: hashed,
      });
      const response = await fetch(base + 'payments/webhooks/payhere', { method: 'POST', body });
      assert.equal(response.status, 200);
    }

    const near = await bookingAt(60_000);
    const payhere = await serverClock(120_000, async () => {
      const advance = await order(near.id, 'advance');
      const deposit = await order(near.id, 'deposit');
      const advanceCheckout = await request(paymentPath(advance) + '/sessions', billing);
      const depositCheckout = await request(paymentPath(deposit) + '/sessions', billing);
      assert.equal(advanceCheckout.status, 200);
      assert.equal(depositCheckout.status, 200);
      assert.equal(advanceCheckout.body.expiresAt, near.startsAt.toISOString());
      assert.equal(depositCheckout.body.expiresAt, near.startsAt.toISOString());
      await notify(advanceCheckout.body.fields, '320025071279');
      assert.equal((await request(paymentPath(advance))).body.status, 'paid');
      return { deposit, fields: depositCheckout.body.fields };
    });
    const now = await databaseNow(deps.db);
    await deps.db.payHereAttempt.update({
      where: { orderId: payhere.deposit },
      data: { createdAt: new Date(now.getTime() - 30_000), expiresAt: new Date(now.getTime() - 1000) },
    });
    await serverClock(-120_000, async () => {
      assert.equal((await request(paymentPath(payhere.deposit) + '/sessions', billing)).body.code, 'CHECKOUT_EXPIRED');
      await notify(payhere.fields, '320025071280');
      await notify(payhere.fields, '320025071280');
      assert.equal((await request(paymentPath(payhere.deposit))).body.status, 'review');
    });
    const lateEvent = await deps.db.payHereEvent.findMany({ where: { attemptId: payhere.fields.order_id } });
    assert.equal(lateEvent.length, 1);
    assert.ok(lateEvent[0]?.journalId);
    assert.ok(lateEvent[0].receivedAt >= now);
    const credited = await deps.db.journalEntry.findFirstOrThrow({
      where: { transactionId: lateEvent[0].journalId, amountMinor: 2500n }, include: { account: true },
    });
    assert.equal(credited.account.scope, 'sandbox:review:' + payhere.deposit);

    const stripeBooking = await bookingAt(31 * 60_000);
    const stripeOrder = await order(stripeBooking.id, 'advance');
    const stripePath = paymentPath(stripeOrder) + '/sessions/stripe';
    const stripe = await serverClock(120_000, () => request(stripePath, {}));
    assert.equal(stripe.status, 200);
    assert.deepEqual(stripeExpiries, [Math.floor(stripeBooking.startsAt.getTime() / 1000)]);
    assert.equal(stripe.body.expiresAt, new Date(stripeExpiries[0]! * 1000).toISOString());
    assert.deepEqual(await request(stripePath, {}), stripe);
    assert.equal(stripeExpiries.length, 1);

    const stripeDeposit = await order(stripeBooking.id, 'deposit');
    beforeStripeResponse = async () => {
      const observedAt = await databaseNow(deps.db);
      const startsAt = new Date(observedAt.getTime() - 1000);
      await deps.db.booking.update({
        where: { id: stripeBooking.id }, data: { startsAt, holdExpiresAt: startsAt },
      });
    };
    const lateStripe = await serverClock(-120_000, () => request(paymentPath(stripeDeposit) + '/sessions/stripe', {}));
    assert.equal(lateStripe.status, 409);
    assert.equal(lateStripe.body.code, 'CHECKOUT_NOT_ELIGIBLE');
    const needsReconciliation = await deps.db.stripeAttempt.findUniqueOrThrow({ where: { orderId: stripeDeposit } });
    assert.ok(needsReconciliation.sessionId);
    assert.equal(needsReconciliation.checkoutUrl, null);

    const past = await bookingAt(-60_000);
    const rejected = await serverClock(-120_000, () => request(orderPath(past.id), { purpose: 'advance' }));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, 'PAYMENT_NOT_ELIGIBLE');
    assert.equal(await deps.db.paymentOrder.count({ where: { bookingId: past.id } }), 0);
  } finally {
    try {
      const bookings = { bookingId: { in: bookingIds } };
      await deps.db.payHereEvent.deleteMany({ where: { attempt: { order: bookings } } });
      await deps.db.payHereAttempt.deleteMany({ where: { order: bookings } });
      await deps.db.stripeAttempt.deleteMany({ where: { order: bookings } });
      await deps.db.bookingDocument.deleteMany({ where: bookings });
      await deps.db.paymentOrder.deleteMany({ where: bookings });
      await deps.db.bookingAgreement.deleteMany({ where: bookings });
      await deps.db.bookingQuotation.deleteMany({ where: bookings });
      await deps.db.outboxEvent.deleteMany({ where: { OR: bookingIds.map(id => ({ payload: { path: ['sourceId'], equals: id } })) } });
      await deps.db.booking.deleteMany({ where: { id: { in: bookingIds } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await app.close();
    }
  }
});
