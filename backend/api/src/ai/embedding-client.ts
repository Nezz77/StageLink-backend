import { z } from 'zod';
import type { Config } from '../../../shared/config.js';

export const listingEmbeddingInput = 'published_gig_v1';
export function isUnitEmbedding(vector: number[]) {
  return vector.length === 256 && vector.every(Number.isFinite) && Math.abs(Math.hypot(...vector) - 1) <= 0.000_001;
}

const counter = z.number().int().min(0).max(2_147_483_647);
const observation = z.object({
  model: z.string(),
  latencyMs: counter,
  inputTokens: counter.nullable(),
}).and(z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('succeeded'), vector: z.array(z.number()).length(256) }),
  z.object({ outcome: z.literal('failed'), vector: z.null() }),
]));

export type EmbeddingModel = NonNullable<Config['AI_EMBEDDING_MODEL']>;

export async function requestEmbedding(config: Pick<Config, 'AI_SERVICE_ORIGIN' | 'AI_INTERNAL_TOKEN'>, model: EmbeddingModel, text: string) {
  if (!config.AI_SERVICE_ORIGIN || !config.AI_INTERNAL_TOKEN) return null;
  try {
    const response = await fetch(new URL('/internal/embeddings', config.AI_SERVICE_ORIGIN), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: 'Bearer ' + config.AI_INTERNAL_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, text }),
    });
    if (!response.ok) return null;
    const result = observation.safeParse(await response.json());
    if (!result.success || result.data.model !== model) return null;
    if (result.data.vector && !isUnitEmbedding(result.data.vector)) return null;
    return result.data;
  } catch {
    return null;
  }
}
