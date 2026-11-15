import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { AiPromptTemplate, AiPromptVersion, Prisma } from '../../../generated/prisma/client.js';
import { AuthRateLimit } from '../auth/rate-limit.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';
import { requestModelPreview } from './preview.js';

const keys = z.enum(['bio', 'equipment']);
type PromptKey = z.infer<typeof keys>;
const text = z.string().trim().max(3000);
const revision = z.number().int().positive().max(2_147_483_647);
const expected = revision.max(2_147_483_646);
const reason = z.string().trim().min(1).max(500);
const draft = z.object({ expectedRevision: expected, body: text.nullable() }).strict();
const publish = z.object({ expectedRevision: expected, reason }).strict();
const rollback = publish.extend({ version: revision });
const version = z.object({
  version: revision, body: text, reason, rolledBackFrom: revision.nullable(), createdAt: z.iso.datetime(),
});
const template = z.object({
  key: keys, revision, draft: text.nullable(), current: version, updatedAt: z.iso.datetime(),
});
const history = z.object({ items: z.array(version), nextVersion: revision.nullable() });
const preview = z.object({
  body: text.optional(), fields: z.record(z.string(), z.string().trim().min(1).max(500)),
  generate: z.boolean().optional(),
}).strict();
const previewResult = z.discriminatedUnion('modelStatus', [
  z.object({ resolved: z.string(), modelStatus: z.literal('succeeded'), output: z.string() }),
  z.object({ resolved: z.string(), modelStatus: z.enum(['unavailable', 'failed', 'refused']), output: z.null() }),
]);

const fields: Record<PromptKey, readonly string[]> = {
  bio: ['artist_name', 'genres', 'event_type'],
  equipment: ['equipment_title', 'manufacturer'],
};
const placeholder = /{{([a-z_]+)}}/g;

export function validatePrompt(key: PromptKey, body: string) {
  const used = new Set([...body.matchAll(placeholder)].map(match => match[1]!));
  if (body.trim().length < 20 || body.length > 3000 || used.size !== fields[key].length ||
    fields[key].some(field => !used.has(field)) || /{{|}}/.test(body.replaceAll(placeholder, ''))) {
    throw new PublicError(400, 'INVALID_PROMPT', 'Use 20–3,000 characters and include each required placeholder.');
  }
}

export function resolvePrompt(key: PromptKey, body: string, values: Record<string, string>) {
  validatePrompt(key, body);
  if (Object.keys(values).length !== fields[key].length || fields[key].some(field => !Object.hasOwn(values, field))) {
    throw new PublicError(400, 'INVALID_PROMPT_FIELDS', 'Supply the required fields for this prompt.');
  }
  const result = body.replaceAll(placeholder, (_match, key: string) => values[key]!);
  if (result.length > 6000) throw new PublicError(400, 'PROMPT_PREVIEW_TOO_LONG', 'Reduce the length of the preview fields.');
  return result;
}

function presentVersion(row: AiPromptVersion) {
  const { key: _key, actorId: _actor, ...details } = row;
  return { ...details, createdAt: row.createdAt.toISOString() };
}

function present(row: AiPromptTemplate, current: AiPromptVersion) {
  return { ...row, current: presentVersion(current), updatedAt: row.updatedAt.toISOString() };
}

