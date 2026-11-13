import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAiService } from '../api/src/ai/operations.js';

test('AI status reports only the capabilities of the configured service', async () => {
  assert.deepEqual(await checkAiService(undefined), { status: 'unavailable', configured: false, capabilities: [], version: null });
  const origin = 'http://ai:8000';
  const ready: typeof fetch = async (url, options) => {
    assert.equal(String(url), origin + '/health/ready');
    assert.equal(options?.redirect, 'error');
    return Response.json({ status: 'ready', service: 'stagelink-ai', capabilities: ['health-only'], version: '0.1.0' });
  };
  assert.deepEqual(await checkAiService(origin, ready), {
    status: 'ready', configured: true, capabilities: ['health-only'], version: '0.1.0',
  });
  assert.equal((await checkAiService(origin, async () => Response.json({ status: 'ready' }))).status, 'unavailable');
  assert.equal((await checkAiService(origin, async () => { throw new Error('offline'); })).status, 'unavailable');
});
