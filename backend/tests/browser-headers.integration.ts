import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/src/app.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const config = readConfig();
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) throw Error('Browser header checks require an isolated test database');

test('the configured web client can read safe download and error headers without broadening allowed origins', async () => {
  const deps = resources(config), { app } = await createApp(config, deps);
  await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const split = (value: string | null) => (value ?? '').toLowerCase().split(',').map(item => item.trim()).filter(Boolean);
  try {
    const preflight = await fetch(base + '/api/v1/auth/login', { method: 'OPTIONS', headers: { Origin: config.WEB_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-csrf-token' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), config.WEB_ORIGIN);
    assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), 'true');
    const allowed = split(preflight.headers.get('Access-Control-Allow-Headers'));
    assert.ok(allowed.includes('content-type') && allowed.includes('x-csrf-token'));
    const response = await fetch(base + '/api/v1/me', { headers: { Origin: config.WEB_ORIGIN, 'X-Request-ID': 'untrusted-client-value' } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), config.WEB_ORIGIN);
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
    assert.deepEqual(split(response.headers.get('Access-Control-Expose-Headers')).sort(), ['content-disposition', 'x-request-id']);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const error = await response.json() as { requestId: string };
    assert.match(error.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get('X-Request-ID'), error.requestId);
    assert.notEqual(error.requestId, 'untrusted-client-value');
    assert.ok(!split(response.headers.get('Access-Control-Expose-Headers')).includes('set-cookie'));
    const wrongOrigin = 'https://wrong-origin.example.test';
    const other = await fetch(base + '/api/v1/health/live', { headers: { Origin: wrongOrigin } });
    assert.notEqual(other.headers.get('Access-Control-Allow-Origin'), wrongOrigin);
    assert.notEqual(other.headers.get('Access-Control-Allow-Origin'), '*');
    const write = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { Origin: wrongOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'cors-fixture@stagelink.test', password: 'unused' }) });
    assert.equal(write.status, 403);
    assert.equal((await write.json() as { code: string }).code, 'ORIGIN_REJECTED');
  } finally { await app.close(); }
});
