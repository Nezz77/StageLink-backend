import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Prisma, type EventBrief, type MatchingVersion, type RecommendationRun } from '../../../generated/prisma/client.js';
import { databaseNow } from '../../../shared/database-clock.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService, Identity } from '../auth/service.js';
import { publicGigFilter } from '../catalog/gigs.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';
import { listingEmbeddingInput, requestEmbedding } from './embedding-client.js';
import { briefEmbeddingInput, compatibleEmbeddings, minimumEmbeddedCandidates, rerank, semanticCandidateLimit, semanticWeight } from './semantic-ranking.js';

const revision = z.number().int().positive().max(2_147_483_647);
const input = z.object({
  requestKey: uuid, expectedRevision: revision,
  useSemantic: z.boolean().optional(),
  genres: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
}).strict();
const result = z.object({
  gigId: uuid, version: revision, score: z.number().min(0).max(100),
  priceMinor: z.number().int().positive(), city: z.string(),
  rating: z.number().min(1).max(5).nullable(), reviewCount: z.number().int().nonnegative(),
});
const results = z.array(result).max(3);
const methods = z.enum(['weighted_catalog_v1', 'semantic_hybrid_v1']);
const semanticPendingMs = 30_000;
const embeddingProvenance = z.object({
  model: z.string(), listingInputVersion: z.literal(listingEmbeddingInput),
  briefInputVersion: z.literal(briefEmbeddingInput), semanticWeight: z.literal(semanticWeight),
});
const view = z.object({
  id: uuid, briefId: uuid, briefRevision: revision, weightsRevision: revision,
  method: methods, semantic: embeddingProvenance.optional(), currency: z.literal('LKR'), createdAt: z.iso.datetime(),
  items: z.array(result.extend({ currentVersion: z.boolean() })).max(3),
});

const normalize = (value: string) => value.trim().toLowerCase();

