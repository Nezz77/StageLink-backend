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
  ...process.env, AUTH_RATE_PREFIX: 'stripe-transfer-test-' + randomUUID(),
  STRIPE_TEST_PAYOUT_TRANSFERS: 'true', STRIPE_TEST_SECRET_KEY: 'sk_test_transfer', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_transfer',
});
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Stripe payout transfers require an isolated *_test database.');
}

test('approved Stripe transfers reconcile exactly once, including after a hold and a later reversal', async t => {
  const localFetch = globalThis.fetch;
  const sessions = new Map<string, object>();
  const stripeId = 'acct_' + randomUUID().replaceAll('-', '');
  let disputed = false;
  let cardBalanceMinor = 100000;
  let reversedMinor = 0;
  let transfer: Record<string, unknown> | null = null;
  let submissions = 0;
  let sent!: () => void;
  let release!: () => void;
  const sending = new Promise<void>(resolve => { sent = resolve; });
  const waitForResponse = new Promise<void>(resolve => { release = resolve; });

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== 'api.stripe.com') return localFetch(input, init);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer sk_test_transfer');
    if (url.pathname === '/v1/account' || url.pathname === '/v1/accounts/' + stripeId) {
      return Response.json({
        object: 'account', id: url.pathname === '/v1/account' ? 'acct_platform' : stripeId, country: 'US',
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
      assert.equal(new Headers(init.headers).get('Idempotency-Key'), 'stagelink-payout-' + executionId);
      submissions++;
      transfer = {
        id: 'tr_' + executionId.replaceAll('-', ''), object: 'transfer', amount: 95000, currency: 'lkr',
        destination: stripeId, transfer_group: body.get('transfer_group'), livemode: false,
        metadata: { stagelink_payout_transfer: executionId }, reversed: false, amount_reversed: 0,
      };
      sent();
      await waitForResponse;
      return new Response(null, { status: 500 });
    }
    if (url.pathname === '/v1/transfers') {
      assert.equal(url.searchParams.get('transfer_group'), transfer?.transfer_group);
      assert.equal(url.searchParams.get('destination'), stripeId);
      return Response.json({ object: 'list', has_more: false, data: transfer ? [transfer] : [] });
    }
    assert.equal(url.pathname, '/v1/transfers/' + transfer?.id);
    return Response.json({ ...transfer, amount_reversed: reversedMinor });
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
      return { payout, account };
    });
    payoutId = reserved.payout.id;
    const path = base + 'admin/payouts/' + payoutId + '/stripe-transfer';
    const submit = (actor = admin, body: object = {}) => fetch(path, { method: 'POST', headers: actor.headers, body: JSON.stringify(body) });
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
      await deps.db.bookingPayoutHold.create({ data: {
        bookingId: booking.id, revision: 1, held: true, reason: 'Manual review hold fixture', actorId: admin.id, createdAt: now,
      } });
    } finally { release(); }
    assert.equal((await (await first).json()).state, 'uncertain');

    const reconciliation = await submit(admin, { reconcileOnly: true });
    assert.equal(reconciliation.status, 200);
    const saved = await reconciliation.json();
    assert.equal(saved.state, 'transferred');
    assert.equal(saved.destinationLinkId, link.id);
    assert.equal(saved.amountMinor, 95000);
    assert.equal(submissions, 1);
    assert.equal(await postedBalance(deps.db, reserved.account.id), 5000n);
    const view = await fetch(base + 'payouts/' + payoutId, provider);
    assert.equal((await view.json()).stripeTransferStatus, 'transferred');
    const earnings = await fetch(base + 'me/earnings', provider);
    const summary = (await earnings.json()).items[0].payout;
    assert.equal(summary.id, payoutId);
    assert.equal(summary.stripeTransferStatus, 'transferred');
    assert.equal(Object.hasOwn(summary, 'stripeTransfer'), false);
    assert.deepEqual(await (await fetch(path, admin)).json(), { transfer: saved });
    assert.deepEqual(await (await submit()).json(), saved);
    const stored = await deps.db.stripePayoutTransfer.findUniqueOrThrow({ where: { payoutId }, include: { journal: true } });
    assert.equal(stored.journal?.source, 'stripe.test.payout.transfer');

    reversedMinor = 1000;
    assert.equal((await (await submit(admin, { reconcileOnly: true })).json()).state, 'review_required');
    assert.equal(await postedBalance(deps.db, reserved.account.id), 5000n);
    assert.equal((await deps.db.stripePayoutTransfer.findUniqueOrThrow({ where: { payoutId } })).journalId, stored.journalId);
    assert.equal(submissions, 1);
  } finally {
    release();
    try {
      if (payoutId) {
        await deps.db.stripePayoutTransfer.deleteMany({ where: { payoutId } });
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
});
