import { notifyUsers } from '../../../shared/notifications.js';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma, SupportCase, SupportEntry } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { member } from '../bookings/requests.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';

const timestamp = z.iso.datetime();
const status = z.enum(['open', 'resolved']);
const revision = z.number().int().positive().max(2_147_483_647);
const cursor = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const subject = z.string().trim().min(3).max(140);
const message = z.string().trim().min(1).max(2000);
const create = z.object({
  requestKey: uuid, subject, body: message.min(20), bookingId: uuid.optional(),
  assetIds: z.array(uuid).max(5).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length).optional(),
}).strict();
const reply = z.object({ requestKey: uuid, body: message }).strict();
const update = z.object({ expectedRevision: revision.max(2_147_483_646), reason: message.min(10) }).strict();
const transition = update.extend({ status });
const assignment = update.extend({ assigneeId: uuid.nullable() });
const memberCase = z.object({
  id: uuid, subject, body: message, bookingId: uuid.nullable(), status, revision, createdAt: timestamp,
  assetIds: z.array(uuid),
});
const staffCase = memberCase.extend({ ownerId: uuid, assigneeId: uuid.nullable() });
const memberEntry = z.object({ id: z.string(), staff: z.boolean(), body: message, createdAt: timestamp });
const staffEntry = memberEntry.extend({
  kind: z.enum(['reply', 'note', 'status', 'assignment']), actorId: uuid,
  assigneeId: uuid.nullable(), status: status.nullable(), revision: revision.nullable(),
});
const casePage = z.object({ items: z.array(memberCase), nextCursor: uuid.nullable() });
const adminPage = z.object({ items: z.array(staffCase), nextCursor: uuid.nullable() });
const replies = z.object({ items: z.array(memberEntry), nextCursor: z.string().nullable() });
const entries = z.object({ items: z.array(staffEntry), nextCursor: z.string().nullable() });

const attachments = { orderBy: { position: 'asc' }, select: { assetId: true } } as const;
type Case = SupportCase & { attachments: { assetId: string }[] };
const pageSize = 30;

function presentCase(row: Case) {
  const { id, subject, body, bookingId, status, revision, createdAt } = row;
  return { id, subject, body, bookingId, status, revision, createdAt: createdAt.toISOString(), assetIds: row.attachments.map(item => item.assetId) };
}

function presentStaffCase(row: Case) {
  return { ...presentCase(row), ownerId: row.ownerId, assigneeId: row.assigneeId };
}

function presentReply(row: SupportEntry) {
  return { id: String(row.id), staff: row.staff, body: row.body, createdAt: row.createdAt.toISOString() };
}

function presentEntry(row: SupportEntry) {
  const { kind, actorId, assigneeId, status, revision } = row;
  return { ...presentReply(row), kind, actorId, assigneeId, status, revision };
}

function missing(): never {
  throw new PublicError(404, 'SUPPORT_CASE_NOT_FOUND', 'This support case is unavailable.');
}

