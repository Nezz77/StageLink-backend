import { Body, Controller, Get, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { MatchingVersion } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';

const weight = z.number().int().min(0).max(100);
const weights = z.object({ genre: weight, budget: weight, location: weight, rating: weight }).strict();
const update = z.object({
  expectedRevision: z.number().int().min(1).max(2_147_483_646), weights,
}).strict().refine(({ weights }) => Object.values(weights).reduce((sum, value) => sum + value, 0) === 100);
const config = z.object({ revision: z.number().int().positive(), weights, updatedAt: z.iso.datetime() });
const capabilities = z.array(z.string().max(64)).max(20);
const status = z.object({
  status: z.enum(['ready', 'unavailable']), configured: z.boolean(),
  capabilities, version: z.string().nullable(),
});
const period = z.enum(['24h', '7d']);
const capability = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const metrics = z.object({
  period, since: z.iso.datetime(), requests: z.number().int(), succeeded: z.number().int(),
  failed: z.number().int(), refused: z.number().int(), averageLatencyMs: z.number().nullable(),
  inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), cachedInputTokens: z.number().nullable(),
  models: z.array(z.object({ provider: z.string(), model: z.string(), requests: z.number().int() })),
});

function present({ revision, genre, budget, location, rating, createdAt }: MatchingVersion) {
  return { revision, weights: { genre, budget, location, rating }, updatedAt: createdAt.toISOString() };
}

const health = z.object({
  status: z.literal('ready'), service: z.string().min(1).max(64),
  version: z.string().min(1).max(40), capabilities,
});

export async function checkAiService(origin: string | undefined, send = fetch) {
  const unavailable = { status: 'unavailable' as const, configured: Boolean(origin), capabilities: [], version: null };
  if (!origin) return unavailable;
  try {
    const response = await send(new URL('/health/ready', origin), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return unavailable;
    const result = health.safeParse(await response.json());
    if (!result.success) return unavailable;
    return { status: 'ready' as const, configured: true, capabilities: result.data.capabilities, version: result.data.version };
  } catch {
    return unavailable;
  }
}

export function makeAiOperationsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);

  async function admin(req: Request) {
    const actor = await auth.authenticate(req.get('Authorization'));
    if (actor.session.activeRole !== 'admin' || !actor.user.roles.includes('admin')) {
      throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    }
    profiles.verified(actor);
    return actor;
  }

  @ApiTags('AI operations')
  @ApiBearerAuth()
  @Controller('admin/ai')
  class AiOperationsController {
    @Get('status')
    @ApiOkResponse({ schema: schema(status) })
    async status(@Req() req: Request) {
      await admin(req);
      return checkAiService(auth.config.AI_SERVICE_ORIGIN);
    }

    @Get('config')
    @ApiOkResponse({ schema: schema(config) })
    async config(@Req() req: Request) {
      await admin(req);
      return present(await db.matchingVersion.findFirstOrThrow({ orderBy: { revision: 'desc' } }));
    }

    @Put('config')
    @ApiBody({ schema: schema(update) })
    @ApiOkResponse({ schema: schema(config) })
    async update(@Req() req: Request, @Body() raw: unknown) {
      if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
      }
      const actor = await admin(req);
      profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
      const checked = update.safeParse(raw);
      if (!checked.success) throw new PublicError(400, 'INVALID_MATCHING_WEIGHTS', 'Matching weights must be whole numbers that total 100.');
      const input = checked.data;
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, actor, undefined, true);
        profiles.verified(current);
        await tx.$queryRaw`SELECT revision FROM matching_versions WHERE revision=1 FOR UPDATE`;
        const latest = await tx.matchingVersion.findFirstOrThrow({ orderBy: { revision: 'desc' } });
        const same = Object.entries(input.weights).every(([key, value]) => latest[key as keyof typeof input.weights] === value);
        if (same && (latest.revision === input.expectedRevision ||
          (latest.revision === input.expectedRevision + 1 && latest.actorId === current.user.id))) return present(latest);
        if (latest.revision !== input.expectedRevision) {
          throw new PublicError(409, 'AI_CONFIG_CHANGED', 'Reload the matching weights before saving.');
        }
        return present(await tx.matchingVersion.create({
          data: { ...input.weights, revision: latest.revision + 1, actorId: current.user.id },
        }));
      });
    }

    @Get('metrics')
    @ApiQuery({ name: 'period', enum: period.options, required: false })
    @ApiQuery({ name: 'capability', type: String, required: false })
    @ApiOkResponse({ schema: schema(metrics) })
    async metrics(@Req() req: Request, @Query('period') rawPeriod?: string, @Query('capability') rawCapability?: string) {
      await admin(req);
      const window = parse(period, rawPeriod ?? '24h');
      const since = new Date(Date.now() - (window === '24h' ? 1 : 7) * 86_400_000);
      const where = { createdAt: { gte: since }, ...(rawCapability === undefined ? {} : { capability: parse(capability, rawCapability) }) };
      return db.$transaction(async tx => {
        const [totals, outcomes, models] = await Promise.all([
          tx.aiModelCall.aggregate({
            where, _count: true, _avg: { latencyMs: true },
            _sum: { inputTokens: true, outputTokens: true, cachedInputTokens: true },
          }),
          tx.aiModelCall.groupBy({ by: ['outcome'], where, _count: true }),
          tx.aiModelCall.groupBy({ by: ['provider', 'model'], where, _count: true, orderBy: [{ provider: 'asc' }, { model: 'asc' }] }),
        ]);
        const counts = Object.fromEntries(outcomes.map(row => [row.outcome, row._count]));
        return {
          period: window, since: since.toISOString(), requests: totals._count,
          succeeded: counts.succeeded ?? 0, failed: counts.failed ?? 0, refused: counts.refused ?? 0,
          averageLatencyMs: totals._avg.latencyMs, ...totals._sum,
          models: models.map(({ provider, model, _count }) => ({ provider, model, requests: _count })),
        };
      }, { isolationLevel: 'RepeatableRead' });
    }
  }
  return AiOperationsController;
}
