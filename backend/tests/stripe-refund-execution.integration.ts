import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { recordCapture } from '../api/src/payments/capture.js';
import { readConfig } from '../shared/config.js';
import { openAccount, postedBalance, postJournal } from '../shared/payments/journal.js';
import { resources } from '../shared/resources.js';

const config = readConfig({
  ...process.env, AUTH_RATE_PREFIX: 'stripe-refund-test-' + randomUUID(),
  STRIPE_TEST_REFUND_EXECUTION: 'true', STRIPE_TEST_SECRET_KEY: 'sk_test_refund', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_refund',
});
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Stripe refund execution requires an isolated *_test database.');
}

test('approved Stripe refunds settle reserved funds once after exact authenticated evidence', async t => {
  const localFetch = globalThis.fetch;
  const checkoutSessions = new Map<string, object>();
  const providerRefunds = new Map<string, { id: string; status: string }>();
  const submissions: string[] = [];
  let release!: () => void;
  let sent!: () => void;
  const awaitResponse = new Promise<void>(resolve => { release = resolve; });
  const awaitingStripe = new Promise<void>(resolve => { sent = resolve; });

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== 'api.stripe.com') return localFetch(input, init);
    if (url.pathname.startsWith('/v1/checkout/sessions/')) {
      return Response.json(checkoutSessions.get(url.pathname.split('/').at(-1)!));
    }
    if (url.pathname === '/v1/refunds' && init?.method === 'POST') {
      const body = init.body as URLSearchParams;
      const intent = body.get('payment_intent')!;
      const executionId = body.get('metadata[stagelink_refund_execution]')!;
      assert.equal(body.get('amount'), '150001');
      assert.equal(new Headers(init.headers).get('Idempotency-Key'), 'stagelink-refund-' + executionId);
      submissions.push(intent);
      const response = {
        id: intent === 'pi_service' ? 're_service' : 're_deposit', status: intent === 'pi_service' ? 'pending' : 'succeeded',
        object: 'refund', amount: 150001, currency: 'lkr', payment_intent: intent, metadata: { stagelink_refund_execution: executionId },
      };
      providerRefunds.set(intent, response);
      if (intent === 'pi_deposit') return new Response(null, { status: 500 });
      sent();
      await awaitResponse;
      return Response.json(response);
    }
    if (url.pathname === '/v1/refunds') {
      const matching = providerRefunds.get(url.searchParams.get('payment_intent')!);
      return Response.json({ object: 'list', has_more: false, data: matching ? [matching] : [] });
    }
    assert.equal(url.pathname, '/v1/refunds/re_service');
    return Response.json({ ...providerRefunds.get('pi_service'), status: 'succeeded' });
  });

  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const users: string[] = [];
  let bookingId: string | undefined;
  let refundId: string | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl() + '/api/v1/';
    async function fixture(role: 'admin' | 'customer' | 'artist', recent = true) {
      const user = await deps.db.authUser.create({ data: {
        roles: [role], email: randomUUID() + '@stagelink.test', emailVerifiedAt: new Date(), displayName: 'Stripe fixture', passwordHash: 'unused',
      } });
      users.push(user.id);
      const session = await deps.db.authSession.create({ data: {
        userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600_000),
        createdAt: recent ? new Date() : new Date(Date.now() - 20 * 60_000),
      } });
      const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user.id)
        .setIssuer('stagelink-api').setAudience('stagelink-web').setIssuedAt().setExpirationTime('10m')
        .sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
      return { id: user.id, headers: {
        Authorization: 'Bearer ' + token, Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json',
        'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id),
      } };
    }
    const admin = await fixture('admin');
    const old = await fixture('admin', false);
    const customer = await fixture('customer');
    const artist = await fixture('artist');
    const startsAt = new Date(Date.now() + 3600_000);
    const booking = await deps.db.booking.create({ data: {
      customerId: customer.id, providerId: artist.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
      targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt, holdExpiresAt: startsAt,
      endsAt: new Date(startsAt.getTime() + 3600_000), snapshot: {},
    } });
    bookingId = booking.id;
    const refund = await deps.db.refundRequest.create({ data: {
      bookingId, status: 'approved', createdAt: new Date(), decidedAt: new Date(), decidedBy: admin.id,
      reason: 'Customer refund fixture request', decisionReason: 'Authorized test refund fixture',
    } });
    refundId = refund.id;

    async function reserve(purpose: 'advance' | 'deposit') {
      return deps.db.$transaction(async tx => {
        const order = await tx.paymentOrder.create({ data: { bookingId: booking.id, purpose, amountMinor: 150001, status: 'paid' } });
        const sessionId = 'cs_test_' + randomUUID().replaceAll('-', '');
        const expiresAt = new Date(Math.floor(Date.now() / 1000 + 2100) * 1000);
        const journalId = await recordCapture(tx, order, 'stripe', sessionId, 'paid', new Date());
        const attempt = await tx.stripeAttempt.create({ data: {
          orderId: order.id, sessionId, journalId, createdAt: new Date(), expiresAt, returnUrl: 'https://stage.test',
        } });
        checkoutSessions.set(sessionId, {
          id: sessionId, client_reference_id: attempt.id, object: 'checkout.session', livemode: false, mode: 'payment',
          currency: 'lkr', amount_total: 150001, status: 'complete', payment_status: 'paid', url: null,
          expires_at: expiresAt.getTime() / 1000, payment_intent: purpose === 'advance' ? 'pi_service' : 'pi_deposit',
        });
        const fund = { currency: 'LKR', purpose: purpose === 'deposit' ? 'deposit' as const : 'service' as const };
        const available = await openAccount(tx, { ...fund, scope: 'sandbox:booking:' + booking.id, kind: 'available' });
        const reserved = await openAccount(tx, { ...fund, scope: 'sandbox:refund:' + refund.id + ':' + order.id, kind: 'reserved' });
        const reservationId = await postJournal(tx, { ...fund, source: 'refund.sandbox.reserve', reference: refund.id + ':' + order.id }, [
          { accountId: available.id, amountMinor: -150001n }, { accountId: reserved.id, amountMinor: 150001n },
        ]);
        await tx.refundItem.create({ data: { requestId: refund.id, orderId: order.id, amountMinor: 150001, reservationId } });
        return { id: order.id, accountId: reserved.id };
      });
    }
    const advance = await reserve('advance');
    const deposit = await reserve('deposit');
    const path = (id: string) => base + 'admin/refund-requests/' + refund.id + '/items/' + id + '/stripe-execution';
    const submit = (id: string, actor = admin) => fetch(path(id), { method: 'POST', headers: actor.headers, body: '{}' });
    assert.equal((await submit(advance.id, customer)).status, 403);
    assert.equal((await (await submit(advance.id, old)).json()).code, 'RECENT_LOGIN_REQUIRED');
    assert.equal((await (await fetch(path(advance.id), admin)).json()).execution, null);

    const waiting = submit(advance.id);
    await Promise.race([awaitingStripe, waiting.then(async response => assert.fail(await response.clone().text()))]);
    try {
      assert.equal((await (await submit(advance.id)).json()).state, 'processing');
    } finally { release(); }
    assert.equal((await (await waiting).json()).state, 'pending');
    assert.equal(await postedBalance(deps.db, advance.accountId), 150001n);
    const settled = await (await submit(advance.id)).json();
    assert.equal(settled.state, 'succeeded');
    assert.deepEqual(await (await submit(advance.id)).json(), settled);
    assert.equal(await postedBalance(deps.db, advance.accountId), 0n);

    assert.equal((await (await submit(deposit.id)).json()).state, 'uncertain');
    assert.equal(await postedBalance(deps.db, deposit.accountId), 150001n);
    assert.equal((await (await submit(deposit.id)).json()).state, 'succeeded');
    assert.equal(await postedBalance(deps.db, deposit.accountId), 0n);
    assert.deepEqual(submissions, ['pi_service', 'pi_deposit']);

    const rows = await deps.db.stripeRefundExecution.findMany({ where: { requestId: refund.id }, include: { settlement: true } });
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.actorId === admin.id && row.status === 'succeeded' &&
      row.settlement?.source === 'stripe.test.refund.settle' && row.settlement.reference === row.providerRefundId));
    const customerRefund = await (await fetch(base + 'bookings/' + booking.id + '/refund-requests', customer)).json();
    assert.ok(customerRefund.request.items.every((item: { stripeExecutionStatus: string }) => item.stripeExecutionStatus === 'succeeded'));
  } finally {
    release();
    try {
      if (refundId) {
        await deps.db.stripeRefundExecution.deleteMany({ where: { requestId: refundId } });
        await deps.db.refundItem.deleteMany({ where: { requestId: refundId } });
        await deps.db.refundRequest.delete({ where: { id: refundId } });
      }
      if (bookingId) {
        await deps.db.stripeAttempt.deleteMany({ where: { order: { bookingId } } });
        await deps.db.bookingDocument.deleteMany({ where: { bookingId } });
        await deps.db.paymentOrder.deleteMany({ where: { bookingId } });
        await deps.db.outboxEvent.deleteMany({ where: { payload: { path: ['sourceId'], equals: bookingId } } });
        await deps.db.booking.delete({ where: { id: bookingId } });
      }
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally { await app.close(); }
  }
});
