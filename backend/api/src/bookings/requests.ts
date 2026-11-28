import { databaseNow } from '../../../shared/database-clock.js';
import { notifyUsers } from '../../../shared/notifications.js';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { Booking, Prisma } from '../../../generated/prisma/client.js';
import type { AuthService, Identity } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { checkCalendar, checkCapacity } from './reservations.js';
import { bookingSelection, publishedTarget, selection, snapshot } from './selection.js';

const uuid = z.string().uuid();
const timestamp = z.iso.datetime({ offset: true });
const request = selection.extend({
  requestKey: uuid, startsAt: timestamp, endsAt: timestamp, inquiryId: uuid.optional(),
});
const states = z.enum(['held', 'expired', 'accepted', 'rejected', 'agreed', 'cancelled']);
const booking = z.object({
  id: uuid, customerId: uuid, providerId: uuid, inquiryId: uuid.nullable(),
  targetKind: z.enum(['gig', 'rental']), targetId: uuid, targetVersion: z.number().int(),
  startsAt: timestamp, endsAt: timestamp, holdExpiresAt: timestamp, createdAt: timestamp,
  state: states, snapshot, revision: z.number().int(),
  providerDecision: z.enum(['accepted', 'rejected']).nullable(),
  cancelledAt: timestamp.nullable(), cancellationReason: z.string().nullable(),
  decidedAt: timestamp.nullable(), agreedAt: timestamp.nullable(), decisionReason: z.string().nullable(),
});
const page = z.object({ items: z.array(booking), nextCursor: uuid.nullable() });
const availabilityQuery = selection.omit({ targetId: true }).extend({
  startsAt: timestamp, endsAt: timestamp,
  targetVersion: z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(selection.shape.targetVersion),
  quantity: z.string().regex(/^[1-9][0-9]{0,5}$/).transform(Number).pipe(selection.shape.quantity),
  guestCount: z.string().regex(/^[1-9][0-9]{0,5}$/).transform(Number).pipe(selection.shape.guestCount.unwrap()).optional(),
  addonIds: z.string().max(74).optional().transform(value => value ? value.split(',') : []).pipe(selection.shape.addonIds.removeDefault()),
}).strict();
const availability = z.object({ available: z.boolean() });
const decide = z.object({
  revision: z.number().int().positive().max(2_147_483_647),
  decision: z.enum(['accepted', 'rejected']),
  reason: z.string().trim().max(500).default(''),
}).strict();
const listQuery = z.object({
  cursor: uuid.optional(), status: states.optional(), from: timestamp.optional(), to: timestamp.optional(),
}).strict().refine(value => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to));
const calendarQuery = z.object({
  cursor: uuid.optional(), from: timestamp, to: timestamp,
}).strict().refine(value => Date.parse(value.to) > Date.parse(value.from) && Date.parse(value.to) - Date.parse(value.from) <= 366 * 86400000);
const renew = z.object({ expectedHoldExpiresAt: timestamp }).strict();
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0', io: 'input' }) as SchemaObject;
const pageSize = 30;
const holdMs = 15 * 60000;
const negotiationHoldMs = 24 * 3600000;

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const result = type.safeParse(value);
  if (!result.success) throw new PublicError(400, 'INVALID_BOOKING_REQUEST', 'Check the booking selection, dates, or cursor.');
  return result.data;
}

function present(record: Booking, now: Date) {
  const { requestKey: _key, requestDigest: _digest, ...fields } = record;
  return {
    ...fields, snapshot: snapshot.parse(record.snapshot),
    state: record.cancelledAt ? 'cancelled' : record.agreedAt ? 'agreed' : record.providerDecision === 'rejected' ? 'rejected'
      : record.holdExpiresAt <= now ? 'expired' : record.providerDecision ?? 'held',
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    decidedAt: record.decidedAt?.toISOString() ?? null, agreedAt: record.agreedAt?.toISOString() ?? null,
    startsAt: record.startsAt.toISOString(), endsAt: record.endsAt.toISOString(),
    holdExpiresAt: record.holdExpiresAt.toISOString(), createdAt: record.createdAt.toISOString(),
  };
}

