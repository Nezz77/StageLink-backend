import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ListingEmbedding, Prisma } from '../../../generated/prisma/client.js';
import type { Config } from '../../../shared/config.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { publicGigFilter } from '../catalog/gigs.js';
import { parse, schema } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';

const inputVersion = 'published_gig_v1';
const leaseMs = 30_000;
const counter = z.number().int().min(0).max(2_147_483_647);
const indexRequest = z.object({ expectedVersion: counter.min(1) }).strict();
const indexStatus = z.object({
  gigId: z.uuid(),
  gigVersion: counter.min(1),
  model: z.string().nullable(),
  inputVersion: z.literal(inputVersion),
  state: z.enum(['disabled', 'missing', 'processing', 'ready', 'failed']),
  indexedAt: z.iso.datetime().nullable(),
});
const observation = z.object({
  model: z.string(),
  latencyMs: counter,
  inputTokens: counter.nullable(),
}).and(z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('succeeded'), vector: z.array(z.number()).length(256) }),
  z.object({ outcome: z.literal('failed'), vector: z.null() }),
]));

type EmbeddingModel = NonNullable<Config['AI_EMBEDDING_MODEL']>;
type Key = Pick<ListingEmbedding, 'gigId' | 'gigVersion' | 'model' | 'inputVersion'>;
const statusFields = { state: true, startedAt: true, indexedAt: true } as const;
type IndexRow = Pick<ListingEmbedding, keyof typeof statusFields>;

function present(key: Omit<Key, 'model'> & { model: string | null }, row?: IndexRow | null) {
  const expired = row?.state === 'processing' && row.startedAt.getTime() <= Date.now() - leaseMs;
  return {
    ...key,
    state: expired ? 'failed' : row?.state ?? (key.model ? 'missing' : 'disabled'),
    indexedAt: row?.indexedAt?.toISOString() ?? null,
  };
}

async function requestEmbedding(config: Config, model: EmbeddingModel, text: string) {
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
    if (result.data.vector && Math.abs(Math.hypot(...result.data.vector) - 1) > 0.000_001) return null;
    return result.data;
  } catch {
    return null;
  }
}

async function publishedVersion(tx: Prisma.TransactionClient, gigId: string) {
  const gig = await tx.artistGig.findFirst({
    where: { ...publicGigFilter, id: gigId },
    select: { publication: { select: { title: true, description: true, version: true } } },
  });
  if (!gig?.publication) throw new PublicError(404, 'GIG_NOT_FOUND', 'This gig is not available.');
  return gig.publication;
}

export function makeListingEmbeddingsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const config = auth.config;
  const model = config.AI_SERVICE_ORIGIN && config.AI_INTERNAL_TOKEN ? config.AI_EMBEDDING_MODEL : undefined;

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
  @Controller('admin/ai/listing-embeddings')
  class ListingEmbeddingsController {
    @Get(':gigId')
    @ApiParam({ name: 'gigId', format: 'uuid' })
    @ApiOkResponse({ schema: schema(indexStatus) })
    async status(@Req() req: Request, @Param('gigId') rawId: string) {
      await admin(req);
      const gigId = parse(z.uuid(), rawId);
      return db.$transaction(async tx => {
        const { version: gigVersion } = await publishedVersion(tx, gigId);
        const key = { gigId, gigVersion, inputVersion };
        if (!model) return present({ ...key, model: null });
        const versioned = { ...key, model };
        return present(versioned, await tx.listingEmbedding.findUnique({
          where: { gigId_gigVersion_model_inputVersion: versioned }, select: statusFields,
        }));
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Post(':gigId')
    @HttpCode(200)
    @ApiParam({ name: 'gigId', format: 'uuid' })
    @ApiBody({ schema: schema(indexRequest) })
    @ApiOkResponse({ schema: schema(indexStatus) })
    async index(@Req() req: Request, @Param('gigId') rawId: string, @Body() body: unknown) {
      if (req.get('Origin') !== config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
      }
      const actor = await admin(req);
      profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
      const gigId = parse(z.uuid(), rawId);
      const { expectedVersion } = parse(indexRequest, body);
      if (!model) throw new PublicError(503, 'EMBEDDINGS_DISABLED', 'Listing embeddings are unavailable.');

      const key = { gigId, gigVersion: expectedVersion, model, inputVersion };
      const attemptId = randomUUID();
      const existing = { gigId_gigVersion_model_inputVersion: key };
      const claim = await db.$transaction(async tx => {
        profiles.verified(await profiles.actor(tx, actor, undefined, true));
        const published = await publishedVersion(tx, gigId);
        if (published.version !== expectedVersion) {
          throw new PublicError(409, 'GIG_VERSION_CHANGED', 'Reload the published gig before indexing.');
        }
        const staleAt = new Date(Date.now() - leaseMs);
        const claimed = await tx.$executeRaw`
          INSERT INTO listing_embeddings (gig_id, gig_version, model, input_version, attempt_id, started_at)
          VALUES (${gigId}::uuid, ${expectedVersion}, ${model}, ${inputVersion}, ${attemptId}::uuid, CURRENT_TIMESTAMP)
          ON CONFLICT (gig_id, gig_version, model, input_version) DO UPDATE
          SET state = 'processing', attempt_id = EXCLUDED.attempt_id, started_at = EXCLUDED.started_at
          WHERE listing_embeddings.state = 'failed'
             OR (listing_embeddings.state = 'processing' AND listing_embeddings.started_at <= ${staleAt})
        `;
        if (claimed) return { text: published.title + '\n\n' + published.description };
        const row = await tx.listingEmbedding.findUniqueOrThrow({ where: existing, select: statusFields });
        return { row };
      });
      if (claim.row) return present(key, claim.row);

      const attempt = { ...key, attemptId, state: 'processing' as const };
      try {
        await auth.limits.check('listing-embedding', 'shared', config.AI_EMBEDDING_DAILY_LIMIT, 86_400);
      } catch (error) {
        await db.listingEmbedding.updateMany({ where: attempt, data: { state: 'failed' } });
        throw error;
      }

      const result = await requestEmbedding(config, model, claim.text);
      return db.$transaction(async tx => {
        const data = result?.vector
          ? { state: 'ready' as const, vector: result.vector, indexedAt: new Date() }
          : { state: 'failed' as const };
        await tx.listingEmbedding.updateMany({ where: attempt, data });
        if (result) {
          await tx.aiModelCall.create({ data: {
            provider: 'openai', model, capability: 'listing-embedding', outcome: result.outcome,
            latencyMs: result.latencyMs, inputTokens: result.inputTokens,
          } });
        }
        return present(key, await tx.listingEmbedding.findUnique({ where: existing, select: statusFields }));
      });
    }
  }
  return ListingEmbeddingsController;
}
