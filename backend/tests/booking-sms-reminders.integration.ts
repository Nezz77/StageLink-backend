import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { processBookingSmsReminders, scheduleBookingSmsReminders } from '../shared/booking-sms-reminders.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
import { smsDigest, type SmsResult, type TextLk } from '../shared/sms.js';
import { sealSmsNumber } from '../shared/sms-verification.js';

const config = readConfig({
  ...process.env, BOOKING_SMS_REMINDERS: 'true', SMS_VERIFICATION_ENABLED: 'false',
  SMS_HOURLY_LIMIT: '20', TEXTLK_TOKEN: 'fixture-token', TEXTLK_SENDER: 'StageLink',
});
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Booking SMS integration requires an isolated test database.');
}

test('booking SMS reminders honor current consent and share a durable SMS submission cap', async () => {
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const users: string[] = [];
  const bookings: string[] = [];
  const number = '94771234567';
  const targetDigest = smsDigest(config, number);
  const providerId = 'reminder-' + randomUUID();
  let sends = 0;
  let reads = 0;
  let uncertainSend = false;
  let uncertainRead = true;
  const unknown: SmsResult = { status: 'unknown', providerId: null, code: 'PROVIDER_OUTCOME_UNKNOWN' };
  const transport: Pick<TextLk, 'send' | 'read'> = {
    async send(payload, digest) {
      sends++;
      assert.equal(payload.number, number);
      assert.equal(digest, targetDigest);
      assert.match(payload.message, /^StageLink booking reminder: .* Sri Lanka time\. Open StageLink for details\.$/);
      assert.ok(payload.message.length <= 160);
      return uncertainSend ? unknown : { status: 'accepted', providerId, code: null };
    },
    async read(id, digest) {
      reads++;
      assert.equal(id, providerId);
      assert.equal(digest, targetDigest);
      return uncertainRead ? { ...unknown, providerId } : { status: 'delivered', providerId, code: null };
    },
  };

  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1/me/booking-sms-reminders';
    async function actor(role: 'customer' | 'artist', bookingConsent: boolean) {
      const user = await deps.db.authUser.create({ data: {
        roles: [role], email: randomUUID() + '@stagelink.test', displayName: 'Booking SMS fixture',
        passwordHash: 'unused', emailVerifiedAt: new Date(),
      } });
      users.push(user.id);
      await deps.db.smsContact.create({ data: {
        userId: user.id, verifiedAt: new Date(), last4: number.slice(-4),
        sealedNumber: sealSmsNumber(config, user.id, number), bookingConsent, marketingConsent: !bookingConsent,
      } });
      const session = await deps.db.authSession.create({ data: { userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600_000) } });
      const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id).setIssuedAt().setExpirationTime('10m')
        .sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
      return { id: user.id, headers: { Authorization: 'Bearer ' + token } };
    }
    const customer = await actor('customer', true);
    const provider = await actor('artist', false);
    async function booking(minutes: number, paid = true) {
      const startsAt = new Date(Date.now() + minutes * 60_000);
      const row = await deps.db.booking.create({ data: {
        customerId: customer.id, providerId: provider.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
        targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt, agreedAt: new Date(), holdExpiresAt: startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000), snapshot: {},
      } });
      bookings.push(row.id);
      await deps.db.paymentOrder.create({ data: { bookingId: row.id, purpose: 'advance', amountMinor: 150001, status: paid ? 'paid' : 'pending' } });
      return row;
    }

    const due = await booking(60);
    const unpaid = await booking(45, false);
    const process = (overrides = {}) => processBookingSmsReminders(deps.db, { ...config, ...overrides }, transport);
    await process({ BOOKING_SMS_REMINDERS: 'false' });
    assert.equal(await deps.db.bookingSmsReminder.count({ where: { bookingId: due.id } }), 0);
    assert.equal(sends, 0);

    const verification = await deps.db.smsVerification.create({ data: {
      userId: customer.id, targetDigest, last4: number.slice(-4), status: 'unknown',
      expiresAt: new Date(), sendingAt: new Date(),
    } });
    await process({ SMS_HOURLY_LIMIT: 1 });
    assert.equal(sends, 0, 'A verification attempt consumes the shared hourly allowance');
    const [queued] = await deps.db.bookingSmsReminder.findMany({ where: { bookingId: due.id } });
    assert.equal(queued?.status, 'queued');
    assert.equal(queued?.recipientId, customer.id);
    assert.equal(queued?.offsetHours, 2);
    assert.equal(await deps.db.bookingSmsReminder.count({ where: { bookingId: unpaid.id } }), 0);
    await deps.db.smsVerification.delete({ where: { id: verification.id } });

    await Promise.all([process(), process()]);
    assert.equal(sends, 1);
    const accepted = await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: queued!.id } });
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.targetDigest, targetDigest);
    assert.equal(accepted.providerId, providerId);
    for (const expected of ['accepted', 'delivered']) {
      uncertainRead = expected === 'accepted';
      await deps.db.bookingSmsReminder.update({ where: { id: accepted.id }, data: { checkedAt: new Date(0) } });
      await process();
      assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: accepted.id } })).status, expected);
    }
    assert.equal(reads, 2);

    const later = await booking(5 * 60);
    uncertainSend = true;
    await process({ SMS_HOURLY_LIMIT: 1 });
    assert.equal(sends, 1, 'A reminder attempt consumes the shared hourly allowance');
    await process();
    await process();
    assert.equal(sends, 2, 'An uncertain send is not automatically retried');
    const scheduled = await deps.db.bookingSmsReminder.findMany({ where: { bookingId: later.id }, orderBy: { offsetHours: 'desc' } });
    assert.deepEqual(scheduled.map(row => [row.offsetHours, row.status]), [[24, 'unknown'], [2, 'queued']]);
    assert.equal(scheduled[0]!.providerId, null);

    const optedOut = await booking(30);
    await scheduleBookingSmsReminders(deps.db);
    await deps.db.smsContact.update({ where: { userId: customer.id }, data: { bookingConsent: false } });
    await process();
    assert.equal(sends, 2);
    assert.equal((await deps.db.bookingSmsReminder.findFirstOrThrow({ where: { bookingId: optedOut.id } })).status, 'cancelled');
    assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: scheduled[1]!.id } })).status, 'cancelled');

    assert.equal((await fetch(base)).status, 401);
    const visible = await fetch(base, customer);
    const { items } = await visible.json();
    assert.equal(visible.status, 200);
    assert.ok(items.some((row: { id: string; status: string }) => row.id === accepted.id && row.status === 'delivered'));
    assert.doesNotMatch(JSON.stringify(items), new RegExp(`${number}|${targetDigest}|${providerId}`));
    assert.deepEqual(await (await fetch(base, provider)).json(), { items: [] });
  } finally {
    try {
      await deps.db.bookingSmsReminder.deleteMany({ where: { bookingId: { in: bookings } } });
      await deps.db.paymentOrder.deleteMany({ where: { bookingId: { in: bookings } } });
      await deps.db.booking.deleteMany({ where: { id: { in: bookings } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally { await app.close(); }
  }
});
