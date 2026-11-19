import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
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
  STRIPE_TEST_REFUND_EXECUTION: 'true', STRIPE_TEST_PAYOUT_TRANSFERS: 'true',
  STRIPE_TEST_SECRET_KEY: 'sk_test_refund', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_refund',
  PAYHERE_SANDBOX_REFUND_EXECUTION: 'true', PAYHERE_SANDBOX_RETRIEVAL_APP_ID: 'fixture-app', PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET: 'fixture-secret',
});
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Stripe refund execution requires an isolated *_test database.');
}

test('approved sandbox refunds settle reserved funds once after exact authenticated evidence', async t => {
  const localFetch = globalThis.fetch;
  const checkoutSessions = new Map<string, object>();
  const providerRefunds = new Map<string, { id: string; status: string; amount: number }>();
  const captureAmounts = new Map<string, number>();
  let feeEvidenceUnavailable = false;
  let feeChargeDisputed = false;
  const submissions: string[] = [];
  const damageRefundMinor = 120001;
  const refundAmounts = new Map([['pi_service', 150001], ['pi_deposit', 150001], ['pi_damage', damageRefundMinor]]);
  let payHereAttemptId: string | undefined;
  let payHereSubmissions = 0;
  let payHereReads = 0;
  let payHereStatus = 'RECEIVED';
  let payHereMethod: string | undefined;
  const paymentId = '320025071278';
  let activePayHerePaymentId = paymentId;
  let providerRefundId = 560034010257;
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
        payHereReads++;
        assert.equal(url.searchParams.get('order_id'), payHereAttemptId);
        return Response.json({ status: 1, data: [{
          payment_id: activePayHerePaymentId, order_id: payHereAttemptId, currency: 'LKR', amount: '1500.01', status: payHereStatus,
          payment_method: payHereMethod ? { method: payHereMethod } : undefined,
        }] });
      }
      assert.equal(url.pathname, '/merchant/v1/payment/refund');
      assert.equal(init?.method, 'POST');
      const request = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(request).sort(), ['description', 'payment_id']);
      assert.equal(request.payment_id, activePayHerePaymentId);
      payHereSubmissions++;
      return Response.json({ status: 1, data: providerRefundId });
    }
    if (url.hostname !== 'api.stripe.com') return localFetch(input, init);
    if (url.pathname.startsWith('/v1/checkout/sessions/')) {
      return Response.json(checkoutSessions.get(url.pathname.split('/').at(-1)!));
    }
    if (url.pathname.startsWith('/v1/payment_intents/')) {
      if (feeEvidenceUnavailable) return new Response(null, { status: 503 });
      const id = url.pathname.split('/').at(-1)!;
      const amount = captureAmounts.get(id);
      assert.ok(amount);
      return Response.json({
        id, object: 'payment_intent', livemode: false, currency: 'lkr', amount_received: amount, status: 'succeeded',
        latest_charge: {
          object: 'charge', payment_intent: id, livemode: false, currency: 'lkr', paid: true, captured: true,
          disputed: feeChargeDisputed, amount_captured: amount, amount_refunded: providerRefunds.get(id)?.amount ?? 0,
        },
      });
    }
    if (url.pathname === '/v1/refunds' && init?.method === 'POST') {
      const body = init.body as URLSearchParams;
      const intent = body.get('payment_intent')!;
      const executionId = body.get('metadata[stagelink_refund_execution]')!;
      const amount = refundAmounts.get(intent);
      assert.ok(amount);
      assert.equal(body.get('amount'), String(amount));
      assert.equal(new Headers(init.headers).get('Idempotency-Key'), 'stagelink-refund-' + executionId);
      submissions.push(intent);
      const response = {
        id: intent.replace(/^pi_/, 're_'), status: intent === 'pi_service' ? 'pending' : 'succeeded',
        object: 'refund', amount, currency: 'lkr', payment_intent: intent, metadata: { stagelink_refund_execution: executionId },
      };
      providerRefunds.set(intent, response);
      if (intent !== 'pi_service') return new Response(null, { status: 500 });
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
  const bookingIds: string[] = [];
  let refundId: string | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl() + '/api/v1/';
    async function fixture(role: 'admin' | 'customer' | 'artist' | 'renter', recent = true) {
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
    bookingIds.push(booking.id);
    const refund = await deps.db.refundRequest.create({ data: {
      bookingId: booking.id, status: 'approved', createdAt: new Date(), decidedAt: new Date(), decidedBy: admin.id,
      reason: 'Customer refund fixture request', decisionReason: 'Authorized test refund fixture',
    } });
    refundId = refund.id;

    async function stripeCapture(tx: Parameters<typeof recordCapture>[0], order: Parameters<typeof recordCapture>[1], intent: string) {
      captureAmounts.set(intent, order.amountMinor);
      const sessionId = 'cs_test_' + randomUUID().replaceAll('-', '');
      const expiresAt = new Date(Math.floor(Date.now() / 1000 + 2100) * 1000);
      const journalId = await recordCapture(tx, order, 'stripe', sessionId, 'paid', new Date());
      const attempt = await tx.stripeAttempt.create({ data: {
        orderId: order.id, sessionId, journalId, createdAt: new Date(), expiresAt, returnUrl: 'https://stage.test',
      } });
      checkoutSessions.set(sessionId, {
        id: sessionId, client_reference_id: attempt.id, object: 'checkout.session', livemode: false, mode: 'payment',
        currency: 'lkr', amount_total: order.amountMinor, status: 'complete', payment_status: 'paid', url: null,
        expires_at: expiresAt.getTime() / 1000, payment_intent: intent,
      });
    }

    async function payHereCapture(tx: Parameters<typeof recordCapture>[0], order: Parameters<typeof recordCapture>[1], capturedPaymentId: string) {
      const attempt = await tx.payHereAttempt.create({ data: {
        orderId: order.id, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      } });
      const journalId = await recordCapture(tx, order, 'payhere', attempt.id, 'paid', new Date());
      await tx.payHereEvent.create({ data: { attemptId: attempt.id, statusCode: '2', reportedPaymentId: capturedPaymentId, journalId } });
      payHereAttemptId = attempt.id;
      activePayHerePaymentId = capturedPaymentId;
    }

    async function reserve(purpose: 'advance' | 'deposit' | 'balance', gateway: 'stripe' | 'payhere' = 'stripe') {
      return deps.db.$transaction(async tx => {
        const order = await tx.paymentOrder.create({ data: { bookingId: booking.id, purpose, amountMinor: 150001, status: 'paid' } });
        if (gateway === 'stripe') {
          await stripeCapture(tx, order, purpose === 'advance' ? 'pi_service' : 'pi_deposit');
        } else {
          await payHereCapture(tx, order, paymentId);
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

    const renter = await fixture('renter');
    async function createDamageClaim(deductionMinor: number, capturedPaymentId?: string) {
      const rental = await deps.db.booking.create({ data: {
        customerId: customer.id, providerId: renter.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
        targetKind: 'rental', targetId: randomUUID(), targetVersion: 1, startsAt, holdExpiresAt: startsAt,
        endsAt: new Date(startsAt.getTime() + 3600_000), snapshot: {},
      } });
      bookingIds.push(rental.id);
      return deps.db.$transaction(async tx => {
        const order = await tx.paymentOrder.create({ data: {
          bookingId: rental.id, purpose: 'deposit', amountMinor: 150001, status: 'paid',
        } });
        if (capturedPaymentId) await payHereCapture(tx, order, capturedPaymentId);
        else await stripeCapture(tx, order, 'pi_damage');
        const inspection = await tx.equipmentInspection.create({ data: {
          bookingId: rental.id, stage: 'quarantined', revision: 2, accessories: [],
        } });
        await tx.equipmentInspectionReport.create({ data: {
          inspectionId: inspection.id, revision: 2, phase: 'return', evidence: {}, submittedBy: renter.id,
          decidedBy: customer.id, decidedAt: new Date(), decision: 'acknowledged',
        } });
        return tx.damageClaim.create({ data: {
          bookingId: rental.id, inspectionId: inspection.id, reportRevision: 2, depositOrderId: order.id,
          depositMinor: order.amountMinor, proposedMinor: deductionMinor, reason: 'Deposit decision for the acknowledged return.',
        } });
      });
    }
    const claimPath = (claimId: string) => base + 'admin/damage-claims/' + claimId;
    async function resolveDamageClaim(claimId: string) {
      const acceptedClaim = await fetch(base + 'damage-claims/' + claimId + '/respond', {
        method: 'POST', headers: customer.headers, body: JSON.stringify({ response: 'accepted' }),
      });
      assert.equal(acceptedClaim.status, 200);
      const resolved = await fetch(claimPath(claimId) + '/resolve', {
        method: 'POST', headers: admin.headers, body: JSON.stringify({ approveDeduction: true, reason: 'Approve the reviewed deposit allocation.' }),
      });
      assert.equal(resolved.status, 200);
      return resolved.json();
    }
    const fund = { kind: 'reserved', currency: 'LKR', purpose: 'deposit' } as const;
    const reserveAccount = (claimId: string, recipient: 'customer' | 'provider') => deps.db.financialAccount.findFirstOrThrow({
      where: { ...fund, scope: 'sandbox:damage:' + claimId + ':' + recipient },
    });

    const deductionMinor = 30000;
    const claim = await createDamageClaim(deductionMinor);
    const damagePath = claimPath(claim.id);
    const executeDamage = (actor = admin) => fetch(damagePath + '/stripe-refund', { method: 'POST', headers: actor.headers, body: '{}' });
    const readDamage = () => fetch(damagePath + '/stripe-refund', admin);
    assert.equal((await executeDamage(customer)).status, 403);
    assert.equal((await (await executeDamage(old)).json()).code, 'RECENT_LOGIN_REQUIRED');
    assert.equal((await (await executeDamage()).json()).code, 'STRIPE_REFUND_NOT_ELIGIBLE');
    assert.equal((await (await readDamage()).json()).execution, null);
    assert.equal((await resolveDamageClaim(claim.id)).refundMinor, damageRefundMinor);
    const customerReserve = await reserveAccount(claim.id, 'customer');
    const providerReserve = await reserveAccount(claim.id, 'provider');
    assert.equal((await (await executeDamage()).json()).state, 'uncertain');
    assert.equal(await postedBalance(deps.db, customerReserve.id), BigInt(damageRefundMinor));
    const damageSettlement = await (await executeDamage()).json();
    assert.equal(damageSettlement.state, 'succeeded');
    assert.equal(damageSettlement.claimId, claim.id);
    assert.equal(damageSettlement.amountMinor, damageRefundMinor);
    assert.deepEqual(await (await executeDamage()).json(), damageSettlement);
    assert.deepEqual((await (await readDamage()).json()).execution, damageSettlement);
    assert.deepEqual(submissions, ['pi_service', 'pi_deposit', 'pi_damage']);
    assert.equal(await postedBalance(deps.db, customerReserve.id), 0n);
    assert.equal(await postedBalance(deps.db, providerReserve.id), BigInt(deductionMinor));
    assert.equal((await dashboard(renter)).settled.refundedMinor, String(damageRefundMinor));
    const participantView = await fetch(base + 'bookings/' + claim.bookingId + '/damage-claim', customer);
    assert.equal((await participantView.json()).claim.stripeRefundState, 'succeeded');

    // Simulate the next gateway rate-limit window after the cancellation scenario.
    const gatewayKey = createHmac('sha256', Buffer.from(config.AUTH_JWT_SECRET, 'hex')).update('payhere').digest('hex');
    await deps.redis.del(`${config.AUTH_RATE_PREFIX}:reconciliation-gateway:${gatewayKey}`);

    const payHereClaimPath = (claimId: string) => claimPath(claimId) + '/payhere-refund';
    const executePayHereClaim = (claimId: string, actor = admin) => fetch(payHereClaimPath(claimId), {
      method: 'POST', headers: actor.headers, body: '{}',
    });
    const beforeDeposit = payHereReads;
    const partial = await createDamageClaim(deductionMinor, '320025071279');
    assert.equal((await resolveDamageClaim(partial.id)).refundMinor, damageRefundMinor);
    assert.equal((await (await executePayHereClaim(partial.id)).json()).code, 'PAYHERE_PARTIAL_REFUND_UNAVAILABLE');
    assert.equal(await postedBalance(deps.db, (await reserveAccount(partial.id, 'customer')).id), BigInt(damageRefundMinor));
    assert.equal(await postedBalance(deps.db, (await reserveAccount(partial.id, 'provider')).id), BigInt(deductionMinor));
    assert.equal((await (await executePayHereClaim(claim.id)).json()).code, 'PAYHERE_REFUND_NOT_ELIGIBLE');

    const full = await createDamageClaim(0, '320025071280');
    assert.equal((await executePayHereClaim(full.id, customer)).status, 403);
    assert.equal((await (await executePayHereClaim(full.id)).json()).code, 'PAYHERE_REFUND_NOT_ELIGIBLE');
    assert.equal(payHereReads, beforeDeposit);
    assert.equal(payHereSubmissions, 1);
    assert.equal((await resolveDamageClaim(full.id)).refundMinor, 150001);
    const fullReserve = await reserveAccount(full.id, 'customer');
    payHereStatus = 'RECEIVED';
    payHereMethod = 'FRIMI';
    providerRefundId = 560034010258;
    assert.equal((await (await executePayHereClaim(full.id)).json()).code, 'PAYHERE_CARD_PAYMENT_REQUIRED');
    assert.equal((await (await fetch(payHereClaimPath(full.id), admin)).json()).execution, null);
    assert.equal(payHereSubmissions, 1);

    payHereMethod = 'VISA';
    const pending = await (await executePayHereClaim(full.id)).json();
    assert.equal(pending.state, 'pending');
    assert.equal(pending.claimId, full.id);
    assert.equal(pending.amountMinor, 150001);
    assert.equal(await postedBalance(deps.db, fullReserve.id), 150001n);
    payHereStatus = 'REFUNDED';
    const confirmed = await (await executePayHereClaim(full.id)).json();
    assert.equal(confirmed.state, 'succeeded');
    assert.deepEqual(await (await executePayHereClaim(full.id)).json(), confirmed);
    assert.deepEqual((await (await fetch(payHereClaimPath(full.id), admin)).json()).execution, confirmed);
    assert.equal(payHereSubmissions, 2);
    assert.equal(await postedBalance(deps.db, fullReserve.id), 0n);
    assert.equal((await dashboard(renter)).settled.refundedMinor, String(damageRefundMinor + 150001));
    const depositView = await (await fetch(base + 'bookings/' + full.bookingId + '/damage-claim', customer)).json();
    assert.equal(depositView.claim.payHereRefundState, 'succeeded');

    const arbitrationAdmin = await fixture('admin');
    const arbitrationProvider = await fixture('artist');
    const reviewedAt = new Date();
    const destination = { userId: arbitrationProvider.id, revision: 1, accountLast4: '1234', sealedDetails: 'fixture', status: 'approved' };
    await deps.db.payoutDestination.create({ data: destination });
    await deps.db.payoutDestinationVersion.create({ data: {
      ...destination, reviewerId: arbitrationAdmin.id, reviewedAt, reviewReason: 'Verified fixture payout destination.',
    } });
    await deps.db.verificationCase.create({ data: {
      providerId: arbitrationProvider.id, kind: 'artist', requestKey: randomUUID(), version: 1,
      subject: 'Arbitration provider identity', body: 'Verified fixture provider identity documents.',
      status: 'approved', createdAt: reviewedAt, decidedBy: arbitrationAdmin.id, decidedAt: reviewedAt, reason: 'Independent fixture identity review.',
    } });

    async function arbitration(refundMinor: number) {
      const booking = await deps.db.booking.create({ data: {
        customerId: customer.id, providerId: arbitrationProvider.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
        targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt, holdExpiresAt: startsAt,
        endsAt: new Date(startsAt.getTime() + 3600_000), agreedAt: reviewedAt, snapshot: {},
      } });
      bookingIds.push(booking.id);
      const quotation = await deps.db.bookingQuotation.create({ data: {
        bookingId: booking.id, version: 1, authorId: arbitrationProvider.id, lines: [], terms: 'Fixture agreement.', totalMinor: 300002,
      } });
      const artifact = JSON.stringify({ version: 1, currency: 'LKR', totalMinor: 300002, serviceAdvanceMinor: 150001, depositMinor: 0 });
      await deps.db.bookingAgreement.create({ data: {
        bookingId: booking.id, quotationId: quotation.id, artifact, digest: createHash('sha256').update(artifact).digest('hex'),
      } });
      const orders = [];
      let remaining = refundMinor;
      for (const purpose of ['advance', 'balance'] as const) {
        const order = await deps.db.$transaction(async tx => {
          const order = await tx.paymentOrder.create({ data: { bookingId: booking.id, purpose, amountMinor: 150001, status: 'paid' } });
          const intent = 'pi_arbitration_' + order.id.replaceAll('-', '');
          await stripeCapture(tx, order, intent);
          refundAmounts.set(intent, Math.min(remaining, order.amountMinor));
          remaining -= Math.min(remaining, order.amountMinor);
          return order;
        });
        orders.push(order);
      }
      const dispute = await fetch(base + 'bookings/' + booking.id + '/disputes', {
        method: 'POST', headers: customer.headers, body: JSON.stringify({ subject: 'Booking payment review', body: 'Please review the captured service payments for this booking.' }),
      });
      assert.equal(dispute.status, 200);
      const disputeId = (await dispute.json()).id;
      const mode = refundMinor === 300002 ? 'refund' : refundMinor === 0 ? 'provider' : 'split';
      const decision = await fetch(base + 'admin/disputes/' + disputeId + '/decisions', {
        method: 'POST', headers: arbitrationAdmin.headers,
        body: JSON.stringify({ mode, expectedHeldMinor: 300002, refundMinor, destinationRevision: 300002 - refundMinor > 15000 ? 1 : null,
          reason: 'Reviewed the captured payments and approved this allocation.', evidenceReviewed: true }),
      });
      assert.equal(decision.status, 200, await decision.clone().text());
      return { decision: await decision.json(), orders, bookingId: booking.id };
    }
    const arbitrationPath = (id: string, orderId: string) => base + 'admin/arbitrations/' + id + '/items/' + orderId + '/stripe-refund';
    const executeArbitration = (id: string, orderId: string, actor = arbitrationAdmin) => fetch(arbitrationPath(id, orderId), {
      method: 'POST', headers: actor.headers, body: '{}',
    });
    const reserveBalance = async (id: string, recipient: string) => {
      const account = await deps.db.financialAccount.findFirstOrThrow({
        where: { scope: 'sandbox:arbitration:' + id + ':' + recipient, purpose: 'service', kind: 'reserved' },
      });
      return postedBalance(deps.db, account.id);
    };
    const split = await arbitration(200001);
    const [first, second] = split.orders;
    assert.ok(first && second);
    assert.equal((await executeArbitration(split.decision.id, first.id, customer)).status, 403);
    assert.equal((await (await executeArbitration(split.decision.id, first.id, old)).json()).code, 'RECENT_LOGIN_REQUIRED');
    assert.equal((await executeArbitration(split.decision.id, advance.id)).status, 404);
    const initialView = await fetch(base + 'arbitrations/' + split.decision.id, customer);
    assert.ok((await initialView.json()).refundItems.every((item: { stripeRefundState: string | null }) => item.stripeRefundState === null));
    const initialExecutions = await Promise.all(split.orders.map(order => executeArbitration(split.decision.id, order.id)));
    assert.ok((await Promise.all(initialExecutions.map(response => response.json()))).every(value => value.state === 'uncertain'));
    assert.equal(await reserveBalance(split.decision.id, 'customer'), 200001n);
    const settlements = await Promise.all([first, second, first].map(order => executeArbitration(split.decision.id, order.id)));
    assert.ok((await Promise.all(settlements.map(response => response.json()))).every(value => value.state === 'succeeded' || value.state === 'processing'));
    assert.equal(await reserveBalance(split.decision.id, 'customer'), 0n);
    assert.equal(await reserveBalance(split.decision.id, 'fee'), BigInt(split.decision.feeMinor));
    assert.equal(await reserveBalance(split.decision.id, 'provider'), BigInt(split.decision.payoutMinor));
    const saved = await (await executeArbitration(split.decision.id, first.id)).json();
    assert.equal(saved.arbitrationId, split.decision.id);
    assert.deepEqual((await (await fetch(arbitrationPath(split.decision.id, first.id), arbitrationAdmin)).json()).execution, saved);
    const finalView = await (await fetch(base + 'arbitrations/' + split.decision.id, customer)).json();
    assert.ok(finalView.refundItems.every((item: { stripeRefundState: string }) => item.stripeRefundState === 'succeeded'));
    assert.equal((await fetch(base + 'arbitrations/' + split.decision.id, outsider)).status, 404);
    const arbitrationRows = await deps.db.stripeRefundExecution.findMany({ where: { arbitrationId: split.decision.id }, include: { settlement: true } });
    assert.equal(arbitrationRows.length, 2);
    assert.deepEqual(arbitrationRows.map(row => row.amountMinor).sort((a, b) => a - b), [50000, 150001]);
    assert.ok(arbitrationRows.every(row => row.settlement?.source === 'stripe.test.refund.settle'));
    assert.equal((await dashboard(arbitrationProvider)).settled.refundedMinor, '200001');

    const complete = await arbitration(300002);
    for (const order of complete.orders) {
      assert.equal((await (await executeArbitration(complete.decision.id, order.id)).json()).state, 'uncertain');
      assert.equal((await (await executeArbitration(complete.decision.id, order.id)).json()).state, 'succeeded');
    }
    assert.equal(await reserveBalance(complete.decision.id, 'customer'), 0n);
    assert.equal(await deps.db.stripeRefundExecution.count({ where: { arbitrationId: complete.decision.id } }), 2);
    const providerOnly = await arbitration(0);
    const countBeforeZero = submissions.length;
    for (const order of providerOnly.orders) {
      assert.equal((await (await executeArbitration(providerOnly.decision.id, order.id)).json()).code, 'STRIPE_REFUND_NOT_ELIGIBLE');
    }
    assert.equal(submissions.length, countBeforeZero);
    assert.equal(await reserveBalance(providerOnly.decision.id, 'provider'), BigInt(providerOnly.decision.payoutMinor));

    const feeAward = await arbitration(290002);
    assert.equal(feeAward.decision.feeMinor, 10000);
    assert.equal(feeAward.decision.payoutMinor, 0);
    const feePath = base + 'admin/arbitrations/' + feeAward.decision.id + '/stripe-fee';
    const settleFee = (actor = arbitrationAdmin) => fetch(feePath, { method: 'POST', headers: actor.headers, body: '{}' });
    assert.equal((await settleFee(customer)).status, 403);
    assert.equal((await (await settleFee(old)).json()).code, 'RECENT_LOGIN_REQUIRED');
    assert.equal((await settleFee()).status, 409);
    const refundAdmin = await fixture('admin');
    for (const order of feeAward.orders) {
      assert.equal((await (await executeArbitration(feeAward.decision.id, order.id, refundAdmin)).json()).state, 'uncertain');
      assert.equal((await (await executeArbitration(feeAward.decision.id, order.id, refundAdmin)).json()).state, 'succeeded');
    }
    feeEvidenceUnavailable = true;
    assert.deepEqual(await (await settleFee()).json(), { evidence: 'unavailable', settlement: null });
    assert.equal(await reserveBalance(feeAward.decision.id, 'fee'), 10000n);
    feeEvidenceUnavailable = false;
    const holdPath = base + 'admin/bookings/' + feeAward.bookingId + '/holds';
    const hold = async (expectedRevision: number, held: boolean) => fetch(holdPath, {
      method: 'POST', headers: arbitrationAdmin.headers, body: JSON.stringify({ expectedRevision, held, reason: 'Review the retained arbitration fee.' }),
    });
    assert.equal((await hold(0, true)).status, 200);
    assert.equal((await settleFee()).status, 409);
    assert.equal((await hold(1, false)).status, 200);
    const beforeFee = await dashboard(arbitrationProvider);
    const feeResults = await Promise.all([settleFee(), settleFee()]);
    assert.ok(feeResults.every(response => response.status === 200));
    const [fee, duplicateFee] = await Promise.all(feeResults.map(response => response.json()));
    assert.deepEqual(fee, duplicateFee);
    assert.equal(fee.evidence, 'verified');
    assert.equal(fee.settlement.state, 'settled');
    assert.equal(fee.settlement.amountMinor, 10000);
    assert.equal(await reserveBalance(feeAward.decision.id, 'fee'), 0n);
    assert.deepEqual((await (await fetch(feePath, arbitrationAdmin)).json()).settlement, fee.settlement);
    const feeView = () => fetch(base + 'arbitrations/' + feeAward.decision.id, customer).then(response => response.json());
    assert.equal((await feeView()).execution, 'settled');
    assert.equal((await feeView()).stripeFeeState, 'settled');
    assert.equal((await dashboard(arbitrationProvider)).settled.feeRevenueMinor, '10000');
    assert.equal((await dashboard(arbitrationProvider)).settled.paidOutMinor, beforeFee.settled.paidOutMinor);
    feeEvidenceUnavailable = true;
    assert.deepEqual(await (await settleFee()).json(), { evidence: 'unavailable', settlement: fee.settlement });
    feeEvidenceUnavailable = false;
    feeChargeDisputed = true;
    const reversedFee = await (await settleFee()).json();
    assert.equal(reversedFee.evidence, 'review_required');
    assert.equal(reversedFee.settlement.state, 'review_required');
    assert.ok(reversedFee.settlement.reversalJournalId);
    assert.deepEqual(await (await settleFee()).json(), reversedFee);
    assert.equal(await reserveBalance(feeAward.decision.id, 'fee'), 10000n);
    assert.equal((await feeView()).execution, 'review_required');
    assert.equal((await dashboard(arbitrationProvider)).settled.feeRevenueMinor, '0');
    assert.equal(await deps.db.payoutOrder.count({ where: { arbitrationId: feeAward.decision.id } }), 0);
  } finally {
    release();
    try {
      if (refundId) {
        await deps.db.payHereRefundExecution.deleteMany({ where: { requestId: refundId } });
        await deps.db.stripeRefundExecution.deleteMany({ where: { requestId: refundId } });
        await deps.db.refundItem.deleteMany({ where: { requestId: refundId } });
        await deps.db.refundRequest.delete({ where: { id: refundId } });
      }
      for (const bookingId of bookingIds) {
        const arbitration = { decision: { dispute: { bookingId } } };
        await deps.db.stripeArbitrationFeeSettlement.deleteMany({ where: { arbitration: { dispute: { bookingId } } } });
        await deps.db.stripeRefundExecution.deleteMany({ where: { arbitrationSource: arbitration } });
        await deps.db.arbitrationSource.deleteMany({ where: arbitration });
        await deps.db.arbitrationDecision.deleteMany({ where: { dispute: { bookingId } } });
        await deps.db.bookingDispute.deleteMany({ where: { bookingId } });
        await deps.db.stripeRefundExecution.deleteMany({ where: { damageClaim: { bookingId } } });
        await deps.db.payHereRefundExecution.deleteMany({ where: { damageClaim: { bookingId } } });
        await deps.db.damageClaim.deleteMany({ where: { bookingId } });
        await deps.db.equipmentInspectionReport.deleteMany({ where: { inspection: { bookingId } } });
        await deps.db.equipmentInspection.deleteMany({ where: { bookingId } });
        await deps.db.payHereEvent.deleteMany({ where: { attempt: { order: { bookingId } } } });
        await deps.db.payHereAttempt.deleteMany({ where: { order: { bookingId } } });
        await deps.db.stripeAttempt.deleteMany({ where: { order: { bookingId } } });
        await deps.db.bookingDocument.deleteMany({ where: { bookingId } });
        await deps.db.bookingAgreement.deleteMany({ where: { bookingId } });
        await deps.db.bookingQuotation.deleteMany({ where: { bookingId } });
        await deps.db.paymentOrder.deleteMany({ where: { bookingId } });
        await deps.db.outboxEvent.deleteMany({ where: { payload: { path: ['sourceId'], equals: bookingId } } });
        await deps.db.booking.delete({ where: { id: bookingId } });
      }
      await deps.db.verificationCase.deleteMany({ where: { providerId: { in: users } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally { await app.close(); }
  }
});
