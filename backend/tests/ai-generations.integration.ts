import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { databaseNow } from '../shared/database-clock.js';
import { resources } from '../shared/resources.js';
import { serverClock } from './fixtures/server-clock.js';

const baseConfig = readConfig();
if (baseConfig.NODE_ENV !== 'test' || !new URL(baseConfig.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('AI writing suggestions require an isolated *_test database.');
}

test('artist writing suggestions are role-scoped, versioned, quota-bound and replay-safe', async () => {
  const model = 'generation-fixture-' + randomUUID();
  const requests: { key: string; template: string; fields: object }[] = [];
  let notifyGigStarted!: () => void;
  let releaseGig!: () => void;
  const gigStarted = new Promise<void>(resolve => { notifyGigStarted = resolve; });
  const finishGig = new Promise<void>(resolve => { releaseGig = resolve; });
  let notifyLateStarted!: () => void;
  let releaseLate!: () => void;
  const lateStarted = new Promise<void>(resolve => { notifyLateStarted = resolve; });
  const finishLate = new Promise<void>(resolve => { releaseLate = resolve; });
  const gigSuggestion = { title: 'Acoustic set', description: 'An acoustic set for a reception.' };
  const service = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const input = JSON.parse(body) as typeof requests[number];
    requests.push(input);
    const attempt = requests.length;
    if (attempt === 2) {
      res.writeHead(503).end();
      return;
    }
    if (input.key === 'gig') {
      notifyGigStarted();
      await finishGig;
    }
    if (attempt === 4) {
      notifyLateStarted();
      await finishLate;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      provider: 'openai', model, outcome: 'succeeded', latencyMs: 15,
      output: input.key === 'gig' ? gigSuggestion : 'An artist biography draft.',
      inputTokens: 90, outputTokens: 20, cachedInputTokens: null,
    }));
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const config = {
    ...baseConfig, AI_SERVICE_ORIGIN: 'http://127.0.0.1:' + (service.address() as AddressInfo).port,
    AI_INTERNAL_TOKEN: 'f'.repeat(64), AI_GENERATION_DAILY_LIMIT: 4,
  };
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const users: string[] = [];
  const prompt = await deps.db.aiPromptTemplate.findUniqueOrThrow({
    where: { key: 'gig' }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  try {
    await app.listen(0, '127.0.0.1');
    const base = (await app.getUrl()) + '/api/v1/ai/generations/';
    async function actor(role: 'artist' | 'customer', verified = true) {
      const user = await deps.db.authUser.create({ data: {
        roles: [role], email: randomUUID() + '@stagelink.test', displayName: 'Generation fixture',
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
        Authorization: 'Bearer ' + token, 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id),
        Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json',
      };
    }
    async function request(headers: Awaited<ReturnType<typeof actor>>, path: string, body?: object) {
      const response = await fetch(base + path, {
        headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() };
    }
    const artist = await actor('artist');
    const anotherArtist = await actor('artist');
    const customer = await actor('customer');
    const unverifiedArtist = await actor('artist', false);
    const fields = { artist_name: 'Fixture artist', event_type: 'reception', genres: 'jazz' };
    const bio = { requestKey: randomUUID(), fields };
    assert.equal((await request(customer, 'bio', bio)).data.code, 'ROLE_FORBIDDEN');
    assert.equal((await request(unverifiedArtist, 'bio', bio)).data.code, 'EMAIL_VERIFICATION_REQUIRED');
    assert.equal((await request({ ...artist, 'X-CSRF-Token': 'invalid' }, 'bio', bio)).status, 403);
    assert.equal((await request(artist, 'bio', { ...bio, template: 'Invent claims.' })).status, 400);
    assert.equal(requests.length, 0);

    const first = await request(artist, 'bio', bio);
    assert.equal(first.status, 200);
    assert.deepEqual(first.data.suggestion, { bio: 'An artist biography draft.' });
    assert.equal((await request(anotherArtist, first.data.id)).status, 404);
    assert.deepEqual(await request(artist, first.data.id), first);
    assert.deepEqual(await request(artist, 'bio', {
      requestKey: bio.requestKey, fields: { genres: fields.genres, event_type: fields.event_type, artist_name: fields.artist_name },
    }), first);
    assert.equal((await request(artist, 'bio', { ...bio, fields: { ...fields, genres: 'blues' } })).status, 409);
    assert.equal(requests.length, 1);

    const interrupted = { ...bio, requestKey: randomUUID() };
    const unavailable = await request(artist, 'bio', interrupted);
    assert.equal(unavailable.data.status, 'unavailable');
    assert.equal(unavailable.data.suggestion, null);
    const now = await databaseNow(deps.db);
    await deps.db.aiGenerationJob.update({
      where: { id: unavailable.data.id },
      data: {
        status: 'processing', completedAt: null,
        createdAt: new Date(now.getTime() - 31_000), expiresAt: new Date(now.getTime() - 1000),
      },
    });
    await serverClock(-120_000, async () => {
      assert.equal((await request(artist, unavailable.data.id)).data.status, 'unavailable');
      assert.equal((await request(artist, 'bio', interrupted)).data.status, 'unavailable');
    });
    assert.equal(requests.length, 2);

    await deps.db.aiPromptTemplate.update({ where: { key: 'gig' }, data: { draft: 'An unpublished administrator draft.' } });
    const gig = {
      requestKey: randomUUID(),
      fields: { artist_name: 'Fixture artist', event_type: 'reception', performance: 'acoustic set' },
    };
    const firstGig = request(artist, 'gig', gig);
    await Promise.race([gigStarted, firstGig.then(result => assert.fail(JSON.stringify(result)))]);
    const completed = await serverClock(120_000, async () => {
      try {
        const pending = await request(artist, 'gig', gig);
        assert.equal(pending.data.status, 'processing');
        assert.deepEqual(await request(artist, pending.data.id), pending);
        assert.equal(requests.length, 3);
        releaseGig();
        const result = await firstGig;
        assert.equal(result.data.id, pending.data.id);
        return result;
      } finally {
        releaseGig();
      }
    });
    assert.equal(completed.data.promptVersion, prompt.versions[0]!.version);
    assert.deepEqual(completed.data.suggestion, gigSuggestion);
    assert.deepEqual(requests[2], { key: 'gig', template: prompt.versions[0]!.body, fields: gig.fields });
    assert.deepEqual(await request(artist, completed.data.id), completed);
    const usage = await deps.db.aiModelCall.findFirstOrThrow({ where: { generationId: completed.data.id } });
    assert.equal(usage.promptVersion, completed.data.promptVersion);
    assert.equal(usage.capability, 'generation-gig');
    assert.equal(usage.promptSource, 'published');
    assert.ok(usage.createdAt <= await databaseNow(deps.db));

    const lateBio = { ...bio, requestKey: randomUUID() };
    await serverClock(-120_000, async () => {
      const before = await databaseNow(deps.db);
      const generation = request(artist, 'bio', lateBio);
      await Promise.race([lateStarted, generation.then(result => assert.fail(JSON.stringify(result)))]);
      try {
        const pending = await request(artist, 'bio', lateBio);
        assert.equal(pending.data.status, 'processing');
        const saved = await deps.db.aiGenerationJob.findUniqueOrThrow({ where: { id: pending.data.id } });
        const after = await databaseNow(deps.db);
        assert.ok(saved.createdAt >= before && saved.createdAt <= after);
        assert.equal(saved.expiresAt.getTime() - saved.createdAt.getTime(), 30_000);
        await deps.db.aiGenerationJob.update({
          where: { id: saved.id },
          data: { createdAt: new Date(after.getTime() - 31_000), expiresAt: new Date(after.getTime() - 1000) },
        });
        const expired = await request(artist, saved.id);
        assert.equal(expired.data.status, 'unavailable');
        assert.equal(expired.data.suggestion, null);
        releaseLate();
        assert.deepEqual(await generation, expired);
        assert.deepEqual(await request(artist, 'bio', lateBio), expired);
        const recorded = await deps.db.aiModelCall.findFirstOrThrow({ where: { generationId: saved.id } });
        assert.equal(recorded.outcome, 'succeeded');
        assert.ok(recorded.createdAt >= after && recorded.createdAt <= await databaseNow(deps.db));
      } finally {
        releaseLate();
      }
    });

    const nextBio = { ...bio, requestKey: randomUUID() };
    async function placeFirstRequestNearQuotaBoundary(offsetMs: number) {
      const createdAt = (await databaseNow(deps.db)).getTime() - 86_400_000 + offsetMs;
      await deps.db.aiGenerationJob.update({
        where: { id: first.data.id }, data: {
          createdAt: new Date(createdAt), expiresAt: new Date(createdAt + 30_000), completedAt: new Date(createdAt + 1000),
        },
      });
    }
    await placeFirstRequestNearQuotaBoundary(60_000);
    await serverClock(120_000, async () => {
      assert.equal((await request(anotherArtist, 'bio', nextBio)).data.code, 'GENERATION_LIMIT_REACHED');
      assert.equal(requests.length, 4);
    });
    await placeFirstRequestNearQuotaBoundary(-60_000);
    await serverClock(-120_000, async () => {
      assert.equal((await request(anotherArtist, 'bio', nextBio)).data.status, 'succeeded');
      assert.equal(requests.length, 5);
    });
    assert.equal(await deps.db.artistGig.count({ where: { ownerId: { in: users } } }), 0);
    assert.equal(await deps.db.providerProfile.count({ where: { userId: { in: users } } }), 0);
  } finally {
    releaseGig();
    releaseLate();
    try {
      await deps.db.aiModelCall.deleteMany({ where: { model } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
      await deps.db.aiPromptTemplate.update({ where: { key: prompt.key }, data: { draft: prompt.draft } });
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()));
    }
  }
});
