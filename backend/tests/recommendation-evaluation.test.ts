import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureRecommendationEvaluation } from '../scripts/capture-recommendation-evaluation.js';
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

const captureCase = {
  key: pair.key, briefId: pair.weighted.briefId, briefRevision: pair.weighted.briefRevision, genres: ['Jazz'],
  weightedRequestKey: id(20), semanticRequestKey: id(21), judgments: pair.judgments,
};
const captureSettings = {
  origin: 'https://api.staging.test', webOrigin: 'https://web.staging.test',
  session: { accessToken: 'staging.session.fixture', csrfToken: 'B'.repeat(43) },
  plan: { version: 1, expectedModel, cases: [captureCase] },
};

test('staging capture pairs both commands and rereads the resulting snapshots', async () => {
  const postPath = '/api/v1/event-posts/' + captureCase.briefId + '/recommendations';
  const requests: { path: string; body?: unknown }[] = [];
  const report = await captureRecommendationEvaluation(captureSettings, async (url, init) => {
    const target = new URL(String(url));
    assert.equal(target.origin, captureSettings.origin);
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer ' + captureSettings.session.accessToken);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: target.pathname, ...(body && { body }) });
    if (body) {
      assert.equal(headers.get('origin'), captureSettings.webOrigin);
      assert.equal(headers.get('x-csrf-token'), captureSettings.session.csrfToken);
      assert.equal(init?.method, 'POST');
      return Response.json(body.useSemantic ? pair.semantic : pair.weighted);
    }
    assert.equal(headers.has('x-csrf-token'), false);
    return Response.json(target.pathname.endsWith(pair.weighted.id) ? pair.weighted : {
      ...pair.semantic, items: [{ ...item(3), currentVersion: false }],
    });
  });
  const input = { expectedRevision: captureCase.briefRevision, genres: captureCase.genres };
  assert.deepEqual(requests, [
    { path: postPath, body: { ...input, requestKey: captureCase.weightedRequestKey, useSemantic: false } },
    { path: postPath, body: { ...input, requestKey: captureCase.semanticRequestKey, useSemantic: true } },
    { path: '/api/v1/recommendations/' + pair.weighted.id },
    { path: '/api/v1/recommendations/' + pair.semantic.id },
  ]);
  assert.ok(report.captured);
  assert.equal(report.evaluation.complete, false);
  assert.deepEqual(report.evaluation.cases, [{ key: pair.key, status: 'excluded', reason: 'listing_revision_changed' }]);
  assert.doesNotMatch(JSON.stringify(report), /00000000-0000-4000|staging\.session\.fixture/);
});

test('staging capture validates unique request keys and stops on mismatched brief evidence', async () => {
  await assert.rejects(captureRecommendationEvaluation({
    ...captureSettings,
    plan: { ...captureSettings.plan, cases: [{ ...captureCase, semanticRequestKey: captureCase.weightedRequestKey }] },
  }, async () => assert.fail('Invalid capture plan must fail before sending requests')));

  let calls = 0;
  const report = await captureRecommendationEvaluation(captureSettings, async () => {
    calls++;
    return Response.json({ ...pair.weighted, briefId: id(99) });
  });
  assert.equal(calls, 1);
  assert.deepEqual(report, { captured: false, failedCase: pair.key, stage: 'create_weighted', httpStatus: 200 });
});
