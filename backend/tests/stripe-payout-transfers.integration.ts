import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { recordCapture } from '../api/src/payments/capture.js';
import { issueDocument } from '../shared/booking-documents.js';
import { readConfig } from '../shared/config.js';
import { openAccount, postedBalance, postJournal } from '../shared/payments/journal.js';
import { resources } from '../shared/resources.js';

const testConfig = readConfig({
  ...process.env,
  STRIPE_TEST_PAYOUT_TRANSFERS: 'true', STRIPE_TEST_SECRET_KEY: 'sk_test_transfer', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_transfer',
});
if (testConfig.NODE_ENV !== 'test' || !new URL(testConfig.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Stripe payout transfers require an isolated *_test database.');
}

test('a fully reversed test transfer can authorize one new attempt using the original reserve', t =>
  checkPayoutReconciliation(t));
test('a transfer already partially reversed at first confirmation records both journal movements', t =>
  checkPayoutReconciliation(t, { initialReversedMinor: 1000 }));
test('a definitive Stripe test balance rejection preserves the reserve for an authorized retry', t =>
  checkPayoutReconciliation(t, { rejectFirst: true }));
test('signed Stripe transfer events reconcile a lost response and ignore duplicate or stale reversals', t =>
  checkPayoutReconciliation(t, { useWebhooks: true }));

async function checkPayoutReconciliation(
  t: TestContext,
  { initialReversedMinor = 0, rejectFirst = false, useWebhooks = false }:
    { initialReversedMinor?: number; rejectFirst?: boolean; useWebhooks?: boolean } = {},
) {
  const config = { ...testConfig, AUTH_RATE_PREFIX: 'stripe-transfer-test-' + randomUUID() };
  const localFetch = globalThis.fetch;
  const sessions = new Map<string, object>();
  const stripeId = 'acct_' + randomUUID().replaceAll('-', '');
  let platformAccountId = 'acct_platform';
  let disputed = false;
  let cardBalanceMinor = 100000;
  let reversedMinor = 0;
  let bankPayoutStatus = 'paid';
  let transfer: Record<string, unknown> | null = null;
  let submissions = 0;
  const idempotencyKeys = new Set<string>();
  let sent!: () => void;
  let release!: () => void;
  const sending = new Promise<void>(resolve => { sent = resolve; });
  const waitForResponse = new Promise<void>(resolve => { release = resolve; });

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== 'api.stripe.com') return localFetch(input, init);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer sk_test_transfer');
    if (url.pathname === '/v1/payouts/po_fixture' || url.pathname === '/v1/balance_transactions') {
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).get('Stripe-Account'), stripeId);
      if (url.pathname === '/v1/payouts/po_fixture') {
        return Response.json({
          id: 'po_fixture', object: 'payout', livemode: false, status: bankPayoutStatus, automatic: true,
          method: 'standard', type: 'bank_account', amount: 105000, currency: 'lkr',
          destination: 'ba_fixture', reconciliation_status: 'completed',
        });
      }
      assert.equal(url.searchParams.get('payout'), 'po_fixture');
      assert.equal(url.searchParams.get('source'), 'py_fixture');
      return Response.json({
        object: 'list', has_more: false, data: [{
          id: 'txn_fixture', object: 'balance_transaction', source: 'py_fixture',
          amount: 95000, net: 95000, currency: 'lkr', status: 'available',
        }],
      });
    }
    assert.equal(new Headers(init?.headers).get('Stripe-Account'), null);
    if (url.pathname === '/v1/account' || url.pathname === '/v1/accounts/' + stripeId) {
      return Response.json({
        object: 'account', id: url.pathname === '/v1/account' ? platformAccountId : stripeId, country: 'US',
        charges_enabled: true, payouts_enabled: true, controller: { is_controller: true }, capabilities: { transfers: 'active' },
      });
    }
    if (url.pathname === '/v1/balance') {
      return Response.json({
        object: 'balance', livemode: false,
        available: [{ currency: 'lkr', amount: 100000, source_types: { card: cardBalanceMinor } }],
      });
    }
    if (url.pathname.startsWith('/v1/checkout/sessions/')) {
      return Response.json(sessions.get(url.pathname.split('/').at(-1)!));
    }
    if (url.pathname.startsWith('/v1/payment_intents/')) {
      const id = url.pathname.split('/').at(-1)!;
      assert.equal(url.searchParams.get('expand[]'), 'latest_charge');
      return Response.json({
        object: 'payment_intent', id, livemode: false, currency: 'lkr', amount_received: 50000, status: 'succeeded',
        latest_charge: {
          object: 'charge', payment_intent: id, livemode: false, currency: 'lkr',
          paid: true, captured: true, disputed, amount_captured: 50000, amount_refunded: 0,
        },
      });
    }
    if (url.pathname === '/v1/transfers' && init?.method === 'POST') {
      const body = init.body as URLSearchParams;
      const executionId = body.get('metadata[stagelink_payout_transfer]')!;
      assert.equal(body.get('amount'), '95000');
      assert.equal(body.get('destination'), stripeId);
      const key = new Headers(init.headers).get('Idempotency-Key');
      assert.equal(key, 'stagelink-payout-' + executionId);
      idempotencyKeys.add(key!);
      submissions++;
      if (rejectFirst && submissions === 1) {
        sent();
        await waitForResponse;
        return Response.json({ error: { type: 'invalid_request_error', code: 'balance_insufficient' } }, {
          status: 400, headers: { 'Request-Id': 'req_transferFixture' },
        });
      }
      transfer = {
        id: 'tr_' + executionId.replaceAll('-', ''), object: 'transfer', amount: 95000, currency: 'lkr',
        destination: stripeId, destination_payment: 'py_fixture', transfer_group: body.get('transfer_group'), livemode: false,
        metadata: { stagelink_payout_transfer: executionId }, reversed: false, amount_reversed: 0,
      };
      if (submissions > 1) return Response.json(transfer);
      sent();
      await waitForResponse;
      return new Response(null, { status: 500 });
    }
    const observedTransfer = { ...transfer, amount_reversed: reversedMinor, reversed: reversedMinor === 95000 };
    if (url.pathname === '/v1/transfers') {
      assert.equal(url.searchParams.get('transfer_group'), transfer?.transfer_group);
      assert.equal(url.searchParams.get('destination'), stripeId);
      return Response.json({ object: 'list', has_more: false, data: transfer ? [observedTransfer] : [] });
    }
    assert.equal(url.pathname, '/v1/transfers/' + transfer?.id);
    return Response.json(observedTransfer);
  });

  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const users: string[] = [];
  let bookingId: string | undefined;
  let payoutId: string | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl() + '/api/v1/';
    async function fixture(role: 'admin' | 'customer' | 'artist') {
      const user = await deps.db.authUser.create({ data: {
        roles: [role], email: randomUUID() + '@stagelink.test', emailVerifiedAt: new Date(),
        displayName: 'Transfer fixture', passwordHash: 'unused',
      } });
      users.push(user.id);
      const session = await deps.db.authSession.create({ data: {
        userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600_000),
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
    const customer = await fixture('customer');
    const provider = await fixture('artist');
    const now = new Date();
    const startsAt = new Date(now.getTime() - 7200_000);
    const booking = await deps.db.booking.create({ data: {
      customerId: customer.id, providerId: provider.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
      targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt, holdExpiresAt: startsAt,
      endsAt: new Date(now.getTime() - 3600_000), snapshot: {},
    } });
    bookingId = booking.id;
    await deps.db.bookingCompletion.create({ data: {
      bookingId, reportedBy: provider.id, reportedAt: now, verifiedBy: admin.id, verifiedAt: now,
      verificationReason: 'Independent fixture review approved.', originalMinor: 100000, advanceMinor: 50000,
      overtimeMinor: 0, overtimeMinutes: 0, balanceMinor: 50000, platformFeeMinor: 5000,
    } });
    const dest = { userId: provider.id, revision: 1, accountLast4: '1234', sealedDetails: 'fixture', status: 'approved' };
    await deps.db.payoutDestination.create({ data: dest });
    await deps.db.payoutDestinationVersion.create({
      data: { ...dest, reviewerId: admin.id, reviewedAt: now, reviewReason: 'Independent fixture review approved.' },
    });
    await deps.db.verificationCase.create({ data: {
      providerId: provider.id, kind: 'artist', requestKey: randomUUID(), version: 1,
      subject: 'Provider fixture identity', body: 'Fixture documentation for provider identity.',
      status: 'approved', createdAt: now, decidedBy: admin.id, decidedAt: now, reason: 'Independent fixture review approved.',
    } });
    const link = await deps.db.stripePayoutDestinationLink.create({ data: {
      providerId: provider.id, destinationRevision: 1, platformAccountId: 'acct_platform', stripeAccountId: stripeId,
      accountCountry: 'US', linkedBy: admin.id, requestKey: randomUUID(), reason: 'Verified the provider account.',
    } });

    const reserved = await deps.db.$transaction(async tx => {
      for (const purpose of ['advance', 'balance'] as const) {
        const order = await tx.paymentOrder.create({ data: { bookingId: booking.id, purpose, amountMinor: 50000, status: 'paid' } });
        const sessionId = 'cs_test_' + randomUUID().replaceAll('-', '');
        const journalId = await recordCapture(tx, order, 'stripe', sessionId, 'paid', now);
        const expiresAt = new Date(Math.floor(now.getTime() / 1000 + 2000) * 1000);
        const attempt = await tx.stripeAttempt.create({ data: { orderId: order.id, sessionId, journalId, expiresAt, createdAt: now, returnUrl: 'https://stage.test' } });
        sessions.set(sessionId, {
          id: sessionId, client_reference_id: attempt.id, object: 'checkout.session', livemode: false, mode: 'payment',
          currency: 'lkr', amount_total: 50000, status: 'complete', payment_status: 'paid', url: null,
          expires_at: expiresAt.getTime() / 1000, payment_intent: 'pi_' + purpose,
        });
      }
      const id = randomUUID();
      const fund = { currency: 'LKR', purpose: 'service' } as const;
      const available = await openAccount(tx, { ...fund, scope: 'sandbox:booking:' + booking.id, kind: 'available' });
      const account = await openAccount(tx, { ...fund, scope: 'sandbox:payout:' + id, kind: 'reserved' });
      const reservationId = await postJournal(tx, { ...fund, source: 'payout.sandbox.reserve', reference: booking.id }, [
        { accountId: available.id, amountMinor: -100000n }, { accountId: account.id, amountMinor: 100000n },
      ]);
      const payout = await tx.payoutOrder.create({ data: {
        id, bookingId: booking.id, providerId: provider.id, destinationRevision: 1, createdBy: admin.id, createdAt: now,
        grossMinor: 100000, platformFeeMinor: 5000, netMinor: 95000, reservationId,
      } });
      await issueDocument(tx, booking.id, payout.id, {
        version: 1, kind: 'settlement', issuedAt: now.toISOString(),
        grossMinor: payout.grossMinor, platformFeeMinor: payout.platformFeeMinor,
        netMinor: payout.netMinor, destinationRevision: payout.destinationRevision,
      });
      return { payout, account };
    });
    payoutId = reserved.payout.id;
    const path = base + 'admin/payouts/' + payoutId + '/stripe-transfer';
    const bankPath = path + '/bank-payout?bankPayoutId=po_fixture';
    const submit = (actor = admin, body: object = {}) => fetch(path, { method: 'POST', headers: actor.headers, body: JSON.stringify(body) });
    const webhookEvent = (type: string, reversal: number, details: object = {}) => ({
      id: 'evt_' + randomUUID().replaceAll('-', ''), object: 'event', type, livemode: false, created: Math.floor(Date.now() / 1000),
      data: { object: { ...(transfer ?? {}), amount_reversed: reversal, reversed: reversal === 95000 } }, ...details,
    });
    const notify = (event: object, signed = true) => {
      const raw = JSON.stringify(event);
      const time = Math.floor(Date.now() / 1000);
      const signature = createHmac('sha256', config.STRIPE_TEST_WEBHOOK_SECRET!).update(time + '.' + raw).digest('hex');
      return fetch(base + 'payments/webhooks/stripe', {
        method: 'POST', body: raw, headers: {
          'Content-Type': 'application/json', 'Stripe-Signature': 't=' + time + ',v1=' + (signed ? signature : '0'.repeat(64)),
        },
      });
    };
    const retryReason = 'Reviewed the Stripe test transfer and its full reserve.';
    const authorize = (transferId: string, actor = admin, reason = retryReason) => fetch(path + '/retry-authorizations', {
      method: 'POST', headers: actor.headers, body: JSON.stringify({ transferId, reason }),
    });
    const repairPath = base + 'admin/bookings/' + booking.id + '/payout-destination-repairs';
    const repairInput = {
      requestKey: randomUUID(), expectedDestinationRevision: 1, destinationRevision: 2, reason: 'Reviewed the updated payout destination.',
    };
    const repair = (body = repairInput, actor = admin) => fetch(repairPath, {
      method: 'POST', headers: actor.headers, body: JSON.stringify(body),
    });
    let activeLinkId = link.id;
    let holdRevision = 1;
    if (!initialReversedMinor && !rejectFirst && !useWebhooks) {
      const pending = { ...dest, revision: 2, status: 'pending' };
      await deps.db.payoutDestinationVersion.create({ data: pending });
      await deps.db.payoutDestination.update({ where: { userId: provider.id }, data: pending });
      assert.equal((await repair(repairInput, provider)).status, 403);
      assert.equal((await (await repair()).json()).code, 'DESTINATION_NOT_APPROVED');
      await deps.db.payoutDestinationVersion.update({
        where: { userId_revision: { userId: provider.id, revision: 2 } },
        data: { status: 'approved', reviewerId: admin.id, reviewedAt: now, reviewReason: repairInput.reason },
      });
      await deps.db.payoutDestination.update({ where: { userId: provider.id }, data: { status: 'approved' } });
      await deps.db.bookingPayoutHold.create({ data: {
        bookingId, revision: 1, held: true, reason: 'Review destination first.', actorId: admin.id, createdAt: now,
      } });
      assert.equal((await (await repair()).json()).code, 'PAYOUT_NOT_ELIGIBLE');
      await deps.db.bookingPayoutHold.create({ data: {
        bookingId, revision: 2, held: false, reason: 'Destination review completed.', actorId: admin.id, createdAt: now,
      } });
      holdRevision = 3;
      const [repaired, replay] = await Promise.all([repair(), repair()]);
      assert.equal(repaired.status, 200);
      assert.equal(replay.status, 200);
      const decision = await repaired.json();
      assert.deepEqual(await replay.json(), decision);
      assert.equal(decision.previousDestinationRevision, 1);
      assert.equal(decision.destinationRevision, 2);
      assert.equal(decision.actorId, admin.id);
      assert.equal((await (await repair({ ...repairInput, reason: 'A different reason for the repair.' })).json()).code, 'REQUEST_KEY_REUSED');
      assert.equal((await (await repair({ ...repairInput, requestKey: randomUUID() })).json()).code, 'PAYOUT_DESTINATION_CHANGED');
      assert.equal(await deps.db.payoutDestinationRepair.count({ where: { payoutId } }), 1);
      const updated = await deps.db.payoutOrder.findUniqueOrThrow({ where: { id: payoutId } });
      assert.deepEqual(updated, { ...reserved.payout, destinationRevision: 2 });
      assert.equal(await postedBalance(deps.db, reserved.account.id), 100000n);
      const statements = await deps.db.bookingDocument.findMany({ where: { bookingId, kind: 'settlement' } });
      assert.equal(statements.length, 2);
      for (const [sourceId, destinationRevision] of [[payoutId, 1], [decision.id, 2]]) {
        const snapshot = statements.find(row => row.sourceId === sourceId)?.snapshot;
        assert.equal((snapshot as { destinationRevision: number } | undefined)?.destinationRevision, destinationRevision);
      }
      assert.equal((await submit()).status, 409);
      assert.equal(submissions, 0);
      const replacement = await fetch(base + 'admin/providers/' + provider.id + '/stripe-destination', {
        method: 'POST', headers: admin.headers, body: JSON.stringify({
          requestKey: randomUUID(), expectedLinkId: link.id, destinationRevision: 2, accountId: stripeId, reason: repairInput.reason,
        }),
      });
      assert.equal(replacement.status, 200);
      activeLinkId = (await replacement.json()).id;
    }
    assert.equal((await submit(provider)).status, 403);
    assert.equal((await submit(admin, { reconcileOnly: true })).status, 409);
    cardBalanceMinor = 90000;
    assert.equal((await submit()).status, 409);
    cardBalanceMinor = 100000;
    disputed = true;
    assert.equal((await submit()).status, 409);
    assert.equal(submissions, 0);
    disputed = false;

    const first = submit();
    await Promise.race([sending, first.then(async value => assert.fail(await value.clone().text()))]);
    try {
      assert.equal((await (await submit()).json()).state, 'processing');
      assert.equal(await postedBalance(deps.db, reserved.account.id), 100000n);
      const expectedDestinationRevision = initialReversedMinor || rejectFirst || useWebhooks ? 1 : 2;
      const claimedRepair = { ...repairInput, requestKey: randomUUID(), expectedDestinationRevision, destinationRevision: expectedDestinationRevision + 1 };
      assert.equal((await (await repair(claimedRepair)).json()).code, 'PAYOUT_TRANSFER_STARTED');
      await deps.db.bookingPayoutHold.create({ data: {
        bookingId: booking.id, revision: holdRevision, held: true, reason: 'Manual review hold fixture', actorId: admin.id, createdAt: now,
      } });
      if (useWebhooks) {
        const partial = webhookEvent('transfer.reversed', 1000);
        assert.equal((await notify(partial, false)).status, 401);
        assert.equal((await notify({ ...partial, livemode: true })).status, 400);
        assert.equal((await notify({ ...partial, account: stripeId })).status, 200);
        assert.equal((await notify({
          ...partial, data: { object: { ...partial.data.object, amount: 95001 } },
        })).status, 409);
        assert.equal((await notify(partial)).status, 503, 'Stripe retrieval is behind the signed reversal snapshot');
        reversedMinor = 1000;
        platformAccountId = 'acct_wrongPlatform';
        assert.equal((await notify(partial)).status, 409);
        platformAccountId = 'acct_platform';
        assert.equal(await deps.db.stripePayoutTransferEvent.count({ where: { transfer: { payoutId } } }), 0);
        assert.equal(await postedBalance(deps.db, reserved.account.id), 100000n);

        const deliveries = await Promise.all([notify(partial), notify(partial)]);
        assert.ok(deliveries.every(response => response.status === 200));
        assert.equal(await deps.db.stripePayoutTransferEvent.count({ where: { transfer: { payoutId } } }), 1);
        assert.equal(await postedBalance(deps.db, reserved.account.id), 6000n);
        assert.equal((await (await fetch(path, admin)).json()).transfer.state, 'review_required');

        reversedMinor = 0;
        assert.equal((await notify(webhookEvent('transfer.created', 0, { created: partial.created - 1 }))).status, 200);
        assert.equal(await postedBalance(deps.db, reserved.account.id), 6000n);
        reversedMinor = 95000;
        const full = webhookEvent('transfer.reversed', 95000);
        assert.equal((await notify(full)).status, 200);
        assert.equal((await notify(full)).status, 200);
      }
    } finally { release(); }
    const firstOutcome = await (await first).json();
    if (useWebhooks) {
      assert.equal(firstOutcome.state, 'review_required');
      assert.equal(firstOutcome.reversedMinor, 95000);
      assert.equal(submissions, 1);
      assert.equal(await postedBalance(deps.db, reserved.account.id), 100000n);
      const receipts = await deps.db.stripePayoutTransferEvent.findMany({ where: { transferId: firstOutcome.id } });
      assert.deepEqual(receipts.map(row => row.observedReversedMinor).sort((a, b) => a - b), [0, 1000, 95000]);
      const postings = await deps.db.journalEntry.findMany({
        where: { accountId: reserved.account.id, transaction: { source: { in: ['stripe.test.payout.transfer', 'stripe.test.payout.transfer_reversal'] } } },
        orderBy: { amountMinor: 'asc' },
      });
      assert.deepEqual(postings.map(posting => posting.amountMinor), [-95000n, 1000n, 94000n]);
      return;
    }
    if (rejectFirst) {
      assert.equal(firstOutcome.state, 'rejected');
      assert.deepEqual(firstOutcome.rejection, { code: 'balance_insufficient', requestId: 'req_transferFixture' });
      assert.equal(firstOutcome.providerTransferId, null);
      assert.equal(await postedBalance(deps.db, reserved.account.id), 100000n);
      assert.equal(await deps.db.journalEntry.count({
        where: { accountId: reserved.account.id, transaction: { source: 'stripe.test.payout.transfer' } },
      }), 0);
      assert.deepEqual(await (await submit(admin, { reconcileOnly: true })).json(), firstOutcome);
      const retryCommand = { retryOfTransferId: firstOutcome.id };
      assert.equal((await (await submit(admin, retryCommand)).json()).code, 'STRIPE_RETRY_NOT_AUTHORIZED');
      const approved = await authorize(firstOutcome.id);
      assert.equal(approved.status, 200);
      const decision = await approved.json();
      assert.equal(decision.transferId, firstOutcome.id);
      assert.equal((await submit(admin, retryCommand)).status, 409);
      await deps.db.bookingPayoutHold.create({ data: {
        bookingId, revision: holdRevision + 1, held: false, reason: 'Confirmed Stripe rejection reviewed.', actorId: admin.id, createdAt: now,
      } });
      const retried = await submit(admin, retryCommand);
      assert.equal(retried.status, 200);
      const latest = await retried.json();
      assert.equal(latest.state, 'transferred');
      assert.equal(latest.attempt, 2);
      assert.equal(latest.rejection, null);
      assert.equal((await (await submit(admin, retryCommand)).json()).id, latest.id);
      const history = await (await fetch(path + '/attempts', admin)).json();
      assert.deepEqual(history.attempts, [latest, { ...firstOutcome, retryAuthorization: decision }]);
      assert.equal(submissions, 2);
      assert.equal(idempotencyKeys.size, 2);
      assert.equal(await postedBalance(deps.db, reserved.account.id), 5000n);
      return;
    }
    const uncertain = firstOutcome;
    assert.equal(uncertain.state, 'uncertain');
    assert.equal((await (await authorize(uncertain.id)).json()).code, 'STRIPE_RETRY_NOT_ELIGIBLE');
    assert.equal((await fetch(bankPath, admin)).status, 409);

    reversedMinor = initialReversedMinor;
    const reconciliation = await submit(admin, { reconcileOnly: true });
    assert.equal(reconciliation.status, 200);
    const saved = await reconciliation.json();
    const expectedState = initialReversedMinor ? 'review_required' : 'transferred';
    assert.equal(saved.state, expectedState);
    assert.equal(saved.destinationLinkId, activeLinkId);
    assert.equal(saved.amountMinor, 95000);
    assert.equal(saved.reversedMinor, initialReversedMinor);
    assert.equal(submissions, 1);
    assert.equal(await postedBalance(deps.db, reserved.account.id), 5000n + BigInt(initialReversedMinor));
    const view = await fetch(base + 'payouts/' + payoutId, provider);
    assert.equal((await view.json()).stripeTransferStatus, expectedState);
    const earnings = await fetch(base + 'me/earnings', provider);
    const summary = (await earnings.json()).items[0].payout;
    assert.equal(summary.id, payoutId);
    assert.equal(summary.stripeTransferStatus, expectedState);
    assert.equal(Object.hasOwn(summary, 'stripeTransfer'), false);
    assert.deepEqual(await (await fetch(path, admin)).json(), { transfer: saved });
    assert.deepEqual(await (await submit()).json(), saved);
    const stored = await deps.db.stripePayoutTransfer.findUniqueOrThrow({ where: { id: saved.id }, include: { journal: true } });
    assert.equal(stored.journal?.source, 'stripe.test.payout.transfer');
    if (!initialReversedMinor) {
      assert.equal((await fetch(bankPath, provider)).status, 403);
      assert.equal((await fetch(path + '/bank-payout?bankPayoutId=tr_fixture', admin)).status, 400);
      const included = await fetch(bankPath, admin);
      assert.equal(included.status, 200);
      assert.equal(included.headers.get('cache-control'), 'no-store');
      const reference = { transferId: saved.id, bankPayoutId: 'po_fixture' };
      assert.deepEqual(await included.json(), {
        ...reference, status: 'included', balanceTransactionId: 'txn_fixture', stripePayoutStatus: 'paid',
      });
      bankPayoutStatus = 'failed';
      assert.deepEqual(await (await fetch(bankPath, admin)).json(), {
        ...reference, status: 'review_required', balanceTransactionId: null, stripePayoutStatus: 'failed',
      });
      assert.deepEqual(await deps.db.stripePayoutTransfer.findUniqueOrThrow({ where: { id: saved.id }, include: { journal: true } }), stored);
      assert.equal(await postedBalance(deps.db, reserved.account.id), 5000n);
    }

    reversedMinor = 1000;
    const partial = await (await submit(admin, { reconcileOnly: true })).json();
    assert.equal(partial.state, 'review_required');
    assert.equal(partial.reversedMinor, 1000);
    assert.equal(await postedBalance(deps.db, reserved.account.id), 6000n);
    assert.equal((await (await authorize(partial.id)).json()).code, 'STRIPE_RETRY_NOT_ELIGIBLE');

    assert.equal((await (await submit(admin, { reconcileOnly: true })).json()).reversedMinor, 1000);
    reversedMinor = 500;
    assert.equal((await (await submit(admin, { reconcileOnly: true })).json()).reversedMinor, 1000);
    assert.equal(await postedBalance(deps.db, reserved.account.id), 6000n);

    reversedMinor = 95000;
    const full = await (await submit(admin, { reconcileOnly: true })).json();
    assert.equal(full.state, 'review_required');
    assert.equal(full.reversedMinor, 95000);
    assert.equal(await postedBalance(deps.db, reserved.account.id), 100000n);
    const reversalPostings = await deps.db.journalEntry.findMany({
      where: { accountId: reserved.account.id, transaction: { source: 'stripe.test.payout.transfer_reversal' } },
      orderBy: { amountMinor: 'asc' },
    });
    assert.deepEqual(reversalPostings.map(posting => posting.amountMinor), [1000n, 94000n]);
    assert.equal((await deps.db.stripePayoutTransfer.findUniqueOrThrow({ where: { id: saved.id } })).journalId, stored.journalId);
    assert.equal(submissions, 1);

    if (!initialReversedMinor) {
      const retryCommand = { retryOfTransferId: full.id };
      assert.equal((await (await submit(admin, retryCommand)).json()).code, 'STRIPE_RETRY_NOT_AUTHORIZED');
      assert.equal((await authorize(full.id, provider)).status, 403);
      const [approved, approvalReplay] = await Promise.all([authorize(full.id), authorize(full.id)]);
      assert.equal(approved.status, 200);
      assert.equal(approvalReplay.status, 200);
      const decision = await approved.json();
      assert.deepEqual(await approvalReplay.json(), decision);
      assert.equal(decision.actorId, admin.id);
      assert.equal(decision.transferId, full.id);
      assert.equal((await (await authorize(full.id, admin, 'A different review reason for this attempt.')).json()).code,
        'STRIPE_RETRY_ALREADY_AUTHORIZED');
      assert.equal((await (await submit()).json()).id, full.id);
      assert.equal((await submit(admin, retryCommand)).status, 409);
      assert.equal(submissions, 1);
      assert.equal(await postedBalance(deps.db, reserved.account.id), 100000n);

      await deps.db.bookingPayoutHold.create({ data: {
        bookingId, revision: holdRevision + 1, held: false, reason: 'Full reversal confirmed.', actorId: admin.id, createdAt: now,
      } });
      const newer = { ...dest, revision: 3 };
      await deps.db.payoutDestinationVersion.create({
        data: { ...newer, reviewerId: admin.id, reviewedAt: now, reviewReason: retryReason },
      });
      await deps.db.payoutDestination.update({ where: { userId: provider.id }, data: newer });
      assert.equal((await repair({
        ...repairInput, requestKey: randomUUID(), expectedDestinationRevision: 2, destinationRevision: 3,
      })).status, 200);
      const replacement = await fetch(base + 'admin/providers/' + provider.id + '/stripe-destination', {
        method: 'POST', headers: admin.headers, body: JSON.stringify({
          requestKey: randomUUID(), expectedLinkId: activeLinkId, destinationRevision: 3, accountId: stripeId, reason: retryReason,
        }),
      });
      assert.equal(replacement.status, 200);
      const newLink = await replacement.json();
      const retries = await Promise.all([submit(admin, retryCommand), submit(admin, retryCommand)]);
      assert.ok(retries.every(response => response.status === 200));
      const [retry, duplicate] = await Promise.all(retries.map(response => response.json()));
      assert.equal(retry.id, duplicate.id);
      assert.notEqual(retry.id, full.id);
      assert.equal(retry.attempt, 2);
      assert.equal(retry.destinationLinkId, newLink.id);
      const latest = (await (await fetch(path, admin)).json()).transfer;
      assert.equal(latest.state, 'transferred');
      assert.equal(latest.reversedMinor, 0);
      assert.equal((await (await submit(admin, retryCommand)).json()).id, retry.id);
      assert.deepEqual(await (await authorize(full.id)).json(), decision);
      const history = await (await fetch(path + '/attempts', admin)).json();
      assert.deepEqual(history.attempts, [latest, { ...full, retryAuthorization: decision }]);
      assert.equal(submissions, 2);
      assert.equal(idempotencyKeys.size, 2);
      assert.equal(await postedBalance(deps.db, reserved.account.id), 5000n);
      assert.equal(await deps.db.payoutOrder.count({ where: { bookingId } }), 1);
    }
  } finally {
    release();
    try {
      if (payoutId) {
        await deps.db.stripePayoutTransferEvent.deleteMany({ where: { transfer: { payoutId } } });
        await deps.db.stripePayoutTransfer.deleteMany({ where: { payoutId } });
        await deps.db.payoutDestinationRepair.deleteMany({ where: { payoutId } });
        await deps.db.payoutOrder.delete({ where: { id: payoutId } });
      }
      if (bookingId) {
        await deps.db.stripeAttempt.deleteMany({ where: { order: { bookingId } } });
        await deps.db.bookingPayoutHold.deleteMany({ where: { bookingId } });
        await deps.db.bookingCompletion.deleteMany({ where: { bookingId } });
        await deps.db.bookingDocument.deleteMany({ where: { bookingId } });
        await deps.db.paymentOrder.deleteMany({ where: { bookingId } });
        await deps.db.booking.delete({ where: { id: bookingId } });
      }
      await deps.db.stripePayoutDestinationLink.deleteMany({ where: { providerId: { in: users } } });
      await deps.db.verificationCase.deleteMany({ where: { providerId: { in: users } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally { await app.close(); }
  }
}
