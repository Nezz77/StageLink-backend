import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { BookingSmsReminder, Prisma, SmsReminderCancellation } from '../../../generated/prisma/client.js';
import { smsDeliveryStatus } from '../../../shared/sms.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';
const timestamp = z.iso.datetime();
const count = z.number().int().nonnegative();
const offset = z.enum(['2', '24']).transform(Number);
const cancelInput = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
const cancellationSchema = z.object({ actorId: uuid, reason: z.string(), createdAt: timestamp });
const reminderSchema = z.object({
    id: uuid, bookingId: uuid, recipientId: uuid,
    offsetHours: z.union([z.literal(2), z.literal(24)]), startsAt: timestamp, dueAt: timestamp,
    status: smsDeliveryStatus, sendingAt: timestamp.nullable(), checkedAt: timestamp.nullable(),
    lastCode: z.string().nullable(), canCancel: z.boolean(), cancellation: cancellationSchema.nullable(),
});
const countsSchema = z.object({ queued: count, sending: count, accepted: count, delivered: count, failed: count, unknown: count, cancelled: count });
const pageSchema = z.object({ items: z.array(reminderSchema), nextCursor: uuid.nullable(), counts: countsSchema, enabled: z.boolean(), hourlyLimit: z.number().int().positive() });
type Row = BookingSmsReminder & {
    cancellation: SmsReminderCancellation | null;
};
const include = { cancellation: true } as const;
function present(row: Row) {
    const { id, bookingId, recipientId, offsetHours, startsAt, dueAt, status, sendingAt, checkedAt, lastCode, cancellation } = row;
    return { id, bookingId, recipientId, offsetHours, startsAt: startsAt.toISOString(), dueAt: dueAt.toISOString(), status,
        sendingAt: sendingAt?.toISOString() ?? null, checkedAt: checkedAt?.toISOString() ?? null,
        lastCode, canCancel: status === 'queued', cancellation: cancellation ? {
            actorId: cancellation.actorId, reason: cancellation.reason, createdAt: cancellation.createdAt.toISOString(),
        } : null };
}
function missing(): never { throw new PublicError(404, 'SMS_REMINDER_NOT_FOUND', 'This SMS reminder is unavailable.'); }
export function makeSmsRemindersController(auth: AuthService) {
    const db = auth.deps.db, profiles = new ProfileService(auth);
    async function admin(req: Request) {
        const actor = await auth.authenticate(req.get('Authorization'));
        if (actor.session.activeRole !== 'admin')
            throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
        profiles.verified(actor);
        return actor;
    }
    @ApiTags('Booking SMS operations')
    @ApiBearerAuth()
    @Controller('admin/sms-reminders')
    class SmsRemindersController {
        @Get()
        @ApiQuery({ name: 'cursor', type: String, required: false })
        @ApiQuery({ name: 'status', enum: smsDeliveryStatus.options, required: false })
        @ApiQuery({ name: 'offsetHours', enum: ['2', '24'], required: false })
        @ApiQuery({ name: 'bookingId', format: 'uuid', required: false })
        @ApiOkResponse({ schema: schema(pageSchema) })
        async list(
        @Req()
        req: Request,
        @Query('cursor')
        rawCursor?: string,
        @Query('status')
        rawStatus?: string,
        @Query('offsetHours')
        rawOffset?: string,
        @Query('bookingId')
        rawBooking?: string) {
            await admin(req);
            const cursor = rawCursor === undefined ? undefined : parse(uuid, rawCursor);
            const filter: Prisma.BookingSmsReminderWhereInput = {
                ...(rawOffset === undefined ? {} : { offsetHours: parse(offset, rawOffset) }),
                ...(rawBooking === undefined ? {} : { bookingId: parse(uuid, rawBooking) }),
            };
            const byStatus = rawStatus === undefined ? {} : { status: parse(smsDeliveryStatus, rawStatus) };
            return db.$transaction(async (tx) => {
                const [rows, groups] = await Promise.all([
                    tx.bookingSmsReminder.findMany({ where: { ...filter, ...byStatus, ...(cursor ? { id: { gt: cursor } } : {}) }, include, take: 31, orderBy: { id: 'asc' } }),
                    tx.bookingSmsReminder.groupBy({ by: ['status'], where: filter, _count: true }),
                ]);
                const counts = { queued: 0, sending: 0, accepted: 0, delivered: 0, failed: 0, unknown: 0, cancelled: 0 };
                for (const group of groups)
                    counts[group.status] = group._count;
                const items = rows.slice(0, 30).map(present);
                return { items, counts, nextCursor: rows.length > 30 ? items[29]!.id : null,
                    enabled: auth.config.BOOKING_SMS_REMINDERS === 'true', hourlyLimit: auth.config.SMS_HOURLY_LIMIT };
            }, { isolationLevel: 'RepeatableRead' });
        }
        @Get(':id')
        @ApiParam({ name: 'id', format: 'uuid' })
        @ApiOkResponse({ schema: schema(reminderSchema) })
        async detail(
        @Req()
        req: Request,
        @Param('id')
        raw: string) {
            await admin(req);
            const row = await db.bookingSmsReminder.findUnique({ where: { id: parse(uuid, raw) }, include });
            if (!row)
                missing();
            return present(row);
        }
        @Post(':id/cancel')
        @HttpCode(200)
        @ApiParam({ name: 'id', format: 'uuid' })
        @ApiBody({ schema: schema(cancelInput) })
        @ApiOkResponse({ schema: schema(reminderSchema) })
        async cancel(
        @Req()
        req: Request,
        @Param('id')
        rawId: string,
        @Body()
        raw: unknown) {
            if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
                throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
            }
            const signedIn = await admin(req);
            profiles.checkCsrf(signedIn, req.get('X-CSRF-Token'));
            const id = parse(uuid, rawId), { reason } = parse(cancelInput, raw);
            return db.$transaction(async (tx) => {
                const actor = await profiles.actor(tx, signedIn, undefined, true);
                profiles.verified(actor);
                // The sender also locks this row before claiming. Exactly one action can win.
                await tx.$queryRaw `SELECT id FROM booking_sms_reminders WHERE id=${id}::uuid FOR UPDATE`;
                const row = await tx.bookingSmsReminder.findUnique({ where: { id }, include });
                if (!row)
                    missing();
                if (row.status === 'cancelled' && row.cancellation?.actorId === actor.user.id && row.cancellation.reason === reason)
                    return present(row);
                if (row.status !== 'queued')
                    throw new PublicError(409, 'SMS_REMINDER_ACTION_UNAVAILABLE', 'Only an unsent queued SMS reminder can be cancelled.');
                await tx.smsReminderCancellation.create({ data: { reminderId: id, actorId: actor.user.id, reason } });
                return present(await tx.bookingSmsReminder.update({ where: { id }, data: { status: 'cancelled', lastCode: 'ADMIN_CANCELLED' }, include }));
            });
        }
    }
    return SmsRemindersController;
}
