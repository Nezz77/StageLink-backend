import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor, seal } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
import { processBookingSmsReminders } from '../shared/booking-sms-reminders.js';
import { payloadContext, sealSmsNumber } from '../shared/sms-verification.js';
import { smsDigest, type SmsResult } from '../shared/sms.js';
const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'sms-optout-' + randomUUID(), SMS_VERIFICATION_ENABLED: 'false', BOOKING_SMS_REMINDERS: 'false', PROMOTIONAL_SMS_DELIVERY: 'false', TEXTLK_TOKEN: 'fixture-token', TEXTLK_SENDER: 'StageLink' });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test'))
    throw Error('SMS opt-out integration requires the isolated test database');
test('SMS opt-out works during maintenance, cancels queued sends and records complete revocation history', async (t) => {
    const deps = resources(config), { app } = await createApp(config, deps), users: string[] = [], bookings: string[] = [], campaigns: string[] = [];
    const initial = await deps.db.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
    const number = '94771234567', targetDigest = smsDigest(config, number);
    let external = 0;
    t.mock.method(globalThis, 'fetch', ((original) => async (input: string | URL | Request, init?: RequestInit) => {
        if (new URL(input instanceof Request ? input.url : input).hostname === 'app.text.lk') {
            external++;
            throw Error('Real SMS is forbidden in this test');
        }
        return original(input, init);
    })(globalThis.fetch));
    await app.listen(0, '127.0.0.1');
    const root = (await app.getUrl()) + '/api/v1/';
    async function actor(verified = true) {
        const user = await deps.db.authUser.create({ data: { email: randomUUID() + '@stagelink.test', displayName: 'SMS opt-out fixture', passwordHash: 'unused', roles: ['customer'], emailVerifiedAt: verified ? new Date() : null } });
        users.push(user.id);
        const session = await deps.db.authSession.create({ data: { userId: user.id, activeRole: 'customer', expiresAt: new Date(Date.now() + 600000) } });
        const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
        return { id: user.id, email: user.email, sessionId: session.id, headers: { Authorization: 'Bearer ' + token, Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id) } };
    }
    type Actor = Awaited<ReturnType<typeof actor>>;
    async function call(actor: Actor | undefined, path: string, body?: unknown, method?: string, headers: Record<string, string> = {}) {
        const response = await fetch(root + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json', ...actor?.headers, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json() as any };
    }
    const optOut = 'me/sms-contact/opt-out', revoke = 'me/sms-contact/revoke';
    async function contact(a: Actor, revision = 1) {
        return deps.db.smsContact.create({ data: { userId: a.id, revision, sealedNumber: sealSmsNumber(config, a.id, number), last4: '4567', verifiedAt: new Date(), bookingConsent: true, marketingConsent: true } });
    }
    async function queued(a: Actor, provider: Actor) {
        const startsAt = new Date(Date.now() + 3600000);
        const booking = await deps.db.booking.create({ data: { customerId: a.id, providerId: provider.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64), targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, snapshot: {}, startsAt, endsAt: new Date(startsAt.getTime() + 3600000), holdExpiresAt: startsAt, agreedAt: new Date() } });
        bookings.push(booking.id);
        await deps.db.paymentOrder.create({ data: { bookingId: booking.id, purpose: 'advance', amountMinor: 150001, status: 'paid' } });
        const reminder = await deps.db.bookingSmsReminder.create({ data: { bookingId: booking.id, recipientId: a.id, startsAt, dueAt: new Date(startsAt.getTime() - 7200000), offsetHours: 2 } });
        const c = await deps.db.smsCampaign.create({ data: { id: randomUUID(), body: 'Synthetic fixture.', recipientLimit: 1, createdBy: provider.id, state: 'scheduled', scheduledBy: provider.id, scheduledFor: new Date(Date.now() - 1000) } });
        campaigns.push(c.id);
        const current = await deps.db.smsContact.findUniqueOrThrow({ where: { userId: a.id } });
        await deps.db.smsCampaignRecipient.create({ data: { campaignId: c.id, userId: a.id, contactRevision: current.revision } });
        return { reminder, campaignId: c.id };
    }
    async function pending(a: Actor, status: 'queued' | 'accepted') {
        const id = randomUUID();
        await deps.db.smsVerification.create({ data: { id, userId: a.id, targetDigest, last4: '4567', expiresAt: new Date(Date.now() + 600000), status, codeDigest: '1'.repeat(64), sealedPayload: seal(config.AUTH_MAIL_KEY, { number, message: 'Your StageLink contact verification code is 123456.' }, payloadContext(id)), ...(status === 'accepted' ? { providerId: 'prior-' + id, sendingAt: new Date() } : {}) } });
        await deps.db.smsContact.update({ where: { userId: a.id }, data: { pendingId: id } });
        return id;
    }
    try {
        const a = await actor(), b = await actor(), none = await actor(), unverified = await actor(false);
        const original = await contact(a);
        await contact(b);
        await contact(unverified);
        await deps.db.notificationPreference.create({ data: { userId: a.id, bookingReminderEmail: true } });
        await deps.db.marketingEmailPreference.create({ data: { userId: a.id, consentEmail: a.email, revision: 1 } });
        const jobs = await queued(a, b), other = await queued(b, a), challenge = await pending(a, 'queued');
        await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: true, maintenanceMessage: 'SMS opt-out test' } });
        assert.equal((await call(undefined, optOut, { channel: 'all' })).status, 401);
        assert.equal((await call(a, optOut, { channel: 'all' }, undefined, { 'X-CSRF-Token': 'bad' })).status, 403);
        assert.equal((await call(a, optOut, { channel: 'all' }, undefined, { Origin: 'https://untrusted.example' })).status, 403);
        for (const body of [{ channel: 'unknown' }, { channel: 'marketing', marketingConsent: true }, { channel: 'all', userId: b.id }])
            assert.equal((await call(a, optOut, body)).status, 400);
        assert.equal((await call(a, 'me/sms-contact/consent', { revision: 1, bookingConsent: true, marketingConsent: true }, 'PUT')).status, 503);
        assert.equal((await call(a, 'me/sms-contact/verification', { revision: 1, number })).status, 503);
        assert.equal((await call(a, 'me/sms-contact/confirm', { challengeId: challenge, code: '123456' })).status, 503);
        const stopped = await call(a, optOut, { channel: 'marketing' });
        assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
        assert.equal(stopped.data.marketingConsent, false);
        assert.equal(stopped.data.bookingConsent, true);
        assert.equal(stopped.data.verified, true);
        assert.ok(!JSON.stringify(stopped.data).includes(number));
        assert.equal((await deps.db.smsContact.findUniqueOrThrow({ where: { userId: a.id } })).sealedNumber, original.sealedNumber);
        assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: jobs.reminder.id } })).status, 'queued');
        assert.equal((await deps.db.smsCampaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: jobs.campaignId, userId: a.id } } })).status, 'skipped');
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id: challenge } })).status, 'queued', 'Channel opt-out preserves pending phone verification');
        assert.equal((await deps.db.smsCampaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: other.campaignId, userId: b.id } } })).status, 'queued');
        assert.deepEqual((await call(a, optOut, { channel: 'marketing' })).data, stopped.data, 'Identical opt-out is idempotent');
        assert.equal(await deps.db.smsConsentEvent.count({ where: { userId: a.id } }), 1);
        const allOff = await call(a, optOut, { channel: 'all' });
        assert.equal(allOff.data.bookingConsent, false);
        assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: jobs.reminder.id } })).status, 'cancelled');
        const unverifiedOff = await call(unverified, optOut, { channel: 'all' });
        assert.equal(unverifiedOff.status, 200, 'Stopping SMS does not require verified email');
        const missing = await call(none, optOut, { channel: 'all' });
        assert.equal(missing.status, 200);
        assert.equal(missing.data.revision, 0);
        assert.equal(await deps.db.smsContact.count({ where: { userId: none.id } }), 0);
        assert.equal(await deps.db.smsConsentEvent.count({ where: { userId: none.id } }), 0);
        const revoked = await call(a, revoke, { revision: allOff.data.revision });
        assert.equal(revoked.status, 200);
        assert.equal(revoked.data.verified, false);
        assert.equal(revoked.data.pending, null);
        const erased = await deps.db.smsVerification.findUniqueOrThrow({ where: { id: challenge } });
        assert.equal(erased.status, 'cancelled');
        assert.equal(erased.codeDigest, null);
        assert.equal(erased.sealedPayload, null);
        const audit = await deps.db.smsConsentEvent.findMany({ where: { userId: a.id }, orderBy: { revision: 'asc' } });
        assert.deepEqual(audit.map(r => r.action), ['consent', 'consent', 'revoked']);
        assert.equal(audit.at(-1)!.targetDigest, targetDigest);
        assert.equal(audit.at(-1)!.last4, '4567');
        assert.equal(audit.at(-1)!.marketingConsent, false);
        assert.equal((await call(a, revoke, { revision: allOff.data.revision })).status, 409);
        assert.equal((await deps.db.notificationPreference.findUniqueOrThrow({ where: { userId: a.id } })).bookingReminderEmail, true);
        assert.equal((await deps.db.marketingEmailPreference.findUniqueOrThrow({ where: { userId: a.id } })).consentEmail, a.email);
        // Removing a number keeps already-submitted delivery evidence but erases its usable OTP.
        const acceptedId = await pending(b, 'accepted');
        const submitted = await deps.db.bookingSmsReminder.update({ where: { id: other.reminder.id }, data: { status: 'accepted', providerId: 'booking-' + randomUUID(), sendingAt: new Date(), targetDigest } });
        await deps.db.smsCampaignRecipient.update({ where: { campaignId_userId: { campaignId: other.campaignId, userId: b.id } }, data: { status: 'unknown', sendingAt: new Date(), targetDigest } });
        assert.equal((await call(b, revoke, { revision: 1 })).status, 200);
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id: acceptedId } })).status, 'accepted');
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id: acceptedId } })).sealedPayload, null);
        assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: submitted.id } })).status, 'accepted');
        assert.equal((await deps.db.smsCampaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: other.campaignId, userId: b.id } } })).status, 'unknown');
        const broken = await actor();
        await contact(broken);
        await deps.db.smsContact.update({ where: { userId: broken.id }, data: { sealedNumber: 'corrupt-ciphertext' } });
        assert.equal((await call(broken, optOut, { channel: 'all' })).status, 200);
        const brokenView = await call(broken, 'me/sms-contact');
        assert.equal((await call(broken, revoke, { revision: brokenView.data.revision })).status, 200);
        assert.ok((await deps.db.smsConsentEvent.findMany({ where: { userId: broken.id } })).every(r => r.targetDigest === null));
        const bookingOnly = await actor();
        await contact(bookingOnly);
        const bookingOnlyJobs = await queued(bookingOnly, b);
        const bookingOff = await call(bookingOnly, optOut, { channel: 'booking' });
        assert.equal(bookingOff.data.bookingConsent, false);
        assert.equal(bookingOff.data.marketingConsent, true);
        assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: bookingOnlyJobs.reminder.id } })).status, 'cancelled');
        assert.equal((await deps.db.smsCampaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: bookingOnlyJobs.campaignId, userId: bookingOnly.id } } })).lastCode, 'CONTACT_CONSENT_CHANGED');
        const simultaneous = await actor();
        await contact(simultaneous);
        const stoppedTwice = await Promise.all([call(simultaneous, optOut, { channel: 'all' }), call(simultaneous, optOut, { channel: 'all' })]);
        assert.deepEqual(stoppedTwice.map(r => r.status), [200, 200]);
        assert.deepEqual(stoppedTwice[0]!.data, stoppedTwice[1]!.data);
        assert.equal(await deps.db.smsConsentEvent.count({ where: { userId: simultaneous.id } }), 1);
        await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: false, maintenanceMessage: null } });
        const legacy = await actor();
        await contact(legacy);
        const legacyJobs = await queued(legacy, b);
        assert.equal((await call(legacy, 'me/sms-contact/consent', { revision: 1, bookingConsent: false, marketingConsent: false }, 'PUT')).status, 200);
        assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: legacyJobs.reminder.id } })).status, 'cancelled');
        assert.equal((await deps.db.smsCampaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: legacyJobs.campaignId, userId: legacy.id } } })).status, 'skipped');
        const inFlight = await actor();
        await contact(inFlight);
        const inFlightJobs = await queued(inFlight, b);
        // Cancel its promotional fixture; only the booking transport is exercised below.
        await call(inFlight, optOut, { channel: 'marketing' });
        let entered!: () => void, release!: (result: SmsResult) => void;
        const sending = new Promise<void>(resolve => { entered = resolve; });
        const result = new Promise<SmsResult>(resolve => { release = resolve; });
        let sends = 0;
        const worker = processBookingSmsReminders(deps.db, { ...config, BOOKING_SMS_REMINDERS: 'true', SMS_HOURLY_LIMIT: 1000 }, {
            async send() { sends++; entered(); return result; },
            async read(id) { return { status: 'unknown', providerId: id, code: 'RECONCILIATION_UNAVAILABLE' }; },
        });
        try {
            await Promise.race([sending, worker.then(() => { throw Error('The fixture reminder was not claimed'); })]);
            assert.equal((await call(inFlight, optOut, { channel: 'all' })).status, 200);
            assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: inFlightJobs.reminder.id } })).status, 'sending');
        }
        finally {
            release({ status: 'accepted', providerId: 'inflight-' + randomUUID(), code: null });
            await worker;
        }
        assert.equal(sends, 1);
        assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({ where: { id: inFlightJobs.reminder.id } })).status, 'accepted');
        assert.equal(external, 0);
    }
    finally {
        try {
            await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: initial.maintenance, maintenanceMessage: initial.maintenanceMessage } });
            await deps.db.smsCampaignRecipient.deleteMany({ where: { campaignId: { in: campaigns } } });
            await deps.db.smsCampaign.deleteMany({ where: { id: { in: campaigns } } });
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
