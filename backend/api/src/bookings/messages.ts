import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Booking, Prisma } from '../../../generated/prisma/client.js';
import type { AuthService, Identity } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { consumeDraft, draftReference } from '../events/drafts.js';
import { member } from './requests.js';
import { lockBooking } from './lifecycle.js';

const uuid = z.string().uuid();
const sequence = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const messageText = z.string().trim().max(4000);
const send = z.object({
  requestKey: uuid, body: messageText, draft: draftReference.optional(),
  attachmentIds: z.array(uuid).max(4).optional(),
}).strict().refine(input => {
  const ids = input.attachmentIds ?? [];
  return (input.body.length > 0 || ids.length > 0) && new Set(ids.map(id => id.toLowerCase())).size === ids.length;
});
const read = z.object({ throughId: sequence }).strict();
const query = z.object({ before: sequence.optional(), after: sequence.optional() }).strict().refine(input => !input.before || !input.after);
const attachment = z.object({ id: uuid, filename: z.string(), mime: z.string(), bytes: z.number().int().positive() });
const message = z.object({
  id: sequence, authorId: uuid, body: messageText, createdAt: z.iso.datetime(), attachments: z.array(attachment),
});
const receipt = read.extend({ readerId: uuid });
const page = z.object({ items: z.array(message), nextCursor: sequence.nullable(), receipts: z.array(receipt) });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;
const pageSize = 40;
const includeAttachments = {
  attachments: { orderBy: { position: 'asc' }, select: {
    asset: { select: { id: true, filename: true, mime: true, bytes: true } },
  } },
} satisfies Prisma.BookingMessageInclude;
type MessageWithAttachments = Prisma.BookingMessageGetPayload<{ include: typeof includeAttachments }>;

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const parsed = type.safeParse(value);
  if (!parsed.success) throw new PublicError(400, 'INVALID_BOOKING_MESSAGE', 'Provide text or up to four distinct image attachments and check the cursor.');
  return parsed.data;
}

function present(record: MessageWithAttachments) {
  return {
    id: String(record.id), authorId: record.authorId, body: record.body,
    createdAt: record.createdAt.toISOString(), attachments: record.attachments.map(link => link.asset),
  };
}

export type BookingChatChange =
  | { bookingId: string; kind: 'message'; messageId: string }
  | { bookingId: string; kind: 'read'; readerId: string; throughId: string };