function getWindow(startsAt: Date, endsAt: Date, now: Date) {
  const duration = endsAt.getTime() - startsAt.getTime();
  if (startsAt <= now || duration <= 0 || duration > 31 * 86400000 ||
    startsAt.getTime() % 60000 !== 0 || endsAt.getTime() % 60000 !== 0) {
    throw new PublicError(400, 'INVALID_BOOKING_WINDOW', 'Choose a future booking of up to 31 days with minute-aligned times.');
  }
  return { startsAt, endsAt, duration };
}

function expiry(startsAt: Date, now: Date) {
  return new Date(Math.min(startsAt.getTime(), now.getTime() + holdMs));
}

export async function member(tx: Prisma.TransactionClient, id: string, userId: string) {
  const record = await tx.booking.findFirst({ where: { id, OR: [{ customerId: userId }, { providerId: userId }] } });
  if (!record) throw new PublicError(404, 'BOOKING_NOT_FOUND', 'This booking is unavailable.');
  return record;
}

export async function recheckReservation(tx: Prisma.TransactionClient, record: Booking, now: Date) {
  const window = getWindow(record.startsAt, record.endsAt, now);
  const original = snapshot.parse(record.snapshot);
  const selected = {
    targetKind: record.targetKind === 'gig' ? 'gig' as const : 'rental' as const,
    targetId: record.targetId, targetVersion: record.targetVersion, quantity: original.quantity,
    rateUnit: original.rateUnit ?? undefined, guestCount: original.guestCount ?? undefined,
    packageId: original.package?.id, addonIds: original.package?.addons.map(item => item.id) ?? [],
  };
  const quoted = await bookingSelection(tx, selected, window.duration);
  await checkCalendar(tx, record.providerId, window, selected.targetKind === 'gig');
  await checkCapacity(tx, quoted.lines, window, now, record.id);
}

async function bookingPage(db: Prisma.TransactionClient, where: Prisma.BookingWhereInput, cursor: string | undefined, now: Date) {
  const records = await db.booking.findMany({
    where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: 'asc' }, take: pageSize + 1,
  });
  const items = records.slice(0, pageSize).map(record => present(record, now));
  return { items, nextCursor: records.length > pageSize ? items[pageSize - 1]!.id : null };
}

