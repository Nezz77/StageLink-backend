import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../api/src/app.js';
import { hashPassword } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'gigs-test-' + randomUUID() });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Gig integration requires an isolated *_test database.');
}

test('gig ownership, publication snapshots and concurrent revisions', async () => {
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const ids: string[] = [];
  const password = 'A private fixture password 12!';
  type Login = { accessToken: string; csrfToken: string; user: { id: string } };

  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();

    async function call(path: string, body?: unknown, login?: Login, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + '/api/v1/' + path, {
        method,
        headers: {
          'Content-Type': 'application/json', Origin: config.WEB_ORIGIN,
          ...(login ? { Authorization: 'Bearer ' + login.accessToken, 'X-CSRF-Token': login.csrfToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }

    async function fixture(role: 'artist' | 'admin'): Promise<Login> {
      const user = await deps.db.authUser.create({ data: {
        email: randomUUID() + '@stagelink.test', displayName: 'Gig fixture', roles: [role],
        passwordHash: await hashPassword(password), emailVerifiedAt: new Date(),
      } });
      ids.push(user.id);
      const result = await call('auth/login', { email: user.email, password });
      assert.equal(result.status, 200);
      return result.data;
    }

    const artist = await fixture('artist');
    const other = await fixture('artist');
    const admin = await fixture('admin');
    const fields = { title: 'Acoustic set', description: 'A live performance', priceMinor: 1500000 };
    assert.equal((await call('me/gigs', fields, admin)).status, 403);
    const created = await call('me/gigs', fields, artist);
    assert.equal(created.status, 200);
    const privatePath = 'me/gigs/' + created.data.id;
    const publicPath = 'listings/' + created.data.id;
    assert.deepEqual((await call('me/gigs', undefined, other)).data, []);
    assert.equal((await call(privatePath, { ...fields, revision: 1 }, other, 'PATCH')).status, 404);
    assert.equal((await call(publicPath)).status, 404);
    assert.equal((await call(privatePath + '/status', { revision: 1, action: 'publish' }, artist)).status, 409);

    const profile = {
      revision: 0, displayName: 'Acoustic fixture', bio: 'Acoustic music for events.', city: 'Colombo',
      serviceRadiusKm: 45, address: 'Private fixture address', latitude: null, longitude: null,
      details: { category: 'Vocalist', genres: ['Jazz'], experienceYears: 5, baseRateMinor: 1500000, currency: 'LKR' },
    };
    assert.equal((await call('me/providers/artist', profile, artist, 'PUT')).status, 200);
    assert.equal((await call('me/providers/artist/submit', { revision: 1 }, artist)).status, 200);
    const decision = { revision: 2, approved: true, reason: 'Approved artist profile for the catalog fixture' };
    assert.equal((await call(`admin/providers/${artist.user.id}/artist/decision`, decision, admin)).status, 200);

    assert.equal((await call(privatePath + '/status', { revision: 1, action: 'publish' }, artist)).status, 200);
    const fixed = {
      title: 'Acoustic package', pricing: 'fixed', durationMinutes: 120, performers: 2,
      basePriceMinor: 1500000, included: 'Acoustic set', excluded: 'Lighting',
      addons: [{ id: 'sound', title: 'Sound system', priceMinor: 100000 }],
    };
    const packages = [
      { ...fixed, id: 'standard' },
      { ...fixed, id: 'deluxe', performers: 4 },
      { ...fixed, id: 'vip', pricing: 'custom', basePriceMinor: null, addons: [] },
    ];
    const change = { ...fields, packages, title: 'Revised acoustic set', revision: 2 };
    assert.equal((await call(privatePath, { ...change, packages: [packages[0]] }, artist, 'PATCH')).status, 400);
    const attempts = await Promise.all([
      call(privatePath, change, artist, 'PATCH'),
      call(privatePath, change, artist, 'PATCH'),
    ]);
    assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
    const stillPublished = await call(publicPath);
    assert.equal(stillPublished.data.title, fields.title);
    assert.deepEqual(stillPublished.data.packages, []);
    assert.deepEqual((await call('me/gigs', undefined, artist)).data[0].packages, packages);
    assert.equal((await call(privatePath + '/status', { revision: 3, action: 'publish' }, artist)).status, 200);
    const republished = await call(publicPath);
    assert.equal(republished.data.title, change.title);
    assert.deepEqual(republished.data.packages, packages);
    assert.equal((await call(privatePath + '/status', { revision: 4, action: 'pause' }, artist)).status, 200);
    assert.equal((await call(publicPath)).status, 404);
    assert.equal((await call(privatePath + '/status', { revision: 5, action: 'archive' }, artist)).status, 200);
    assert.deepEqual((await call('me/gigs', undefined, artist)).data, []);
    assert.equal(await deps.db.artistGigVersion.count({ where: { gigId: created.data.id } }), 2);
  } finally {
    try {
      const owned = { ownerId: { in: ids } };
      await deps.db.artistGig.updateMany({ where: owned, data: { status: 'archived', publishedVersion: null } });
      await deps.db.artistGigVersion.deleteMany({ where: { gig: owned } });
      await deps.db.artistGig.deleteMany({ where: owned });
      await deps.db.profileAudit.deleteMany({ where: { targetUserId: { in: ids } } });
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