export function makeBookingChat(auth: AuthService, onChange: (change: BookingChatChange) => void) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);

  function write<T>(actor: Identity, bookingId: string, work: (tx: Prisma.TransactionClient, booking: Booking, userId: string) => Promise<T>) {
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, actor);
      const booking = await member(tx, bookingId, current.user.id);
      // Serialize message insertion across participants so a committed cursor cannot skip a late insert.
      await lockBooking(tx, bookingId);
      return work(tx, await member(tx, booking.id, current.user.id), current.user.id);
    });
  }

  async function history(actor: Identity, id: string, raw: unknown) {
    const { user } = actor;
    const bookingId = parse(uuid, id).toLowerCase();
    const { before, after } = parse(query, raw);
    return db.$transaction(async tx => {
      await member(tx, bookingId, user.id);
      const rows = await tx.bookingMessage.findMany({
        where: { bookingId, ...(before ? { id: { lt: BigInt(before) } } : after ? { id: { gt: BigInt(after) } } : {}) },
        include: includeAttachments, orderBy: { id: after ? 'asc' : 'desc' }, take: pageSize + 1,
      });
      const readRows = await tx.bookingMessageRead.findMany({ where: { bookingId } });
      const items = rows.slice(0, pageSize).map(present);
      return { items, nextCursor: rows.length > pageSize ? items[pageSize - 1]!.id : null,
        receipts: readRows.map(row => ({ readerId: row.readerId, throughId: String(row.throughId) })) };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async function sendMessage(actor: Identity, id: string, raw: unknown) {
    const bookingId = parse(uuid, id).toLowerCase();
    const input = parse(send, raw);
    const result = await write(actor, bookingId, async (tx, booking, authorId) => {
      const key = { bookingId, authorId, requestKey: input.requestKey };
      const ids = (input.attachmentIds ?? []).map(id => id.toLowerCase());
      const previous = await tx.bookingMessage.findUnique({
        where: { bookingId_authorId_requestKey: key }, include: includeAttachments,
      });
      if (previous) {
        if (previous.body !== input.body || previous.attachments.length !== ids.length ||
          previous.attachments.some((link, index) => link.asset.id !== ids[index])) {
          throw new PublicError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different message.');
        }
        return { item: present(previous), created: false };
      }
      if (booking.providerDecision === 'rejected') throw new PublicError(409, 'CONVERSATION_CLOSED', 'This booking conversation is closed.');
      for (const id of [...ids].sort()) {
        const eligible = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM assets
          WHERE id=${id}::uuid AND owner_id=${authorId}::uuid AND purpose='chat' AND status='ready'
            AND variants ? 'display'
          FOR UPDATE
        `;
        if (!eligible.length) throw new PublicError(404, 'ATTACHMENT_UNAVAILABLE', 'Choose a validated chat image from your uploads.');
      }
      if (input.draft) await consumeDraft(tx, authorId, input.draft, 'message');
      const item = present(await tx.bookingMessage.create({
        data: { ...key, body: input.body, attachments: { create: ids.map((assetId, position) => ({ assetId, position })) } },
        include: includeAttachments,
      }));
      return { item, created: true };
    });
    if (result.created) onChange({ bookingId, kind: 'message', messageId: result.item.id });
    return result.item;
  }

  async function markRead(actor: Identity, id: string, raw: unknown) {
    const bookingId = parse(uuid, id).toLowerCase();
    const throughId = BigInt(parse(read, raw).throughId);
    const result = await write(actor, bookingId, async (tx, _booking, readerId) => {
      const selected = await tx.bookingMessage.findFirst({ where: { id: throughId, bookingId }, select: { id: true } });
      if (!selected) throw new PublicError(404, 'MESSAGE_NOT_FOUND', 'This message is unavailable.');
      const where = { bookingId_readerId: { bookingId, readerId } };
      const previous = await tx.bookingMessageRead.findUnique({ where });
      if (previous && previous.throughId >= throughId) return { receipt: { readerId, throughId: String(previous.throughId) }, advanced: false };
      await tx.bookingMessageRead.upsert({ where, create: { bookingId, readerId, throughId }, update: { throughId } });
      return { receipt: { readerId, throughId: String(throughId) }, advanced: true };
    });
    if (result.advanced) onChange({ bookingId, kind: 'read', ...result.receipt });
    return result.receipt;
  }

  async function join(actor: Identity, bookingId: string) {
    const booking = await member(db, bookingId, actor.user.id);
    return booking.id;
  }

  return { history, sendMessage, markRead, join };
}

export type BookingChat = ReturnType<typeof makeBookingChat>;

export function makeBookingMessagesController(auth: AuthService, chat: BookingChat) {
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function mutation(req: Request) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return actor;
  }

  @ApiTags('Booking chat')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', format: 'uuid', description: 'Booking conversation ID.' })
  @Controller('conversations/:id')
  class BookingMessagesController {
    @Get('messages')
    @ApiQuery({ name: 'before', required: false, type: String })
    @ApiQuery({ name: 'after', required: false, type: String })
    @ApiOkResponse({ schema: schema(page) })
    async history(@Req() req: Request, @Param('id') id: string, @Query() raw: unknown) {
      return chat.history(await identity(req), id, raw);
    }

    @Post('messages')
    @HttpCode(200)
    @ApiBody({ schema: schema(send) })
    @ApiOkResponse({ schema: schema(message) })
    async send(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      return chat.sendMessage(await mutation(req), id, raw);
    }

    @Put('read')
    @ApiBody({ schema: schema(read) })
    @ApiOkResponse({ schema: schema(receipt) })
    async markRead(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      return chat.markRead(await mutation(req), id, raw);
    }
  }
  return BookingMessagesController;
}
