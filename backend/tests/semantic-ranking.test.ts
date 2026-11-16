import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rerank } from '../api/src/ai/semantic-ranking.js';

test('labeled synthetic briefs improve mean reciprocal rank over the weighted shortlist', () => {
  const candidates = [
    { gigId: 'cover-band', version: 1, score: 67 },
    { gigId: 'string-quartet', version: 1, score: 62 },
    { gigId: 'jazz-trio', version: 2, score: 58 },
  ];
  const topics = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(components => [...components, ...Array<number>(253).fill(0)]);
  const embeddings = new Map(candidates.map(({ gigId, version }, index) => [
    gigId + ':' + version, { vector: topics[index]!, attemptId: 'index-' + index, indexedAt: '2026-11-16T00:00:00.000Z' },
  ]));
  const reciprocalRank = (items: typeof candidates, gigId: string) => 1 / (items.findIndex(item => item.gigId === gigId) + 1);
  const weighted = candidates.map(item => reciprocalRank(candidates, item.gigId));
  const hybrid = candidates.map((item, index) => reciprocalRank(rerank(candidates, embeddings, topics[index]!).items, item.gigId));
  assert.deepEqual(weighted, [1, 1 / 2, 1 / 3]);
  assert.deepEqual(hybrid, [1, 1, 1]);
});
