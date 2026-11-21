import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'maintenance-cancel-' + randomUUID() });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test'))
    throw Error('Maintenance cancellation requires an isolated test database');
test('maintenance permits audited cancellation of pending communication while preserving submitted deliveries and blocking new work', async () => {
    const deps = resources(config), { app } = await createApp(config, deps), users: string[] = [], emails: string[] = [], sms: string[] = [];
    let bookingId: string | undefined;
    const initial = await deps.db.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
    await app.listen(0, '127.0.0.1');
    const root = (await app.getUrl()) + '/api/v1/';
    async function actor(role: 'admin' | 'customer', verified = true) { const user = await deps.db.authUser.create({ data: { email: randomUUID() + '@stagelink.test', displayName: 'Maintenance cancellation fixture', passwordHash: 'unused', roles: [role], emailVerifiedAt: verified ? new Date() : null } }); users.push(user.id); const session = await deps.db.authSession.create({ data: { userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600000) } }); const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex')); return { id: user.id, sessionId: session.id, headers: { Authorization: 'Bearer ' + token, Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id) } }; }
    type Actor = Awaited<ReturnType<typeof actor>>;
    async function call(actor: Actor | undefined, path: string, body?: unknown, headers: Record<string, string> = {}) { const r = await fetch(root + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json', ...actor?.headers, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() as any }; }
    const reason = 'Stop queued communication during maintenance.';
    try {
        const admin = await actor('admin'), member = await actor('customer'), unverified = await actor('admin', false), other = await actor('customer');
        const startsAt = new Date(Date.now() + 3600000);
        const booking = await deps.db.booking.create({ data: { customerId: member.id, providerId: other.id, requestKey: randomUUID(), requestDigest: '0'.repeat(64), targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, snapshot: {}, startsAt, endsAt: new Date(startsAt.getTime() + 3600000), holdExpiresAt: startsAt, agreedAt: new Date() } });
        bookingId = booking.id;
        const reminder = await deps.db.bookingReminder.create({ data: { bookingId, recipientId: member.id, startsAt, dueAt: new Date(startsAt.getTime() - 7200000), offsetHours: 2 } });
        const accepted = await deps.db.bookingReminder.create({ data: { bookingId, recipientId: other.id, startsAt, dueAt: new Date(startsAt.getTime() - 7200000), offsetHours: 2, status: 'accepted', attempts: 1, acceptedAt: new Date() } });
        const email = await deps.db.promotionalCampaign.create({ data: { id: randomUUID(), createdBy: admin.id, scheduledBy: admin.id, state: 'scheduled', scheduledFor: new Date(), subject: 'Fixture', body: 'Synthetic pending campaign', recipientLimit: 2 } });
        emails.push(email.id);
        await deps.db.promotionalCampaignRecipient.createMany({ data: [{ campaignId: email.id, userId: member.id, consentRevision: 1 }, { campaignId: email.id, userId: other.id, consentRevision: 1, deliveryStatus: 'accepted', claimedAt: new Date(), resolvedAt: new Date() }] });
        const campaign = await deps.db.smsCampaign.create({ data: { id: randomUUID(), createdBy: admin.id, scheduledBy: admin.id, state: 'scheduled', scheduledFor: new Date(), body: 'Synthetic fixture.', recipientLimit: 2 } });
        sms.push(campaign.id);
        await deps.db.smsCampaignRecipient.createMany({ data: [{ campaignId: campaign.id, userId: member.id, contactRevision: 1 }, { campaignId: campaign.id, userId: other.id, contactRevision: 1, status: 'unknown', targetDigest: '1'.repeat(64), sendingAt: new Date() }] });
        const paths = ['admin/reminders/' + reminder.id + '/cancel', 'admin/campaigns/' + email.id + '/cancel', 'admin/sms-campaigns/' + campaign.id + '/cancel'];
        await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: true, maintenanceMessage: 'Cancellation fixture' } });
        for (const path of paths) {
            assert.equal((await call(undefined, path, { reason })).status, 401);
            assert.equal((await call(member, path, { reason })).status, 403);
            assert.equal((await call(unverified, path, { reason })).status, 403);
            assert.equal((await call(admin, path, { reason }, { 'X-CSRF-Token': 'bad' })).status, 403);
            assert.equal((await call(admin, path, { reason }, { Origin: 'https://untrusted.example' })).status, 403);
            assert.equal((await call(admin, path, { reason: 'short' })).status, 400);
            const result = await call(admin, path, { reason });
            assert.equal(result.status, 200, JSON.stringify(result.data));
            assert.equal((await call(admin, path, { reason })).status, 200);
        }
        assert.equal((await deps.db.bookingReminder.findUniqueOrThrow({ where: { id: reminder.id } })).status, 'cancelled');
        assert.equal((await deps.db.bookingReminder.findUniqueOrThrow({ where: { id: accepted.id } })).status, 'accepted');
        const audit = await deps.db.reminderAdminAction.findMany({ where: { reminderId: reminder.id } });
        assert.equal(audit.length, 1);
        assert.equal(audit[0]!.actorId, admin.id);
        assert.equal(audit[0]!.reason, reason);
        const emailAfter = await deps.db.promotionalCampaign.findUniqueOrThrow({ where: { id: email.id } });
        assert.equal(emailAfter.state, 'cancelled');
        assert.equal(emailAfter.cancelledBy, admin.id);
        assert.equal(emailAfter.cancellationReason, reason);
        assert.equal((await deps.db.promotionalCampaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: email.id, userId: member.id } } })).deliveryStatus, 'skipped');
        assert.equal((await deps.db.promotionalCampaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: email.id, userId: other.id } } })).deliveryStatus, 'accepted');
        const smsAfter = await deps.db.smsCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
        assert.equal(smsAfter.state, 'cancelled');
        assert.equal(smsAfter.cancelledBy, admin.id);
        assert.equal(smsAfter.cancellationReason, reason);
        assert.equal((await deps.db.smsCampaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: campaign.id, userId: member.id } } })).status, 'skipped');
        assert.equal((await deps.db.smsCampaignRecipient.findUniqueOrThrow({ where: { campaignId_userId: { campaignId: campaign.id, userId: other.id } } })).status, 'unknown');
        for (const path of ['admin/reminders/' + reminder.id + '/retry', 'admin/campaigns/' + email.id + '/schedule', 'admin/sms-campaigns/' + campaign.id + '/schedule', 'admin/campaigns', 'admin/sms-campaigns']) {
            const blocked = await call(admin, path, {});
            assert.equal(blocked.status, 503);
            assert.equal(blocked.data.code, 'MAINTENANCE_MODE');
        }
        assert.equal((await call(admin, 'admin/reminders/' + accepted.id + '/cancel', { reason })).status, 409);
        assert.equal((await call(admin, 'admin/campaigns/' + email.id)).status, 200);
        assert.equal((await call(admin, 'admin/sms-campaigns/' + campaign.id)).status, 200);
    }
    finally {
        try {
            await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: initial.maintenance, maintenanceMessage: initial.maintenanceMessage } });
            await deps.db.promotionalCampaignRecipient.deleteMany({ where: { campaignId: { in: emails } } });
            await deps.db.promotionalCampaign.deleteMany({ where: { id: { in: emails } } });
            await deps.db.smsCampaignRecipient.deleteMany({ where: { campaignId: { in: sms } } });
            await deps.db.smsCampaign.deleteMany({ where: { id: { in: sms } } });
            if (bookingId) {
                await deps.db.reminderAdminAction.deleteMany({ where: { reminder: { bookingId } } });
                await deps.db.bookingReminder.deleteMany({ where: { bookingId } });
                await deps.db.booking.delete({ where: { id: bookingId } });
            }
            await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
            assert.equal(await deps.db.authUser.count({ where: { id: { in: users } } }), 0);
        }
        finally {
            await app.close();
        }
    }
});
