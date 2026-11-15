import { z } from 'zod';
import type { Config } from '../../../shared/config.js';

const tokens = z.number().int().min(0).max(2_147_483_647);
const usage = z.object({
  provider: z.enum(['openai', 'gemini']),
  model: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
  latencyMs: tokens,
  inputTokens: tokens.nullable(), outputTokens: tokens.nullable(), cachedInputTokens: tokens.nullable(),
}).refine(value => value.cachedInputTokens === null ||
  (value.inputTokens !== null && value.cachedInputTokens <= value.inputTokens));
const earlierAttempt = usage.and(z.object({ outcome: z.literal('failed'), output: z.null() }));
const observation = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('succeeded'), output: z.string().trim().min(1).max(1600) }),
  z.object({ outcome: z.enum(['failed', 'refused']), output: z.null() }),
]).and(usage).and(z.object({
  priorAttempts: z.array(earlierAttempt).max(1).default([]),
})).refine(result => result.priorAttempts.every(attempt => attempt.provider !== result.provider));

type PreviewInput = { key: 'bio' | 'equipment'; template: string; fields: Record<string, string> };

export async function requestModelPreview(
  config: Pick<Config, 'AI_SERVICE_ORIGIN' | 'AI_INTERNAL_TOKEN'>, input: PreviewInput, send = fetch,
) {
  if (!config.AI_SERVICE_ORIGIN || !config.AI_INTERNAL_TOKEN) return null;
  try {
    const response = await send(new URL('/internal/prompt-preview', config.AI_SERVICE_ORIGIN), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: 'Bearer ' + config.AI_INTERNAL_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) return null;
    const parsed = observation.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