export function makeBookingRequestsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function write<T>(req: Request, provider: (actor: Identity) => Promise<string>,
    work: (tx: Prisma.TransactionClient, current: Identity, providerId: string) => Promise<T>, role: 'customer' | 'provider' = 'customer') {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    const providerId = await provider(actor);
    return db.$transaction(async tx => {
      for (const id of [...new Set([actor.user.id, providerId])].sort()) {
        await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${id}::uuid FOR UPDATE`;
      }
      const current = await profiles.actor(tx, actor);
      if (role === 'customer' && !current.user.roles.includes('customer')) throw new PublicError(403, 'ROLE_FORBIDDEN', 'A customer membership is required.');
      profiles.verified(current);
      return work(tx, current, providerId);
    });
  }

  @ApiTags('Booking requests')
  @ApiBearerAuth()
  @Controller()
  class BookingRequestsController {
    @Post('bookings')
    @HttpCode(200)
    @ApiBody({ schema: schema(request) })
    @ApiOkResponse({ schema: schema(booking) })
    submit(@Req() req: Request, @Body() body: unknown) {
      const input = parse(request, body);
      const { requestKey, inquiryId, ...selected } = input;
      const startsAt = new Date(input.startsAt), endsAt = new Date(input.endsAt);
      if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
        throw new PublicError(400, 'INVALID_BOOKING_WINDOW', 'Choose valid booking dates.');
      }
      const digest = createHash('sha256').update(JSON.stringify({
        ...selected, addonIds: [...selected.addonIds].sort(), startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(), inquiryId: inquiryId ?? null,
      })).digest('hex');
      return write(req, async actor => {
        const existing = await db.booking.findUnique({ where: { customerId_requestKey: { customerId: actor.user.id, requestKey } } });
        return existing?.providerId ?? publishedTarget(db, input);
      }, async (tx, current, providerId) => {
        const customerId = current.user.id;
        const existing = await tx.booking.findUnique({ where: { customerId_requestKey: { customerId, requestKey } } });
        const now = await databaseNow(tx);
        if (existing) {
          if (existing.requestDigest !== digest) throw new PublicError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different booking.');
          return present(existing, now);
        }
        if (providerId === customerId) throw new PublicError(409, 'SELF_BOOKING', 'Choose a listing from another provider.');
        if (await publishedTarget(tx, input) !== providerId) throw new PublicError(409, 'LISTING_VERSION_CHANGED', 'Reload the listing before booking.');
        if (inquiryId) {
          const inquiry = await tx.inquiry.findFirst({ where: { id: inquiryId, customerId, providerId, targetKind: input.targetKind, targetId: input.targetId } });
          if (!inquiry) throw new PublicError(404, 'INQUIRY_NOT_FOUND', 'This inquiry is unavailable.');
          if (await tx.booking.findUnique({ where: { inquiryId } })) throw new PublicError(409, 'INQUIRY_ALREADY_BOOKED', 'This inquiry already has a booking.');
        }
        const window = getWindow(startsAt, endsAt, now);
        const quoted = await bookingSelection(tx, selected, window.duration);
        await checkCalendar(tx, providerId, window, input.targetKind === 'gig');
        await checkCapacity(tx, quoted.lines, window, now);
        const record = await tx.booking.create({
          data: {
            customerId, providerId, inquiryId, requestKey, requestDigest: digest, targetKind: input.targetKind,
            targetId: input.targetId, targetVersion: input.targetVersion, startsAt, endsAt, holdExpiresAt: expiry(startsAt, now),
            snapshot: quoted.snapshot,
            lines: { create: quoted.lines.map(({ capacity: _capacity, ...line }) => line) },
          },
        });
        return present(record, now);
      });
    }

    @Get('listings/:id/availability')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiQuery({ name: 'targetKind', enum: ['gig', 'rental'] })
    @ApiQuery({ name: 'targetVersion', type: Number })
    @ApiQuery({ name: 'quantity', type: Number })
    @ApiQuery({ name: 'startsAt', type: String })
    @ApiQuery({ name: 'endsAt', type: String })
    @ApiQuery({ name: 'packageId', required: false, enum: ['standard', 'deluxe', 'vip'] })
    @ApiQuery({ name: 'addonIds', required: false, type: String, description: 'Comma-separated add-on IDs.' })
    @ApiQuery({ name: 'rateUnit', required: false, enum: ['hour', 'day', 'week'] })
    @ApiQuery({ name: 'guestCount', required: false, type: Number })
    @ApiOkResponse({ schema: schema(availability) })
    async availability(@Param('id') id: string, @Query() raw: unknown) {
      const { startsAt, endsAt, ...selected } = parse(availabilityQuery, raw);
      const input = { ...selected, targetId: parse(uuid, id) };
      return db.$transaction(async tx => {
        const now = await databaseNow(tx);
        const window = getWindow(new Date(startsAt), new Date(endsAt), now);
        const providerId = await publishedTarget(tx, input);
        const quoted = await bookingSelection(tx, input, window.duration);
        try {
          await checkCalendar(tx, providerId, window, input.targetKind === 'gig');
          await checkCapacity(tx, quoted.lines, window, now);
          return { available: true };
        } catch (error) {
          if (error instanceof PublicError && error.code === 'RESERVATION_UNAVAILABLE') return { available: false };
          throw error;
        }
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Get('me/bookings')
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiQuery({ name: 'status', required: false, enum: states.options })
    @ApiQuery({ name: 'from', required: false, type: String })
    @ApiQuery({ name: 'to', required: false, type: String })
    @ApiOkResponse({ schema: schema(page) })
    async list(@Req() req: Request, @Query() raw: unknown) {
      const { user } = await identity(req);
      const query = parse(listQuery, raw);
      const now = await databaseNow(db);
      const stateFilters = {
        held: { providerDecision: null, holdExpiresAt: { gt: now } },
        agreed: { agreedAt: { not: null } },
        accepted: { agreedAt: null, providerDecision: 'accepted', holdExpiresAt: { gt: now } },
        rejected: { providerDecision: 'rejected' },
        expired: { agreedAt: null, AND: [{ OR: [{ providerDecision: null }, { providerDecision: 'accepted' }] }, { holdExpiresAt: { lte: now } }] },
      } satisfies Record<Exclude<z.infer<typeof states>, 'cancelled'>, Prisma.BookingWhereInput>;
      const state = query.status === 'cancelled' ? { cancelledAt: { not: null } }
        : query.status ? { cancelledAt: null, ...stateFilters[query.status] } : {};
      return bookingPage(db, {
        OR: [{ customerId: user.id }, { providerId: user.id }], ...state,
        ...(query.from ? { endsAt: { gt: new Date(query.from) } } : {}),
        ...(query.to ? { startsAt: { lt: new Date(query.to) } } : {}),
      }, query.cursor, now);
    }

    @Get('me/calendar')
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiQuery({ name: 'from', type: String })
    @ApiQuery({ name: 'to', type: String })
    @ApiOkResponse({ schema: schema(page) })
    async calendar(@Req() req: Request, @Query() raw: unknown) {
      const actor = await identity(req);
      profiles.providerRole(actor);
      const query = parse(calendarQuery, raw);
      const now = await databaseNow(db);
      return bookingPage(db, {
        providerId: actor.user.id, providerDecision: 'accepted', cancelledAt: null,
        OR: [{ agreedAt: { not: null } }, { holdExpiresAt: { gt: now } }],
        endsAt: { gt: new Date(query.from) }, startsAt: { lt: new Date(query.to) },
      }, query.cursor, now);
    }

    @Post('bookings/:id/provider-decisions')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(decide) })
    @ApiOkResponse({ schema: schema(booking) })
    decide(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const bookingId = parse(uuid, id);
      const input = parse(decide, raw);
      return write(req, async actor => (await member(db, bookingId, actor.user.id)).providerId, async (tx, actor) => {
        const record = await member(tx, bookingId, actor.user.id);
        if (record.providerId !== actor.user.id) throw new PublicError(403, 'ROLE_FORBIDDEN', 'Only the assigned provider can decide this request.');
        profiles.providerRole(actor, record.targetKind === 'gig' ? 'artist' : 'renter');
        if (record.cancelledAt || record.revision !== input.revision || record.providerDecision) {
          throw new PublicError(409, 'BOOKING_CHANGED', 'Reload the booking before deciding this request.');
        }
        const now = await databaseNow(tx);
        if (input.decision === 'accepted') {
          if (record.holdExpiresAt <= now) throw new PublicError(409, 'HOLD_EXPIRED', 'The customer must renew the hold before acceptance.');
          await recheckReservation(tx, record, now);
        }
        const updated = await tx.booking.update({
          where: { id: record.id },
          data: {
            providerDecision: input.decision, decidedAt: now, decisionReason: input.reason,
            revision: { increment: 1 },
            ...(input.decision === 'accepted' ? { holdExpiresAt: new Date(Math.min(record.startsAt.getTime(), now.getTime() + negotiationHoldMs)) } : {}),
          },
        });
        await notifyUsers(tx, [record.customerId], 'provider_decision', record.id, record.id);
        return present(updated, now);
      }, 'provider');
    }

    @Get('bookings/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(booking) })
    async get(@Req() req: Request, @Param('id') id: string) {
      const { user } = await identity(req);
      const record = await member(db, parse(uuid, id), user.id);
      return present(record, await databaseNow(db));
    }

    @Post('bookings/:id/reservation-renewals')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(renew) })
    @ApiOkResponse({ schema: schema(booking) })
    renew(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const bookingId = parse(uuid, id);
      const { expectedHoldExpiresAt } = parse(renew, body);
      return write(req, async actor => (await member(db, bookingId, actor.user.id)).providerId, async (tx, actor, providerId) => {
        const record = await member(tx, bookingId, actor.user.id);
        if (record.customerId !== actor.user.id) throw new PublicError(403, 'ROLE_FORBIDDEN', 'Only the booking customer can renew a hold.');
        if (record.holdExpiresAt.getTime() !== Date.parse(expectedHoldExpiresAt)) {
          throw new PublicError(409, 'HOLD_CHANGED', 'Reload the booking before renewing its hold.');
        }
        const now = await databaseNow(tx);
        if (record.cancelledAt) throw new PublicError(409, 'BOOKING_CANCELLED', 'This booking is cancelled.');
        if (record.agreedAt) return present(record, now);
        if (record.providerDecision === 'rejected') throw new PublicError(409, 'BOOKING_REJECTED', 'This booking was rejected.');
        if (record.providerDecision === 'accepted' && record.holdExpiresAt > now) return present(record, now);
        await recheckReservation(tx, record, now);
        return present(await tx.booking.update({
          where: { id: record.id }, data: { holdExpiresAt: expiry(record.startsAt, now), revision: { increment: 1 } },
        }), now);
      });
    }
  }
  return BookingRequestsController;
}