export function makePromptController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const previewLimits = new AuthRateLimit(auth.deps.redis, auth.config.AUTH_RATE_PREFIX, auth.config.AUTH_JWT_SECRET);

  async function admin(req: Request) {
    const actor = await auth.authenticate(req.get('Authorization'));
    if (actor.session.activeRole !== 'admin' || !actor.user.roles.includes('admin')) {
      throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    }
    profiles.verified(actor);
    return actor;
  }

  async function mutation(req: Request) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await admin(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return actor;
  }

  async function current(tx: Prisma.TransactionClient, key: PromptKey) {
    return tx.aiPromptVersion.findFirstOrThrow({ where: { key }, orderBy: { version: 'desc' } });
  }

  async function edit<T>(
    req: Request, key: PromptKey, expectedRevision: number,
    work: (tx: Prisma.TransactionClient, row: AiPromptTemplate, active: AiPromptVersion, actorId: string) => Promise<T>,
  ) {
    const actor = await mutation(req);
    return db.$transaction(async tx => {
      const identity = await profiles.actor(tx, actor, undefined, true);
      profiles.verified(identity);
      await tx.$queryRaw`SELECT key FROM ai_prompt_templates WHERE key=${key} FOR UPDATE`;
      const row = await tx.aiPromptTemplate.findUniqueOrThrow({ where: { key } });
      if (row.revision !== expectedRevision) throw new PublicError(409, 'PROMPT_CHANGED', 'Reload the template before making changes.');
      return work(tx, row, await current(tx, key), identity.user.id);
    });
  }

  async function activate(
    tx: Prisma.TransactionClient, key: PromptKey, body: string, active: AiPromptVersion, actorId: string, reason: string, source?: number,
  ) {
    validatePrompt(key, body);
    if (body === active.body) throw new PublicError(409, 'PROMPT_UNCHANGED', 'The selected content is already published.');
    const next = await tx.aiPromptVersion.create({
      data: { key, version: active.version + 1, body, reason, actorId, rolledBackFrom: source },
    });
    const row = await tx.aiPromptTemplate.update({
      where: { key }, data: { revision: { increment: 1 }, draft: null, updatedAt: new Date() },
    });
    return present(row, next);
  }

  @ApiTags('AI prompt templates')
  @ApiBearerAuth()
  @Controller('admin/ai/prompts')
  class PromptController {
    @Get()
    @ApiOkResponse({ schema: schema(z.object({ items: z.array(template) })) })
    async list(@Req() req: Request) {
      await admin(req);
      const rows = await db.aiPromptTemplate.findMany({
        orderBy: { key: 'asc' }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      return { items: rows.map(({ versions, ...row }) => present(row, versions[0]!)) };
    }

    @Get(':key/versions')
    @ApiParam({ name: 'key', enum: keys.options })
    @ApiQuery({ name: 'beforeVersion', type: Number, required: false })
    @ApiOkResponse({ schema: schema(history) })
    async versions(@Req() req: Request, @Param('key') rawKey: string, @Query('beforeVersion') raw?: string) {
      await admin(req);
      const key = parse(keys, rawKey);
      const before = raw === undefined ? undefined : parse(z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).pipe(revision), raw);
      const rows = await db.aiPromptVersion.findMany({
        where: { key, ...(before ? { version: { lt: before } } : {}) }, orderBy: { version: 'desc' }, take: 31,
      });
      return { items: rows.slice(0, 30).map(presentVersion), nextVersion: rows.length > 30 ? rows[29]!.version : null };
    }

    @Put(':key/draft')
    @ApiParam({ name: 'key', enum: keys.options })
    @ApiBody({ schema: schema(draft) })
    @ApiOkResponse({ schema: schema(template) })
    draft(@Req() req: Request, @Param('key') rawKey: string, @Body() raw: unknown) {
      const key = parse(keys, rawKey);
      const input = parse(draft, raw);
      return edit(req, key, input.expectedRevision, async (tx, row, active) => {
        if (row.draft === input.body) return present(row, active);
        const updated = await tx.aiPromptTemplate.update({
          where: { key }, data: { draft: input.body, revision: { increment: 1 }, updatedAt: new Date() },
        });
        return present(updated, active);
      });
    }

    @Post(':key/preview')
    @HttpCode(200)
    @ApiParam({ name: 'key', enum: keys.options })
    @ApiBody({ schema: schema(preview) })
    @ApiOkResponse({ schema: schema(previewResult) })
    async preview(@Req() req: Request, @Param('key') rawKey: string, @Body() raw: unknown) {
      await mutation(req);
      const key = parse(keys, rawKey);
      const input = parse(preview, raw);
      const row = await db.aiPromptTemplate.findUniqueOrThrow({
        where: { key }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      const active = row.versions[0]!;
      const body = input.body ?? row.draft ?? active.body;
      const resolved = resolvePrompt(key, body, input.fields);
      const unavailable = { resolved, modelStatus: 'unavailable' as const, output: null };
      if (!input.generate || !auth.config.AI_SERVICE_ORIGIN || !auth.config.AI_INTERNAL_TOKEN) return unavailable;
      await previewLimits.check('ai-preview', 'shared', auth.config.AI_PREVIEW_DAILY_LIMIT, 86_400);
      const result = await requestModelPreview(auth.config, { key, template: body, fields: input.fields });
      if (!result) return unavailable;
      const { priorAttempts, ...latest } = result;
      const promptSource = input.body !== undefined ? 'inline' : row.draft !== null ? 'draft' : 'published';
      await db.aiModelCall.createMany({ data: [...priorAttempts, latest].map(({ output: _output, ...attempt }) => ({
        ...attempt, capability: 'preview-' + key, promptKey: key, promptSource,
        templateRevision: row.revision, promptVersion: promptSource === 'published' ? active.version : null,
      })) });
      return { resolved, modelStatus: latest.outcome, output: latest.output };
    }

    @Post(':key/publish')
    @HttpCode(200)
    @ApiParam({ name: 'key', enum: keys.options })
    @ApiBody({ schema: schema(publish) })
    @ApiOkResponse({ schema: schema(template) })
    publish(@Req() req: Request, @Param('key') rawKey: string, @Body() raw: unknown) {
      const key = parse(keys, rawKey);
      const input = parse(publish, raw);
      return edit(req, key, input.expectedRevision, async (tx, row, active, actorId) => {
        if (row.draft === null) throw new PublicError(409, 'PROMPT_DRAFT_REQUIRED', 'Save a draft before publishing.');
        return activate(tx, key, row.draft, active, actorId, input.reason);
      });
    }

    @Post(':key/rollback')
    @HttpCode(200)
    @ApiParam({ name: 'key', enum: keys.options })
    @ApiBody({ schema: schema(rollback) })
    @ApiOkResponse({ schema: schema(template) })
    rollback(@Req() req: Request, @Param('key') rawKey: string, @Body() raw: unknown) {
      const key = parse(keys, rawKey);
      const input = parse(rollback, raw);
      return edit(req, key, input.expectedRevision, async (tx, _row, active, actorId) => {
        const source = await tx.aiPromptVersion.findUnique({ where: { key_version: { key, version: input.version } } });
        if (!source) throw new PublicError(404, 'PROMPT_VERSION_NOT_FOUND', 'This prompt version is unavailable.');
        return activate(tx, key, source.body, active, actorId, input.reason, source.version);
      });
    }
  }
  return PromptController;
}
