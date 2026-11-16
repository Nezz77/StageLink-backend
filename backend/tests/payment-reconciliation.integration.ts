import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const config = readConfig({
  ...process.env, STRIPE_TEST_SECRET_KEY: 'sk_test_reconciliation', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_reconciliation',
  AUTH_RATE_PREFIX: 'payment-reconciliation-test-' + randomUUID(),
});
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Payment reconciliation requires an isolated *_test database.');
}

test('verified administrators can compare sandbox checkout evidence without mutating orders', async t => {
  const originalFetch = globalThis.fetch;
  let matches = true;
  let gatewayReads = 0;
  const deps = resources(config);
  const users: string[] = [];
  let bookingId: string | undefined;
  let orderId: string | undefined;
  let stripePayload: object = {};
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === 'string' && input === 'https://api.stripe.com/v1/checkout/sessions/cs_test_reconciliation') {
      gatewayReads++;
      assert.equal(init?.method, 'GET');
      return Promise.resolve(Response.json({ ...stripePayload, amount_total: matches ? 150000 : 100 }));
    }
    return originalFetch(input, init);
  });
  const { app } = await createApp(config, deps);

  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl() + '/api/v1/admin/payment-orders/';
    async function fixture(role: 'admin' | 'customer' | 'artist', verified = true) {
      const user = await deps.db.authUser.create({ data: {
        roles: [role], email: randomUUID() + '@stagelink.test', emailVerifiedAt: verified ? new Date() : null,
        displayName: 'Reconciliation fixture', passwordHash: 'unused',
      } });
      users.push(user.id);
      const session = await deps.db.authSession.create({ data: {
        userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600_000),
      } });
      const accessToken = await new SignJWT({ sid: session.id })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user.id)
        .setIssuer('stagelink-api').setAudience('stagelink-web').setIssuedAt().setExpirationTime('10m')
        .sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
      return { userId: user.id, headers: { Authorization: 'Bearer ' + accessToken } };
    }

    const admin = await fixture('admin');
    const unverified = await fixture('admin', false);
    const customer = await fixture('customer');
    const artist = await fixture('artist');
    const startsAt = new Date(Date.now() + 60_000);
    const booking = await deps.db.booking.create({ data: {
      customerId: customer.userId, providerId: artist.userId, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
      targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt, endsAt: new Date(Date.now() + 120_000),
      holdExpiresAt: startsAt, snapshot: {},
    } });
    bookingId = booking.id;
    const order = await deps.db.paymentOrder.create({ data: { bookingId, purpose: 'advance', amountMinor: 150000 } });
    orderId = order.id;
    const endpoint = base + order.id + '/reconciliation';
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, customer)).status, 403);
    assert.equal((await fetch(endpoint, unverified)).status, 403);
    assert.equal((await fetch(base + randomUUID() + '/reconciliation', admin)).status, 404);
    const empty = await fetch(endpoint, admin);
    assert.equal(empty.status, 200);
    assert.equal((await empty.json()).providerStatus, 'not_started');
    assert.equal(gatewayReads, 0);

    await deps.db.paymentOrder.update({ where: { id: order.id }, data: { status: 'pending' } });
    const expiresAt = new Date(Math.floor(Date.now() / 1000 + 2100) * 1000);
    const attempt = await deps.db.stripeAttempt.create({ data: {
      orderId, createdAt: new Date(), expiresAt, sessionId: 'cs_test_reconciliation', returnUrl: 'https://stage.test',
    } });
    stripePayload = {
      id: attempt.sessionId, client_reference_id: attempt.id, object: 'checkout.session', livemode: false,
      mode: 'payment', currency: 'lkr', status: 'complete', payment_status: 'paid',
      expires_at: expiresAt.getTime() / 1000, url: null, customer_details: { email: 'private@example.test' },
    };
    const observed = await fetch(endpoint, admin);
    assert.equal(observed.status, 200);
    const data = await observed.json();
    assert.deepEqual({ ...data, checkedAt: undefined }, {
      orderId, gateway: 'stripe', localStatus: 'pending', localCaptureRecorded: false,
      providerStatus: 'captured', assessment: 'needs_review', checkedAt: undefined,
    });
    assert.ok(!JSON.stringify(data).includes('private@example.test'));
    matches = false;
    assert.equal((await (await fetch(endpoint, admin)).json()).providerStatus, 'mismatch');
    assert.equal(gatewayReads, 2);
    assert.equal((await deps.db.paymentOrder.findUniqueOrThrow({ where: { id: orderId } })).status, 'pending');
    assert.equal((await deps.db.stripeAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).journalId, null);
    assert.equal(await deps.db.stripeEvent.count({ where: { attemptId: attempt.id } }), 0);
  } finally {
    try {
      if (orderId) {
        await deps.db.stripeAttempt.deleteMany({ where: { orderId } });
        await deps.db.paymentOrder.delete({ where: { id: orderId } });
      }
      if (bookingId) await deps.db.booking.delete({ where: { id: bookingId } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app.close();
    }
  }
});
