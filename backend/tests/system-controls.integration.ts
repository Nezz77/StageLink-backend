import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../api/src/app.js';
import { hashPassword } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'system-controls-test-' + randomUUID() });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('System controls integration requires an isolated *_test database.');
}

test('system controls enforce maintenance, invalidate announcements and revoke scoped sessions', async () => {
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const users: string[] = [];
  const announcementId = randomUUID();
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
    const publish = { action: 'publish', id: announcementId, title: 'System notice', body: 'Scheduled maintenance.',
      startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: null, reason };
    assert.equal((await request('admin/announcements', 'PUT', publish, admin)).response.status, 200);
    assert.equal(await hasAnnouncement(), true);
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
  } finally {
    try {
      await deps.db.systemSetting.update({ where: { id: 1 }, data: {
        maintenance: initial.maintenance, maintenanceMessage: initial.maintenanceMessage, revision: initial.revision,
      } });
      await deps.db.publicAnnouncement.deleteMany({ where: { id: announcementId } });
      await deps.db.systemAuditEntry.deleteMany({ where: { actorId: { in: users } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app.close();
    }
  }
});
