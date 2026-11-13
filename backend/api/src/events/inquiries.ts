import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Inquiry, InquiryMessage, Prisma } from '../../../generated/prisma/client.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { publicGigFilter } from '../catalog/gigs.js';
import { publicRentalFilter } from '../catalog/rentals.js';
import { consumeDraft, draftReference } from './drafts.js';

const uuid = z.string().uuid();
const kind = z.enum(['gig', 'rental']);
const sequence = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const text = z.string().trim().min(1).max(4000);
const send = z.object({ requestKey: uuid, message: text, draft: draftReference.optional() }).strict();
const open = send.extend({ targetKind: kind, targetId: uuid });
const message = z.object({ id: sequence, authorId: uuid, body: text, createdAt: z.iso.datetime() });
const thread = z.object({
  id: uuid, customerId: uuid, providerId: uuid, targetKind: kind, targetId: uuid,
  targetVersion: z.number().int().positive(), title: z.string(), createdAt: z.iso.datetime(),
});
const opened = thread.extend({ firstMessage: message });
const threads = z.object({ items: z.array(thread), nextCursor: uuid.nullable() });
const messages = z.object({ items: z.array(message), nextCursor: sequence.nullable() });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;
const pageSize = 30;

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const result = type.safeParse(value);
  if (!result.success) throw new PublicError(400, 'INVALID_INQUIRY', 'Check the inquiry message, listing or cursor.');
  return result.data;
}

function presentThread(record: Inquiry) {
  const { requestKey: _requestKey, ...fields } = record;
  return { ...fields, createdAt: fields.createdAt.toISOString() };
}

function presentMessage(record: InquiryMessage) {
  return { id: String(record.id), authorId: record.authorId, body: record.body, createdAt: record.createdAt.toISOString() };
}

async function member(tx: Prisma.TransactionClient, id: string, userId: string) {
  const record = await tx.inquiry.findFirst({
    where: { id, OR: [{ customerId: userId }, { providerId: userId }] },
  });
  if (!record) throw new PublicError(404, 'INQUIRY_NOT_FOUND', 'This inquiry is unavailable.');
  return record;
}

function reusedKey(): never {
  throw new PublicError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different inquiry or message.');
}

export function makeInquiriesController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function write<T>(req: Request, work: (tx: Prisma.TransactionClient, actor: Awaited<ReturnType<typeof identity>>) => Promise<T>) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, actor);
      return work(tx, current);
    });
  }

  @ApiTags('Pre-booking inquiries')
  @ApiBearerAuth()
  @Controller()
  class InquiriesController {
    @Post('inquiries')
    @HttpCode(200)
    @ApiBody({ schema: schema(open) })
    @ApiOkResponse({ schema: schema(opened) })
    open(@Req() req: Request, @Body() body: unknown) {
      const input = parse(open, body);
      return write(req, async (tx, actor) => {
        const customerId = actor.user.id;
        if (!actor.user.roles.includes('customer')) throw new PublicError(403, 'ROLE_FORBIDDEN', 'A customer membership is required.');
        profiles.verified(actor);
        const existing = await tx.inquiry.findUnique({
          where: { customerId_requestKey: { customerId, requestKey: input.requestKey } },
          include: { messages: { orderBy: { id: 'asc' }, take: 1 } },
        });
        if (existing) {
          const [first] = existing.messages;
          if (!first || existing.targetKind !== input.targetKind || existing.targetId !== input.targetId || first.body !== input.message) reusedKey();
          const { messages: _messages, ...thread } = existing;
          return { ...presentThread(thread), firstMessage: presentMessage(first) };
        }

        const select = { ownerId: true, publication: { select: { title: true, version: true } } } as const;
        const target = input.targetKind === 'gig'
          ? await tx.artistGig.findFirst({ where: { ...publicGigFilter, id: input.targetId }, select })
          : await tx.rentalListing.findFirst({ where: { ...publicRentalFilter, id: input.targetId }, select });
        if (!target?.publication) throw new PublicError(404, 'INQUIRY_TARGET_UNAVAILABLE', 'This listing is unavailable.');
        if (target.ownerId === customerId) throw new PublicError(409, 'SELF_INQUIRY', 'Choose a listing from another provider.');
        if (input.draft) await consumeDraft(tx, customerId, input.draft, 'message');

        const created = await tx.inquiry.create({
          data: {
            customerId, providerId: target.ownerId, targetKind: input.targetKind, targetId: input.targetId,
            targetVersion: target.publication.version, title: target.publication.title, requestKey: input.requestKey,
            messages: { create: { authorId: customerId, requestKey: input.requestKey, body: input.message } },
          },
          include: { messages: true },
        });
        const { messages: [first], ...thread } = created;
        if (!first) throw new Error('Inquiry first message is missing.');
        return { ...presentThread(thread), firstMessage: presentMessage(first) };
      });
    }

    @Get('me/conversations')
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiOkResponse({ schema: schema(threads) })
    async list(@Req() req: Request, @Query('cursor') cursor?: string) {
      const { user } = await identity(req);
      const records = await db.inquiry.findMany({
        where: {
          OR: [{ customerId: user.id }, { providerId: user.id }],
          ...(cursor === undefined ? {} : { id: { gt: parse(uuid, cursor) } }),
        },
        orderBy: { id: 'asc' }, take: pageSize + 1,
      });
      const items = records.slice(0, pageSize).map(presentThread);
      return { items, nextCursor: records.length > pageSize ? items[pageSize - 1]!.id : null };
    }

    @Get('inquiries/:id/messages')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiOkResponse({ schema: schema(messages) })
    async history(@Req() req: Request, @Param('id') id: string, @Query('cursor') cursor?: string) {
      const { user } = await identity(req);
      const inquiryId = parse(uuid, id);
      await member(db, inquiryId, user.id);
      const records = await db.inquiryMessage.findMany({
        where: { inquiryId, ...(cursor === undefined ? {} : { id: { lt: BigInt(parse(sequence, cursor)) } }) },
        orderBy: { id: 'desc' }, take: pageSize + 1,
      });
      const items = records.slice(0, pageSize).map(presentMessage);
      return { items, nextCursor: records.length > pageSize ? items[pageSize - 1]!.id : null };
    }

    @Post('inquiries/:id/messages')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(send) })
    @ApiOkResponse({ schema: schema(message) })
    reply(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const input = parse(send, body);
      const inquiryId = parse(uuid, id);
      return write(req, async (tx, actor) => {
        const authorId = actor.user.id;
        await member(tx, inquiryId, authorId);
        const key = { inquiryId, authorId, requestKey: input.requestKey };
        const existing = await tx.inquiryMessage.findUnique({ where: { inquiryId_authorId_requestKey: key } });
        if (existing) {
          if (existing.body !== input.message) reusedKey();
          return presentMessage(existing);
        }
        if (input.draft) await consumeDraft(tx, authorId, input.draft, 'message');
        return presentMessage(await tx.inquiryMessage.create({ data: { ...key, body: input.message } }));
      });
    }
  }

  return InquiriesController;
}
