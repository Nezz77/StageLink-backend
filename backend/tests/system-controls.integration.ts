import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../api/src/app.js';
import { hashPassword } from '../api/src/auth/security.js';
import { processPromotionalEmail } from '../shared/campaign-delivery.js';
import { databaseNow } from '../shared/database-clock.js';
import { promotionalUnsubscribeHeaders } from '../shared/promotional-unsubscribe.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
import { serverClock } from './fixtures/server-clock.js';

const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'system-controls-test-' + randomUUID() });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('System controls integration requires an isolated *_test database.');
}

test('system controls enforce maintenance, invalidate announcements and revoke scoped sessions', async () => {
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const users: string[] = [];
  const announcementId = randomUUID();
  const futureAnnouncementId = randomUUID();
  const campaignId = randomUUID();
  const deliveryCampaignId = randomUUID();
  const password = 'A private fixture password 12!';
  const reason = 'Verify the system operations.';
  type Login = { accessToken: string; csrfToken: string; user: { id: string; email: string } };
  const initial = await deps.db.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    async function request(path: string, method = 'GET', body?: object, actor?: Login) {
      const response = await fetch(base + '/api/v1/' + path, {
        method,
        headers: {
          Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json',
          ...(actor ? { Authorization: 'Bearer ' + actor.accessToken, 'X-CSRF-Token': actor.csrfToken } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { response, data: await response.json() };
    }

    async function fixture(role: 'admin' | 'customer'): Promise<Login> {
      const user = await deps.db.authUser.create({ data: {
        email: randomUUID() + '@stagelink.test', displayName: 'System fixture', roles: [role],
        passwordHash: await hashPassword(password), emailVerifiedAt: new Date(),
      } });
      users.push(user.id);
      const { response, data } = await request('auth/login', 'POST', { email: user.email, password });
      assert.equal(response.status, 200);
      return data;
    }

    const admin = await fixture('admin');
    const customer = await fixture('customer');
    const outsider = await fixture('customer');
    const status = 'system/public-status';
    const controls = 'admin/system/maintenance';
    const change = { revision: initial.revision, enabled: true, message: 'Scheduled work.', reason };
    assert.equal((await request(controls, 'PUT', change, customer)).response.status, 403);
    const enabled = await request(controls, 'PUT', change, admin);
    assert.equal(enabled.response.status, 200);
    assert.equal((await request(status)).data.message, change.message);
    const write = await request('event-posts', 'POST', {}, customer);
    assert.equal(write.response.status, 503);
    assert.equal(write.response.headers.get('retry-after'), '60');
    assert.equal(write.data.code, 'MAINTENANCE_MODE');
    assert.equal((await request('payments/webhooks/stripe', 'POST', {})).data.code === 'MAINTENANCE_MODE', false);
    assert.equal((await request('auth/login', 'POST', { email: customer.user.email, password })).response.status, 200);
    assert.equal((await request(controls, 'PUT', { revision: initial.revision, enabled: false, reason }, admin)).response.status, 409);

    const hasAnnouncement = async () => (await request('public/announcements')).data.items
      .some((item: { id: string }) => item.id === announcementId);
    assert.equal(await hasAnnouncement(), false);
    const announcementTime = await databaseNow(deps.db);
    const startsLater = new Date(announcementTime.getTime() + 120_000);
    await deps.db.publicAnnouncement.create({ data: {
      id: futureAnnouncementId, title: 'Future notice', body: 'Scheduled message.',
      startsAt: startsLater, publishedAt: announcementTime,
    } });
    const publish = { action: 'publish', id: announcementId, title: 'System notice', body: 'Scheduled maintenance.',
      startsAt: new Date(announcementTime.getTime() - 120_000).toISOString(), endsAt: startsLater.toISOString(), reason };
    const announcementSkew = 5 * 60_000;
    assert.equal((await serverClock(announcementSkew, () => request('admin/announcements', 'PUT', publish, admin))).response.status, 200);
    assert.equal(await hasAnnouncement(), true);
    for (const skew of [announcementSkew, -announcementSkew]) {
      await serverClock(skew, async () => {
        for (const [path, key] of [['public/feed', 'announcements'], ['public/announcements', 'items']] as const) {
          const { data } = await request(path);
          assert.deepEqual(data[key].map((item: { id: string }) => item.id)
            .filter((id: string) => id === announcementId || id === futureAnnouncementId), [announcementId]);
        }
      });
    }
    assert.equal((await request('admin/cache/invalidate', 'POST', { scope: 'sessions', reason }, admin)).response.status, 400);
    assert.equal((await request('admin/cache/invalidate', 'POST', { scope: 'public_announcements', reason }, admin)).response.status, 200);
    assert.equal((await request('admin/announcements', 'PUT', { action: 'unpublish', id: announcementId, reason }, admin)).response.status, 200);
    assert.equal(await hasAnnouncement(), false);

    const session = await deps.db.authSession.findFirstOrThrow({
      where: { userId: customer.user.id }, orderBy: { createdAt: 'asc' },
    });
    assert.equal((await request('admin/sessions/revoke', 'POST', { userId: outsider.user.id, sessionId: session.id, reason }, admin)).response.status, 404);
    assert.ok((await request('admin/sessions/revoke', 'POST', { userId: customer.user.id, reason }, admin)).data.revoked > 0);
    assert.equal((await request('me', 'GET', undefined, customer)).response.status, 401);
    assert.equal((await request('me', 'GET', undefined, outsider)).response.status, 200);
    assert.equal((await request('admin/audit', 'GET', undefined, outsider)).response.status, 403);
    const events = await request('admin/audit', 'GET', undefined, admin);
    assert.deepEqual(events.data.items.filter((row: { actorId: string }) => row.actorId === admin.user.id)
      .map((row: { action: string }) => row.action), [
      'sessions_revoke', 'announcement_unpublish', 'announcement_cache_invalidate', 'announcement_publish', 'maintenance',
    ]);
    assert.equal((await request(controls, 'PUT', { revision: enabled.data.revision, enabled: false, reason }, admin)).response.status, 200);
    assert.equal((await request('event-posts', 'POST', {}, outsider)).response.status, 400);

    const preferencePath = 'me/marketing-preferences';
    assert.deepEqual((await request(preferencePath, 'GET', undefined, outsider)).data, { revision: 0, emailOptIn: false });
    const consent = { revision: 0, emailOptIn: true };
    assert.deepEqual((await request(preferencePath, 'PUT', consent, outsider)).data, { revision: 1, emailOptIn: true });
    const draft = { id: campaignId, subject: 'StageLink update', body: 'A member update.', recipientLimit: 100 };
    assert.equal((await request('admin/campaigns', 'POST', draft, outsider)).response.status, 403);
    assert.equal((await request('admin/campaigns', 'POST', draft, admin)).data.state, 'draft');
    const campaign = 'admin/campaigns/' + campaignId;
    const preview = await request(campaign + '/preview', 'POST', {}, admin);
    assert.equal(preview.data.recipientCount, 1);
    assert.deepEqual(Object.keys(preview.data).sort(), ['audienceFingerprint', 'recipientCount', 'recipientLimit']);
    const campaignTime = (await databaseNow(deps.db)).getTime();
    const scheduledFor = new Date(campaignTime + 120_000).toISOString();
    await request(preferencePath, 'PUT', { revision: 1, emailOptIn: false }, outsider);
    const stale = { scheduledFor, audienceFingerprint: preview.data.audienceFingerprint };
    assert.equal((await request(campaign + '/schedule', 'POST', stale, admin)).data.code, 'CAMPAIGN_AUDIENCE_CHANGED');
    await request(preferencePath, 'PUT', { revision: 2, emailOptIn: true }, outsider);
    const refreshed = await request(campaign + '/preview', 'POST', {}, admin);
    const schedule = { scheduledFor, audienceFingerprint: refreshed.data.audienceFingerprint };
    const skew = 5 * 60_000;
    const slowAdmin = await serverClock(-skew, async () => {
      const login = await request('auth/login', 'POST', { email: admin.user.email, password });
      assert.equal(login.response.status, 200);
      return login.data as Login;
    });
    const pastSchedule = { ...schedule, scheduledFor: new Date(campaignTime - 120_000).toISOString() };
    const beyondLimit = { ...schedule, scheduledFor: new Date(campaignTime + 30 * 86_400_000 + 120_000).toISOString() };
    assert.equal((await serverClock(-skew, () => request(campaign + '/schedule', 'POST', pastSchedule, slowAdmin))).data.code,
      'INVALID_CAMPAIGN_SCHEDULE');
    assert.equal((await serverClock(skew, () => request(campaign + '/schedule', 'POST', beyondLimit, admin))).data.code,
      'INVALID_CAMPAIGN_SCHEDULE');
    assert.equal((await serverClock(skew, () => request(campaign + '/schedule', 'POST', schedule, admin))).data.state, 'scheduled');
    assert.equal((await request(campaign + '/schedule', 'POST', schedule, admin)).data.recipientCount, 1);
    const beforeCancel = await databaseNow(deps.db);
    const cancelled = await serverClock(-skew, () => request(campaign + '/cancel', 'POST', { reason }, slowAdmin));
    assert.equal(cancelled.data.state, 'cancelled');
    const cancelledRecipient = await deps.db.promotionalCampaignRecipient.findFirstOrThrow({ where: { campaignId } });
    assert.equal(cancelledRecipient.deliveryStatus, 'skipped');
    assert.equal(cancelledRecipient.resolvedAt?.toISOString(), cancelled.data.cancelledAt);
    assert.ok(cancelledRecipient.resolvedAt! >= beforeCancel);

    const deliveryCampaign = 'admin/campaigns/' + deliveryCampaignId;
    assert.equal((await request('admin/campaigns', 'POST', { ...draft, id: deliveryCampaignId }, admin)).response.status, 200);
    const deliveryPreview = await request(deliveryCampaign + '/preview', 'POST', {}, admin);
    assert.equal((await request(deliveryCampaign + '/schedule', 'POST', {
      scheduledFor, audienceFingerprint: deliveryPreview.data.audienceFingerprint,
    }, admin)).response.status, 200);
    let sends = 0;
    const mailer = { async sendMail() {
      sends += 1;
      return {
        accepted: [outsider.user.email], rejected: [], response: '250 fixture accepted',
        messageId: 'campaign-clock-fixture', envelope: { from: config.SMTP_FROM, to: [outsider.user.email] },
        envelopeTime: 0, messageTime: 0, messageSize: 0,
      };
    } };
    const deliver = () => processPromotionalEmail(deps.db, { ...config, PROMOTIONAL_EMAIL_DELIVERY: 'true' }, mailer);
    await serverClock(skew, deliver);
    assert.equal(sends, 0, 'A fast host must not send a future campaign');
    await deps.db.promotionalCampaign.update({
      where: { id: deliveryCampaignId }, data: { scheduledFor: pastSchedule.scheduledFor },
    });
    await serverClock(-skew, deliver);
    const delivered = await deps.db.promotionalCampaignRecipient.findFirstOrThrow({ where: { campaignId: deliveryCampaignId } });
    assert.equal(sends, 1);
    assert.equal(delivered.deliveryStatus, 'accepted');
    assert.ok(delivered.resolvedAt! >= delivered.claimedAt!);
    assert.ok(delivered.resolvedAt! <= await databaseNow(deps.db));

    function unsubscribeUrl(consentRevision: number) {
      const headers = promotionalUnsubscribeHeaders({
        ...config, PROMOTIONAL_UNSUBSCRIBE_ORIGIN: 'https://api.stagelink.test',
      }, { userId: outsider.user.id, email: outsider.user.email, consentRevision });
      const url = new URL(headers['List-Unsubscribe']!.slice(1, -1));
      return base + url.pathname + url.search;
    }
    const url = unsubscribeUrl(3);
    assert.equal((await fetch(url)).status, 404);
    const form = { 'List-Unsubscribe': 'One-Click' };
    const unsubscribe = (target: string, fields = form) => fetch(target, {
      method: 'POST', body: new URLSearchParams(fields),
    });
    assert.equal((await unsubscribe(url + 'invalid')).status, 400);
    assert.equal((await unsubscribe(url, { 'List-Unsubscribe': 'anything-else' })).status, 400);
    assert.deepEqual((await request(preferencePath, 'GET', undefined, outsider)).data, { revision: 3, emailOptIn: true });
    const maintenance = await request(controls, 'PUT', { ...change, revision: enabled.data.revision + 1 }, admin);
    assert.equal(maintenance.response.status, 200);
    assert.equal((await unsubscribe(url)).status, 204);
    assert.equal((await unsubscribe(url)).status, 204);
    assert.deepEqual((await request(preferencePath, 'GET', undefined, outsider)).data, { revision: 4, emailOptIn: false });
    assert.equal((await request(preferencePath, 'PUT', { revision: 4, emailOptIn: true }, outsider)).response.status, 200);
    assert.equal((await unsubscribe(url)).status, 204);
    assert.deepEqual((await request(preferencePath, 'GET', undefined, outsider)).data, { revision: 5, emailOptIn: true });
    const multipart = new FormData();
    multipart.set('List-Unsubscribe', 'One-Click');
    assert.equal((await fetch(unsubscribeUrl(5), { method: 'POST', body: multipart })).status, 204);
    assert.deepEqual((await request(preferencePath, 'GET', undefined, outsider)).data, { revision: 6, emailOptIn: false });

  } finally {
    try {
      await deps.db.systemSetting.update({ where: { id: 1 }, data: {
        maintenance: initial.maintenance, maintenanceMessage: initial.maintenanceMessage, revision: initial.revision,
      } });
      await deps.db.publicAnnouncement.deleteMany({ where: { id: { in: [announcementId, futureAnnouncementId] } } });
      await deps.db.systemAuditEntry.deleteMany({ where: { actorId: { in: users } } });
      const campaignIds = [campaignId, deliveryCampaignId];
      await deps.db.promotionalCampaignRecipient.deleteMany({ where: { campaignId: { in: campaignIds } } });
      await deps.db.promotionalCampaign.deleteMany({ where: { id: { in: campaignIds } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app.close();
    }
  }
});
