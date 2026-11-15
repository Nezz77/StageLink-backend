import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const baseConfig = readConfig();
if (baseConfig.NODE_ENV !== 'test' || !new URL(baseConfig.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Equipment reference tests require an isolated *_test database.');
}

test('equipment lookup retains approved sources, matches exact models and hides retired specifications', async () => {
  const config = { ...baseConfig, AI_SERVICE_ORIGIN: undefined, AI_INTERNAL_TOKEN: undefined };
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const users: string[] = [];
  const sourceIds: string[] = [];
  try {
    await app.listen(0, '127.0.0.1');
    const root = (await app.getUrl()) + '/api/v1/';
    async function actor(role: 'admin' | 'renter' | 'customer') {
      const user = await deps.db.authUser.create({ data: {
        roles: [role], email: randomUUID() + '@stagelink.test', displayName: 'Equipment reference fixture',
        passwordHash: 'unused', emailVerifiedAt: new Date(),
      } });
      users.push(user.id);
      const session = await deps.db.authSession.create({ data: {
        userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600_000),
      } });
      const access = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id)
        .setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
      return {
        Authorization: 'Bearer ' + access, 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id),
        Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json',
      };
    }
    async function request(headers: Awaited<ReturnType<typeof actor>>, path: string, body?: object) {
      const response = await fetch(root + path, {
        headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() };
    }
    const admin = await actor('admin');
    const renter = await actor('renter');
    const other = await actor('renter');
    const customer = await actor('customer');
    const catalog = 'admin/equipment-spec-sources';
    const search = 'ai/generations/equipment-specs';
    const source = {
      manufacturer: 'Fixture Audio', model: 'X-12', specs: { specWattage: '240', specWeight: '14.25' },
      url: 'https://vendor.example/specification', title: 'Fixture specification sheet', locator: 'Page 8',
    };
    assert.equal((await request(renter, catalog, source)).status, 403);
    assert.equal((await request({ ...admin, 'X-CSRF-Token': 'invalid' }, catalog, source)).status, 403);
    for (const invalid of [
      { ...source, specs: {} },
      { ...source, specs: { specSpl: '500' } },
      { ...source, specs: { packageInclusions: 'Rental-specific accessories' } },
      { ...source, url: 'http://vendor.example/specification' },
    ]) {
      assert.equal((await request(admin, catalog, invalid)).status, 400);
    }
    const approved = await request(admin, catalog, source);
    assert.equal(approved.status, 200);
    sourceIds.push(approved.data.id);
    assert.equal((await request(admin, catalog, { ...source, model: 'x-12' })).status, 409);
    assert.equal((await request(admin, catalog)).data.items.some((item: { id: string }) => item.id === approved.data.id), true);

    const input = { requestKey: randomUUID(), manufacturer: ' fixture   AUDIO ', model: 'x-12' };
    assert.equal((await request(customer, search, input)).status, 403);
    const matched = await request(renter, search, input);
    assert.equal(matched.status, 200);
    assert.equal(matched.data.kind, 'equipment-specs');
    assert.equal(matched.data.promptVersion, null);
    const snapshot = matched.data.suggestion;
    assert.equal(snapshot.match, 'matched');
    assert.deepEqual(snapshot.specs, source.specs);
    assert.deepEqual(snapshot.source, {
      id: approved.data.id, url: source.url, title: source.title, locator: source.locator, approvedAt: approved.data.approvedAt,
    });
    const lookup = 'ai/generations/' + matched.data.id;
    assert.deepEqual(await request(renter, lookup), matched);
    assert.equal((await request(other, lookup)).status, 404);
    assert.deepEqual(await request(renter, search, { ...input, manufacturer: 'Fixture Audio', model: 'X-12' }), matched);
    assert.equal((await request(renter, search, { ...input, model: 'X-12 MKII' })).status, 409);

    const unknown = await request(renter, search, { requestKey: randomUUID(), model: 'X-12 MKII' });
    assert.deepEqual(unknown.data.suggestion, {
      match: 'unknown', manufacturer: null, model: 'X-12 MKII', specs: {}, source: null,
    });
    const alternate = await request(admin, catalog, { ...source, manufacturer: 'Other fixture manufacturer' });
    assert.equal(alternate.status, 200);
    sourceIds.push(alternate.data.id);
    const ambiguous = await request(renter, search, { requestKey: randomUUID(), model: source.model });
    assert.equal(ambiguous.data.suggestion.match, 'ambiguous');
    assert.deepEqual(ambiguous.data.suggestion.specs, {});

    const retired = await request(admin, catalog + '/' + approved.data.id + '/retire', { reason: 'Reference was withdrawn.' });
    assert.equal(retired.status, 200);
    assert.ok(retired.data.retiredAt);
    const withdrawn = await request(renter, lookup);
    assert.deepEqual(withdrawn.data.suggestion, { ...snapshot, match: 'withdrawn', specs: {} });
    assert.deepEqual(await request(renter, search, input), withdrawn);

    const replacement = await request(admin, catalog, { ...source, specs: { specWeight: '14.50' }, locator: 'Page 10' });
    assert.equal(replacement.status, 200);
    sourceIds.push(replacement.data.id);
    const refreshed = await request(renter, search, { ...input, requestKey: randomUUID() });
    assert.deepEqual(refreshed.data.suggestion.specs, { specWeight: '14.50' });
    assert.equal(refreshed.data.suggestion.source.id, replacement.data.id);
    assert.equal((await request(renter, lookup)).data.suggestion.match, 'withdrawn');
    assert.equal(await deps.db.aiModelCall.count({ where: { generation: { ownerId: { in: users } } } }), 0);
    assert.equal(await deps.db.rentalListing.count({ where: { ownerId: { in: users } } }), 0);
  } finally {
    try {
      await deps.db.aiGenerationJob.deleteMany({ where: { ownerId: { in: users } } });
      await deps.db.equipmentSpecSource.deleteMany({ where: { id: { in: sourceIds } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app.close();
    }
  }
});
