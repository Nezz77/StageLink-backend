import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { listingEmbeddingInput } from '../api/src/ai/embedding-client.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const model = 'text-embedding-3-small';
const capability = 'semantic-recommendation';
const query = [1, ...Array<number>(255).fill(0)];
const offTopic = [0, 1, ...Array<number>(254).fill(0)];

test('semantic recommendations preserve eligibility, consent, provenance, and weighted fallback', async () => {
  const config = readConfig({
    ...process.env, AUTH_RATE_PREFIX: 'recommendation-test-' + randomUUID(),
    AI_EMBEDDING_MODEL: model, AI_INTERNAL_TOKEN: 'ab'.repeat(32),
    AI_SEMANTIC_RECOMMENDATIONS: 'true', AI_SEMANTIC_DAILY_LIMIT: '2',
  });
  if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
    throw new Error('Semantic recommendation integration requires an isolated *_test database.');
  }
  const calls: unknown[] = [];
  let notifyStarted!: () => void;
  let releaseResponse!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const proceed = new Promise<void>(resolve => { releaseResponse = resolve; });
  const service = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    const first = calls.length === 1;
    if (first) {
      notifyStarted();
      await proceed;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      model, outcome: first ? 'succeeded' : 'failed', vector: first ? query : null, latencyMs: 12, inputTokens: 8,
    }));
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const address = service.address();
  assert.ok(address && typeof address === 'object');
  const deps = resources(config);
  const { app } = await createApp({ ...config, AI_SERVICE_ORIGIN: 'http://127.0.0.1:' + address.port }, deps);
  const users: string[] = [];
  const gigs: string[] = [];
  const since = new Date();

  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl() + '/api/v1/';
    async function user(role: 'artist' | 'customer') {
      const row = await deps.db.authUser.create({ data: {
        email: randomUUID() + '@stagelink.test', displayName: 'Recommendation fixture', roles: [role],
        passwordHash: 'unused', emailVerifiedAt: new Date(),
      } });
      users.push(row.id);
      return row.id;
    }
    async function session(ownerId: string) {
      const row = await deps.db.authSession.create({ data: {
        userId: ownerId, activeRole: 'customer', expiresAt: new Date(Date.now() + 600_000),
      } });
      const token = await new SignJWT({ sid: row.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(ownerId)
        .setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
      return {
        Authorization: 'Bearer ' + token, 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, row.id),
        Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json',
      };
    }
    async function listing(priceMinor: number, vector: number[], currentVersion = 1) {
      const ownerId = await user('artist');
      await deps.db.providerProfile.create({ data: {
        userId: ownerId, kind: 'artist', displayName: 'Artist fixture', city: 'Colombo', bio: '',
        serviceRadiusKm: 30, address: 'Private address', category: 'Band', genres: ['Jazz'], experienceYears: 1,
        baseRateMinor: priceMinor, equipmentCategories: [], operatingHours: [], rentalTerms: '', approvedRevision: 1,
        approvedSnapshot: { city: 'Colombo', details: { genres: ['Jazz'] } }, reviewStatus: 'approved',
      } });
      const { id } = await deps.db.artistGig.create({ data: { ownerId } });
      gigs.push(id);
      for (let version = 1; version <= currentVersion; version++) {
        await deps.db.artistGigVersion.create({ data: { gigId: id, version, title: 'Show', description: 'Public listing', priceMinor } });
      }
      await deps.db.artistGig.update({
        where: { id }, data: { status: 'published', revision: currentVersion, publishedVersion: currentVersion },
      });
      await deps.db.listingEmbedding.create({ data: {
        gigId: id, gigVersion: 1, model, inputVersion: listingEmbeddingInput, state: 'ready',
        vector, attemptId: randomUUID(), startedAt: new Date(), indexedAt: new Date(),
      } });
      return { id, ownerId };
    }
    const ownerId = await user('customer');
    const owner = await session(ownerId);
    const other = await session(await user('customer'));
    const brief = await deps.db.eventBrief.create({ data: {
      ownerId, city: 'Colombo', eventDate: new Date('2080-02-29'), budgetMinor: 1000,
      title: 'Jazz reception', description: 'Instrumental small-band sound',
      requirements: [{ category: 'venue', description: 'Private venue detail', quantity: 1 }],
    } });
    const path = 'event-posts/' + brief.id + '/recommendations';
    const relevant = await listing(800, query);
    const cheap = await listing(200, offTopic);
    const stale = await listing(400, query, 2);
    const paused = await listing(50, query);
    const expensive = await listing(1100, query);
    const blocked = await listing(100, query);
    await deps.db.availabilityCalendar.create({ data: { ownerId: blocked.ownerId, timezone: 'Asia/Colombo', hours: [] } });
    await deps.db.availabilityBlock.create({ data: {
      ownerId: blocked.ownerId, startsAt: new Date('2080-02-28T00:00:00+05:30'),
      endsAt: new Date('2080-03-02T00:00:00+05:30'), reason: 'Fixture blackout',
    } });
    async function request(headers: Record<string, string>, relative: string, command?: object) {
      const response = await fetch(base + relative, {
        method: command ? 'POST' : 'GET', headers, body: command ? JSON.stringify(command) : undefined,
      });
      return { status: response.status, data: await response.json() };
    }
    const command = () => ({ requestKey: randomUUID(), expectedRevision: brief.revision });
    const baseline = await request(owner, path, command());
    assert.equal(baseline.status, 200);
    assert.equal(baseline.data.method, 'weighted_catalog_v1');
    assert.equal(baseline.data.items[0].gigId, paused.id);
    assert.equal(calls.length, 0);

    const optedIn = { ...command(), useSemantic: true };
    assert.equal((await request(other, path, optedIn)).status, 404);
    const running = request(owner, path, optedIn);
    await Promise.race([started, running.then(result => assert.fail(JSON.stringify(result)))]);
    try {
      assert.equal((await request(owner, path, optedIn)).data.code, 'RECOMMENDATION_PROCESSING');
      assert.equal((await request(owner, path, { ...optedIn, useSemantic: false })).data.code, 'REQUEST_KEY_REUSED');
      await deps.db.artistGig.update({ where: { id: paused.id }, data: { status: 'paused' } });
    } finally {
      releaseResponse();
    }

    const hybrid = await running;
    assert.equal(hybrid.status, 200);
    assert.equal(hybrid.data.method, 'semantic_hybrid_v1');
    assert.deepEqual(hybrid.data.items.map((item: { gigId: string }) => item.gigId), [relevant.id, stale.id, cheap.id],
      JSON.stringify({ relevant, stale, cheap, paused, expensive, blocked, items: hybrid.data.items }));
    assert.deepEqual(hybrid.data.semantic, {
      model, listingInputVersion: listingEmbeddingInput, briefInputVersion: 'brief_title_description_v1', semanticWeight: 30,
    });
    assert.deepEqual(calls, [{ model, text: brief.title + '\n\n' + brief.description }]);
    assert.deepEqual(await request(owner, path, optedIn), hybrid);
    assert.deepEqual(await request(owner, 'recommendations/' + hybrid.data.id), hybrid);
    assert.equal((await request(other, 'recommendations/' + hybrid.data.id)).status, 404);

    const stored = await deps.db.recommendationRun.findUniqueOrThrow({ where: { id: hybrid.data.id } });
    const proof = stored.semanticProvenance as { candidates: { gigId: string; version: number; embeddingAttemptId: string | null }[] };
    assert.ok(proof.candidates.find(candidate => candidate.gigId === relevant.id)?.embeddingAttemptId);
    assert.ok(proof.candidates.some(candidate => candidate.gigId === stale.id && candidate.version === 2 && candidate.embeddingAttemptId === null));
    assert.ok(!proof.candidates.some(candidate => [paused.id, expensive.id, blocked.id].includes(candidate.gigId)));
    assert.ok(!JSON.stringify(stored).includes(brief.description));

    const failed = await request(owner, path, { ...command(), useSemantic: true });
    assert.equal(failed.status, 200);
    assert.equal(failed.data.method, 'weighted_catalog_v1');
    assert.equal(failed.data.items[0].gigId, cheap.id);
    assert.equal('semantic' in failed.data, false);
    assert.equal((await request(owner, path, { ...command(), useSemantic: true })).data.method, 'weighted_catalog_v1');
    assert.equal(calls.length, 2);

    await deps.db.artistGig.update({ where: { id: relevant.id }, data: { status: 'paused' } });
    const noCoverage = await request(owner, path, { ...command(), useSemantic: true });
    assert.equal(noCoverage.data.method, 'weighted_catalog_v1');
    assert.equal(calls.length, 2);

    const usage = await deps.db.aiModelCall.findMany({ where: { model, capability, createdAt: { gte: since } } });
    assert.deepEqual(usage.map(item => item.outcome).sort(), ['failed', 'succeeded']);
    assert.ok(usage.every(item => item.inputTokens === 8));
  } finally {
    releaseResponse();
    try {
      await deps.db.aiModelCall.deleteMany({ where: { model, capability, createdAt: { gte: since } } });
      await deps.db.artistGig.updateMany({ where: { id: { in: gigs } }, data: { publishedVersion: null, status: 'draft' } });
      await deps.db.artistGigVersion.deleteMany({ where: { gigId: { in: gigs } } });
      await deps.db.artistGig.deleteMany({ where: { id: { in: gigs } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()));
    }
  }
});
