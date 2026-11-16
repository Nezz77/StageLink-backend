import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const config = readConfig({
  ...process.env, AUTH_RATE_PREFIX: 'payment-recovery-test-' + randomUUID(),
  STRIPE_TEST_SECRET_KEY: 'sk_test_recovery', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_recovery',
  PAYHERE_SANDBOX_MERCHANT_ID: '1210000', PAYHERE_SANDBOX_MERCHANT_SECRET: 'fixture-secret',
  PAYHERE_SANDBOX_NOTIFY_URL: 'https://staging.test/api/v1/payments/webhooks/payhere',
  PAYHERE_SANDBOX_RETRIEVAL_APP_ID: 'fixture-app', PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET: 'fixture-secret',
});
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Payment recovery requires an isolated *_test database.');
}

test('confirmed sandbox recovery is audited, quarantined and idempotent against delayed callbacks', async t => {
  const localFetch = globalThis.fetch;
  const stripeSessions = new Map<string, Record<string, unknown>>();
  const payHereAmounts = new Map<string, string>();
  let amountMatches = false;
  let stripeReads = 0;
  const deps = resources(config);
  const ids: string[] = [];
  let bookingId: string | undefined;
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === 'api.stripe.com') {
      const session = stripeSessions.get(url.pathname.split('/').at(-1)!);
      assert.equal(init?.method, 'GET');
      assert.ok(session);
      stripeReads++;
      return Promise.resolve(Response.json({ ...session, amount_total: amountMatches ? 150001 : 150000 }));
    }
    if (url.hostname === 'sandbox.payhere.lk') {
      if (url.pathname.endsWith('/oauth/token')) {
        return Promise.resolve(Response.json({ access_token: 'fixture', token_type: 'bearer', expires_in: 599, scope: 'SANDBOX' }));
      }
      assert.equal(init?.method, 'GET');
      const orderId = url.searchParams.get('order_id')!;
      assert.ok(payHereAmounts.has(orderId));
      return Promise.resolve(Response.json({ status: 1, data: [{
        payment_id: '320025071278', order_id: orderId, status: 'RECEIVED', currency: 'LKR', amount: payHereAmounts.get(orderId),
      }] }));
    }
    return localFetch(input, init);
  });
  const { app } = await createApp(config, deps);

  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl() + '/api/v1/';
    async function fixture(role: 'admin' | 'customer' | 'artist') {
      const user = await deps.db.authUser.create({ data: {
        roles: [role], email: randomUUID() + '@stagelink.test', emailVerifiedAt: new Date(),
        displayName: 'Recovery fixture', passwordHash: 'unused',
      } });
      ids.push(user.id);
      const session = await deps.db.authSession.create({ data: {
        userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600_000),
      } });
      const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user.id)
        .setIssuer('stagelink-api').setAudience('stagelink-web').setIssuedAt().setExpirationTime('10m')
        .sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
      return {
        userId: user.id,
        headers: {
          Authorization: 'Bearer ' + token, Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json',
          'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id),
        },
      };
    }
    const admin = await fixture('admin');
    const customer = await fixture('customer');
    const artist = await fixture('artist');
    const startsAt = new Date(Date.now() + 60_000);
    const booking = await deps.db.booking.create({ data: {
      customerId: customer.userId, providerId: artist.userId, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
      targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt, endsAt: new Date(Date.now() + 120_000),
      holdExpiresAt: startsAt, snapshot: {},
    } });
    bookingId = booking.id;
    async function order(purpose: 'advance' | 'deposit' | 'balance') {
      return deps.db.paymentOrder.create({ data: { bookingId: booking.id, purpose, amountMinor: 150001, status: 'pending' } });
    }
    async function stripe(orderId: string, paid: boolean) {
      const sessionId = 'cs_test_' + randomUUID().replaceAll('-', '');
      const createdAt = new Date(Date.now() - 3600_000);
      const expiresAt = new Date(Math.floor(Date.now() / 1000 - 60) * 1000);
      const attempt = await deps.db.stripeAttempt.create({ data: {
        orderId, sessionId, createdAt, expiresAt, returnUrl: 'https://staging.test',
      } });
      const object = {
        id: sessionId, client_reference_id: attempt.id, object: 'checkout.session', livemode: false,
        mode: 'payment', amount_total: 150001, currency: 'lkr', status: paid ? 'complete' : 'expired',
        payment_status: paid ? 'paid' : 'unpaid', expires_at: expiresAt.getTime() / 1000, url: null,
      };
      stripeSessions.set(sessionId, object);
      return { attempt, object };
    }
    const recon = (id: string) => base + 'admin/payment-orders/' + id + '/reconciliation';
    const capture = { requestKey: randomUUID(), expectedOutcome: 'captured', reason: 'Gateway receipt verified after the callback was missed.' };
    const recover = (id: string, command: object, actor = admin) => fetch(recon(id) + '/recover', {
      method: 'POST', headers: actor.headers, body: JSON.stringify(command),
    });

    const advance = await order('advance');
    const checkout = await stripe(advance.id, true);
    assert.equal((await recover(advance.id, capture, customer)).status, 403);
    assert.equal((await recover(advance.id, capture, { ...admin, headers: { ...admin.headers, 'X-CSRF-Token': 'bad' } })).status, 403);
    assert.equal((await recover(advance.id, capture)).status, 409);
    assert.equal(await deps.db.paymentRecoveryAction.count({ where: { orderId: advance.id } }), 0);

    amountMatches = true;
    const responses = await Promise.all([recover(advance.id, capture), recover(advance.id, capture)]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    const actions = await Promise.all(responses.map(response => response.json()));
    const saved = actions[0];
    assert.deepEqual(actions[1], saved);
    assert.equal(saved.actorId, admin.userId);
    assert.equal(saved.previousStatus, 'pending');
    assert.equal(saved.outcome, 'captured');
    assert.ok(saved.journalId);
    assert.equal(await deps.db.paymentRecoveryAction.count({ where: { orderId: advance.id } }), 1);
    assert.deepEqual(await (await recover(advance.id, capture)).json(), saved);
    assert.equal((await recover(advance.id, { ...capture, reason: 'A different reason using the same key.' })).status, 409);
    assert.ok(stripeReads === 2 || stripeReads === 3);
    assert.deepEqual(await (await fetch(recon(advance.id) + '/recoveries', admin)).json(), { items: [saved] });

    const raw = JSON.stringify({
      id: 'evt_' + randomUUID().replaceAll('-', ''), type: 'checkout.session.completed',
      object: 'event', livemode: false, created: Math.floor(Date.now() / 1000), data: { object: checkout.object },
    });
    const now = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', config.STRIPE_TEST_WEBHOOK_SECRET!).update(now + '.' + raw).digest('hex');
    const delivered = await fetch(base + 'payments/webhooks/stripe', {
      method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=' + now + ',v1=' + signature },
    });
    assert.equal(delivered.status, 200);
    const stripeRow = await deps.db.stripeAttempt.findUniqueOrThrow({ where: { id: checkout.attempt.id } });
    assert.equal(stripeRow.journalId, saved.journalId);
    assert.equal(await deps.db.stripeEvent.count({ where: { attemptId: stripeRow.id } }), 1);

    const deposit = await order('deposit');
    const payhere = await deps.db.payHereAttempt.create({ data: {
      orderId: deposit.id, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    } });
    payHereAmounts.set(payhere.id, '1500.01');
    const recoveredDeposit = await recover(deposit.id, capture);
    assert.equal(recoveredDeposit.status, 200);
    const deposited = await recoveredDeposit.json();
    const signedFields = ['1210000', payhere.id, '1500.01', 'LKR', '2'];
    const md5 = (value: string) => createHash('md5').update(value).digest('hex').toUpperCase();
    const form = new URLSearchParams({
      merchant_id: signedFields[0]!, order_id: payhere.id, payhere_amount: signedFields[2]!, payhere_currency: 'LKR',
      payment_id: '320025071278', status_code: '2', md5sig: md5(signedFields.join('') + md5('fixture-secret')),
    });
    assert.equal((await fetch(base + 'payments/webhooks/payhere', { method: 'POST', body: form })).status, 200);
    const events = await deps.db.payHereEvent.findMany({ where: { attemptId: payhere.id } });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.source, 'retrieval');
    assert.equal(events[0]?.journalId, deposited.journalId);

    const balance = await order('balance');
    await stripe(balance.id, false);
    const expired = await recover(balance.id, { ...capture, expectedOutcome: 'expired' });
    assert.equal(expired.status, 200);
    assert.equal((await expired.json()).journalId, null);
    const recoveredOrders = await deps.db.paymentOrder.findMany({ where: { bookingId: booking.id } });
    const states = new Map(recoveredOrders.map(item => [item.purpose, item.status]));
    assert.deepEqual(states, new Map([['advance', 'review'], ['deposit', 'review'], ['balance', 'cancelled']]));

    const postings = await deps.db.journalEntry.findMany({
      where: { transactionId: { in: [saved.journalId, deposited.journalId] }, amountMinor: { gt: 0n } },
      include: { account: true },
    });
    assert.equal(postings.length, 2);
    assert.deepEqual(postings.map(item => item.account.scope).sort(), [advance.id, deposit.id].sort().map(id => 'sandbox:review:' + id));
    assert.equal(await deps.db.bookingDocument.count({ where: { bookingId: booking.id, kind: 'receipt' } }), 2);
  } finally {
    try {
      if (bookingId) {
        const orders = { bookingId };
        await deps.db.paymentRecoveryAction.deleteMany({ where: { order: orders } });
        await deps.db.stripeEvent.deleteMany({ where: { attempt: { order: orders } } });
        await deps.db.stripeAttempt.deleteMany({ where: { order: orders } });
        await deps.db.payHereEvent.deleteMany({ where: { attempt: { order: orders } } });
        await deps.db.payHereAttempt.deleteMany({ where: { order: orders } });
        await deps.db.bookingDocument.deleteMany({ where: { bookingId } });
        await deps.db.paymentOrder.deleteMany({ where: orders });
        await deps.db.outboxEvent.deleteMany({ where: { payload: { path: ['sourceId'], equals: bookingId } } });
        await deps.db.booking.delete({ where: { id: bookingId } });
      }
      await deps.db.authUser.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await app.close();
    }
  }
});
