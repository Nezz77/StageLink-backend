import { consume } from '../shared/outbox.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../api/src/app.js';
import { hashPassword } from '../api/src/auth/security.js';
import { databaseNow } from '../shared/database-clock.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
import { serverClock } from './fixtures/server-clock.js';

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
  type Login = { accessToken: string; csrfToken: string; user: { id: string; email: string } };
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    async function call(path: string, body?: unknown, login?: Login) {
      const response = await fetch(base + '/api/v1/' + path, {
        method: body === undefined ? 'GET' : path.endsWith('/moderation') || path === 'me/notification-preferences' ? 'PATCH'
          : path.endsWith('/read') ? 'PUT' : 'POST',
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

    const caseInput = {
      requestKey: randomUUID(), subject: 'Booking follow-up', body: 'Please help with this booking follow-up.', bookingId,
    };
    const ticket = await call('cases', caseInput, customer);
    assert.equal(ticket.status, 200);
    assert.equal((await call('cases', caseInput, customer)).data.id, ticket.data.id);
    assert.equal((await call('cases', caseInput, outsider)).status, 404);
    const casePath = 'cases/' + ticket.data.id;
    assert.equal((await call(casePath, undefined, provider)).status, 404);
    const note = { requestKey: randomUUID(), body: 'Internal triage notes.' };
    assert.equal((await call('admin/' + casePath + '/notes', note, admin)).data.kind, 'note');
    const publicReply = { requestKey: randomUUID(), body: 'We have received your case.' };
    assert.equal((await call('admin/' + casePath + '/replies', publicReply, admin)).status, 200);
    const history = await call(casePath + '/replies', undefined, customer);
    assert.deepEqual(history.data.items.map((item: { body: string }) => item.body), [publicReply.body]);
    assert.equal((await call('admin/' + casePath + '/entries', undefined, customer)).status, 403);
    assert.equal((await call('admin/' + casePath + '/status', { expectedRevision: 1, status: 'resolved', reason: 'The question was answered.' }, admin)).data.status, 'resolved');
    assert.equal((await call(casePath + '/replies', publicReply, customer)).data.code, 'SUPPORT_CASE_RESOLVED');
    assert.equal((await call('admin/' + casePath + '/status', { expectedRevision: 2, status: 'open', reason: 'Reopened to follow up.' }, admin)).data.status, 'open');
    assert.equal((await call(casePath + '/replies', publicReply, customer)).status, 200);

    const messages = await deps.db.outboxEvent.findMany({
      where: { topic: 'notification.create.v1', payload: { path: ['sourceId'], equals: ticket.data.id } },
      select: { id: true },
    });
    assert.equal(messages.length, 1);
    await consume(deps.db, messages[0]!.id);
    await consume(deps.db, messages[0]!.id);
    const memberNotifications = await call('me/notifications', undefined, customer);
    const supportNotifications = memberNotifications.data.items.filter((item: { kind: string }) => item.kind === 'support');
    assert.equal(supportNotifications.length, 1);
    const readNotification = 'me/notifications/' + supportNotifications[0].id + '/read';
    assert.equal((await call(readNotification, {}, outsider)).status, 404);
    const read = await call(readNotification, {}, customer);
    assert.ok(read.data.readAt);
    assert.equal((await call(readNotification, {}, customer)).data.readAt, read.data.readAt);
    assert.equal((await call('me/notifications', undefined, customer)).data.unread, memberNotifications.data.unread - 1);
    const preferences = await call('me/notification-preferences', { bookingReminderEmail: false, revision: 0 }, customer);
    assert.deepEqual(preferences.data, { bookingReminderEmail: false, revision: 1 });

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

    const destination = { userId: provider.user.id, revision: 1, sealedDetails: 'fixture', accountLast4: '1234', status: 'approved' as const };
    await deps.db.payoutDestination.create({ data: destination });
    await deps.db.payoutDestinationVersion.create({ data: destination });
    assert.equal((await call(holdPath, { ...hold, expectedRevision: 1, held: false }, admin)).status, 200);
    const payout = () => call('admin/payouts', { bookingId, destinationRevision: 1 }, admin);
    assert.equal((await payout()).data.code, 'PAYOUT_PROVIDER_VERIFICATION_REQUIRED');
    const verification = {
      providerId: provider.user.id, subject: 'Identity review', body: 'Review provider identity for sandbox payout.',
    };
    await deps.db.verificationCase.create({
      data: { ...verification, kind: 'renter', version: 1, requestKey: randomUUID(), status: 'approved',
        decidedBy: admin.user.id, reason: 'Verified the rental identity evidence.', decidedAt: new Date(), createdAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await payout()).data.code, 'PAYOUT_PROVIDER_VERIFICATION_REQUIRED');
    const artistCase = await deps.db.verificationCase.create({
      data: { ...verification, kind: 'artist', version: 1, requestKey: randomUUID() },
    });
    assert.equal((await payout()).data.code, 'PAYOUT_PROVIDER_VERIFICATION_REQUIRED');
    const approval = { status: 'approved', reason: 'Verified the artist identity evidence.', documentsReviewed: true };
    assert.equal((await call('admin/verification-cases/' + artistCase.id + '/decisions', approval, admin)).status, 200);
    assert.equal((await payout()).data.code, 'PAYOUT_NOT_ELIGIBLE', 'Identity approval alone cannot replace captured payment evidence');
    assert.equal(await deps.db.payoutOrder.count({ where: { bookingId } }), 0);

    const disputeInput = { subject: 'Service disagreement', body: 'Please review the work performed at this booking.' };
    assert.equal((await call(path + '/disputes', disputeInput, outsider)).status, 404);
    const dispute = await call(path + '/disputes', disputeInput, customer);
    assert.equal(dispute.status, 200);
    assert.equal((await call(path + '/disputes', disputeInput, customer)).data.id, dispute.data.id);
    assert.equal((await call(path + '/disputes', undefined, provider)).data.dispute.id, dispute.data.id);
    assert.equal((await call(path + '/refund-requests', { reason: 'Request a refund for this booking.' }, customer)).data.code, 'BOOKING_DISPUTED');
    const adminDispute = 'admin/disputes/' + dispute.data.id;
    const resolution = { reason: 'There is no actionable payment issue.' };
    assert.equal((await call(adminDispute + '/dismissals', resolution, provider)).status, 403);
    assert.ok((await call(adminDispute + '/dismissals', resolution, admin)).data.dismissedAt);
    assert.equal((await call(path + '/disputes', undefined, customer)).data.dispute.dismissalReason, resolution.reason);

    const cancellationTime = (await databaseNow(deps.db)).getTime();
    const futureStart = new Date(cancellationTime + 120_000);
    const futureEnd = new Date(futureStart.getTime() + 3_600_000);
    const holdExpiresAt = new Date(cancellationTime + 60_000);
    const cancellation = await deps.db.booking.create({ data: {
      providerId: provider.user.id, customerId: customer.user.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
      targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt: futureStart,
      endsAt: futureEnd, holdExpiresAt,
      snapshot: {
        title: 'Cancellation fixture', currency: 'LKR', quantity: 1, guestCount: null,
        rateMinor: 35_011, periods: 1, rateUnit: null, subtotalMinor: 35_011,
        depositPolicy: { mode: 'none', currency: 'LKR' }, depositMinor: 0, package: null, bundleItems: [],
      },
    } });
    cancelledBookingId = cancellation.id;
    const cancellationPath = 'bookings/' + cancellation.id;
    const cancelBody = { reason: 'The customer changed the event date.' };
    assert.equal((await call(cancellationPath + '/cancellations', cancelBody, provider)).status, 403);
    assert.equal((await call(cancellationPath + '/cancellations', cancelBody, outsider)).status, 404);
    const fastClock = 5 * 60_000;
    const pastStart = new Date(cancellationTime - 60_000);
    await deps.db.booking.update({
      where: { id: cancellation.id }, data: { startsAt: pastStart, holdExpiresAt: pastStart },
    });
    const started = await serverClock(-fastClock, async () => {
      const slowLogin = await call('auth/login', { email: customer.user.email, password });
      assert.equal(slowLogin.status, 200);
      return call(cancellationPath + '/cancellations', cancelBody, slowLogin.data);
    });
    assert.equal(started.data.code, 'CANCELLATION_NOT_ELIGIBLE');
    await deps.db.booking.update({
      where: { id: cancellation.id }, data: { startsAt: futureStart, holdExpiresAt },
    });
    const cancelled = await serverClock(fastClock, () => call(cancellationPath + '/cancellations', cancelBody, customer));
    assert.equal(cancelled.status, 200);
    const cancelledAt = Date.parse(cancelled.data.cancelledAt);
    assert.ok(cancelledAt >= cancellationTime && cancelledAt <= (await databaseNow(deps.db)).getTime());
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
        await deps.db.bookingDispute.deleteMany({ where: { bookingId } });
        await deps.db.outboxEvent.deleteMany({
          where: { topic: 'notification.create.v1', OR: [
            { payload: { path: ['sourceId'], equals: bookingId } },
            ...((await deps.db.supportCase.findMany({ where: { bookingId }, select: { id: true } })).map(({ id }) =>
              ({ payload: { path: ['sourceId'], equals: id } }))),
          ] },
        });
        await deps.db.supportCase.deleteMany({ where: { bookingId } });
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
      await deps.db.verificationCase.deleteMany({ where: { providerId: { in: users } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app.close();
    }
  }
});
