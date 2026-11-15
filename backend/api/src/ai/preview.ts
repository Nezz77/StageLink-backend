import { z } from 'zod';
import type { Config } from '../../../shared/config.js';

const tokens = z.number().int().min(0).max(2_147_483_647);
const noOutput = z.object({ outcome: z.enum(['failed', 'refused']), output: z.null() });
const observation = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('succeeded'), output: z.string().trim().min(1).max(1600) }),
  noOutput,
]).and(z.object({
  provider: z.literal('openai'),
  model: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
  latencyMs: tokens,
  inputTokens: tokens.nullable(), outputTokens: tokens.nullable(), cachedInputTokens: tokens.nullable(),
})).refine(value => value.cachedInputTokens === null ||
  (value.inputTokens !== null && value.cachedInputTokens <= value.inputTokens));

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
