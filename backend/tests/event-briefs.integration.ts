import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../api/src/app.js';
import { hashPassword } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'briefs-test-' + randomUUID() });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Event brief integration requires an isolated *_test database.');
}

test('event briefs persist, remain private, and reject stale changes', async () => {
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const ids: string[] = [];
  const password = 'A private event fixture password 12!';
  type Session = { accessToken: string; csrfToken: string };
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();

    async function call(path: string, method: string, session?: Session, body?: unknown) {
      const response = await fetch(base + '/api/v1/' + path, {
        method,
        headers: {
          'Content-Type': 'application/json', Origin: config.WEB_ORIGIN,
          ...(session ? { Authorization: 'Bearer ' + session.accessToken, 'X-CSRF-Token': session.csrfToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }

    async function login(role: 'customer' | 'admin'): Promise<Session> {
      const user = await deps.db.authUser.create({ data: {
        email: randomUUID() + '@stagelink.test', displayName: 'Event fixture', roles: [role],
        passwordHash: await hashPassword(password), emailVerifiedAt: new Date(),
      } });
      ids.push(user.id);
      const session = await call('auth/login', 'POST', undefined, { email: user.email, password });
      assert.equal(session.status, 200);
      return session.data;
    }

    const owner = await login('customer');
    const other = await login('customer');
    const admin = await login('admin');
    const brief = {
      title: 'School concert', description: 'Outdoor sound and live music', eventDate: '2028-02-29',
      city: 'Colombo', budgetMinor: 15000000, currency: 'LKR',
      requirements: [{ category: 'equipment', description: 'Powered speaker', quantity: 4 }],
    };
    assert.equal((await call('event-posts', 'POST', admin, brief)).status, 403);
    assert.equal((await call('event-posts', 'POST', owner, { ...brief, eventDate: '2027-02-29' })).status, 400);
    assert.equal((await call('event-posts', 'POST', owner, { ...brief, currency: 'USD' })).status, 400);
    const created = await call('event-posts', 'POST', owner, brief);
    assert.equal(created.status, 200);
    const path = 'event-posts/' + created.data.id;
    assert.equal(created.data.eventDate, brief.eventDate);
    assert.deepEqual(created.data.requirements, brief.requirements);
    assert.equal((await call(path, 'GET', other)).status, 404);
    assert.deepEqual((await call('me/event-posts', 'GET', other)).data.items, []);
    assert.equal((await call('me/event-posts', 'GET', owner)).data.items[0].id, created.data.id);
    const update = { revision: 1, budgetMinor: 17500000 };
    const edits = await Promise.all([call(path, 'PATCH', owner, update), call(path, 'PATCH', owner, update)]);
    assert.deepEqual(edits.map(result => result.status).sort(), [200, 409]);
    const reloaded = await call(path, 'GET', owner);
    assert.equal(reloaded.data.budgetMinor, update.budgetMinor);
    assert.equal(reloaded.data.eventDate, brief.eventDate);
    assert.equal((await call(path, 'DELETE', owner, { revision: 1 })).status, 409);
    assert.equal((await call(path, 'DELETE', owner, { revision: 2 })).status, 200);
    assert.equal((await call(path, 'GET', owner)).status, 404);
  } finally {
    try {
      await deps.db.authUser.deleteMany({ where: { id: { in: ids } } });
      let cursor = '0';
      do {
        const [next, keys] = await deps.redis.scan(cursor, 'MATCH', config.AUTH_RATE_PREFIX + ':*', 'COUNT', 100);
        cursor = next;
        if (keys.length) await deps.redis.del(...keys);
      } while (cursor !== '0');
    } finally {
      await app.close();
    }
  }
});
