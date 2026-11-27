import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { listingEmbeddingInput } from '../api/src/ai/embedding-client.js';
import { briefEmbeddingInput, semanticWeight } from '../api/src/ai/semantic-ranking.js';

const uuid = z.uuid().transform(value => value.toLowerCase());
const revision = z.number().int().positive().max(2_147_483_647);
const item = z.object({ gigId: uuid, version: revision, currentVersion: z.boolean() });
export const recommendationRun = z.object({
  id: uuid, briefId: uuid, briefRevision: revision, weightsRevision: revision,
  method: z.enum(['weighted_catalog_v1', 'semantic_hybrid_v1']),
  semantic: z.object({
    model: z.string(), listingInputVersion: z.string(), briefInputVersion: z.string(), semanticWeight: z.number(),
  }).optional(),
  items: z.array(item).max(3).refine(items => new Set(items.map(row => row.gigId)).size === items.length),
});
export const caseKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const judgments = z.array(z.object({ gigId: uuid, relevance: z.number().int().min(0).max(3) }).strict()).min(1).max(500)
  .refine(rows => new Set(rows.map(row => row.gigId)).size === rows.length && rows.some(row => row.relevance > 0));
export const evaluationModel = z.enum(['text-embedding-3-small', 'text-embedding-3-large']);
const scenario = z.object({
  key: caseKey, judgments,
  weighted: recommendationRun.extend({ method: z.literal('weighted_catalog_v1') }),
  semantic: recommendationRun,
}).strict();
const manifest = z.object({
  version: z.literal(1), expectedModel: evaluationModel,
  cases: z.array(scenario).min(1).max(500).refine(cases => new Set(cases.map(row => row.key)).size === cases.length),
}).strict();

type Scenario = z.infer<typeof scenario>;
type Metrics = { reciprocalRankAt3: number; ndcgAt3: number; judgedRecallAt3: number };
type Comparison = {
  key: string;
  status: 'compared';
  weighted: Metrics;
  semantic: Metrics;
  ndcgChange: 'improved' | 'regressed' | 'unchanged';
} | { key: string; status: 'excluded' | 'fallback'; reason: string };

function discountedGain(grades: number[]) {
  return grades.slice(0, 3).reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

function metrics(items: z.infer<typeof item>[], judgments: Map<string, number>): Metrics {
  const scores = items.map(row => judgments.get(row.gigId)!);
  const ideal = [...judgments.values()].sort((a, b) => b - a);
  const firstRelevant = scores.findIndex(grade => grade > 0);
  return {
    reciprocalRankAt3: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    ndcgAt3: discountedGain(scores) / discountedGain(ideal),
    judgedRecallAt3: scores.filter(grade => grade > 0).length / ideal.filter(grade => grade > 0).length,
  };
}

function compare({ key, weighted, semantic, judgments }: Scenario, model: string): Comparison {
  const excluded = (reason: string): Comparison => ({ key, status: 'excluded', reason });
  if (weighted.id === semantic.id) return excluded('same_run');
  if (weighted.briefId !== semantic.briefId || weighted.briefRevision !== semantic.briefRevision) return excluded('brief_mismatch');
  if (weighted.weightsRevision !== semantic.weightsRevision) return excluded('weight_revision_mismatch');
  if (semantic.method === 'weighted_catalog_v1') return { key, status: 'fallback', reason: 'semantic_returned_weighted_results' };
  const provenance = semantic.semantic;
  if (!provenance || provenance.model !== model || provenance.semanticWeight !== semanticWeight ||
    provenance.listingInputVersion !== listingEmbeddingInput || provenance.briefInputVersion !== briefEmbeddingInput) {
    return excluded('embedding_provenance_mismatch');
  }

  const items = [...weighted.items, ...semantic.items];
  const versions = new Map(weighted.items.map(row => [row.gigId, row.version]));
  if (items.some(row => !row.currentVersion) || semantic.items.some(row => versions.has(row.gigId) && versions.get(row.gigId) !== row.version)) {
    return excluded('listing_revision_changed');
  }
  const labels = new Map(judgments.map(row => [row.gigId, row.relevance]));
  if (items.some(row => !labels.has(row.gigId))) return excluded('unjudged_result');

  const baseline = metrics(weighted.items, labels);
  const hybrid = metrics(semantic.items, labels);
  const delta = hybrid.ndcgAt3 - baseline.ndcgAt3;
  return {
    key, status: 'compared', weighted: baseline, semantic: hybrid,
    ndcgChange: Math.abs(delta) < 1e-9 ? 'unchanged' : delta > 0 ? 'improved' : 'regressed',
  };
}

function mean(rows: Metrics[]): Metrics | null {
  if (!rows.length) return null;
  const average = (key: keyof Metrics) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  return {
    reciprocalRankAt3: average('reciprocalRankAt3'), ndcgAt3: average('ndcgAt3'), judgedRecallAt3: average('judgedRecallAt3'),
  };
}

export function evaluateRecommendations(raw: unknown) {
  const { expectedModel, cases } = manifest.parse(raw);
  const results = cases.map(row => compare(row, expectedModel));
  const compared = results.filter(row => row.status === 'compared');
  return {
    expectedModel,
    complete: compared.length === cases.length,
    counts: {
      total: cases.length, compared: compared.length,
      fallback: results.filter(row => row.status === 'fallback').length,
      excluded: results.filter(row => row.status === 'excluded').length,
      improved: compared.filter(row => row.ndcgChange === 'improved').length,
      regressed: compared.filter(row => row.ndcgChange === 'regressed').length,
      unchanged: compared.filter(row => row.ndcgChange === 'unchanged').length,
    },
    mean: { weighted: mean(compared.map(row => row.weighted)), semantic: mean(compared.map(row => row.semantic)) },
    cases: results,
  };
}

if (import.meta.main) {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) {
    console.error('Usage: npm run --silent recommendations:evaluate -- <manifest.json>');
    process.exitCode = 1;
  } else {
    try {
      const report = evaluateRecommendations(JSON.parse(readFileSync(path, 'utf8')));
      console.log(JSON.stringify(report, null, 2));
      if (!report.complete) process.exitCode = 1;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fields = [...new Set(error.issues.map(issue => issue.path.join('.') || 'manifest'))];
        console.error('Invalid recommendation manifest fields: ' + fields.join(', '));
      } else {
        console.error('Provide a readable JSON recommendation manifest.');
      }
      process.exitCode = 1;
    }
  }
}
