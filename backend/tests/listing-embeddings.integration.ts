import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { databaseNow } from '../shared/database-clock.js';
import { resources } from '../shared/resources.js';
import { serverClock } from './fixtures/server-clock.js';

const model = 'text-embedding-3-small';
const capability = 'listing-embedding';
const secret = 'ab'.repeat(32);
const vector = [1, ...Array<number>(255).fill(0)];

test('only admins index the current public gig with retries, version isolation and a shared quota', async () => {
  const requests: { url?: string; authorization?: string; body: unknown }[] = [];
  let notifyStarted!: () => void;
  let releaseResponse!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const proceed = new Promise<void>(resolve => { releaseResponse = resolve; });
  let notifyLateStarted!: () => void;
  let releaseLateResponse!: () => void;
  const lateStarted = new Promise<void>(resolve => { notifyLateStarted = resolve; });
  const lateProceed = new Promise<void>(resolve => { releaseLateResponse = resolve; });
  const service = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    const attempt = requests.length;
    if (attempt === 1) {
      notifyStarted();
      await proceed;
    }
    if (attempt === 4) {
      notifyLateStarted();
      await lateProceed;
    }
    const failed = attempt === 2;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      model, outcome: failed ? 'failed' : 'succeeded', vector: failed ? null : vector, latencyMs: 20, inputTokens: 7,
    }));
  });
  const config = readConfig({
    ...process.env, AI_EMBEDDING_MODEL: model, AI_EMBEDDING_DAILY_LIMIT: '4', AI_INTERNAL_TOKEN: secret,
    AUTH_RATE_PREFIX: 'embeddings-test-' + randomUUID(),
  });
  if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
    throw new Error('Listing embedding integration requires an isolated *_test database.');
  }
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const address = service.address();
  assert.ok(address && typeof address === 'object');
  const deps = resources(config);
  const { app } = await createApp({ ...config, AI_SERVICE_ORIGIN: 'http://127.0.0.1:' + address.port }, deps);
  const users: string[] = [];
  const gigId = randomUUID();
  const since = await databaseNow(deps.db);

  try {
    await app.listen(0, '127.0.0.1');
    const endpoint = await app.getUrl() + '/api/v1/admin/ai/listing-embeddings/' + gigId;
    async function fixture(role: 'artist' | 'admin', verified = true) {
      const user = await deps.db.authUser.create({ data: {
        email: randomUUID() + '@stagelink.test', displayName: 'Embedding fixture', roles: [role],
        passwordHash: 'unused', emailVerifiedAt: verified ? new Date() : null,
      } });
      users.push(user.id);
      const session = await deps.db.authSession.create({ data: {
        userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600_000),
      } });
      const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 180).setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
      return {
        userId: user.id,
        headers: {
          Authorization: 'Bearer ' + token, 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id),
          Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json',
        },
      };
    }
    const admin = await fixture('admin');
    const otherAdmin = await fixture('admin');
    const unverified = await fixture('admin', false);
    const artist = await fixture('artist');
    const call = async (headers: Record<string, string>, expectedVersion?: number) => {
      const response = await fetch(endpoint, expectedVersion === undefined
        ? { headers }
        : { method: 'POST', headers, body: JSON.stringify({ expectedVersion }) });
      return { status: response.status, data: await response.json() };
    };
    await deps.db.providerProfile.create({ data: {
      userId: artist.userId, kind: 'artist', displayName: 'Artist fixture', city: 'Colombo', bio: '',
      serviceRadiusKm: 30, address: 'Private address', category: 'Band', genres: ['Jazz'], experienceYears: 1,
      baseRateMinor: 5000, equipmentCategories: [], operatingHours: [], rentalTerms: '',
      approvedRevision: 1, approvedSnapshot: { displayName: 'Public artist name' }, reviewStatus: 'approved',
    } });
    await deps.db.artistGig.create({ data: { id: gigId, ownerId: artist.userId } });
    async function createVersion(version: number) {
      await deps.db.artistGigVersion.create({ data: {
        gigId, version, title: 'Jazz set ' + version, description: 'Public description', priceMinor: 5000,
      } });
    }
    async function publish(version: number) {
      await deps.db.artistGig.update({ where: { id: gigId }, data: { publishedVersion: version, revision: version, status: 'published' } });
    }
    await createVersion(1);
    await createVersion(2);
    assert.equal((await call(admin.headers, 1)).status, 404);
    await publish(1);
    assert.equal((await call({}, undefined)).status, 401);
    assert.equal((await call(artist.headers, 1)).status, 403);
    assert.equal((await call(unverified.headers)).data.code, 'EMAIL_VERIFICATION_REQUIRED');
    assert.equal((await call({ ...admin.headers, 'X-CSRF-Token': 'invalid' }, 1)).data.code, 'CSRF_REJECTED');
    assert.equal((await call(admin.headers, 2)).data.code, 'GIG_VERSION_CHANGED');
    assert.equal((await call(admin.headers)).data.state, 'missing');
    assert.equal(requests.length, 0);

    const ready = await serverClock(120_000, async () => {
      const indexing = call(admin.headers, 1);
      await Promise.race([started, indexing.then(result => assert.fail(JSON.stringify(result)))]);
      try {
        assert.equal((await call(otherAdmin.headers)).data.state, 'processing');
        assert.equal((await call(otherAdmin.headers, 1)).data.state, 'processing');
        assert.equal(requests.length, 1);
      } finally {
        releaseResponse();
      }
      return indexing;
    });
    assert.equal(ready.status, 200);
    assert.equal(ready.data.state, 'ready');
    assert.equal(ready.data.gigVersion, 1);
    assert.ok(ready.data.indexedAt);
    assert.equal('vector' in ready.data, false);
    assert.deepEqual(await call(admin.headers), ready);
    assert.deepEqual(await call(admin.headers, 1), ready);
    assert.deepEqual(requests, [{
      url: '/internal/embeddings', authorization: 'Bearer ' + secret,
      body: { model, text: 'Jazz set 1\n\nPublic description' },
    }]);
    const first = await deps.db.listingEmbedding.findFirstOrThrow({ where: { gigId, gigVersion: 1 } });
    assert.deepEqual(first.vector, vector);
    assert.ok(first.indexedAt && first.indexedAt >= first.startedAt && first.indexedAt <= await databaseNow(deps.db));

    await publish(2);
    assert.equal((await call(admin.headers, 1)).status, 409);
    assert.equal((await call(admin.headers)).data.state, 'missing');
    assert.equal((await call(admin.headers, 2)).data.state, 'failed');
    const second = await deps.db.listingEmbedding.findFirstOrThrow({ where: { gigId, gigVersion: 2 } });
    const where = { gigId_gigVersion_model_inputVersion: { gigId, gigVersion: 2, model, inputVersion: second.inputVersion } };
    const expiry = new Date((await databaseNow(deps.db)).getTime() - 31_000);
    await deps.db.listingEmbedding.update({ where, data: { state: 'processing', startedAt: expiry } });
    await serverClock(-120_000, async () => {
      assert.equal((await call(admin.headers)).data.state, 'failed');
      assert.equal((await call(admin.headers, 2)).data.state, 'ready');
    });
    assert.notEqual((await deps.db.listingEmbedding.findUniqueOrThrow({ where })).attemptId, second.attemptId);

    await createVersion(3);
    await publish(3);
    await serverClock(-120_000, async () => {
      const indexing = call(admin.headers, 3);
      await Promise.race([lateStarted, indexing.then(result => assert.fail(JSON.stringify(result)))]);
      try {
        const pending = await deps.db.listingEmbedding.findFirstOrThrow({ where: { gigId, gigVersion: 3 } });
        assert.ok(pending.startedAt > expiry && pending.startedAt <= await databaseNow(deps.db));
        const startedAt = new Date((await databaseNow(deps.db)).getTime() - 31_000);
        await deps.db.listingEmbedding.updateMany({ where: { gigId, gigVersion: 3 }, data: { startedAt } });
        assert.equal((await call(admin.headers)).data.state, 'failed');
        releaseLateResponse();
        const expired = await indexing;
        assert.equal(expired.status, 200);
        assert.equal(expired.data.state, 'failed');
        assert.equal(expired.data.indexedAt, null);
        const saved = await deps.db.listingEmbedding.findFirstOrThrow({ where: { gigId, gigVersion: 3 } });
        assert.deepEqual(saved.vector, pending.vector);
      } finally {
        releaseLateResponse();
      }
    });
    const usage = await deps.db.aiModelCall.findMany({ where: { model, capability, createdAt: { gte: since } } });
    assert.deepEqual(usage.map(item => item.outcome).sort(), ['failed', 'succeeded', 'succeeded', 'succeeded']);
    const finishedAt = await databaseNow(deps.db);
    assert.ok(usage.every(item => item.inputTokens === 7 && item.createdAt <= finishedAt));

    await createVersion(4);
    await publish(4);
    assert.equal((await call(otherAdmin.headers, 4)).status, 429);
    assert.equal((await call(admin.headers)).data.state, 'failed');
    assert.equal(requests.length, 4);
    await deps.db.artistGig.update({ where: { id: gigId }, data: { status: 'paused' } });
    assert.equal((await call(admin.headers)).status, 404);
  } finally {
    releaseResponse();
    releaseLateResponse();
    try {
      await deps.db.aiModelCall.deleteMany({ where: { model, capability, createdAt: { gte: since } } });
      await deps.db.artistGig.updateMany({ where: { id: gigId }, data: { publishedVersion: null, status: 'draft' } });
      await deps.db.artistGigVersion.deleteMany({ where: { gigId } });
      await deps.db.artistGig.deleteMany({ where: { id: gigId } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()));
    }
  }
});
