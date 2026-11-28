import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILD_FINGERPRINT, MIGRATION } from '../generated/migration-version.js';
import { checkReleaseReadiness, releaseReadinessConfig } from '../scripts/release-readiness-check.js';

const env = {
  STAGELINK_RELEASE_API_ORIGIN: 'https://staging-api.example.test/',
  STAGELINK_RELEASE_WORKER_ORIGIN: 'http://127.0.0.1:4001',
};
const config = releaseReadinessConfig(env);
const healthy = { status: 'ready', dependencies: { postgres: 'up', redis: 'up' }, schemaVersion: MIGRATION, buildFingerprint: BUILD_FINGERPRINT };

function transport(worker: () => Response, api = () => Response.json(healthy)): typeof fetch {
  return async (input, init) => {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    if (String(input) === 'https://staging-api.example.test/api/v1/health/ready') return api();
    assert.equal(String(input), 'http://127.0.0.1:4001/health/ready');
    return worker();
  };
}

test('release check requires both services and the schema bundled with this build', async () => {
  const result = await checkReleaseReadiness(config, transport(() => Response.json({ ...healthy, dispatcher: 'up' })));
  assert.deepEqual(result, { passed: true, expectedSchemaVersion: MIGRATION, expectedBuildFingerprint: BUILD_FINGERPRINT, checks: [
    { service: 'api', passed: true, httpStatus: 200 }, { service: 'worker', passed: true, httpStatus: 200 },
  ] });
});

test('release check rejects services with matching schema and an older or missing build fingerprint', async () => {
  const otherBuild = '0'.repeat(64);
  const result = await checkReleaseReadiness(config, transport(
    () => Response.json({ ...healthy, dispatcher: 'up', buildFingerprint: otherBuild }),
    () => Response.json({ ...healthy, buildFingerprint: undefined }),
  ));
  assert.equal(result.passed, false);
  assert.deepEqual(result.checks, [
    { service: 'api', passed: false, httpStatus: 200, reason: 'build_mismatch' },
    { service: 'worker', passed: false, httpStatus: 200, reason: 'build_mismatch' },
  ]);
});

test('release check rejects an older schema, failed dependency, unavailable service and malformed response', async () => {
  for (const [response, reason] of [
    [() => Response.json({ ...healthy, dispatcher: 'up', schemaVersion: '20261101010000_previous' }), 'schema_mismatch'],
    [() => Response.json({ ...healthy, dispatcher: 'down' }), 'invalid_health_response'],
    [() => new Response('Private error from a proxy', { status: 503 }), 'not_ready'],
    [() => new Response('A proxy page', { status: 200 }), 'invalid_health_response'],
    [() => { throw new Error('Private connection details'); }, 'request_failed'],
  ] as const) {
    const result = await checkReleaseReadiness(config, transport(response));
    assert.equal(result.passed, false);
    const worker = result.checks.find(row => row.service === 'worker');
    assert.ok(worker && !worker.passed);
    assert.equal(worker.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /Private|proxy page|20261101010000/);
  }
  assert.throws(() => releaseReadinessConfig({ ...env, STAGELINK_RELEASE_API_ORIGIN: 'file:///tmp/ready' }));
  assert.throws(() => releaseReadinessConfig({ ...env, STAGELINK_RELEASE_API_ORIGIN: env.STAGELINK_RELEASE_API_ORIGIN + 'api' }));
});
