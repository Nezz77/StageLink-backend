import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ListingEmbedding, Prisma } from '../../../generated/prisma/client.js';
import { databaseNow } from '../../../shared/database-clock.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { publicGigFilter } from '../catalog/gigs.js';
import { parse, schema } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';

import { listingEmbeddingInput as inputVersion, requestEmbedding } from './embedding-client.js';
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
type Key = Pick<ListingEmbedding, 'gigId' | 'gigVersion' | 'model' | 'inputVersion'>;
const statusFields = { state: true, startedAt: true, indexedAt: true } as const;
type IndexRow = Pick<ListingEmbedding, keyof typeof statusFields>;

async function present(tx: Prisma.TransactionClient, key: Omit<Key, 'model'> & { model: string | null }, row?: IndexRow | null) {
  const expired = row?.state === 'processing' && row.startedAt.getTime() <= (await databaseNow(tx)).getTime() - leaseMs;
  return {
    ...key,
    state: expired ? 'failed' : row?.state ?? (key.model ? 'missing' : 'disabled'),
    indexedAt: row?.indexedAt?.toISOString() ?? null,
  };
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
        if (!model) return present(tx, { ...key, model: null });
        const versioned = { ...key, model };
        return present(tx, versioned, await tx.listingEmbedding.findUnique({
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
        const claimed = await tx.$executeRaw`
          INSERT INTO listing_embeddings (gig_id, gig_version, model, input_version, attempt_id, started_at)
          VALUES (${gigId}::uuid, ${expectedVersion}, ${model}, ${inputVersion}, ${attemptId}::uuid, clock_timestamp())
          ON CONFLICT (gig_id, gig_version, model, input_version) DO UPDATE
          SET state = 'processing', attempt_id = EXCLUDED.attempt_id, started_at = clock_timestamp()
          WHERE listing_embeddings.state = 'failed'
             OR (listing_embeddings.state = 'processing'
               AND listing_embeddings.started_at <= clock_timestamp() - ${leaseMs} * interval '1 millisecond')
        `;
        if (claimed) return { text: published.title + '\n\n' + published.description };
        const row = await tx.listingEmbedding.findUniqueOrThrow({ where: existing, select: statusFields });
        return { status: await present(tx, key, row) };
      });
      if (claim.status) return claim.status;

      const attempt = { ...key, attemptId, state: 'processing' as const };
      try {
        await auth.limits.check('listing-embedding', 'shared', config.AI_EMBEDDING_DAILY_LIMIT, 86_400);
      } catch (error) {
        await db.listingEmbedding.updateMany({ where: attempt, data: { state: 'failed' } });
        throw error;
      }

      const result = await requestEmbedding(config, model, claim.text);
      return db.$transaction(async tx => {
        // Check the deadline after waiting for any concurrent retry of this row.
        await tx.$queryRaw`
          SELECT attempt_id FROM listing_embeddings
          WHERE gig_id = ${gigId}::uuid AND gig_version = ${expectedVersion}
            AND model = ${model} AND input_version = ${inputVersion} AND attempt_id = ${attemptId}::uuid
          FOR UPDATE
        `;
        const now = await databaseNow(tx);
        const data = result?.vector
          ? { state: 'ready' as const, vector: result.vector, indexedAt: now }
          : { state: 'failed' as const };
        const startedAfter = new Date(now.getTime() - leaseMs);
        await tx.listingEmbedding.updateMany({ where: { ...attempt, startedAt: { gt: startedAfter } }, data });
        if (result) {
          await tx.aiModelCall.create({ data: {
            provider: 'openai', model, capability: 'listing-embedding', outcome: result.outcome,
            latencyMs: result.latencyMs, inputTokens: result.inputTokens, createdAt: now,
          } });
        }
        return present(tx, key, await tx.listingEmbedding.findUnique({ where: existing, select: statusFields }));
      });
    }
  }
  return ListingEmbeddingsController;
}
