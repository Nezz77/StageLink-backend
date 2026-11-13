import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { EventBrief, Prisma } from '../../../generated/prisma/client.js';
import type { AuthService, Identity } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { consumeDraft, draftReference } from './drafts.js';

const uuid = z.string().uuid();
const revision = z.number().int().min(1).max(2_147_483_647);
const text = (max: number) => z.string().trim().min(1).max(max);
const date = z.iso.date().refine(value => !value.startsWith('0000-'));
const requirements = z.array(z.object({
  category: z.enum(['artist', 'equipment', 'venue']),
  description: text(300),
  quantity: z.number().int().min(1).max(1000),
}).strict()).max(25);
const fields = z.object({
  title: text(120), description: text(2000), eventDate: date, city: text(100),
  budgetMinor: z.number().int().min(1).max(2_147_483_647), currency: z.literal('LKR'),
  requirements,
}).strict();
const create = fields.extend({ draft: draftReference.optional() });
const edit = fields.partial().extend({ revision }).refine(input => Object.keys(input).length > 1);
const remove = z.object({ revision }).strict();
const brief = fields.extend({ id: uuid, revision, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
const page = z.object({ items: z.array(brief), nextCursor: uuid.nullable() });
const deleted = z.object({ deleted: z.literal(true) });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;
const pageSize = 30;

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const result = type.safeParse(value);
  if (!result.success) throw new PublicError(400, 'INVALID_EVENT_BRIEF', 'Check the event date, LKR budget, and requirements.');
  return result.data;
}

function present(record: EventBrief) {
  const { id, title, description, city, budgetMinor, revision, eventDate, createdAt, updatedAt } = record;
  return {
    id, title, description, city, budgetMinor, revision, currency: 'LKR' as const,
    eventDate: eventDate.toISOString().slice(0, 10), requirements: requirements.parse(record.requirements),
    createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
  };
}

function customer(identity: Identity) {
  if (!identity.user.roles.includes('customer')) {
    throw new PublicError(403, 'ROLE_FORBIDDEN', 'A customer membership is required.');
  }
}

async function ownedBrief(db: Prisma.TransactionClient, ownerId: string, id: string) {
  const record = await db.eventBrief.findFirst({ where: { id, ownerId } });
  if (!record) throw new PublicError(404, 'EVENT_BRIEF_NOT_FOUND', 'This event brief is unavailable.');
  return record;
}

export function makeEventBriefController(auth: AuthService) {
  const profiles = new ProfileService(auth);
  const db = auth.deps.db;
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function write<T>(req: Request, work: (tx: Prisma.TransactionClient, ownerId: string) => Promise<T>) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, actor);
      customer(current);
      return work(tx, current.user.id);
    });
  }

  async function currentVersion(tx: Prisma.TransactionClient, ownerId: string, id: string, expected: number) {
    const record = await ownedBrief(tx, ownerId, id);
    if (record.revision !== expected) throw new PublicError(409, 'REVISION_CONFLICT', 'Reload the event brief before changing it.');
    return record;
  }

  @ApiTags('Customer event briefs')
  @ApiBearerAuth()
  @Controller()
  class EventBriefController {
    @Get('me/event-posts')
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiOkResponse({ schema: schema(page) })
    async list(@Req() req: Request, @Query('cursor') cursor?: string) {
      const actor = await identity(req);
      customer(actor);
      const records = await db.eventBrief.findMany({
        where: { ownerId: actor.user.id, ...(cursor === undefined ? {} : { id: { gt: parse(uuid, cursor) } }) },
        orderBy: { id: 'asc' }, take: pageSize + 1,
      });
      const items = records.slice(0, pageSize).map(present);
      return { items, nextCursor: records.length > pageSize ? items[pageSize - 1]!.id : null };
    }

    @Get('event-posts/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(brief) })
    async get(@Req() req: Request, @Param('id') id: string) {
      const actor = await identity(req);
      customer(actor);
      return present(await ownedBrief(db, actor.user.id, parse(uuid, id)));
    }

    @Post('event-posts')
    @HttpCode(200)
    @ApiBody({ schema: schema(create) })
    @ApiOkResponse({ schema: schema(brief) })
    create(@Req() req: Request, @Body() body: unknown) {
      const { currency: _currency, eventDate, draft, ...details } = parse(create, body);
      return write(req, async (tx, ownerId) => {
        if (draft) await consumeDraft(tx, ownerId, draft, 'event_brief');
        return present(await tx.eventBrief.create({ data: { ...details, ownerId, eventDate: new Date(eventDate) } }));
      });
    }

    @Patch('event-posts/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(edit) })
    @ApiOkResponse({ schema: schema(brief) })
    update(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const { revision, currency: _currency, eventDate, ...details } = parse(edit, body);
      const briefId = parse(uuid, id);
      return write(req, async (tx, ownerId) => {
        await currentVersion(tx, ownerId, briefId, revision);
        return present(await tx.eventBrief.update({
          where: { id: briefId },
          data: { ...details, ...(eventDate ? { eventDate: new Date(eventDate) } : {}), revision: { increment: 1 }, updatedAt: new Date() },
        }));
      });
    }

    @Delete('event-posts/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(remove) })
    @ApiOkResponse({ schema: schema(deleted) })
    delete(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const { revision } = parse(remove, body);
      const briefId = parse(uuid, id);
      return write(req, async (tx, ownerId) => {
        await currentVersion(tx, ownerId, briefId, revision);
        await tx.eventBrief.delete({ where: { id: briefId } });
        return { deleted: true };
      });
    }
  }
  return EventBriefController;
}
