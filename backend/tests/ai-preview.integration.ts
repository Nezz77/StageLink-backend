import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const baseConfig = readConfig();
if (baseConfig.NODE_ENV !== 'test' || !new URL(baseConfig.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('AI previews require an isolated *_test database.');
}

test('model previews require opt-in, obey the shared budget and record usage against the prompt source', async () => {
  const token = 'f'.repeat(64);
  const model = 'fixture-' + randomUUID();
  const fallbackModel = model + '-fallback';
  const models = [model, fallbackModel];
  const requests: { credential?: string; key: string; template: string; fields: Record<string, string> }[] = [];
  const service = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests.push({ credential: req.headers.authorization, ...JSON.parse(body) });
    const initial = {
      provider: 'openai', model, outcome: 'succeeded', latencyMs: 14,
      output: 'A biography draft.', inputTokens: 120, outputTokens: 16, cachedInputTokens: 6,
    };
    const result = requests.length === 1 ? initial : {
      ...initial, provider: 'gemini', model: fallbackModel,
      priorAttempts: [{
        ...initial, outcome: 'failed', output: null, inputTokens: null,
        outputTokens: null, cachedInputTokens: null,
      }],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const config = {
    ...baseConfig, AUTH_RATE_PREFIX: 'ai-preview-test-' + randomUUID(),
    AI_SERVICE_ORIGIN: 'http://127.0.0.1:' + (service.address() as AddressInfo).port,
    AI_INTERNAL_TOKEN: token, AI_PREVIEW_DAILY_LIMIT: 2,
  };
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  let userId: string | undefined;
  try {
    const admin = await deps.db.authUser.create({ data: {
      roles: ['admin'], email: randomUUID() + '@stagelink.test', displayName: 'AI preview fixture',
      passwordHash: 'unused', emailVerifiedAt: new Date(),
    } });
    userId = admin.id;
    const session = await deps.db.authSession.create({ data: {
      userId, activeRole: 'admin', expiresAt: new Date(Date.now() + 600_000),
    } });
    const accessToken = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(userId)
      .setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
    const headers = {
      Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json',
      'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id), Origin: config.WEB_ORIGIN,
    };
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const fields = { artist_name: 'Fixture artist', genres: 'jazz', event_type: 'gala' };
    async function preview(options: object = {}) {
      const response = await fetch(base + '/api/v1/admin/ai/prompts/bio/preview', {
        method: 'POST', headers, body: JSON.stringify({ fields, ...options }),
      });
      return { status: response.status, data: await response.json() };
    }
    const dry = await preview();
    assert.equal(dry.status, 200);
    assert.equal(dry.data.modelStatus, 'unavailable');
    assert.equal(requests.length, 0);

    const active = await deps.db.aiPromptVersion.findFirstOrThrow({ where: { key: 'bio' }, orderBy: { version: 'desc' } });
    const generated = await preview({ generate: true });
    assert.equal(generated.status, 200);
    assert.deepEqual(generated.data, { resolved: dry.data.resolved, output: 'A biography draft.', modelStatus: 'succeeded' });
    assert.deepEqual(requests[0], { credential: 'Bearer ' + token, key: 'bio', template: active.body, fields });

    const inline = 'Draft {{artist_name}} in {{genres}} for {{event_type}}.';
    assert.equal((await preview({ generate: true, body: inline })).data.modelStatus, 'succeeded');
    const overBudget = await preview({ generate: true });
    assert.equal(overBudget.status, 429);
    assert.equal(requests.length, 2);

    const observed = await deps.db.aiModelCall.findMany({ where: { model: { in: models } } });
    assert.deepEqual(observed.map(row => ({
      provider: row.provider, outcome: row.outcome, source: row.promptSource,
      version: row.promptVersion, key: row.promptKey, tokens: row.inputTokens,
    })).sort((a, b) => (a.source + a.provider).localeCompare(b.source + b.provider)), [
      { provider: 'gemini', outcome: 'succeeded', source: 'inline', version: null, key: 'bio', tokens: 120 },
      { provider: 'openai', outcome: 'failed', source: 'inline', version: null, key: 'bio', tokens: null },
      { provider: 'openai', outcome: 'succeeded', source: 'published', version: active.version, key: 'bio', tokens: 120 },
    ]);
  } finally {
    try {
      await deps.db.aiModelCall.deleteMany({ where: { model: { in: models } } });
      if (userId) await deps.db.authUser.delete({ where: { id: userId } });
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()));
    }
  }
});
