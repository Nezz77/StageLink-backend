import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
import { processPromotionalSms } from '../shared/promotional-sms.js';
import { sealSmsNumber } from '../shared/sms-verification.js';
import { smsDigest, type SmsResult, type TextLk } from '../shared/sms.js';
import { runSmsDeliverySmoke } from '../scripts/sms-delivery-smoke.js';
const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'promo-sms-' + randomUUID(), PROMOTIONAL_SMS_DELIVERY: 'true', SMS_VERIFICATION_ENABLED: 'false', BOOKING_SMS_REMINDERS: 'false', TEXTLK_TOKEN: 'fixture-token', TEXTLK_SENDER: 'StageLink', SMS_HOURLY_LIMIT: '100' });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test'))
    throw Error('Promotional SMS requires the isolated test database');
test('promotional SMS freezes a reviewed audience and honors consent, cancellation, concurrency and uncertain delivery', async (t) => {
    const deps = resources(config), { app } = await createApp(config, deps), users: string[] = [], campaigns: string[] = [];
    const number = '94771234567', digest = smsDigest(config, number);
    const unknown: SmsResult = { status: 'unknown', providerId: null, code: 'PROVIDER_OUTCOME_UNKNOWN' };
    let sends = 0, reads = 0, mode: 'accepted' | 'timeout' | 'failed' = 'accepted', readMode: 'unknown' | 'delivered' = 'unknown';
    const transport: Pick<TextLk, 'send' | 'read'> = {
        async send(payload, targetDigest) {
            sends++;
            assert.equal(payload.number, number);
            assert.equal(targetDigest, digest);
            assert.match(payload.message, /Stop SMS: StageLink > Account > SMS preferences\.$/);
            assert.ok(payload.message.length <= 160);
            if (mode === 'timeout')
                throw Error('Possible acceptance');
            return mode === 'failed' ? { status: 'failed', providerId: null, code: 'PROVIDER_REJECTED' } : { status: 'accepted', providerId: 'promo-fixture-' + randomUUID(), code: null };
        },
        async read(id, targetDigest) {
            reads++;
            assert.equal(targetDigest, digest);
            return { ...unknown, providerId: id, status: readMode };
        },
    };
    await app.listen(0, '127.0.0.1');
    const root = (await app.getUrl()) + '/api/v1/';
    async function actor(role: 'admin' | 'customer', consent = false, verified = true) {
        const user = await deps.db.authUser.create({ data: { email: randomUUID() + '@stagelink.test', displayName: 'Promotional SMS fixture', roles: [role], passwordHash: 'unused', emailVerifiedAt: verified ? new Date() : null } });
        users.push(user.id);
        const session = await deps.db.authSession.create({ data: { userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 3600000) } });
        const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id).setIssuedAt().setExpirationTime('1h').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
        await deps.db.smsContact.create({ data: { userId: user.id, revision: 1, verifiedAt: new Date(), last4: '4567', sealedNumber: sealSmsNumber(config, user.id, number), bookingConsent: true, marketingConsent: consent } });
        return { id: user.id, headers: { Authorization: 'Bearer ' + token, Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id) } };
    }
    type Actor = Awaited<ReturnType<typeof actor>>;
    async function call(actor: Actor, path: string, body?: unknown, method?: string, headers: Record<string, string> = {}) {
        const r = await fetch(root + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { ...actor.headers, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: r.status, data: await r.json() as any };
    }
    const status = (campaignId: string, userId: string) => deps.db.smsCampaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId, userId } } });
    async function draft(admin: Actor) {
        const id = randomUUID();
        campaigns.push(id);
        const input = { id, body: 'Explore this week on StageLink.', recipientLimit: 100 };
        const r = await call(admin, 'admin/sms-campaigns', input);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        return { id, input, path: 'admin/sms-campaigns/' + id };
    }
    async function schedule(admin: Actor) {
        const c = await draft(admin), preview = await call(admin, c.path + '/preview', {});
        const body = { scheduledFor: new Date(Date.now() + 60000).toISOString(), audienceFingerprint: preview.data.audienceFingerprint };
        const r = await call(admin, c.path + '/schedule', body);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal((await call(admin, c.path + '/schedule', body)).status, 200, 'Schedule retry is idempotent');
        await deps.db.smsCampaign.update({ where: { id: c.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
        return c;
    }
    try {
        const admin = await actor('admin'), member = await actor('customer', true), bookingOnly = await actor('customer'), unverified = await actor('customer', true, false), outsider = await actor('customer');
        const c = await draft(admin);
        assert.equal((await call(member, 'admin/sms-campaigns')).status, 403);
        assert.equal((await call(member, 'admin/sms-campaigns', c.input)).status, 403);
        assert.equal((await call(admin, 'admin/sms-campaigns', c.input, undefined, { 'X-CSRF-Token': 'bad' })).status, 403);
        assert.equal((await call(admin, 'admin/sms-campaigns', c.input, undefined, { Origin: 'https://untrusted.example' })).status, 403);
        assert.equal((await call(admin, 'admin/sms-campaigns', { ...c.input, body: 'Invalid 🎵' })).status, 400);
        assert.equal((await call(admin, 'admin/sms-campaigns', { ...c.input, numbers: [number] })).status, 400);
        assert.equal((await call(admin, 'admin/sms-campaigns', c.input)).status, 200);
        assert.equal((await call(admin, 'admin/sms-campaigns', { ...c.input, body: 'Different' })).status, 409);
        const preview = await call(admin, c.path + '/preview', {});
        assert.equal(preview.data.recipientCount, 1, 'Booking-only consent and unverified email are excluded');
        assert.ok(!JSON.stringify(preview.data).includes(number));
        await deps.db.smsContact.update({ where: { userId: member.id }, data: { revision: 2 } });
        assert.equal((await call(admin, c.path + '/schedule', { scheduledFor: new Date(Date.now() + 60000).toISOString(), audienceFingerprint: preview.data.audienceFingerprint })).status, 409);
        await call(admin, c.path + '/cancel', { reason: 'Cancel the stale audience fixture.' });
        const first = await schedule(admin);
        assert.equal(await deps.db.smsCampaignRecipient.count({ where: { campaignId: first.id } }), 1);
        await processPromotionalSms(deps.db, { ...config, PROMOTIONAL_SMS_DELIVERY: 'false' }, transport);
        assert.equal(sends, 0);
        const verification = await deps.db.smsVerification.create({ data: {
                userId: member.id, targetDigest: digest, last4: '4567', expiresAt: new Date(Date.now() + 60000),
                status: 'unknown', sendingAt: new Date(),
            } });
        try {
            await processPromotionalSms(deps.db, { ...config, SMS_HOURLY_LIMIT: 1 }, transport);
            assert.equal(sends, 0, 'Verification submissions consume the same budget as campaigns');
        }
        finally {
            await deps.db.smsVerification.delete({ where: { id: verification.id } });
        }
        await Promise.all([processPromotionalSms(deps.db, config, transport), processPromotionalSms(deps.db, config, transport)]);
        assert.equal(sends, 1);
        assert.equal((await status(first.id, member.id)).status, 'accepted');
        await deps.db.smsCampaignRecipient.update({ where: { campaignId_userId: { campaignId: first.id, userId: member.id } }, data: { checkedAt: new Date(Date.now() - 60000) } });
        await processPromotionalSms(deps.db, config, transport);
        assert.equal((await status(first.id, member.id)).status, 'accepted', 'Retrieval outages preserve acceptance');
        readMode = 'delivered';
        await deps.db.smsCampaignRecipient.update({ where: { campaignId_userId: { campaignId: first.id, userId: member.id } }, data: { checkedAt: new Date(Date.now() - 60000) } });
        await processPromotionalSms(deps.db, config, transport);
        assert.equal((await status(first.id, member.id)).status, 'delivered');
        assert.ok(reads >= 2);
        const detail = await call(admin, first.path);
        assert.equal(detail.data.deliveryCounts.delivered, 1);
        assert.ok(!JSON.stringify(detail.data).includes(number));

        const now = new Date();
        const startsAt = new Date(now.getTime() + 7200000);
        const smokeBooking = await deps.db.booking.create({ data: {
            customerId: member.id, providerId: bookingOnly.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
            targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt, endsAt: new Date(startsAt.getTime() + 3600000),
            holdExpiresAt: startsAt, snapshot: {},
        } });
        try {
            const verified = await deps.db.smsVerification.create({ data: {
                userId: member.id, targetDigest: digest, last4: '4567', expiresAt: new Date(now.getTime() + 60000),
                status: 'delivered', confirmedAt: now, providerId: 'fixture-verify-' + randomUUID(),
            } });
            const reminder = await deps.db.bookingSmsReminder.create({ data: {
                bookingId: smokeBooking.id, recipientId: member.id, startsAt, dueAt: now, offsetHours: 2,
                status: 'delivered', targetDigest: digest, providerId: 'fixture-reminder-' + randomUUID(), sendingAt: now, checkedAt: now,
            } });
            const smoke = await runSmsDeliverySmoke({
                origin: await app.getUrl(), verificationId: verified.id, reminderId: reminder.id, campaignId: first.id, expectedRecipients: 1,
                sessions: { member: member.headers.Authorization.slice(7), admin: admin.headers.Authorization.slice(7) },
            });
            assert.equal(smoke.passed, true, JSON.stringify(smoke));
            assert.equal(smoke.checks.length, 3);
            await deps.db.smsVerification.delete({ where: { id: verified.id } });
        }
        finally {
            await deps.db.bookingSmsReminder.deleteMany({ where: { bookingId: smokeBooking.id } });
            await deps.db.booking.delete({ where: { id: smokeBooking.id } });
        }

        const changed = await schedule(admin);
        const optedOut = await call(member, 'me/sms-contact/consent', { revision: 2, bookingConsent: true, marketingConsent: false }, 'PUT');
        assert.equal(optedOut.status, 200);
        await processPromotionalSms(deps.db, { ...config, PROMOTIONAL_SMS_DELIVERY: 'false' }, transport);
        assert.equal((await status(changed.id, member.id)).status, 'skipped');
        assert.equal(sends, 1);
        await call(member, 'me/sms-contact/consent', { revision: optedOut.data.revision, bookingConsent: true, marketingConsent: true }, 'PUT');
        await processPromotionalSms(deps.db, config, transport);
        assert.equal((await status(changed.id, member.id)).status, 'skipped', 'Re-opt-in cannot revive a saved recipient');
        assert.equal(sends, 1);
        const replaced = await schedule(admin);
        await deps.db.smsContact.update({ where: { userId: member.id }, data: {
                revision: { increment: 1 }, sealedNumber: sealSmsNumber(config, member.id, '94771234568'), last4: '4568',
            } });
        await processPromotionalSms(deps.db, config, transport);
        assert.equal((await status(replaced.id, member.id)).status, 'skipped', 'A replacement contact needs another audience review');
        assert.equal(sends, 1);
        await deps.db.smsContact.update({ where: { userId: member.id }, data: {
                revision: { increment: 1 }, sealedNumber: sealSmsNumber(config, member.id, number), last4: '4567',
            } });
        const cancelled = await schedule(admin);
        assert.equal((await call(admin, cancelled.path + '/cancel', { reason: 'Cancel before provider submission.' })).status, 200);
        await processPromotionalSms(deps.db, config, transport);
        assert.equal((await status(cancelled.id, member.id)).status, 'skipped');
        assert.equal(sends, 1);
        const timeout = await schedule(admin);
        mode = 'timeout';
        await processPromotionalSms(deps.db, config, transport);
        await processPromotionalSms(deps.db, config, transport);
        assert.equal(sends, 2);
        assert.equal((await status(timeout.id, member.id)).status, 'unknown');
        const capped = await schedule(admin);
        mode = 'accepted';
        await processPromotionalSms(deps.db, { ...config, SMS_HOURLY_LIMIT: 1 }, transport);
        assert.equal((await status(capped.id, member.id)).status, 'queued');
        assert.equal(sends, 2, 'Unknown submissions still consume the shared hourly budget');
        const realNow = Date.now;
        t.mock.method(Date, 'now', () => realNow() + 10 * 3600000);
        await processPromotionalSms(deps.db, config, transport);
        t.mock.restoreAll();
        assert.equal((await status(capped.id, member.id)).status, 'accepted', 'Queue eligibility uses the database clock');
        const expired = await schedule(admin);
        await deps.db.smsCampaign.update({ where: { id: expired.id }, data: { scheduledFor: new Date(Date.now() - 25 * 3600000) } });
        const beforeExpired = sends;
        await processPromotionalSms(deps.db, config, transport);
        assert.equal((await status(expired.id, member.id)).status, 'skipped');
        assert.equal(sends, beforeExpired);
        const disabled = await schedule(admin);
        await deps.db.authUser.update({ where: { id: member.id }, data: { disabledAt: new Date() } });
        await processPromotionalSms(deps.db, config, transport);
        assert.equal((await status(disabled.id, member.id)).status, 'skipped');
        await deps.db.authUser.update({ where: { id: member.id }, data: { disabledAt: null } });
        const interrupted = await schedule(admin);
        await deps.db.smsCampaignRecipient.update({ where: { campaignId_userId: { campaignId: interrupted.id, userId: member.id } }, data: {
                status: 'sending', targetDigest: digest, sendingAt: new Date(Date.now() - 60000),
            } });
        const beforeInterrupted = sends;
        await processPromotionalSms(deps.db, config, transport);
        assert.equal((await status(interrupted.id, member.id)).status, 'unknown');
        assert.equal(sends, beforeInterrupted, 'A restarted worker must not resubmit an interrupted send');
        const rejected = await schedule(admin);
        mode = 'failed';
        await processPromotionalSms(deps.db, config, transport);
        const afterRejected = sends;
        await processPromotionalSms(deps.db, config, transport);
        assert.equal((await status(rejected.id, member.id)).status, 'failed');
        assert.equal(sends, afterRejected);
        assert.equal((await call(outsider, first.path)).status, 403);
        assert.ok((await call(admin, 'admin/sms-campaigns')).data.items.some((r: any) => r.id === first.id));
        assert.equal(await deps.db.smsCampaignRecipient.count({ where: { userId: { in: [bookingOnly.id, unverified.id, outsider.id, admin.id] } } }), 0);
    }
    finally {
        await deps.db.smsCampaignRecipient.deleteMany({ where: { campaignId: { in: campaigns } } });
        await deps.db.smsCampaign.deleteMany({ where: { id: { in: campaigns } } });
        await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
        await app.close();
    }
});
