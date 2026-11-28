import { z } from 'zod';
import { BUILD_FINGERPRINT, MIGRATION } from '../generated/migration-version.js';

const serviceOrigin = z.url({ protocol: /^https?$/ }).refine(raw => {
  const { origin } = new URL(raw);
  return raw === origin || raw === origin + '/';
}).transform(raw => new URL(raw).origin);
const settings = z.object({
  STAGELINK_RELEASE_API_ORIGIN: serviceOrigin,
  STAGELINK_RELEASE_WORKER_ORIGIN: serviceOrigin,
});
const readiness = z.object({
  status: z.literal('ready'),
  dependencies: z.object({ postgres: z.literal('up'), redis: z.literal('up') }),
  schemaVersion: z.string().min(1),
  buildFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
const workerReadiness = readiness.extend({ dispatcher: z.literal('up') });

class ReleaseConfigError extends Error {}

export function releaseReadinessConfig(env: NodeJS.ProcessEnv) {
  const result = settings.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map(issue => String(issue.path[0])))];
    throw new ReleaseConfigError('Check release readiness origins: ' + fields.join(', '));
  }
  return { apiOrigin: result.data.STAGELINK_RELEASE_API_ORIGIN, workerOrigin: result.data.STAGELINK_RELEASE_WORKER_ORIGIN };
}

type Check = { service: 'api' | 'worker' } & (
  { passed: true; httpStatus: 200 } |
  { passed: false; reason: 'request_failed' | 'not_ready' | 'invalid_health_response' | 'schema_mismatch' | 'build_mismatch'; httpStatus?: number }
);

export async function checkReleaseReadiness(config: ReturnType<typeof releaseReadinessConfig>, send = fetch) {
  async function check(service: 'api' | 'worker', path: string, schema: z.ZodType<z.infer<typeof readiness>>, origin: string): Promise<Check> {
    let response: Response;
    try {
      response = await send(new URL(path, origin), {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json' },
      });
    } catch { return { service, passed: false, reason: 'request_failed' }; }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { service, passed: false, httpStatus: response.status, reason: 'not_ready' };
    }
    try {
      const health = schema.parse(await response.json());
      if (health.schemaVersion !== MIGRATION) return { service, passed: false, httpStatus: 200, reason: 'schema_mismatch' };
      if (health.buildFingerprint !== BUILD_FINGERPRINT) return { service, passed: false, httpStatus: 200, reason: 'build_mismatch' };
      return { service, passed: true, httpStatus: 200 };
    } catch { return { service, passed: false, httpStatus: 200, reason: 'invalid_health_response' }; }
  }
  const checks = await Promise.all([
    check('api', '/api/v1/health/ready', readiness, config.apiOrigin),
    check('worker', '/health/ready', workerReadiness, config.workerOrigin),
  ]);
  return { passed: checks.every(row => row.passed), expectedSchemaVersion: MIGRATION, expectedBuildFingerprint: BUILD_FINGERPRINT, checks };
}

if (import.meta.main) {
  async function main() {
    const result = await checkReleaseReadiness(releaseReadinessConfig(process.env));
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
  main().catch(error => {
    console.error(error instanceof ReleaseConfigError ? error.message : 'StageLink release readiness check failed.');
    process.exitCode = 1;
  });
}
