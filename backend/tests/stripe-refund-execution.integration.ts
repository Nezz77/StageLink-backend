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
  PAYHERE_SANDBOX_REFUND_EXECUTION: 'true', PAYHERE_SANDBOX_RETRIEVAL_APP_ID: 'fixture-app', PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET: 'fixture-secret',
});
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Stripe refund execution requires an isolated *_test database.');
}

test('approved sandbox refunds settle reserved funds once after exact authenticated evidence', async t => {
  const localFetch = globalThis.fetch;
  const checkoutSessions = new Map<string, object>();
  const providerRefunds = new Map<string, { id: string; status: string }>();
  const submissions: string[] = [];
  let payHereAttemptId: string | undefined;
  let payHereSubmissions = 0;
  let payHereStatus = 'RECEIVED';
  const paymentId = '320025071278';
  let release!: () => void;
  let sent!: () => void;
  const awaitResponse = new Promise<void>(resolve => { release = resolve; });
  const awaitingStripe = new Promise<void>(resolve => { sent = resolve; });

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === 'sandbox.payhere.lk') {
      if (url.pathname.endsWith('/oauth/token')) return Response.json({
        scope: 'SANDBOX', expires_in: 599, access_token: 'fixture-token', token_type: 'bearer',
      });
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-token');
      if (url.pathname.endsWith('/payment/search')) {
        assert.equal(url.searchParams.get('order_id'), payHereAttemptId);
        return Response.json({ status: 1, data: [{
          payment_id: paymentId, order_id: payHereAttemptId, currency: 'LKR', amount: '1500.01', status: payHereStatus,
        }] });
      }
      assert.equal(url.pathname, '/merchant/v1/payment/refund');
      assert.equal(init?.method, 'POST');
      const request = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(request).sort(), ['description', 'payment_id']);
      assert.equal(request.payment_id, paymentId);
      payHereSubmissions++;
      return Response.json({ status: 1, data: 560034010257 });
    }
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
    const outsider = await fixture('artist');
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

    async function reserve(purpose: 'advance' | 'deposit' | 'balance', gateway: 'stripe' | 'payhere' = 'stripe') {
      return deps.db.$transaction(async tx => {
        const order = await tx.paymentOrder.create({ data: { bookingId: booking.id, purpose, amountMinor: 150001, status: 'paid' } });
        if (gateway === 'stripe') {
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
        } else {
          const attempt = await tx.payHereAttempt.create({ data: {
            orderId: order.id, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
          } });
          payHereAttemptId = attempt.id;
          const journalId = await recordCapture(tx, order, 'payhere', attempt.id, 'paid', new Date());
          await tx.payHereEvent.create({ data: { attemptId: attempt.id, statusCode: '2', reportedPaymentId: paymentId, journalId } });
        }
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
    const now = Date.now();
    const periodStart = new Date(now - 86_400_000).toISOString().slice(0, 10);
    const periodEnd = new Date(now + 2 * 86_400_000).toISOString().slice(0, 10);
    const selection = '?from=' + periodStart + '&to=' + periodEnd;
    const dashboard = async (actor = artist, environment = 'sandbox') => {
      const response = await fetch(base + 'me/analytics' + selection + '&environment=' + environment, actor);
      assert.equal(response.status, 200);
      return response.json();
    };

    const waiting = submit(advance.id);
    await Promise.race([awaitingStripe, waiting.then(async response => assert.fail(await response.clone().text()))]);
    try {
      assert.equal((await (await submit(advance.id)).json()).state, 'processing');
    } finally { release(); }
    assert.equal((await (await waiting).json()).state, 'pending');
    assert.equal(await postedBalance(deps.db, advance.accountId), 150001n);
    const before = await dashboard();
    assert.equal(before.money.refundReservedMinor, '300002');
    assert.equal(before.settled.refundedMinor, '0');
    const settled = await (await submit(advance.id)).json();
    assert.equal(settled.state, 'succeeded');
    assert.deepEqual(await (await submit(advance.id)).json(), settled);
    assert.equal(await postedBalance(deps.db, advance.accountId), 0n);

    assert.equal((await (await submit(deposit.id)).json()).state, 'uncertain');
    assert.equal(await postedBalance(deps.db, deposit.accountId), 150001n);
    assert.equal((await (await submit(deposit.id)).json()).state, 'succeeded');
    assert.equal(await postedBalance(deps.db, deposit.accountId), 0n);
    assert.deepEqual(submissions, ['pi_service', 'pi_deposit']);
    const after = await dashboard();
    assert.equal(after.money.refundReservedMinor, '300002');
    assert.equal(after.settled.refundedMinor, '300002');
    const daily = after.days.reduce((sum: bigint, day: { settled: { refundedMinor: string } }) =>
      sum + BigInt(day.settled.refundedMinor), 0n);
    assert.equal(daily, 300002n);
    assert.equal((await dashboard(outsider)).settled.refundedMinor, '0');
    assert.equal((await dashboard(artist, 'live')).settled.refundedMinor, null);
    const aggregate = await fetch(base + 'admin/analytics' + selection, admin);
    assert.equal(aggregate.status, 200);
    assert.ok(BigInt((await aggregate.json()).settled.refundedMinor) >= 300002n);

    const rows = await deps.db.stripeRefundExecution.findMany({ where: { requestId: refund.id }, include: { settlement: true } });
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.actorId === admin.id && row.status === 'succeeded' &&
      row.settlement?.source === 'stripe.test.refund.settle' && row.settlement.reference === row.providerRefundId));
    const customerRefund = await (await fetch(base + 'bookings/' + booking.id + '/refund-requests', customer)).json();
    assert.ok(customerRefund.request.items.every((item: { stripeExecutionStatus: string }) => item.stripeExecutionStatus === 'succeeded'));

    const balance = await reserve('balance', 'payhere');
    const payHerePath = path(balance.id).replace(/stripe-execution$/, 'payhere-execution');
    const submitPayHere = () => fetch(payHerePath, { method: 'POST', headers: admin.headers, body: '{}' });
    const accepted = await submitPayHere();
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).state, 'pending');
    assert.equal(payHereSubmissions, 1);
    assert.equal(await postedBalance(deps.db, balance.accountId), 150001n);
    payHereStatus = 'REFUND PROCESSING';
    assert.equal((await (await submitPayHere()).json()).state, 'pending');
    assert.equal((await dashboard()).settled.refundedMinor, '300002');

    payHereStatus = 'REFUNDED';
    const payHereSettled = await (await submitPayHere()).json();
    assert.equal(payHereSettled.state, 'succeeded');
    assert.equal(payHereSubmissions, 1);
    assert.equal(await postedBalance(deps.db, balance.accountId), 0n);
    assert.deepEqual(await (await submitPayHere()).json(), payHereSettled);
    assert.equal((await dashboard()).settled.refundedMinor, '450003');
    const completedPayHere = await deps.db.payHereRefundExecution.findUniqueOrThrow({
      where: { id: payHereSettled.id }, include: { settlement: true },
    });
    assert.equal(completedPayHere.paymentId, paymentId);
    assert.equal(completedPayHere.providerRefundId, '560034010257');
    assert.equal(completedPayHere.settlement?.source, 'payhere.sandbox.refund.settle');
  } finally {
    release();
    try {
      if (refundId) {
        await deps.db.payHereRefundExecution.deleteMany({ where: { requestId: refundId } });
        await deps.db.stripeRefundExecution.deleteMany({ where: { requestId: refundId } });
        await deps.db.refundItem.deleteMany({ where: { requestId: refundId } });
        await deps.db.refundRequest.delete({ where: { id: refundId } });
      }
      if (bookingId) {
        await deps.db.payHereEvent.deleteMany({ where: { attempt: { order: { bookingId } } } });
        await deps.db.payHereAttempt.deleteMany({ where: { order: { bookingId } } });
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
