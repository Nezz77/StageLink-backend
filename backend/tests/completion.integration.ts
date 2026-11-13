import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../api/src/app.js';
import { hashPassword } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const config = readConfig({
  ...process.env, AUTH_RATE_PREFIX: 'completion-test-' + randomUUID(),
  PAYHERE_SANDBOX_MERCHANT_ID: '1210000', PAYHERE_SANDBOX_MERCHANT_SECRET: 'fixture-secret',
  PAYHERE_SANDBOX_NOTIFY_URL: 'https://stage.test/api/v1/payments/webhooks/payhere',
});
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Completion integration requires an isolated *_test database.');
}

test('completion requires a paid advance, provider check-in and resolved overtime before final checkout', async () => {
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const users: string[] = [];
  let bookingId: string | undefined;
  let cancelledBookingId: string | undefined;
  const password = 'A private fixture password 12!';
  type Login = { accessToken: string; csrfToken: string; user: { id: string } };
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    async function call(path: string, body?: unknown, login?: Login) {
      const response = await fetch(base + '/api/v1/' + path, {
        method: path.endsWith('/moderation') ? 'PATCH' : body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json', Origin: config.WEB_ORIGIN,
          ...(login ? { Authorization: 'Bearer ' + login.accessToken, 'X-CSRF-Token': login.csrfToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }

    async function fixture(role: 'artist' | 'admin' | 'customer'): Promise<Login> {
      const user = await deps.db.authUser.create({ data: {
        email: randomUUID() + '@stagelink.test', displayName: 'Completion fixture',
        roles: [role], passwordHash: await hashPassword(password), emailVerifiedAt: new Date(),
      } });
      users.push(user.id);
      const login = await call('auth/login', { email: user.email, password });
      assert.equal(login.status, 200);
      return login.data;
    }

    const [provider, customer, admin, outsider] = await Promise.all([
      fixture('artist'), fixture('customer'), fixture('admin'), fixture('customer'),
    ]);
    const now = Date.now();
    const startsAt = new Date(now - 120_000);
    const booking = await deps.db.booking.create({ data: {
      providerId: provider.user.id, customerId: customer.user.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
      targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt, endsAt: new Date(now + 120_000),
      holdExpiresAt: startsAt, decidedAt: new Date(now - 180_000), agreedAt: new Date(now - 180_000),
      providerDecision: 'accepted', decisionReason: '', snapshot: {},
    } });
    bookingId = booking.id;
    const quotation = await deps.db.bookingQuotation.create({ data: {
      bookingId, version: 1, authorId: provider.user.id, lines: [], terms: 'Fixture', totalMinor: 35_011,
    } });
    const artifact = JSON.stringify({ version: 1, currency: 'LKR', totalMinor: 35_011, serviceAdvanceMinor: 17_506, depositMinor: 0 });
    await deps.db.bookingAgreement.create({ data: {
      bookingId, quotationId: quotation.id, artifact, digest: createHash('sha256').update(artifact).digest('hex'),
    } });

    const path = 'bookings/' + bookingId;
    const checkedIn = { confirmed: true };
    assert.equal((await call(path + '/journey', undefined, outsider)).status, 404);
    assert.equal((await call(path + '/check-ins', checkedIn, customer)).status, 403);
    assert.equal((await call(path + '/check-ins', checkedIn, provider)).data.code, 'ADVANCE_REQUIRED');
    assert.equal((await call(path + '/payment-orders', { purpose: 'balance' }, customer)).data.code, 'BALANCE_NOT_DUE');
    const advance = await deps.db.paymentOrder.create({ data: {
      bookingId, purpose: 'advance', amountMinor: 17_506, status: 'paid',
    } });
    const arrival = await call(path + '/check-ins', checkedIn, provider);
    assert.equal(arrival.status, 200);
    assert.equal(arrival.data.method, 'manual');
    assert.deepEqual((await call(path + '/check-ins', checkedIn, provider)).data, arrival.data);
    assert.equal((await call(path + '/completion', checkedIn, provider)).data.code, 'COMPLETION_NOT_ELIGIBLE');

    const terms = { requestKey: randomUUID(), amountMinor: 2_001, minutes: 1 };
    const proposed = await call(path + '/overtime', terms, provider);
    assert.equal(proposed.status, 200);
    assert.equal((await call(path + '/overtime', terms, provider)).data.id, proposed.data.id);
    assert.equal((await call(path + '/overtime', { ...terms, requestKey: randomUUID() }, customer)).data.code, 'OVERTIME_PENDING');
    const decisionPath = 'overtime/' + proposed.data.id + '/decisions';
    assert.equal((await call(decisionPath, { decision: 'accepted' }, provider)).status, 403);
    assert.equal((await call(decisionPath, { decision: 'accepted' }, outsider)).status, 404);

    await deps.db.booking.update({ where: { id: bookingId }, data: { endsAt: new Date(Date.now() - 1000) } });
    assert.equal((await call(path + '/completion', checkedIn, provider)).data.code, 'OVERTIME_PENDING');
    assert.equal((await call(decisionPath, { decision: 'accepted' }, customer)).data.status, 'accepted');
    assert.equal((await call(decisionPath, { decision: 'accepted' }, customer)).status, 200);
    assert.equal((await call(decisionPath, { decision: 'declined' }, customer)).status, 409);
    assert.equal((await call(path + '/completion', checkedIn, provider)).data.code, 'COMPLETION_NOT_ELIGIBLE');
    await deps.db.booking.update({ where: { id: bookingId }, data: { endsAt: new Date(now - 90_000) } });
    const report = await call(path + '/completion', checkedIn, provider);
    assert.equal(report.status, 200);
    assert.equal(report.data.originalMinor, 35_011);
    assert.equal(report.data.balanceMinor, 19_506);
    assert.equal(report.data.platformFeeMinor, 1_751);
    assert.equal(report.data.verifiedAt, null);
    assert.equal((await call(path + '/overtime', { ...terms, requestKey: randomUUID() }, customer)).data.code, 'OVERTIME_CLOSED');

    const balance = await call(path + '/payment-orders', { purpose: 'balance' }, customer);
    assert.equal(balance.status, 200);
    assert.equal(balance.data.amountMinor, 19_506);
    const checkoutPath = 'payment-orders/' + balance.data.id + '/sessions';
    const billing = { firstName: 'Test', lastName: 'Customer', phone: '0771234567', address: 'Main Street', city: 'Colombo', country: 'Sri Lanka' };
    const checkout = await call(checkoutPath, billing, customer);
    assert.equal(checkout.status, 200);
    assert.equal(checkout.data.fields.amount, '195.06');
    await deps.db.paymentOrder.update({ where: { id: advance.id }, data: { status: 'review' } });
    assert.equal((await call(checkoutPath, billing, customer)).status, 409);

    const verifyPath = 'admin/' + path + '/completion-verification';
    const evidence = { reason: 'Confirmed the service took place.' };
    assert.equal((await call(verifyPath, evidence, customer)).status, 403);
    const verified = await call(verifyPath, evidence, admin);
    assert.equal(verified.status, 200);
    assert.ok(verified.data.verifiedAt);
    const journey = await call(path + '/journey', undefined, customer);
    assert.equal(journey.data.completion.verifiedAt, verified.data.verifiedAt);
    assert.equal(journey.data.completion.verificationReason, undefined);
    assert.equal(journey.data.overtimePending, false);

    const reviewPath = path + '/reviews';
    const reviewInput = { rating: 5, body: 'The provider delivered the agreed performance.' };
    assert.equal((await call(reviewPath, reviewInput, provider)).status, 403);
    assert.equal((await call(reviewPath, reviewInput, outsider)).status, 404);
    const review = await call(reviewPath, reviewInput, customer);
    assert.equal(review.status, 200);
    assert.equal(review.data.status, 'pending');
    assert.equal((await call(reviewPath, reviewInput, customer)).data.id, review.data.id);
    assert.equal((await call(reviewPath, { ...reviewInput, rating: 4 }, customer)).status, 409);
    assert.equal((await call(reviewPath, undefined, provider)).data.review, null);
    const moderation = 'admin/reviews/' + review.data.id + '/moderation';
    assert.equal((await call(moderation, { revision: 1, status: 'published', reason: 'Checked the review.' }, customer)).status, 403);
    assert.equal((await call(moderation, { revision: 1, status: 'published', reason: 'Checked the review.' }, admin)).data.status, 'published');
    assert.equal((await call(reviewPath, undefined, provider)).data.review.rating, 5);
    assert.equal((await call(moderation, { revision: 2, status: 'hidden', reason: 'Withheld for further review.' }, admin)).data.status, 'hidden');
    assert.equal((await call(reviewPath, undefined, provider)).data.review, null);

    const holdPath = 'admin/' + path + '/holds';
    const hold = { expectedRevision: 0, held: true, reason: 'Review payment evidence.' };
    assert.equal((await call(holdPath, hold, provider)).status, 403);
    assert.equal((await call(holdPath, hold, admin)).data.revision, 1);
    assert.equal((await call(holdPath, hold, admin)).data.revision, 1);
    assert.equal((await call(holdPath, { ...hold, held: false }, admin)).data.code, 'PAYOUT_HOLD_CHANGED');
    assert.equal((await call('admin/payouts', { bookingId, destinationRevision: 1 }, admin)).data.code, 'PAYOUT_NOT_ELIGIBLE');
    assert.equal((await call('admin/payments', undefined, customer)).status, 403);
    const earnings = await call('me/earnings', undefined, provider);
    assert.equal(earnings.data.items[0].bookingId, bookingId);
    assert.equal(earnings.data.items[0].holdRevision, 1);
    assert.equal(earnings.data.items[0].payout, null);
    assert.equal((await call('admin/payments', undefined, admin)).data.items.some((item: { bookingId: string }) => item.bookingId === bookingId), true);

    const futureStart = new Date(Date.now() + 86_400_000);
    const cancellation = await deps.db.booking.create({ data: {
      providerId: provider.user.id, customerId: customer.user.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
      targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt: futureStart,
      endsAt: new Date(futureStart.getTime() + 3_600_000), holdExpiresAt: new Date(Date.now() + 60_000), snapshot: {},
    } });
    cancelledBookingId = cancellation.id;
    const cancellationPath = 'bookings/' + cancellation.id;
    const cancelBody = { reason: 'The customer changed the event date.' };
    assert.equal((await call(cancellationPath + '/cancellations', cancelBody, provider)).status, 403);
    assert.equal((await call(cancellationPath + '/cancellations', cancelBody, outsider)).status, 404);
    const cancelled = await call(cancellationPath + '/cancellations', cancelBody, customer);
    assert.equal(cancelled.status, 200);
    assert.deepEqual((await call(cancellationPath + '/cancellations', cancelBody, customer)).data, cancelled.data);
    assert.equal((await call(cancellationPath, undefined, provider)).data.state, 'cancelled');
    assert.equal((await call(cancellationPath + '/provider-decisions', { revision: 2, decision: 'accepted' }, provider)).status, 409);
    assert.equal((await call(cancellationPath + '/payment-orders', { purpose: 'advance' }, customer)).data.code, 'BOOKING_PAYMENT_BLOCKED');
    assert.equal((await call(cancellationPath + '/refund-requests', cancelBody, customer)).status, 409);
  } finally {
    try {
      if (bookingId) {
        await deps.db.payHereAttempt.deleteMany({ where: { order: { bookingId } } });
        await deps.db.paymentOrder.deleteMany({ where: { bookingId } });
        await deps.db.bookingReview.deleteMany({ where: { bookingId } });
        await deps.db.bookingPayoutHold.deleteMany({ where: { bookingId } });
        await deps.db.bookingCompletion.deleteMany({ where: { bookingId } });
        await deps.db.overtimeProposal.deleteMany({ where: { bookingId } });
        await deps.db.bookingCheckIn.deleteMany({ where: { bookingId } });
        await deps.db.bookingAgreement.deleteMany({ where: { bookingId } });
        await deps.db.bookingQuotation.deleteMany({ where: { bookingId } });
        await deps.db.booking.deleteMany({ where: { id: bookingId } });
      }
      if (cancelledBookingId) await deps.db.booking.delete({ where: { id: cancelledBookingId } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app.close();
    }
  }
});
