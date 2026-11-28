import assert from 'node:assert/strict';
import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { recordCapture } from '../api/src/payments/capture.js';
import { documentKey, processBookingDocuments } from '../shared/booking-documents.js';
import { readConfig } from '../shared/config.js';
import { databaseNow } from '../shared/database-clock.js';
import { MediaStore } from '../shared/media-store.js';
import { hasJournalSqlState, openAccount, postedBalance, postJournal } from '../shared/payments/journal.js';
import { resources } from '../shared/resources.js';
import { serverClock } from './fixtures/server-clock.js';

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
  let payHereAmount = '1500.01';
  const paymentId = '320025071278';
  let activePayHerePaymentId = paymentId;
  const firstProviderRefundId = randomInt(100_000_000_000, 900_000_000_000);
  let providerRefundId = firstProviderRefundId;
  let nextPayHerePaymentId = 320025071281;
  let payHereResponseGate: Promise<void> | undefined;
  let payHereSubmitted: (() => void) | undefined;
  let losePayHereResponse = false;
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
          payment_id: activePayHerePaymentId, order_id: payHereAttemptId, currency: 'LKR', amount: payHereAmount, status: payHereStatus,
          payment_method: payHereMethod ? { method: payHereMethod } : undefined,
        }] });
      }
      assert.equal(url.pathname, '/merchant/v1/payment/refund');
      assert.equal(init?.method, 'POST');
      const request = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(request).sort(), ['description', 'payment_id']);
      assert.equal(request.payment_id, activePayHerePaymentId);
      payHereSubmissions++;
      payHereSubmitted?.();
      if (payHereResponseGate) await payHereResponseGate;
      if (losePayHereResponse) return new Response(null, { status: 500 });
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
        id: 're_' + randomUUID().replaceAll('-', ''), status: intent === 'pi_service' ? 'pending' : 'succeeded',
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
    assert.equal(url.pathname, '/v1/refunds/' + providerRefunds.get('pi_service')!.id);
    return Response.json({ ...providerRefunds.get('pi_service'), status: 'succeeded' });
  });

  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const store = new MediaStore(config);
  const users: string[] = [];
  const bookingIds: string[] = [];
  let refundId: string | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl() + '/api/v1/';
    const refundReceipt = (executionId: string) => deps.db.bookingDocument.findFirstOrThrow({
      where: { kind: 'receipt', snapshot: { path: ['refundExecutionId'], equals: executionId } },
    });
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
        .setIssuer('stagelink-api').setAudience('stagelink-web').setIssuedAt(Math.floor(Date.now() / 1000) - 180).setExpirationTime('10m')
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

    async function reserve(
      purpose: 'advance' | 'deposit' | 'balance', gateway: 'stripe' | 'payhere' = 'stripe',
      targetBooking = booking, targetRefund = refund, capturedPaymentId = paymentId,
    ) {
      return deps.db.$transaction(async tx => {
        const order = await tx.paymentOrder.create({ data: { bookingId: targetBooking.id, purpose, amountMinor: 150001, status: 'paid' } });
        if (gateway === 'stripe') {
          await stripeCapture(tx, order, purpose === 'advance' ? 'pi_service' : 'pi_deposit');
        } else {
          await payHereCapture(tx, order, capturedPaymentId);
        }
        const fund = { currency: 'LKR', purpose: purpose === 'deposit' ? 'deposit' as const : 'service' as const };
        const available = await openAccount(tx, { ...fund, scope: 'sandbox:booking:' + targetBooking.id, kind: 'available' });
        const reserved = await openAccount(tx, { ...fund, scope: 'sandbox:refund:' + targetRefund.id + ':' + order.id, kind: 'reserved' });
        const reservationId = await postJournal(tx, { ...fund, source: 'refund.sandbox.reserve', reference: targetRefund.id + ':' + order.id }, [
          { accountId: available.id, amountMinor: -150001n }, { accountId: reserved.id, amountMinor: 150001n },
        ]);
        await tx.refundItem.create({ data: { requestId: targetRefund.id, orderId: order.id, amountMinor: 150001, reservationId } });
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
      await serverClock(120_000, async () => {
        const inFlight = (await (await fetch(path(advance.id), admin)).json()).execution;
        assert.equal(inFlight.state, 'processing');
        assert.deepEqual(await (await submit(advance.id)).json(), inFlight);
        assert.deepEqual(submissions, ['pi_service']);
      });
    } finally { release(); }
    assert.equal((await (await waiting).json()).state, 'pending');
    assert.equal(await postedBalance(deps.db, advance.accountId), 150001n);
    assert.equal(await deps.db.bookingDocument.count({
      where: { bookingId: booking.id, kind: 'receipt', snapshot: { path: ['disposition'], equals: 'refunded' } },
    }), 0);
    const before = await dashboard();
    assert.equal(before.money.refundReservedMinor, '300002');
    assert.equal(before.settled.refundedMinor, '0');
    const settled = await (await submit(advance.id)).json();
    assert.equal(settled.state, 'succeeded');
    assert.deepEqual(await (await submit(advance.id)).json(), settled);
    assert.equal(await postedBalance(deps.db, advance.accountId), 0n);

    const uncertainDeposit = await (await submit(deposit.id)).json();
    assert.equal(uncertainDeposit.state, 'uncertain');
    assert.equal(await postedBalance(deps.db, deposit.accountId), 150001n);
    const moment = await databaseNow(deps.db);
    await deps.db.stripeRefundExecution.update({
      where: { id: uncertainDeposit.id }, data: { createdAt: new Date(moment.getTime() - 23 * 3600_000 - 30_000) },
    });
    const observedDeposit = providerRefunds.get('pi_deposit');
    assert.ok(observedDeposit);
    providerRefunds.delete('pi_deposit');
    await serverClock(-120_000, async () => {
      const older = await (await submit(deposit.id)).json();
      assert.equal(older.state, 'uncertain');
      assert.equal(older.id, uncertainDeposit.id);
      assert.deepEqual(submissions, ['pi_service', 'pi_deposit']);
      assert.equal(await postedBalance(deps.db, deposit.accountId), 150001n);
    });
    providerRefunds.set('pi_deposit', observedDeposit);
    const settledDeposit = await (await submit(deposit.id)).json();
    assert.equal(settledDeposit.id, uncertainDeposit.id);
    assert.equal(settledDeposit.state, 'succeeded');
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
    const stripeRow = rows.find(row => row.id === settled.id)!;
    const stripeReceipt = await refundReceipt(stripeRow.id);
    assert.equal(stripeReceipt.sourceId, stripeRow.settlementId);
    assert.deepEqual(stripeReceipt.snapshot, {
      version: 2, kind: 'receipt', issuedAt: stripeRow.settlement!.postedAt!.toISOString(),
      orderId: advance.id, purpose: 'advance', amountMinor: 150001, gateway: 'Stripe',
      disposition: 'refunded', refundExecutionId: settled.id, journalId: stripeRow.settlementId, refundContext: 'cancellation',
    });
    for (const _ of [0, 1]) await processBookingDocuments(deps.db, store);
    const receiptPath = base + 'documents/' + stripeReceipt.id;
    const documents = await (await fetch(base + 'bookings/' + booking.id + '/documents', customer)).json();
    assert.ok(documents.items.some((item: { id: string }) => item.id === stripeReceipt.id));
    assert.deepEqual((await (await fetch(receiptPath, customer)).json()).snapshot, stripeReceipt.snapshot);
    assert.equal((await fetch(receiptPath + '/download', artist)).status, 404);
    assert.equal((await fetch(receiptPath + '/download', outsider)).status, 404);
    const pdf = await fetch(receiptPath + '/download', customer);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(pdf.headers.get('cache-control'), 'private, no-store');
    assert.match(Buffer.from(await pdf.arrayBuffer()).toString('latin1'), /^%PDF-/);
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
    assert.equal(completedPayHere.providerRefundId, String(firstProviderRefundId));
    assert.equal(completedPayHere.settlement?.source, 'payhere.sandbox.refund.settle');
    const payHereReceipt = await refundReceipt(completedPayHere.id);
    assert.deepEqual(payHereReceipt.snapshot, {
      version: 2, kind: 'receipt', issuedAt: completedPayHere.settlement!.postedAt!.toISOString(),
      orderId: balance.id, purpose: 'balance', amountMinor: 150001, gateway: 'PayHere',
      disposition: 'refunded', refundExecutionId: completedPayHere.id, journalId: completedPayHere.settlementId,
      refundContext: 'cancellation',
    });

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
    assert.equal(((await refundReceipt(damageSettlement.id)).snapshot as { refundContext: string }).refundContext, 'deposit_claim');
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
    providerRefundId = firstProviderRefundId + 1;
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

    async function arbitration(refundMinor: number, gateway: 'stripe' | 'payhere' = 'stripe') {
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
          if (gateway === 'payhere') await payHereCapture(tx, order, String(nextPayHerePaymentId++));
          else {
            await stripeCapture(tx, order, intent);
            refundAmounts.set(intent, Math.min(remaining, order.amountMinor));
          }
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
    for (const row of arbitrationRows) {
      const receipt = await refundReceipt(row.id);
      assert.equal(receipt.sourceId, row.settlementId);
      assert.deepEqual(receipt.snapshot, {
        version: 2, kind: 'receipt', issuedAt: row.settlement!.postedAt!.toISOString(),
        orderId: row.orderId, purpose: row.orderId === first.id ? 'advance' : 'balance',
        amountMinor: row.amountMinor, gateway: 'Stripe', disposition: 'refunded',
        refundExecutionId: row.id, journalId: row.settlementId, refundContext: 'arbitration',
      });
    }
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

    const payHereAdmin = await fixture('admin');
    const payHereArbitrationPath = (id: string, orderId: string) => arbitrationPath(id, orderId).replace(/stripe-refund$/, 'payhere-refund');
    const executePayHereArbitration = (id: string, orderId: string, actor = payHereAdmin) => fetch(payHereArbitrationPath(id, orderId), {
      method: 'POST', headers: actor.headers, body: '{}',
    });
    async function selectPayHerePayment(orderId: string) {
      const attempt = await deps.db.payHereAttempt.findUniqueOrThrow({
        where: { orderId }, include: { events: { where: { statusCode: '2' } } },
      });
      payHereAttemptId = attempt.id;
      activePayHerePaymentId = attempt.events[0]!.reportedPaymentId;
      payHereStatus = 'RECEIVED';
      payHereMethod = 'VISA';
      providerRefundId++;
      await deps.redis.del(`${config.AUTH_RATE_PREFIX}:reconciliation-gateway:${gatewayKey}`);
    }
    const payHereFull = await arbitration(300002, 'payhere');
    const firstPayHereOrder = payHereFull.orders[0]!;
    const beforePayHereArbitration = await dashboard(arbitrationProvider);
    const initialPayHereSubmissions = payHereSubmissions;
    assert.equal((await executePayHereArbitration(payHereFull.decision.id, firstPayHereOrder.id, customer)).status, 403);
    assert.equal((await (await executePayHereArbitration(payHereFull.decision.id, firstPayHereOrder.id, old)).json()).code, 'RECENT_LOGIN_REQUIRED');
    assert.equal((await executePayHereArbitration(payHereFull.decision.id, advance.id)).status, 404);
    assert.equal((await (await executeArbitration(payHereFull.decision.id, firstPayHereOrder.id)).json()).code, 'STRIPE_REFUND_NOT_ELIGIBLE');
    await selectPayHerePayment(firstPayHereOrder.id);
    payHereMethod = 'FRIMI';
    assert.equal((await (await executePayHereArbitration(payHereFull.decision.id, firstPayHereOrder.id)).json()).code, 'PAYHERE_CARD_PAYMENT_REQUIRED');
    assert.equal(payHereSubmissions, initialPayHereSubmissions);
    assert.equal((await (await fetch(payHereArbitrationPath(payHereFull.decision.id, firstPayHereOrder.id), payHereAdmin)).json()).execution, null);
    const payHerePartial = await arbitration(200001, 'payhere');
    const partialSource = payHerePartial.orders.find(order => order.purpose === 'balance')!;
    const readsBeforePartial = payHereReads;
    assert.equal((await (await executePayHereArbitration(payHerePartial.decision.id, partialSource.id)).json()).code, 'PAYHERE_PARTIAL_REFUND_UNAVAILABLE');
    assert.equal(payHereReads, readsBeforePartial);
    assert.equal(await reserveBalance(payHerePartial.decision.id, 'customer'), 200001n);

    for (const order of payHereFull.orders) {
      await selectPayHerePayment(order.id);
      if (order.id === firstPayHereOrder.id) {
        let refundReceived!: () => void;
        let releaseRefund!: () => void;
        const received = new Promise<void>(resolve => { refundReceived = resolve; });
        payHereResponseGate = new Promise<void>(resolve => { releaseRefund = resolve; });
        payHereSubmitted = refundReceived;
        const sending = executePayHereArbitration(payHereFull.decision.id, order.id);
        await Promise.race([received, sending.then(async response => assert.fail(await response.clone().text()))]);
        try {
          assert.equal((await (await executePayHereArbitration(payHereFull.decision.id, order.id)).json()).state, 'uncertain');
        } finally { releaseRefund(); }
        assert.equal((await (await sending).json()).state, 'pending');
        payHereResponseGate = undefined;
        payHereSubmitted = undefined;
      } else {
        assert.equal((await (await executePayHereArbitration(payHereFull.decision.id, order.id)).json()).state, 'pending');
      }
      payHereStatus = 'REFUND PROCESSING';
      assert.equal((await (await executePayHereArbitration(payHereFull.decision.id, order.id)).json()).state, 'pending');
      payHereStatus = 'REFUNDED';
      const settled = await (await executePayHereArbitration(payHereFull.decision.id, order.id)).json();
      assert.equal(settled.state, 'succeeded');
      assert.equal(settled.arbitrationId, payHereFull.decision.id);
      assert.deepEqual(await (await executePayHereArbitration(payHereFull.decision.id, order.id)).json(), settled);
    }
    assert.equal(payHereSubmissions - initialPayHereSubmissions, 2);
    assert.equal(await reserveBalance(payHereFull.decision.id, 'customer'), 0n);
    const payHereView = await (await fetch(base + 'arbitrations/' + payHereFull.decision.id, customer)).json();
    assert.equal(payHereView.execution, 'settled');
    assert.ok(payHereView.refundItems.every((item: { payHereRefundState: string }) => item.payHereRefundState === 'succeeded'));
    const payHereRows = await deps.db.payHereRefundExecution.findMany({ where: { arbitrationId: payHereFull.decision.id }, include: { settlement: true } });
    assert.equal(payHereRows.length, 2);
    assert.ok(payHereRows.every(row => row.settlement?.source === 'payhere.sandbox.refund.settle'));
    assert.equal(BigInt((await dashboard(arbitrationProvider)).settled.refundedMinor) - BigInt(beforePayHereArbitration.settled.refundedMinor), 300002n);

    const uncertainPayHere = await arbitration(150001, 'payhere');
    const uncertainSource = uncertainPayHere.orders.find(order => order.purpose === 'advance')!;
    const zeroSource = uncertainPayHere.orders.find(order => order.purpose === 'balance')!;
    assert.equal((await (await executePayHereArbitration(uncertainPayHere.decision.id, zeroSource.id)).json()).code, 'PAYHERE_REFUND_NOT_ELIGIBLE');
    await selectPayHerePayment(uncertainSource.id);
    losePayHereResponse = true;
    const beforeSubmission = await databaseNow(deps.db);
    const uncertain = await serverClock(120_000, async () =>
      (await executePayHereArbitration(uncertainPayHere.decision.id, uncertainSource.id)).json());
    assert.equal(uncertain.state, 'uncertain');
    const submittedAt = new Date(uncertain.createdAt);
    const uncertainAt = new Date(uncertain.updatedAt);
    assert.ok(submittedAt >= beforeSubmission && submittedAt <= uncertainAt && uncertainAt <= await databaseNow(deps.db));
    const afterUncertainSubmission = payHereSubmissions;
    assert.deepEqual(await (await executePayHereArbitration(uncertainPayHere.decision.id, uncertainSource.id)).json(), uncertain);
    assert.equal(payHereSubmissions, afterUncertainSubmission);
    assert.equal(await reserveBalance(uncertainPayHere.decision.id, 'customer'), 150001n);

    const recoveryAdmin = await fixture('admin');
    const recoveryPath = (id: string) => base + 'admin/payhere-refund-executions/' + id;
    const recoveryCommand = { requestKey: randomUUID(), expectedUpdatedAt: uncertain.updatedAt, reason: 'Reconcile the full refund after a lost gateway response.' };
    const recoverPayHere = (id: string, command = recoveryCommand, actor = recoveryAdmin) => fetch(recoveryPath(id) + '/recover', {
      method: 'POST', headers: actor.headers, body: JSON.stringify(command),
    });
    const resetPayHereLimit = () => deps.redis.del(`${config.AUTH_RATE_PREFIX}:reconciliation-gateway:${gatewayKey}`);
    assert.equal((await recoverPayHere(uncertain.id, recoveryCommand, customer)).status, 403);
    assert.equal((await (await recoverPayHere(uncertain.id, recoveryCommand, old)).json()).code, 'RECENT_LOGIN_REQUIRED');
    assert.equal((await recoverPayHere(uncertain.id, recoveryCommand, { ...recoveryAdmin, headers: { ...recoveryAdmin.headers, Origin: 'https://other.test' } })).status, 403);
    assert.equal((await recoverPayHere(uncertain.id, recoveryCommand, { ...recoveryAdmin, headers: { ...recoveryAdmin.headers, 'X-CSRF-Token': 'incorrect' } })).status, 403);
    assert.equal((await recoverPayHere(uncertain.id, { ...recoveryCommand, reason: 'short' })).status, 400);
    assert.equal((await recoverPayHere(randomUUID())).status, 404);
    assert.equal((await fetch(recoveryPath(uncertain.id) + '/recovery', customer)).status, 403);
    assert.equal((await (await fetch(recoveryPath(uncertain.id) + '/recovery', recoveryAdmin)).json()).recovery, null);
    const readsBeforeStale = payHereReads;
    assert.equal((await (await recoverPayHere(uncertain.id, { ...recoveryCommand, expectedUpdatedAt: new Date(0).toISOString() })).json()).code, 'PAYHERE_RECOVERY_NOT_ELIGIBLE');
    assert.equal(payHereReads, readsBeforeStale);
    for (const scenario of ['captured', 'wrong_payment', 'non_card', 'wrong_amount', 'chargeback']) {
      await resetPayHereLimit();
      const originalPaymentId = activePayHerePaymentId;
      payHereStatus = scenario === 'captured' ? 'RECEIVED' : scenario === 'chargeback' ? 'CHARGEBACKED' : 'REFUNDED';
      if (scenario === 'wrong_payment') activePayHerePaymentId = '999999999999';
      if (scenario === 'non_card') payHereMethod = 'FRIMI';
      if (scenario === 'wrong_amount') payHereAmount = '1500.00';
      const rejected = await recoverPayHere(uncertain.id);
      assert.equal((await rejected.json()).code, 'PAYHERE_REFUND_NOT_CONFIRMED', scenario);
      activePayHerePaymentId = originalPaymentId;
      payHereMethod = 'VISA';
      payHereAmount = '1500.01';
      assert.equal(await reserveBalance(uncertainPayHere.decision.id, 'customer'), 150001n);
      assert.equal(await deps.db.payHereRefundRecovery.count({ where: { executionId: uncertain.id } }), 0);
    }
    await resetPayHereLimit();
    payHereStatus = 'REFUNDED';
    const beforeRecovery = await databaseNow(deps.db);
    const recoveredResponses = await serverClock(-120_000, () =>
      Promise.all([recoverPayHere(uncertain.id), recoverPayHere(uncertain.id)]));
    for (const response of recoveredResponses) assert.equal(response.status, 200, await response.clone().text());
    const recoveries = await Promise.all(recoveredResponses.map(response => response.json()));
    assert.deepEqual(recoveries[0], recoveries[1]);
    const recovery = recoveries[0];
    assert.equal(recovery.actorId, recoveryAdmin.id);
    assert.equal(recovery.paymentId, activePayHerePaymentId);
    assert.equal(recovery.amountMinor, 150001);
    const observedAt = new Date(recovery.observedAt);
    const recoveredAt = new Date(recovery.createdAt);
    assert.ok(observedAt >= beforeRecovery && observedAt <= recoveredAt && recoveredAt <= await databaseNow(deps.db));
    assert.deepEqual(await (await recoverPayHere(uncertain.id)).json(), recovery);
    assert.deepEqual((await (await fetch(recoveryPath(uncertain.id) + '/recovery', recoveryAdmin)).json()).recovery, recovery);
    assert.equal((await (await recoverPayHere(uncertain.id, { ...recoveryCommand, reason: 'Changed reason for the recorded command.' })).json()).code, 'REQUEST_KEY_REUSED');
    assert.equal((await (await recoverPayHere(uncertain.id, { ...recoveryCommand, requestKey: randomUUID() })).json()).code, 'REQUEST_KEY_REUSED');
    const recoveredExecution = await deps.db.payHereRefundExecution.findUniqueOrThrow({ where: { id: uncertain.id }, include: { settlement: true } });
    assert.equal(recoveredExecution.status, 'succeeded');
    assert.equal(recoveredExecution.providerRefundId, null);
    assert.equal(recoveredExecution.settlementId, recovery.journalId);
    assert.equal(recoveredExecution.updatedAt.toISOString(), recovery.createdAt);
    assert.equal(recoveredExecution.settlement?.reference, 'recovery:' + uncertain.id);
    const recoveredReceipt = await refundReceipt(uncertain.id);
    assert.equal(recoveredReceipt.sourceId, recovery.journalId);
    // Rebuild a synthetic receipt using the routine shared by the trigger and historical backfill.
    await deps.db.$transaction(async tx => {
      const where = { bookingId: recoveredReceipt.bookingId, kind: 'receipt' as const, sourceId: recovery.journalId };
      const rebuild = (amountAdjustment: number) => tx.$queryRaw`
        SELECT record_sandbox_refund_receipt(
          id, order_id, settlement_id, amount_minor + ${amountAdjustment}::integer, 'payhere', damage_claim_id,
          arbitration_id, COALESCE(provider_refund_id, 'recovery:' || id::text)
        )::text FROM payhere_refund_executions WHERE id = ${uncertain.id}::uuid
      `;
      await tx.bookingDocument.delete({ where: { id: recoveredReceipt.id } });
      await rebuild(1);
      assert.equal(await tx.bookingDocument.count({ where }), 0);
      await rebuild(0);
      await rebuild(0);
      const matches = await tx.bookingDocument.findMany({ where });
      assert.equal(matches.length, 1);
      assert.deepEqual(matches[0]!.snapshot, recoveredReceipt.snapshot);
    });
    assert.equal(await reserveBalance(uncertainPayHere.decision.id, 'customer'), 0n);
    assert.equal(await deps.db.payHereRefundRecovery.count({ where: { executionId: uncertain.id } }), 1);
    await assert.rejects(deps.db.$executeRaw`
      UPDATE payhere_refund_recoveries SET payment_id = '999999999999' WHERE execution_id = ${uncertain.id}::uuid
    `, error => hasJournalSqlState(error, '23514'));
    await assert.rejects(deps.db.$executeRaw`
      DELETE FROM payhere_refund_recoveries WHERE execution_id = ${uncertain.id}::uuid
    `, error => hasJournalSqlState(error, '23514'));
    assert.equal(payHereSubmissions, afterUncertainSubmission);
    assert.equal((await (await executePayHereArbitration(uncertainPayHere.decision.id, uncertainSource.id)).json()).state, 'succeeded');
    assert.equal((await (await fetch(base + 'arbitrations/' + uncertainPayHere.decision.id, customer)).json()).refundItems.find((item: { orderId: string }) => item.orderId === uncertainSource.id).payHereRefundState, 'succeeded');
    assert.equal((await (await recoverPayHere(payHereRows[0]!.id, { ...recoveryCommand, expectedUpdatedAt: payHereRows[0]!.updatedAt.toISOString() })).json()).code, 'PAYHERE_RECOVERY_NOT_ELIGIBLE');

    const otherRecoveryAdmin = await fixture('admin');
    const lostDeposit = await createDamageClaim(0, String(nextPayHerePaymentId++));
    await resolveDamageClaim(lostDeposit.id);
    assert.ok(lostDeposit.depositOrderId);
    await selectPayHerePayment(lostDeposit.depositOrderId);
    const lostDepositExecution = await (await executePayHereClaim(lostDeposit.id, otherRecoveryAdmin)).json();
    assert.equal(lostDepositExecution.state, 'uncertain');
    const depositReservation = await deps.db.damageClaim.findUniqueOrThrow({ where: { id: lostDeposit.id } });
    await assert.rejects(deps.db.$executeRaw`
      UPDATE payhere_refund_executions SET status = 'succeeded', settlement_id = ${depositReservation.reservationId}::uuid
      WHERE id = ${lostDepositExecution.id}::uuid
    `, error => hasJournalSqlState(error, '23514'));
    payHereStatus = 'REFUNDED';
    const depositRecovery = await recoverPayHere(lostDepositExecution.id, {
      ...recoveryCommand, requestKey: randomUUID(), expectedUpdatedAt: lostDepositExecution.updatedAt,
    }, otherRecoveryAdmin);
    assert.equal(depositRecovery.status, 200);
    assert.equal(await postedBalance(deps.db, (await reserveAccount(lostDeposit.id, 'customer')).id), 0n);
    assert.equal((await (await fetch(base + 'bookings/' + lostDeposit.bookingId + '/damage-claim', customer)).json()).claim.payHereRefundState, 'succeeded');

    const cancelledBooking = await deps.db.booking.create({ data: {
      customerId: customer.id, providerId: artist.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
      targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt, holdExpiresAt: startsAt,
      endsAt: new Date(startsAt.getTime() + 3600_000), snapshot: {},
    } });
    bookingIds.push(cancelledBooking.id);
    const cancelledRefund = await deps.db.refundRequest.create({ data: {
      bookingId: cancelledBooking.id, status: 'approved', createdAt: new Date(), decidedAt: new Date(), decidedBy: admin.id,
      reason: 'Recover a cancelled booking refund.', decisionReason: 'Approved complete cancellation refund.',
    } });
    const cancelledPayment = await reserve('advance', 'payhere', cancelledBooking, cancelledRefund, String(nextPayHerePaymentId++));
    await selectPayHerePayment(cancelledPayment.id);
    const cancelledPath = base + 'admin/refund-requests/' + cancelledRefund.id + '/items/' + cancelledPayment.id + '/payhere-execution';
    const lostCancellation = await (await fetch(cancelledPath, { method: 'POST', headers: otherRecoveryAdmin.headers, body: '{}' })).json();
    assert.equal(lostCancellation.state, 'uncertain');
    payHereStatus = 'REFUNDED';
    assert.equal((await recoverPayHere(lostCancellation.id, {
      ...recoveryCommand, requestKey: randomUUID(), expectedUpdatedAt: lostCancellation.updatedAt,
    }, otherRecoveryAdmin)).status, 200);
    assert.equal(await postedBalance(deps.db, cancelledPayment.accountId), 0n);

    // A delayed submission response must preserve a recovery that settled while it was in flight.
    const racingAward = await arbitration(150001, 'payhere');
    const racingOrder = racingAward.orders.find(order => order.purpose === 'advance')!;
    await selectPayHerePayment(racingOrder.id);
    losePayHereResponse = false;
    let racingSubmitted!: () => void;
    let releaseRacing!: () => void;
    const racingReceived = new Promise<void>(resolve => { racingSubmitted = resolve; });
    payHereResponseGate = new Promise<void>(resolve => { releaseRacing = resolve; });
    payHereSubmitted = racingSubmitted;
    const racingSubmission = executePayHereArbitration(racingAward.decision.id, racingOrder.id, otherRecoveryAdmin);
    await Promise.race([racingReceived, racingSubmission.then(async response => assert.fail(await response.clone().text()))]);
    try {
      const racingExecution = (await (await fetch(payHereArbitrationPath(racingAward.decision.id, racingOrder.id), otherRecoveryAdmin)).json()).execution;
      assert.equal(racingExecution.state, 'uncertain');
      payHereStatus = 'REFUNDED';
      assert.equal((await recoverPayHere(racingExecution.id, {
        ...recoveryCommand, requestKey: randomUUID(), expectedUpdatedAt: racingExecution.updatedAt,
      }, otherRecoveryAdmin)).status, 200);
      assert.equal(await reserveBalance(racingAward.decision.id, 'customer'), 0n);
    } finally { releaseRacing(); }
    assert.equal((await (await racingSubmission).json()).state, 'succeeded');
    const racingRow = await deps.db.payHereRefundExecution.findUniqueOrThrow({ where: { arbitrationId_orderId: { arbitrationId: racingAward.decision.id, orderId: racingOrder.id } } });
    assert.equal(racingRow.status, 'succeeded');
    assert.equal(racingRow.providerRefundId, null);
    assert.ok(racingRow.settlementId);
  } finally {
    release();
    try {
      await deps.db.$transaction(async tx => {
        const recoveries = await tx.payHereRefundRecovery.findMany({ where: { actorId: { in: users } }, select: { executionId: true } });
        await tx.payHereRefundRecovery.deleteMany({ where: { actorId: { in: users } } });
        await tx.payHereRefundExecution.deleteMany({ where: { id: { in: recoveries.map(row => row.executionId) } } });
      });
      if (refundId) {
        await deps.db.payHereRefundExecution.deleteMany({ where: { requestId: refundId } });
        await deps.db.stripeRefundExecution.deleteMany({ where: { requestId: refundId } });
        await deps.db.refundItem.deleteMany({ where: { requestId: refundId } });
        await deps.db.refundRequest.delete({ where: { id: refundId } });
      }
      for (const bookingId of bookingIds) {
        await deps.db.payHereRefundExecution.deleteMany({ where: { item: { request: { bookingId } } } });
        await deps.db.stripeRefundExecution.deleteMany({ where: { item: { request: { bookingId } } } });
        await deps.db.refundItem.deleteMany({ where: { request: { bookingId } } });
        await deps.db.refundRequest.deleteMany({ where: { bookingId } });
        const arbitration = { decision: { dispute: { bookingId } } };
        await deps.db.stripeArbitrationFeeSettlement.deleteMany({ where: { arbitration: { dispute: { bookingId } } } });
        await deps.db.payHereRefundExecution.deleteMany({ where: { arbitrationSource: arbitration } });
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
        const rendered = await deps.db.bookingDocument.findMany({
          where: { bookingId, renderId: { not: null } }, select: { id: true, renderId: true },
        });
        await Promise.all(rendered.map(row => store.remove(documentKey(row.id, row.renderId!))));
        await deps.db.bookingDocument.deleteMany({ where: { bookingId } });
        await deps.db.bookingAgreement.deleteMany({ where: { bookingId } });
        await deps.db.bookingQuotation.deleteMany({ where: { bookingId } });
        await deps.db.bookingPayoutHold.deleteMany({ where: { bookingId } });
        await deps.db.paymentOrder.deleteMany({ where: { bookingId } });
        await deps.db.outboxEvent.deleteMany({ where: { payload: { path: ['sourceId'], equals: bookingId } } });
        await deps.db.booking.delete({ where: { id: bookingId } });
      }
      await deps.db.verificationCase.deleteMany({ where: { providerId: { in: users } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally { store.close(); await app.close(); }
  }
});
