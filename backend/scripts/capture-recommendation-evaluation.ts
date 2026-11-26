import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { caseKey, evaluateRecommendations, evaluationModel, judgments, recommendationRun } from './evaluate-recommendations.js';

const httpsOrigin = z.url({ protocol: /^https$/ }).refine(raw => {
  const { origin } = new URL(raw);
  return raw === origin || raw === origin + '/';
}).transform(raw => new URL(raw).origin);
const uuid = z.uuid().transform(value => value.toLowerCase());
const settings = z.object({
  origin: httpsOrigin,
  webOrigin: httpsOrigin,
  session: z.object({
    accessToken: z.string().max(2048).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }).strict(),
  plan: z.object({
    version: z.literal(1),
    expectedModel: evaluationModel,
    cases: z.array(z.object({
      key: caseKey,
      briefId: uuid,
      briefRevision: z.number().int().positive().max(2_147_483_647),
      genres: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
      weightedRequestKey: uuid,
      semanticRequestKey: uuid,
      judgments,
    }).strict()).min(1).max(5).refine(cases => {
      const requestKeys = cases.flatMap(item => [item.weightedRequestKey, item.semanticRequestKey]);
      return new Set(cases.map(item => item.key)).size === cases.length && new Set(requestKeys).size === requestKeys.length;
    }, 'Use distinct case keys and request keys.'),
  }).strict(),
});

export async function captureRecommendationEvaluation(raw: unknown, send = fetch) {
  const config = settings.parse(raw);
  const authorization = { Authorization: 'Bearer ' + config.session.accessToken };
  const commandHeaders = {
    ...authorization, 'Content-Type': 'application/json',
    Origin: config.webOrigin, 'X-CSRF-Token': config.session.csrfToken,
  };
  const cases = [];
  for (const item of config.plan.cases) {
    const path = '/api/v1/event-posts/' + item.briefId + '/recommendations';
    const command = { expectedRevision: item.briefRevision, genres: item.genres };
    let stage: 'create_weighted' | 'create_semantic' | 'read_weighted' | 'read_semantic' = 'create_weighted';
    let httpStatus: number | undefined;
    async function request(endpoint: string, options: RequestInit) {
      httpStatus = undefined;
      const response = await send(new URL(endpoint, config.origin), {
        ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      });
      httpStatus = response.status;
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error('RECOMMENDATION_CAPTURE_FAILED');
      }
      const run = recommendationRun.parse(await response.json());
      if (run.briefId !== item.briefId || run.briefRevision !== item.briefRevision) {
        throw new Error('RECOMMENDATION_BRIEF_MISMATCH');
      }
      return run;
    }
    try {
      const baseline = await request(path, {
        method: 'POST', headers: commandHeaders,
        body: JSON.stringify({ ...command, requestKey: item.weightedRequestKey, useSemantic: false }),
      });
      if (baseline.method !== 'weighted_catalog_v1') throw new Error('WEIGHTED_RECOMMENDATION_REQUIRED');
      stage = 'create_semantic';
      const hybrid = await request(path, {
        method: 'POST', headers: commandHeaders,
        body: JSON.stringify({ ...command, requestKey: item.semanticRequestKey, useSemantic: true }),
      });
      stage = 'read_weighted';
      const weighted = await request('/api/v1/recommendations/' + baseline.id, { headers: authorization });
      if (weighted.id !== baseline.id || weighted.method !== 'weighted_catalog_v1') throw new Error('RECOMMENDATION_RUN_MISMATCH');
      stage = 'read_semantic';
      const semantic = await request('/api/v1/recommendations/' + hybrid.id, { headers: authorization });
      if (semantic.id !== hybrid.id) throw new Error('RECOMMENDATION_RUN_MISMATCH');
      cases.push({ key: item.key, judgments: item.judgments, weighted, semantic });
    } catch {
      return { captured: false as const, failedCase: item.key, stage, httpStatus };
    }
  }
  return {
    captured: true as const,
    evaluation: evaluateRecommendations({ version: 1, expectedModel: config.plan.expectedModel, cases }),
  };
}

if (import.meta.main) {
  async function main() {
    const [planPath, ...extra] = process.argv.slice(2);
    if (!planPath || extra.length || process.stdin.isTTY) throw new Error('RECOMMENDATION_CAPTURE_SETTINGS_REQUIRED');
    const report = await captureRecommendationEvaluation({
      origin: process.env.STAGELINK_SMOKE_ORIGIN, webOrigin: process.env.STAGELINK_SMOKE_WEB_ORIGIN,
      plan: JSON.parse(readFileSync(planPath, 'utf8')),
      session: JSON.parse(readFileSync(0, 'utf8')),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.captured || !report.evaluation.complete) process.exitCode = 1;
  }
  main().catch(() => {
    console.error('Provide a valid evaluation plan, staging HTTPS origins, and customer session JSON through protected stdin.');
    process.exitCode = 1;
  });
}
