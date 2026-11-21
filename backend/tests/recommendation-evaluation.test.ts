import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRecommendations } from '../scripts/evaluate-recommendations.js';

const id = (value: number) => '00000000-0000-4000-8000-' + String(value).padStart(12, '0');
const item = (value: number) => ({ gigId: id(value), version: 1, currentVersion: true });
const expectedModel = 'text-embedding-3-small';
const pair = {
  key: 'jazz-dinner',
  judgments: [
    { gigId: id(1), relevance: 0 }, { gigId: id(2), relevance: 1 },
    { gigId: id(3), relevance: 3 }, { gigId: id(4), relevance: 2 },
  ],
  weighted: {
    id: id(10), briefId: id(12), briefRevision: 2, weightsRevision: 4,
    method: 'weighted_catalog_v1', items: [item(1), item(2), item(3)],
  },
  semantic: {
    id: id(11), briefId: id(12), briefRevision: 2, weightsRevision: 4,
    method: 'semantic_hybrid_v1', items: [item(3), item(2), item(1)],
    semantic: { model: expectedModel, listingInputVersion: 'published_gig_v1', briefInputVersion: 'brief_title_description_v1', semanticWeight: 30 },
  },
};
const evaluate = (...cases: unknown[]) => evaluateRecommendations({ version: 1, expectedModel, cases });

test('graded ranking evaluation accounts for relevant judgments missing from both top-three results', () => {
  const report = evaluate(pair);
  assert.equal(report.complete, true);
  assert.deepEqual(report.counts, { total: 1, compared: 1, fallback: 0, excluded: 0, improved: 1, regressed: 0, unchanged: 0 });
  const ideal = 7 + 3 / Math.log2(3) + 1 / 2;
  assert.deepEqual(report.mean, {
    weighted: { reciprocalRankAt3: 0.5, ndcgAt3: (1 / Math.log2(3) + 7 / 2) / ideal, judgedRecallAt3: 2 / 3 },
    semantic: { reciprocalRankAt3: 1, ndcgAt3: (7 + 1 / Math.log2(3)) / ideal, judgedRecallAt3: 2 / 3 },
  });
  assert.doesNotMatch(JSON.stringify(report), /00000000-0000-4000/);
});

test('semantic fallback and incompatible snapshots are omitted from paired quality averages', () => {
  const report = evaluate(
    pair,
    { ...pair, key: 'fallback', semantic: { ...pair.semantic, method: 'weighted_catalog_v1', semantic: undefined } },
    { ...pair, key: 'different-weights', semantic: { ...pair.semantic, weightsRevision: 7 } },
    { ...pair, key: 'different-brief', semantic: { ...pair.semantic, briefRevision: 7 } },
    { ...pair, key: 'stale', semantic: { ...pair.semantic, items: [{ ...item(3), currentVersion: false }] } },
    { ...pair, key: 'different-listing-version', semantic: { ...pair.semantic, items: [{ ...item(3), version: 2 }] } },
    { ...pair, key: 'different-model', semantic: { ...pair.semantic, semantic: { ...pair.semantic.semantic, model: 'text-embedding-3-large' } } },
    { ...pair, key: 'unjudged', semantic: { ...pair.semantic, items: [item(5), item(3), item(1)] } },
  );
  assert.equal(report.complete, false);
  assert.deepEqual(report.counts, { total: 8, compared: 1, fallback: 1, excluded: 6, improved: 1, regressed: 0, unchanged: 0 });
  assert.deepEqual(report.mean, evaluate(pair).mean);
  assert.deepEqual(report.cases.slice(1).map(row => 'reason' in row && row.reason), [
    'semantic_returned_weighted_results', 'weight_revision_mismatch', 'brief_mismatch', 'listing_revision_changed',
    'listing_revision_changed', 'embedding_provenance_mismatch', 'unjudged_result',
  ]);
});

test('quality regressions are reported without marking the paired data incomplete', () => {
  const report = evaluate(pair, {
    ...pair, key: 'regression', weighted: { ...pair.weighted, items: pair.semantic.items },
    semantic: { ...pair.semantic, items: pair.weighted.items },
  });
  assert.equal(report.complete, true);
  assert.equal(report.counts.improved, 1);
  assert.equal(report.counts.regressed, 1);
  assert.deepEqual(report.mean.weighted, report.mean.semantic);
  assert.throws(() => evaluate(pair, pair));
  assert.throws(() => evaluate({ ...pair, judgments: [{ gigId: id(1), relevance: 0 }] }));
});
