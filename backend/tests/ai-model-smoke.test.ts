import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAiModelSmoke } from '../scripts/ai-model-smoke.js';

const config = {
  origin: 'https://staging-api.example.test', webOrigin: 'https://staging.example.test',
  session: { accessToken: 'synthetic.fixture.signature', csrfToken: 'a'.repeat(43) },
};

test('AI model smoke skips generation when preview is unavailable and fails when recorded usage is missing', async () => {
  let requested = 0;
  const unavailable = await runAiModelSmoke(config, async () => {
    requested++;
    return Response.json({ configured: true, status: 'ready', capabilities: ['health-only'] });
  });
  assert.equal(requested, 1);
  assert.deepEqual(unavailable.checks, [{ check: 'model_preview_ready', passed: false, status: 200 }]);

  let generated = 0;
  const stale = await runAiModelSmoke(config, async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, config.origin);
    assert.equal(options?.redirect, 'error');
    if (url.pathname.endsWith('/status')) {
      return Response.json({ configured: true, status: 'ready', capabilities: ['prompt-preview'] });
    }
    if (url.pathname.endsWith('/preview')) {
      generated++;
      assert.equal(options?.method, 'POST');
      const headers = new Headers(options?.headers);
      assert.equal(headers.get('Origin'), config.webOrigin);
      assert.equal(headers.get('X-CSRF-Token'), config.session.csrfToken);
      return Response.json({ modelStatus: 'succeeded', output: 'Synthetic private output' });
    }
    assert.equal(url.searchParams.get('capability'), 'preview-bio');
    return Response.json({ period: '24h', requests: 8, succeeded: 5 });
  });
  assert.equal(generated, 1);
  assert.equal(stale.passed, false);
  assert.deepEqual(stale.checks.at(-1), { check: 'preview_usage_recorded', passed: false, status: 200 });
  assert.doesNotMatch(JSON.stringify(stale), /Synthetic private output|fixture.signature/);
});
