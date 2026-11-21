import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { BookingSmsReminder } from '../generated/prisma/client.js';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
import { processBookingSmsReminders, scheduleBookingSmsReminders } from '../shared/booking-sms-reminders.js';
import { sealSmsNumber } from '../shared/sms-verification.js';
import { smsDigest, type SmsResult, type TextLk } from '../shared/sms.js';
const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'sms-ops-' + randomUUID(), BOOKING_SMS_REMINDERS: 'false', SMS_VERIFICATION_ENABLED: 'false', PROMOTIONAL_SMS_DELIVERY: 'false', TEXTLK_TOKEN: 'fixture-token', TEXTLK_SENDER: 'StageLink' });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test'))
    throw Error('SMS operations integration requires the isolated test database');
test('SMS reminder operations paginate real states, protect private data and serialize cancellation against submission', async () => {
    const deps = resources(config), { app } = await createApp(config, deps), users: string[] = [], bookings: string[] = [];
    const number = '94771234567', digest = smsDigest(config, number);
    await app.listen(0, '127.0.0.1');
    const root = (await app.getUrl()) + '/api/v1/';
    async function actor(role: 'admin' | 'customer' | 'artist', verified = true) {
        const user = await deps.db.authUser.create({ data: { email: randomUUID() + '@stagelink.test', displayName: 'SMS operations fixture', passwordHash: 'unused', roles: [role], emailVerifiedAt: verified ? new Date() : null } });
        users.push(user.id);
        const session = await deps.db.authSession.create({ data: { userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600000) } });
        const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
        return { id: user.id, sessionId: session.id, headers: { Authorization: 'Bearer ' + token, Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id) } };
    }
    type Actor = Awaited<ReturnType<typeof actor>>;
    async function call(actor: Actor | undefined, path: string, body?: unknown, headers: Record<string, string> = {}) {
        const response = await fetch(root + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...actor?.headers, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json() as any };
    }
    const reason = 'Cancel this unsent reminder after support review.';
    const cancelPath = (id: string) => 'admin/sms-reminders/' + id + '/cancel';
    try {
        const admin = await actor('admin'), otherAdmin = await actor('admin'), unverified = await actor('admin', false), customer = await actor('customer'), provider = await actor('artist');
        await deps.db.smsContact.create({ data: { userId: customer.id, sealedNumber: sealSmsNumber(config, customer.id, number), last4: '4567', verifiedAt: new Date(), bookingConsent: true } });
        async function booking(minutes: number) {
            const startsAt = new Date(Date.now() + minutes * 60000);
            const row = await deps.db.booking.create({ data: { customerId: customer.id, providerId: provider.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64), targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, snapshot: {}, startsAt, endsAt: new Date(startsAt.getTime() + 3600000), holdExpiresAt: startsAt, agreedAt: new Date() } });
            bookings.push(row.id);
            await deps.db.paymentOrder.create({ data: { bookingId: row.id, purpose: 'advance', amountMinor: 150001, status: 'paid' } });
            return row;
        }
        const history = await booking(30 * 60);
        const states = ['queued', 'sending', 'accepted', 'delivered', 'failed', 'unknown', 'cancelled'] as const;
        const expected = { queued: 0, sending: 0, accepted: 0, delivered: 0, failed: 0, unknown: 0, cancelled: 0 };
        const rows: BookingSmsReminder[] = [];
        // Distinct starts represent retained scheduler revisions for this booking.
        for (let i = 0; i < 38; i++) {
            const status = states[i % states.length]!, startsAt = new Date(history.startsAt.getTime() + i * 60000), offsetHours = i % 2 ? 2 : 24;
            const submitted = ['sending', 'accepted', 'delivered', 'unknown'].includes(status);
            rows.push(await deps.db.bookingSmsReminder.create({ data: {
                    bookingId: history.id, recipientId: customer.id, startsAt, offsetHours, dueAt: new Date(startsAt.getTime() - offsetHours * 3600000), status,
                    ...(submitted ? { sendingAt: new Date(), targetDigest: digest, checkedAt: new Date() } : {}),
                    ...(['accepted', 'delivered'].includes(status) ? { providerId: 'private-provider-' + randomUUID() } : {}),
                } }));
            expected[status]++;
        }
        const listPath = 'admin/sms-reminders?bookingId=' + history.id;
        assert.equal((await call(undefined, listPath)).status, 401);
        assert.equal((await call(customer, listPath)).status, 403);
        assert.equal((await call(provider, listPath)).status, 403);
        assert.equal((await call(unverified, listPath)).status, 403);
        const first = await call(admin, listPath);
        assert.equal(first.status, 200);
        assert.equal(first.data.items.length, 30);
        assert.equal(first.data.enabled, false);
        assert.equal(first.data.hourlyLimit, config.SMS_HOURLY_LIMIT);
        assert.deepEqual(first.data.counts, expected);
        const second = await call(admin, listPath + '&cursor=' + first.data.nextCursor);
        assert.equal(second.data.items.length, 8);
        assert.equal(second.data.nextCursor, null);
        assert.deepEqual([...first.data.items, ...second.data.items].map((r: any) => r.id), rows.map(r => r.id).sort());
        assert.doesNotMatch(JSON.stringify(first.data), new RegExp(number + '|' + digest + '|private-provider-'));
        const filtered = await call(admin, listPath + '&status=delivered&offsetHours=24');
        assert.ok(filtered.data.items.every((r: any) => r.status === 'delivered' && r.offsetHours === 24));
        assert.equal(Object.values(filtered.data.counts).reduce((a: any, b: any) => a + b, 0), 19);
        assert.deepEqual((await call(admin, 'admin/sms-reminders?bookingId=' + randomUUID())).data.counts, { queued: 0, sending: 0, accepted: 0, delivered: 0, failed: 0, unknown: 0, cancelled: 0 });
        for (const query of ['cursor=invalid', 'status=sent', 'offsetHours=3', 'bookingId=invalid'])
            assert.equal((await call(admin, 'admin/sms-reminders?' + query)).status, 400);
        assert.equal((await call(admin, 'admin/sms-reminders/' + randomUUID())).status, 404);
        const queued = rows.find(r => r.status === 'queued')!;
        const path = cancelPath(queued.id);
        assert.equal((await call(customer, path, { reason })).status, 403);
        assert.equal((await call(unverified, path, { reason })).status, 403);
        assert.equal((await call(admin, path, { reason }, { Origin: 'https://untrusted.example' })).status, 403);
        assert.equal((await call(admin, path, { reason }, { 'X-CSRF-Token': 'invalid' })).status, 403);
        assert.equal((await call(admin, path, { reason }, { 'Content-Type': 'text/plain' })).status, 403);
        assert.equal((await call(admin, path, { reason: 'short' })).status, 400);
        assert.equal((await call(admin, path, { reason, status: 'delivered' })).status, 400);
        assert.equal((await call(admin, cancelPath(randomUUID()), { reason })).status, 404);
        const cancelled = await Promise.all([call(admin, path, { reason }), call(admin, path, { reason })]);
        assert.deepEqual(cancelled.map(r => r.status), [200, 200]);
        assert.deepEqual(cancelled[0]!.data, cancelled[1]!.data);
        assert.equal(cancelled[0]!.data.status, 'cancelled');
        assert.equal(cancelled[0]!.data.canCancel, false);
        assert.equal(cancelled[0]!.data.cancellation.actorId, admin.id);
        assert.equal(cancelled[0]!.data.cancellation.reason, reason);
        assert.ok(cancelled[0]!.data.cancellation.createdAt);
        assert.equal(await deps.db.smsReminderCancellation.count({ where: { reminderId: queued.id } }), 1);
        assert.equal((await call(admin, path, { reason: 'A different cancellation justification.' })).status, 409);
        assert.equal((await call(otherAdmin, path, { reason })).status, 409);
        assert.deepEqual((await call(admin, 'admin/sms-reminders/' + queued.id)).data, cancelled[0]!.data);
        for (const status of states.filter(s => s !== 'queued')) {
            const row = rows.find(r => r.status === status)!;
            assert.equal((await call(admin, cancelPath(row.id), { reason })).status, 409, status);
            assert.equal(await deps.db.smsReminderCancellation.count({ where: { reminderId: row.id } }), 0);
        }
        assert.equal((await call(admin, 'admin/sms-reminders/' + queued.id + '/retry', {})).status, 404);
        const revoked = await actor('admin');
        await deps.db.authSession.update({ where: { id: revoked.sessionId }, data: { revokedAt: new Date() } });
        assert.equal((await call(revoked, listPath)).status, 401);
        const disabled = await actor('admin');
        await deps.db.authUser.update({ where: { id: disabled.id }, data: { disabledAt: new Date() } });
        assert.equal((await call(disabled, path, { reason })).status, 401);
        let sends = 0;
        const transport: Pick<TextLk, 'send' | 'read'> = {
            async send() { sends++; return { status: 'accepted', providerId: 'ops-' + randomUUID(), code: null }; },
            async read(id) { return { status: 'unknown', providerId: id, code: 'RECONCILIATION_UNAVAILABLE' }; },
        };
        const enabled = { ...config, BOOKING_SMS_REMINDERS: 'true' as const, SMS_HOURLY_LIMIT: 1000 };
        // A cancellation remains in the unique schedule and cannot be recreated by the scheduler.
        await scheduleBookingSmsReminders(deps.db);
        assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: queued.id } })).status, 'cancelled');
        const race = await booking(60);
        await scheduleBookingSmsReminders(deps.db);
        const raceRow = await deps.db.bookingSmsReminder.findFirstOrThrow({ where: { bookingId: race.id, offsetHours: 2 } });
        const [raceResult] = await Promise.all([call(admin, cancelPath(raceRow.id), { reason }), processBookingSmsReminders(deps.db, enabled, transport)]);
        const outcome = await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: raceRow.id } });
        if (outcome.status === 'cancelled') {
            assert.equal(raceResult.status, 200);
            assert.equal(sends, 0);
            assert.equal(await deps.db.smsReminderCancellation.count({ where: { reminderId: raceRow.id } }), 1);
        }
        else {
            assert.equal(raceResult.status, 409);
            assert.equal(outcome.status, 'accepted');
            assert.equal(sends, 1);
            assert.equal(await deps.db.smsReminderCancellation.count({ where: { reminderId: raceRow.id } }), 0);
        }
        const claimedBooking = await booking(45);
        await scheduleBookingSmsReminders(deps.db);
        const claimed = await deps.db.bookingSmsReminder.findFirstOrThrow({ where: { bookingId: claimedBooking.id, offsetHours: 2 } });
        let entered!: () => void, release!: (result: SmsResult) => void;
        const sending = new Promise<void>(resolve => { entered = resolve; });
        const response = new Promise<SmsResult>(resolve => { release = resolve; });
        const worker = processBookingSmsReminders(deps.db, enabled, { ...transport, async send() { sends++; entered(); return response; } });
        try {
            await Promise.race([sending, worker.then(() => { throw Error('The fixture reminder was not claimed'); })]);
            assert.equal((await call(admin, cancelPath(claimed.id), { reason })).status, 409);
            assert.equal(await deps.db.smsReminderCancellation.count({ where: { reminderId: claimed.id } }), 0);
        }
        finally {
            release({ status: 'accepted', providerId: 'claimed-' + randomUUID(), code: null });
            await worker;
        }
        assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: claimed.id } })).status, 'accepted');
    }
    finally {
        try {
            await deps.db.smsReminderCancellation.deleteMany({ where: { reminder: { bookingId: { in: bookings } } } });
            await deps.db.bookingSmsReminder.deleteMany({ where: { bookingId: { in: bookings } } });
            await deps.db.paymentOrder.deleteMany({ where: { bookingId: { in: bookings } } });
            await deps.db.booking.deleteMany({ where: { id: { in: bookings } } });
            await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
            assert.equal(await deps.db.authUser.count({ where: { id: { in: users } } }), 0);
        }
        finally {
            await app.close();
        }
    }
});
