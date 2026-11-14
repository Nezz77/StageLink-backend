import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { BookingReminder, Prisma } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';

const status = z.enum(['queued', 'sending', 'accepted', 'failed', 'unknown', 'cancelled']);
const timestamp = z.iso.datetime();
const nonnegative = z.number().int().nonnegative();
const action = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
const offset = z.enum(['2', '24']).transform(Number);
const reminder = z.object({
  id: uuid, bookingId: uuid, recipientId: uuid, offsetHours: z.union([z.literal(2), z.literal(24)]),
  startsAt: timestamp, dueAt: timestamp, status, attempts: nonnegative, acceptedAt: timestamp.nullable(), lastCode: z.string().nullable(),
});
const page = z.object({
  items: z.array(reminder), nextCursor: uuid.nullable(),
  counts: z.object({ queued: nonnegative, sending: nonnegative, accepted: nonnegative, failed: nonnegative, unknown: nonnegative, cancelled: nonnegative }),
  enabled: z.boolean(),
});

function present(row: BookingReminder) {
  const { id, bookingId, recipientId, offsetHours, startsAt, dueAt, status, attempts, acceptedAt, lastCode } = row;
  return { id, bookingId, recipientId, offsetHours, startsAt: startsAt.toISOString(), dueAt: dueAt.toISOString(),
    status, attempts, acceptedAt: acceptedAt?.toISOString() ?? null, lastCode };
}

function missing(): never {
  throw new PublicError(404, 'REMINDER_NOT_FOUND', 'This reminder is unavailable.');
}

export function makeRemindersController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function admin(req: Request) {
    const actor = await identity(req);
    if (actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    profiles.verified(actor);
    return actor;
  }

  async function change(req: Request, rawId: string, input: z.infer<typeof action>, command: 'cancel' | 'retry') {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await admin(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    const id = parse(uuid, rawId);
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, actor, undefined, true);
      profiles.verified(current);
      await tx.$queryRaw`SELECT id FROM booking_reminders WHERE id=${id}::uuid FOR UPDATE`;
      const row = await tx.bookingReminder.findUnique({ where: { id } });
      if (!row) missing();
      const target = command === 'cancel' ? 'cancelled' : 'queued';
      if (row.status === target) return present(row);
      if (command === 'retry' ? row.status !== 'failed' || row.attempts >= 3 : row.status !== 'queued' && row.status !== 'failed') {
        throw new PublicError(409, 'REMINDER_ACTION_UNAVAILABLE', 'This reminder is unavailable for the selected action.');
      }
      await tx.reminderAdminAction.create({ data: { reminderId: id, actorId: current.user.id, action: command, reason: input.reason } });
      return present(await tx.bookingReminder.update({
        where: { id }, data: { status: target, lastCode: command === 'cancel' ? 'ADMIN_CANCELLED' : null },
      }));
    });
  }

  @ApiTags('Booking reminders')
  @ApiBearerAuth()
  @Controller('admin/reminders')
  class ReminderController {
    @Get()
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiQuery({ name: 'status', enum: status.options, required: false })
    @ApiQuery({ name: 'offsetHours', enum: ['2', '24'], required: false })
    @ApiOkResponse({ schema: schema(page) })
    async list(
      @Req() req: Request, @Query('cursor') rawCursor?: string, @Query('status') rawStatus?: string, @Query('offsetHours') rawOffset?: string,
    ) {
      await admin(req);
      const cursor = rawCursor === undefined ? undefined : parse(uuid, rawCursor);
      const filter: Prisma.BookingReminderWhereInput = rawOffset === undefined ? {} : { offsetHours: parse(offset, rawOffset) };
      const byStatus = rawStatus === undefined ? {} : { status: parse(status, rawStatus) };
      return db.$transaction(async tx => {
        const [rows, groups] = await Promise.all([
          tx.bookingReminder.findMany({
            where: { ...filter, ...byStatus, ...(cursor ? { id: { gt: cursor } } : {}) },
            take: 31, orderBy: { id: 'asc' },
          }),
          tx.bookingReminder.groupBy({ by: ['status'], where: filter, _count: true }),
        ]);
        const counts = { queued: 0, sending: 0, accepted: 0, failed: 0, unknown: 0, cancelled: 0 };
        for (const row of groups) counts[row.status] = row._count;
        const items = rows.slice(0, 30).map(present);
        return { items, nextCursor: rows.length > 30 ? items[29]!.id : null, counts, enabled: auth.config.BOOKING_EMAIL_REMINDERS === 'true' };
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Get(':id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(reminder) })
    async detail(@Req() req: Request, @Param('id') id: string) {
      await admin(req);
      const row = await db.bookingReminder.findUnique({ where: { id: parse(uuid, id) } });
      if (!row) missing();
      return present(row);
    }

    @Post(':id/retry')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(action) })
    @ApiOkResponse({ schema: schema(reminder) })
    retry(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      return change(req, id, parse(action, raw), 'retry');
    }

    @Post(':id/cancel')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(action) })
    @ApiOkResponse({ schema: schema(reminder) })
    cancel(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      return change(req, id, parse(action, raw), 'cancel');
    }
  }
  return ReminderController;
}
