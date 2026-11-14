import { Body, Controller, Get, HttpCode, Param, Patch, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { notificationKind } from '../../../shared/notifications.js';
import type { Notification } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';

const sequence = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const empty = z.object({}).strict();
const timestamp = z.iso.datetime();
const notification = z.object({
  id: sequence, kind: notificationKind,
  sourceId: uuid, createdAt: timestamp, readAt: timestamp.nullable(),
});
const page = z.object({ items: z.array(notification), unread: z.number().int().nonnegative(), nextCursor: sequence.nullable() });
const preferences = z.object({ revision: z.number().int().nonnegative(), bookingReminderEmail: z.boolean() });
const change = preferences.extend({ revision: z.number().int().min(0).max(2_147_483_646) }).strict();
const defaults = { revision: 0, bookingReminderEmail: true };

function present(row: Notification) {
  return { id: String(row.id), kind: row.kind, sourceId: row.sourceId,
    createdAt: row.createdAt.toISOString(), readAt: row.readAt?.toISOString() ?? null };
}

export function makeNotificationsController(auth: AuthService) {
  const db = auth.deps.db;
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

  @ApiTags('Member notifications')
  @ApiBearerAuth()
  @Controller('me')
  class NotificationsController {
    @Get('notifications')
    @ApiQuery({ name: 'before', type: String, required: false })
    @ApiOkResponse({ schema: schema(page) })
    async list(@Req() req: Request, @Query('before') raw?: string) {
      const { user } = await identity(req);
      const before = raw === undefined ? undefined : BigInt(parse(sequence, raw));
      return db.$transaction(async tx => {
        const [rows, unread] = await Promise.all([
          tx.notification.findMany({
            where: { recipientId: user.id, ...(before ? { id: { lt: before } } : {}) },
            orderBy: { id: 'desc' }, take: 31,
          }),
          tx.notification.count({ where: { recipientId: user.id, readAt: null } }),
        ]);
        const items = rows.slice(0, 30).map(present);
        return { items, unread, nextCursor: rows.length > 30 ? items[29]!.id : null };
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Put('notifications/:id/read')
    @HttpCode(200)
    @ApiParam({ name: 'id', type: String })
    @ApiBody({ schema: schema(empty) })
    @ApiOkResponse({ schema: schema(notification) })
    async read(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      parse(empty, raw);
      const actor = await mutation(req);
      const id = BigInt(parse(sequence, rawId));
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, actor);
        const where = { id, recipientId: current.user.id };
        await tx.notification.updateMany({ where: { ...where, readAt: null }, data: { readAt: new Date() } });
        const row = await tx.notification.findFirst({ where });
        if (!row) throw new PublicError(404, 'NOTIFICATION_NOT_FOUND', 'This notification is unavailable.');
        return present(row);
      });
    }

    @Get('notification-preferences')
    @ApiOkResponse({ schema: schema(preferences) })
    async preferences(@Req() req: Request) {
      const { user } = await identity(req);
      return await db.notificationPreference.findUnique({
        where: { userId: user.id }, select: { revision: true, bookingReminderEmail: true },
      }) ?? defaults;
    }

    @Patch('notification-preferences')
    @ApiBody({ schema: schema(change) })
    @ApiOkResponse({ schema: schema(preferences) })
    async update(@Req() req: Request, @Body() raw: unknown) {
      const actor = await mutation(req);
      const input = parse(change, raw);
      return db.$transaction(async tx => {
        const { user } = await profiles.actor(tx, actor);
        const where = { userId: user.id };
        const select = { revision: true, bookingReminderEmail: true } as const;
        const current = await tx.notificationPreference.findUnique({ where, select }) ?? defaults;
        if (current.revision !== input.revision) {
          throw new PublicError(409, 'NOTIFICATION_PREFERENCES_CHANGED', 'Reload your notification preferences before saving.');
        }
        if (current.bookingReminderEmail === input.bookingReminderEmail) return current;
        const data = { revision: input.revision + 1, bookingReminderEmail: input.bookingReminderEmail };
        return tx.notificationPreference.upsert({ where, select, create: { ...where, ...data }, update: data });
      });
    }
  }
  return NotificationsController;
}
