import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Prisma, type AiGenerationJob } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { schema } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';
import { gigDraft, previewText, requestModelPreview, saveModelAttempts } from './preview.js';
import { resolvePrompt } from './prompts.js';

const kinds = z.enum(['bio', 'gig']);
const field = (limit: number) => z.string().trim().min(1).max(limit);
const common = { artist_name: field(120), event_type: field(160) };
const bio = z.object({
  requestKey: z.uuid(),
  fields: z.object({ ...common, genres: field(160) }).strict(),
}).strict();
const gig = z.object({
  requestKey: z.uuid(),
  fields: z.object({ ...common, performance: field(500) }).strict(),
}).strict();
const biography = z.object({ bio: previewText }).strict();
const suggestion = z.union([biography, gigDraft]);
const job = z.object({
  id: z.uuid(), kind: kinds, promptVersion: z.number().int().positive(),
  status: z.enum(['processing', 'succeeded', 'failed', 'refused', 'unavailable']),
  suggestion: suggestion.nullable(), createdAt: z.iso.datetime(),
});
const rollingDayMs = 86_400_000;
const artistDailyLimit = 5;
const processingWindowMs = 30_000;

function missing() {
  return new PublicError(404, 'GENERATION_NOT_FOUND', 'This writing suggestion is unavailable.');
}

function present(row: AiGenerationJob) {
  const expired = row.status === 'processing' && row.expiresAt <= new Date();
  return {
    id: row.id, kind: kinds.parse(row.kind), promptVersion: row.promptVersion,
    status: expired ? 'unavailable' as const : row.status,
    suggestion: row.suggestion === null ? null : suggestion.parse(row.suggestion),
    createdAt: row.createdAt.toISOString(),
  };
}

export function makeGenerationsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  @ApiTags('Artist writing assistant')
  @ApiBearerAuth()
  @Controller('ai/generations')
  class GenerationsController {
    @Post(':kind')
    @HttpCode(200)
    @ApiParam({ name: 'kind', enum: kinds.options })
    @ApiBody({ schema: schema(z.union([bio, gig])) })
    @ApiOkResponse({ schema: schema(job) })
    async generate(@Req() req: Request, @Param('kind') rawKind: string, @Body() raw: unknown) {
      if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
      }
      const actor = await identity(req);
      profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
      profiles.providerRole(actor, 'artist');
      profiles.verified(actor);
      const parsedKind = kinds.safeParse(rawKind);
      if (!parsedKind.success) throw missing();
      const kind = parsedKind.data;
      const input = (kind === 'bio' ? bio : gig).safeParse(raw);
      if (!input.success) throw new PublicError(400, 'INVALID_GENERATION_INPUT', 'Supply a request key and the fields for this writing suggestion.');
      const { requestKey, fields } = input.data;
      const requestHash = createHash('sha256').update(JSON.stringify([kind, fields])).digest('hex');

      const accepted = await db.$transaction(async tx => {
        const current = await profiles.actor(tx, actor);
        profiles.providerRole(current, 'artist');
        profiles.verified(current);
        const ownerId = current.user.id;
        const existing = await tx.aiGenerationJob.findUnique({
          where: { ownerId_requestKey: { ownerId, requestKey } },
        });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new PublicError(409, 'GENERATION_KEY_REUSED', 'Use a new request key for a different writing suggestion.');
          }
          return { row: existing, template: null };
        }
        if (!auth.config.AI_SERVICE_ORIGIN || !auth.config.AI_INTERNAL_TOKEN) {
          throw new PublicError(503, 'GENERATION_UNAVAILABLE', 'Writing suggestions are temporarily unavailable.');
        }

        // Serialize quota checks across replicas. The model call starts after this transaction commits.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(5, 27)`;
        const now = new Date();
        const createdAt = { gt: new Date(now.getTime() - rollingDayMs) };
        const used = await tx.aiGenerationJob.count({ where: { ownerId, createdAt } });
        if (used >= artistDailyLimit || await tx.aiGenerationJob.count({ where: { createdAt } }) >= auth.config.AI_GENERATION_DAILY_LIMIT) {
          throw new PublicError(429, 'GENERATION_LIMIT_REACHED', 'The writing suggestion limit has been reached. Try again later.');
        }
        await tx.$queryRaw`SELECT key FROM ai_prompt_templates WHERE key=${kind} FOR SHARE`;
        const template = await tx.aiPromptTemplate.findUniqueOrThrow({
          where: { key: kind }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
        });
        const published = template.versions[0]!;
        resolvePrompt(kind, published.body, fields);
        const row = await tx.aiGenerationJob.create({
          data: {
            ownerId, requestKey, requestHash, kind, promptVersion: published.version,
            templateRevision: template.revision, createdAt: now, expiresAt: new Date(now.getTime() + processingWindowMs),
          },
        });
        return { row, template: published.body };
      });
      if (accepted.template === null) return present(accepted.row);

      const result = await requestModelPreview(auth.config, { key: kind, template: accepted.template, fields });
      const row = await db.$transaction(async tx => {
        const existing = await tx.aiGenerationJob.findUnique({ where: { id: accepted.row.id } });
        if (!existing) throw missing();
        const now = new Date();
        const status = existing.expiresAt <= now ? 'unavailable' : (result?.outcome ?? 'unavailable');
        const output = status === 'succeeded' ? result?.output : null;
        const draft = typeof output === 'string' ? { bio: output } : output;
        const completed = await tx.aiGenerationJob.update({
          where: { id: existing.id }, data: { status, completedAt: now, suggestion: draft ?? Prisma.DbNull },
        });
        if (result) await saveModelAttempts(tx, result, {
          capability: 'generation-' + kind, promptKey: kind, promptSource: 'published',
          generationId: completed.id, promptVersion: completed.promptVersion, templateRevision: completed.templateRevision,
        });
        return completed;
      });
      return present(row);
    }

    @Get(':id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(job) })
    async read(@Req() req: Request, @Param('id') id: string) {
      const actor = await identity(req);
      profiles.verified(actor);
      const parsed = z.uuid().safeParse(id);
      if (!parsed.success) throw missing();
      const row = await db.aiGenerationJob.findFirst({ where: { id: parsed.data, ownerId: actor.user.id } });
      if (!row) throw missing();
      return present(row);
    }
  }

  return GenerationsController;
}
