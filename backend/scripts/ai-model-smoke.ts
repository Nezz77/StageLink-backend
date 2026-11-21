import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { previewText } from '../api/src/ai/preview.js';

const httpsOrigin = z.url({ protocol: /^https$/ }).refine(raw => {
  const { origin } = new URL(raw);
  return raw === origin || raw === origin + '/';
}).transform(raw => new URL(raw).origin);
const settings = z.object({
  origin: httpsOrigin,
  webOrigin: httpsOrigin,
  session: z.object({
    accessToken: z.string().max(2048).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }).strict(),
});
const health = z.object({
  configured: z.literal(true), status: z.literal('ready'),
  capabilities: z.array(z.string()).max(20).refine(values => values.includes('prompt-preview')),
});
const count = z.number().int().nonnegative();
const usage = z.object({ period: z.literal('24h'), requests: count, succeeded: count })
  .refine(value => value.succeeded <= value.requests);
const preview = z.discriminatedUnion('modelStatus', [
  z.object({ modelStatus: z.literal('succeeded'), output: previewText }),
  z.object({ modelStatus: z.enum(['unavailable', 'failed', 'refused']), output: z.null() }),
]);
const syntheticPreview = {
  body: 'Write a short artist biography for {{artist_name}} highlighting {{genres}} for {{event_type}}. Use only the supplied details.',
  fields: { artist_name: 'Fixture Jazz Ensemble', genres: 'instrumental jazz', event_type: 'a staging showcase' },
  generate: true,
};
const metricsPath = '/api/v1/admin/ai/metrics?period=24h&capability=preview-bio';
type Config = z.output<typeof settings>;
type Check = { check: string; passed: boolean; status?: number; modelStatus?: z.output<typeof preview>['modelStatus'] };

export async function runAiModelSmoke(config: Config, send = fetch) {
  const report = { passed: false, checks: [] as Check[] };
  const headers = { Authorization: 'Bearer ' + config.session.accessToken };
  async function request<T>(path: string, schema: z.ZodType<T>, body?: object) {
    let status: number | undefined;
    try {
      const response = await send(new URL(path, config.origin), {
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        ...(body ? {
          method: 'POST', body: JSON.stringify(body),
          headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': config.session.csrfToken, Origin: config.webOrigin },
        } : { headers }),
      });
      status = response.status;
      if (status !== 200) {
        await response.body?.cancel();
        return { status, data: null };
      }
      return { status, data: schema.parse(await response.json()) };
    } catch {
      return { status, data: null };
    }
  }

  const ready = await request('/api/v1/admin/ai/status', health);
  report.checks.push({ check: 'model_preview_ready', passed: ready.data !== null, status: ready.status });
  if (!ready.data) return report;

  const before = await request(metricsPath, usage);
  report.checks.push({ check: 'preview_usage_baseline', passed: before.data !== null, status: before.status });
  if (!before.data) return report;

  const generated = await request('/api/v1/admin/ai/prompts/bio/preview', preview, syntheticPreview);
  const modelStatus = generated.data?.modelStatus;
  report.checks.push({ check: 'synthetic_preview', passed: modelStatus === 'succeeded', status: generated.status, modelStatus });
  if (modelStatus !== 'succeeded') return report;

  const after = await request(metricsPath, usage);
  report.passed = after.data !== null && after.data.requests > before.data.requests && after.data.succeeded > before.data.succeeded;
  report.checks.push({ check: 'preview_usage_recorded', passed: report.passed, status: after.status });
  return report;
}

if (import.meta.main) {
  async function main() {
    const session: unknown = process.stdin.isTTY ? null : JSON.parse(readFileSync(0, 'utf8'));
    const config = settings.parse({
      origin: process.env.STAGELINK_SMOKE_ORIGIN, webOrigin: process.env.STAGELINK_SMOKE_WEB_ORIGIN, session,
    });
    const report = await runAiModelSmoke(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
  main().catch(() => {
    console.error('Set the staging API and web HTTPS origins, then pipe the administrator access and CSRF tokens through protected stdin.');
    process.exitCode = 1;
  });
}
