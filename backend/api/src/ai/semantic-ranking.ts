import type { Prisma } from '../../../generated/prisma/client.js';
import { isUnitEmbedding, listingEmbeddingInput, type EmbeddingModel } from './embedding-client.js';

export const semanticCandidateLimit = 30;
export const minimumEmbeddedCandidates = 2;
export const briefEmbeddingInput = 'brief_title_description_v1';
export const semanticWeight = 30;

type Candidate = { gigId: string; version: number; score: number };
const candidateKey = (gigId: string, version: number) => gigId + ':' + version;

type Embeddings = Map<string, { attemptId: string; vector: number[]; indexedAt: string }>;

export async function compatibleEmbeddings(tx: Prisma.TransactionClient, candidates: Candidate[], model: EmbeddingModel) {
  const embeddings: Embeddings = new Map();
  if (candidates.length < minimumEmbeddedCandidates) return embeddings;
  const rows = await tx.listingEmbedding.findMany({
    where: {
      state: 'ready', model, inputVersion: listingEmbeddingInput,
      OR: candidates.map(({ gigId, version }) => ({ gigId, gigVersion: version })),
    },
    select: { gigId: true, gigVersion: true, attemptId: true, vector: true, indexedAt: true },
  });
  for (const row of rows) {
    if (row.indexedAt && isUnitEmbedding(row.vector)) {
      embeddings.set(candidateKey(row.gigId, row.gigVersion), {
        attemptId: row.attemptId, vector: row.vector, indexedAt: row.indexedAt.toISOString(),
      });
    }
  }
  return embeddings;
}

export function rerank<T extends Candidate>(
  candidates: T[], embeddings: Embeddings, query: number[],
) {
  const ranked = candidates.map(candidate => {
    const { gigId, version, score: weightedScore } = candidate;
    const embedding = embeddings.get(candidateKey(gigId, version));
    const dot = embedding?.vector.reduce((sum, component, index) => sum + component * query[index]!, 0);
    const similarity = dot === undefined ? null : Math.max(0, Math.min(1, dot));
    const score = similarity === null
      ? weightedScore
      : Math.round((weightedScore * (100 - semanticWeight) + similarity * 100 * semanticWeight)) / 100;
    return {
      item: { ...candidate, score },
      evidence: {
        gigId, version, weightedScore, similarity, score,
        embeddingAttemptId: embedding?.attemptId ?? null, indexedAt: embedding?.indexedAt ?? null,
      },
    };
  });
  ranked.sort((a, b) => b.item.score - a.item.score);
  return { items: ranked.slice(0, 3).map(row => row.item), candidates: ranked.map(row => row.evidence) };
}