export function makeSupportController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function write<T>(
    req: Request, staff: boolean, work: (tx: Prisma.TransactionClient, actorId: string) => Promise<T>,
  ) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, actor, undefined, staff);
      profiles.verified(current);
      if (!staff && !current.user.roles.some(role => role !== 'admin')) {
        throw new PublicError(403, 'ROLE_FORBIDDEN', 'A StageLink membership is required.');
      }
      return work(tx, current.user.id);
    });
  }

  async function getCase(tx: Prisma.TransactionClient, id: string, ownerId?: string) {
    const row = await tx.supportCase.findFirst({
      where: { id, ...(ownerId ? { ownerId } : {}) }, include: { attachments },
    });
    if (!row) missing();
    return row;
  }

  async function lockCase(tx: Prisma.TransactionClient, id: string, ownerId?: string) {
    if (ownerId) await getCase(tx, id, ownerId);
    await tx.$queryRaw`SELECT id FROM support_cases WHERE id=${id}::uuid FOR UPDATE`;
    return getCase(tx, id, ownerId);
  }

  async function admin(req: Request) {
    const actor = await identity(req);
    if (actor.session.activeRole !== 'admin' || !actor.user.roles.includes('admin')) {
      throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    }
    profiles.verified(actor);
    return actor;
  }

  async function history(req: Request, id: string, before: string | undefined, staff: boolean) {
    const actor = staff ? await admin(req) : await identity(req);
    const caseId = parse(uuid, id);
    const beforeId = before === undefined ? undefined : BigInt(parse(cursor, before));
    return db.$transaction(async tx => {
      await getCase(tx, caseId, staff ? undefined : actor.user.id);
      const rows = await tx.supportEntry.findMany({
        where: { caseId, ...(!staff ? { kind: 'reply' } : {}), ...(beforeId ? { id: { lt: beforeId } } : {}) },
        orderBy: { id: 'desc' }, take: pageSize + 1,
      });
      return {
        items: rows.slice(0, pageSize).map(row => staff ? presentEntry(row) : presentReply(row)),
        nextCursor: rows.length > pageSize ? String(rows[pageSize - 1]!.id) : null,
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async function addMessage(req: Request, id: string, input: z.infer<typeof reply>, staff: boolean, kind: 'reply' | 'note') {
    const caseId = parse(uuid, id);
    return write(req, staff, async (tx, actorId) => {
      const row = await lockCase(tx, caseId, staff ? undefined : actorId);
      const key = { caseId, actorId, requestKey: input.requestKey };
      const existing = await tx.supportEntry.findUnique({ where: { caseId_actorId_requestKey: key } });
      if (existing) {
        if (existing.kind !== kind || existing.staff !== staff || existing.body !== input.body) {
          throw new PublicError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different message.');
        }
        return existing;
      }
      if (kind === 'reply' && row.status === 'resolved') throw new PublicError(409, 'SUPPORT_CASE_RESOLVED', 'Reopen this case before replying.');
      const entry = await tx.supportEntry.create({ data: { ...key, kind, staff, body: input.body } });
      if (staff && kind === 'reply') await notifyUsers(tx, [row.ownerId], 'support', row.id, String(entry.id));
      return entry;
    });
  }

  @ApiTags('Support cases')
  @ApiBearerAuth()
  @Controller()
  class SupportController {
    @Post('cases')
    @HttpCode(200)
    @ApiBody({ schema: schema(create) })
    @ApiOkResponse({ schema: schema(memberCase) })
    create(@Req() req: Request, @Body() raw: unknown) {
      const input = parse(create, raw);
      const assetIds = (input.assetIds ?? []).map(id => id.toLowerCase());
      const bookingId = input.bookingId?.toLowerCase();
      return write(req, false, async (tx, ownerId) => {
        const key = { ownerId, requestKey: input.requestKey };
        const prior = await tx.supportCase.findUnique({ where: { ownerId_requestKey: key }, include: { attachments } });
        if (prior) {
          if (prior.subject !== input.subject || prior.body !== input.body || prior.bookingId !== (bookingId ?? null) ||
            prior.attachments.length !== assetIds.length || prior.attachments.some(({ assetId }, index) => assetId !== assetIds[index])) {
            throw new PublicError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different case.');
          }
          return presentCase(prior);
        }
        if (bookingId) await member(tx, bookingId, ownerId);
        for (const assetId of [...assetIds].sort()) {
          await tx.$queryRaw`SELECT id FROM assets WHERE id=${assetId}::uuid FOR UPDATE`;
          const asset = await tx.asset.findFirst({ where: { id: assetId, ownerId, purpose: 'support', status: 'ready' }, select: { variants: true } });
          if ((asset?.variants as { display?: { mime?: string } } | undefined)?.display?.mime !== 'image/webp') {
            throw new PublicError(409, 'SUPPORT_ATTACHMENT_UNAVAILABLE', 'Choose validated private support images.');
          }
        }
        return presentCase(await tx.supportCase.create({
          data: {
            ...key, bookingId, subject: input.subject, body: input.body,
            attachments: { create: assetIds.map((assetId, position) => ({ assetId, position })) },
          }, include: { attachments },
        }));
      });
    }

    @Get('me/cases')
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiOkResponse({ schema: schema(casePage) })
    async mine(@Req() req: Request, @Query('cursor') raw?: string) {
      const { user } = await identity(req);
      const after = raw === undefined ? undefined : parse(uuid, raw);
      const rows = await db.supportCase.findMany({
        where: { ownerId: user.id, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' }, take: pageSize + 1, include: { attachments },
      });
      return { items: rows.slice(0, pageSize).map(presentCase), nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null };
    }

    @Get('cases/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(memberCase) })
    async read(@Req() req: Request, @Param('id') id: string) {
      const { user } = await identity(req);
      return presentCase(await getCase(db, parse(uuid, id), user.id));
    }

    @Get('cases/:id/replies')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiQuery({ name: 'before', type: String, required: false })
    @ApiOkResponse({ schema: schema(replies) })
    replies(@Req() req: Request, @Param('id') id: string, @Query('before') before?: string) {
      return history(req, id, before, false);
    }

    @Post('cases/:id/replies')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(reply) })
    @ApiOkResponse({ schema: schema(memberEntry) })
    async reply(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      return presentReply(await addMessage(req, id, parse(reply, raw), false, 'reply'));
    }

    @Get('admin/cases')
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiQuery({ name: 'status', enum: status.options, required: false })
    @ApiOkResponse({ schema: schema(adminPage) })
    async queue(@Req() req: Request, @Query('cursor') raw?: string, @Query('status') filter?: string) {
      await admin(req);
      const after = raw === undefined ? undefined : parse(uuid, raw);
      const rows = await db.supportCase.findMany({
        where: { ...(filter === undefined ? {} : { status: parse(status, filter) }), ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' }, take: pageSize + 1, include: { attachments },
      });
      return { items: rows.slice(0, pageSize).map(presentStaffCase), nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null };
    }

    @Get('admin/cases/:id/entries')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiQuery({ name: 'before', type: String, required: false })
    @ApiOkResponse({ schema: schema(entries) })
    entries(@Req() req: Request, @Param('id') id: string, @Query('before') before?: string) {
      return history(req, id, before, true);
    }

    @Post('admin/cases/:id/replies')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(reply) })
    @ApiOkResponse({ schema: schema(staffEntry) })
    async staffReply(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      return presentEntry(await addMessage(req, id, parse(reply, raw), true, 'reply'));
    }

    @Post('admin/cases/:id/notes')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(reply) })
    @ApiOkResponse({ schema: schema(staffEntry) })
    async note(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      return presentEntry(await addMessage(req, id, parse(reply, raw), true, 'note'));
    }

    @Post('admin/cases/:id/status')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(transition) })
    @ApiOkResponse({ schema: schema(staffCase) })
    status(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      const id = parse(uuid, rawId);
      const input = parse(transition, raw);
      return write(req, true, async (tx, actorId) => {
        const row = await lockCase(tx, id);
        if (row.revision !== input.expectedRevision) throw new PublicError(409, 'SUPPORT_CASE_CHANGED', 'Reload the case before updating it.');
        if (row.status === input.status) return presentStaffCase(row);
        return presentStaffCase(await tx.supportCase.update({
          where: { id }, data: {
            status: input.status, revision: { increment: 1 },
            entries: { create: { kind: 'status', staff: true, status: input.status, revision: row.revision + 1, actorId, body: input.reason } },
          }, include: { attachments },
        }));
      });
    }

    @Post('admin/cases/:id/assignment')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(assignment) })
    @ApiOkResponse({ schema: schema(staffCase) })
    assign(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      const id = parse(uuid, rawId);
      const input = parse(assignment, raw);
      const assigneeId = input.assigneeId?.toLowerCase() ?? null;
      return write(req, true, async (tx, actorId) => {
        const row = await lockCase(tx, id);
        if (row.revision !== input.expectedRevision) throw new PublicError(409, 'SUPPORT_CASE_CHANGED', 'Reload the case before updating it.');
        if (row.assigneeId === assigneeId) return presentStaffCase(row);
        if (assigneeId && !await tx.authUser.findFirst({
          where: { id: assigneeId, roles: { has: 'admin' }, disabledAt: null, emailVerifiedAt: { not: null } },
        })) throw new PublicError(409, 'SUPPORT_ASSIGNEE_UNAVAILABLE', 'Choose an active administrator.');
        return presentStaffCase(await tx.supportCase.update({
          where: { id }, data: {
            assigneeId, revision: { increment: 1 },
            entries: { create: { kind: 'assignment', staff: true, assigneeId, revision: row.revision + 1, actorId, body: input.reason } },
          }, include: { attachments },
        }));
      });
    }
  }
  return SupportController;
}