export async function rank(
  tx: Prisma.TransactionClient, brief: EventBrief, weights: MatchingVersion, genres: string[], limit = 3,
) {
  const requestedGenre = genres.length ? Prisma.sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p.approved_snapshot->'details'->'genres') AS g(value)
    WHERE lower(trim(g.value)) IN (${Prisma.join(genres)})
  )` : Prisma.sql`false`;
  const date = brief.eventDate.toISOString().slice(0, 10);
  const rows = await tx.$queryRaw<z.infer<typeof result>[]>`
    SELECT l.id AS "gigId", v.version, v.price_minor AS "priceMinor", p.approved_snapshot->>'city' AS city,
           r.rating, r.count AS "reviewCount",
           round((
             CASE WHEN ${requestedGenre} THEN ${weights.genre} ELSE 0 END +
             ${weights.budget} * (1 - v.price_minor::numeric / ${brief.budgetMinor}) +
             CASE WHEN lower(trim(p.approved_snapshot->>'city')) = ${normalize(brief.city)} THEN ${weights.location} ELSE 0 END +
             ${weights.rating} * COALESCE(r.rating, 0) / 5
           )::numeric, 2)::double precision AS score
    FROM artist_gigs l
    JOIN artist_gig_versions v ON v.gig_id = l.id AND v.version = l.published_version
    JOIN auth_users u ON u.id = l.owner_id
    JOIN provider_profiles p ON p.user_id = u.id AND p.kind = 'artist'
    LEFT JOIN LATERAL (
      SELECT avg(reviews.rating)::double precision AS rating, count(*)::integer AS count
      FROM booking_reviews reviews
      WHERE reviews.target_kind = 'gig' AND reviews.target_id = l.id AND reviews.status = 'published'
    ) r ON true
    WHERE l.status = 'published' AND v.price_minor <= ${brief.budgetMinor}
      AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND 'artist'::"AuthRole" = ANY(u.roles)
      AND p.approved_revision IS NOT NULL AND p.approved_snapshot IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM availability_blocks block
        WHERE block.owner_id = l.owner_id
          AND block.starts_at <= (${date}::date::timestamp AT TIME ZONE 'Asia/Colombo')
          AND block.ends_at >= ((${date}::date + 1)::timestamp AT TIME ZONE 'Asia/Colombo')
      )
    ORDER BY score DESC, l.id ASC LIMIT ${limit}
  `;
  return z.array(result).max(limit).parse(rows);
}

async function present(tx: Prisma.TransactionClient, row: RecommendationRun) {
  if (row.semanticPendingUntil && row.semanticPendingUntil > await databaseNow(tx)) {
    throw new PublicError(409, 'RECOMMENDATION_PROCESSING', 'Recommendations are being prepared. Retry with the same request key.');
  }
  const snapshot = results.parse(row.results);
  const listings = snapshot.length ? await tx.artistGig.findMany({
    where: { ...publicGigFilter, id: { in: snapshot.map(item => item.gigId) } }, select: { id: true, publishedVersion: true },
  }) : [];
  const versions = new Map(listings.map(listing => [listing.id, listing.publishedVersion]));
  return {
    id: row.id, briefId: row.briefId, briefRevision: row.briefRevision, weightsRevision: row.weightsRevision,
    method: methods.parse(row.method),
    ...(row.semanticProvenance ? { semantic: embeddingProvenance.parse(row.semanticProvenance) } : {}),
    currency: 'LKR' as const, createdAt: row.createdAt.toISOString(),
    items: snapshot.map(item => ({ ...item, currentVersion: versions.get(item.gigId) === item.version })),
  };
}

export function makeRecommendationController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const config = auth.config;
  const model = config.AI_SEMANTIC_RECOMMENDATIONS === 'true' && config.AI_SERVICE_ORIGIN && config.AI_INTERNAL_TOKEN
    ? config.AI_EMBEDDING_MODEL : undefined;
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function ownedBrief(tx: Prisma.TransactionClient, actor: Identity, id: string, revision: number) {
    const current = await profiles.actor(tx, actor);
    profiles.verified(current);
    if (!current.user.roles.includes('customer')) throw new PublicError(403, 'ROLE_FORBIDDEN', 'A customer membership is required.');
    const brief = await tx.eventBrief.findFirst({ where: { id, ownerId: current.user.id } });
    if (!brief) throw new PublicError(404, 'EVENT_BRIEF_NOT_FOUND', 'This event brief is unavailable.');
    if (brief.revision !== revision) throw new PublicError(409, 'REVISION_CONFLICT', 'Reload the event brief before requesting recommendations.');
    return brief;
  }

  async function embedBrief(ownerId: string, text: string) {
    if (!model) return null;
    try {
      await auth.limits.check('semantic-recommendation-member', ownerId, 5, 86_400);
      await auth.limits.check('semantic-recommendation', 'shared', config.AI_SEMANTIC_DAILY_LIMIT, 86_400);
    } catch (error) {
      if (error instanceof PublicError) return null;
      throw error;
    }
    return requestEmbedding(config, model, text);
  }

  @ApiTags('Catalog recommendations')
  @ApiBearerAuth()
  @Controller()
  class RecommendationController {
    @Post('event-posts/:id/recommendations')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(input) })
    @ApiOkResponse({ schema: schema(view) })
    async create(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
      }
      const actor = await identity(req);
      profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
      const id = parse(uuid, rawId);
      const command = parse(input, raw);
      const genres = [...new Set((command.genres ?? []).map(normalize))].sort();
      const semanticRequested = command.useSemantic === true;
      const prepared = await db.$transaction(async tx => {
        const brief = await ownedBrief(tx, actor, id, command.expectedRevision);
        const key = { briefId: brief.id, requestKey: command.requestKey };
        const prior = await tx.recommendationRun.findUnique({ where: { briefId_requestKey: key } });
        if (prior) {
          if (prior.briefRevision !== brief.revision || JSON.stringify(prior.genres) !== JSON.stringify(genres) ||
            prior.semanticRequested !== semanticRequested) {
            throw new PublicError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different recommendation request.');
          }
          return { view: await present(tx, prior) };
        }
        const weights = await tx.matchingVersion.findFirstOrThrow({ orderBy: { revision: 'desc' } });
        const semanticModel = semanticRequested ? model : undefined;
        const candidates = await rank(tx, brief, weights, genres, semanticModel ? semanticCandidateLimit : 3);
        const enoughEmbeddings = semanticModel &&
          (await compatibleEmbeddings(tx, candidates, semanticModel)).size >= minimumEmbeddedCandidates;
        const semanticPendingUntil = enoughEmbeddings
          ? new Date((await databaseNow(tx)).getTime() + semanticPendingMs)
          : null;
        const row = await tx.recommendationRun.create({
          data: {
            ...key, briefRevision: brief.revision, weightsRevision: weights.revision,
            method: 'weighted_catalog_v1', genres, results: candidates.slice(0, 3), semanticRequested,
            semanticPendingUntil,
          },
        });
        if (!enoughEmbeddings || !semanticModel) return { view: await present(tx, row) };
        return { row, weights, model: semanticModel, text: brief.title + '\n\n' + brief.description };
      });
      if (prepared.view) return prepared.view;

      const observation = await embedBrief(actor.user.id, prepared.text);
      return db.$transaction(async tx => {
        const brief = await ownedBrief(tx, actor, id, prepared.row.briefRevision);
        const result = await rank(tx, brief, prepared.weights, genres, observation?.vector ? semanticCandidateLimit : 3);
        const vectors = observation?.vector ? await compatibleEmbeddings(tx, result, prepared.model) : undefined;
        const ranked = observation?.vector && vectors && vectors.size >= minimumEmbeddedCandidates
          ? rerank(result, vectors, observation.vector) : null;
        const now = await databaseNow(tx);
        await tx.recommendationRun.updateMany({
          where: { id: prepared.row.id, semanticPendingUntil: { gt: now } },
          data: {
            method: ranked ? 'semantic_hybrid_v1' : 'weighted_catalog_v1',
            semanticPendingUntil: null, results: ranked?.items ?? result.slice(0, 3),
            ...(ranked ? { semanticProvenance: {
              model: prepared.model, listingInputVersion: listingEmbeddingInput, briefInputVersion: briefEmbeddingInput,
              semanticWeight, candidates: ranked.candidates,
            } } : {}),
          },
        });
        if (observation) {
          await tx.aiModelCall.create({ data: {
            capability: 'semantic-recommendation', provider: 'openai', model: prepared.model,
            outcome: observation.outcome, latencyMs: observation.latencyMs, inputTokens: observation.inputTokens, createdAt: now,
          } });
        }
        return present(tx, await tx.recommendationRun.findUniqueOrThrow({ where: { id: prepared.row.id } }));
      });
    }

    @Get('recommendations/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(view) })
    async read(@Req() req: Request, @Param('id') rawId: string) {
      const { user } = await identity(req);
      return db.$transaction(async tx => {
        const row = await tx.recommendationRun.findFirst({ where: { id: parse(uuid, rawId), brief: { ownerId: user.id } } });
        if (!row) throw new PublicError(404, 'RECOMMENDATION_NOT_FOUND', 'This recommendation run is unavailable.');
        return present(tx, row);
      }, { isolationLevel: 'RepeatableRead' });
    }
  }
  return RecommendationController;
}
