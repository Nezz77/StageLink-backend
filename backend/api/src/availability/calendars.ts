import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Prisma, type AvailabilityCalendar, type AvailabilityBlock } from '../../../generated/prisma/client.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { dayHours } from '../profiles/schemas.js';

const uuid = z.string().uuid();
const revision = z.number().int().min(0).max(2_147_483_647);
const hours = z.array(dayHours).length(7).refine(days => new Set(days.map(day => day.day)).size === 7);
const zone = z.string().min(1).max(100).refine(value => {
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
});
const timestamp = z.iso.datetime({ offset: true });
const rangeFields = { startsAt: timestamp, endsAt: timestamp };
const maxRange = 366 * 86400000;
const validRange = ({ startsAt, endsAt }: { startsAt: string; endsAt: string }) => {
  const duration = Date.parse(endsAt) - Date.parse(startsAt);
  return duration > 0 && duration <= maxRange;
};
const range = z.object(rangeFields).strict().refine(validRange);
const block = z.object({ id: uuid, ...rangeFields });
const ownerBlock = block.extend({ reason: z.string() });
const calendar = z.object({ configured: z.boolean(), timezone: zone, hours: z.array(dayHours) });
const publicCalendar = calendar.extend({ blocks: z.array(block.omit({ id: true })) });
const privateCalendar = calendar.extend({ revision, blocks: z.array(ownerBlock) });
const setHours = z.object({ revision, timezone: zone, hours }).strict();
const setBlock = z.object({ revision, ...rangeFields, reason: z.string().trim().max(500) }).strict().refine(validRange);
const removeBlock = z.object({ revision }).strict();
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;
const blockLimit = 250;

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const result = type.safeParse(value);
  if (!result.success) throw new PublicError(400, 'INVALID_AVAILABILITY', 'Check the calendar, timezone, revision, and date range.');
  return result.data;
}

function settings(record: AvailabilityCalendar | null) {
  return { configured: record !== null, timezone: record?.timezone ?? 'Asia/Colombo', hours: record ? hours.parse(record.hours) : [] };
}

function present(block: AvailabilityBlock) {
  return { id: block.id, startsAt: block.startsAt.toISOString(), endsAt: block.endsAt.toISOString() };
}

export function makeAvailabilityControllers(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function write<T>(req: Request, work: (tx: Prisma.TransactionClient, ownerId: string) => Promise<T>) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, actor);
      profiles.providerRole(current);
      return work(tx, current.user.id);
    });
  }

  async function requireRevision(tx: Prisma.TransactionClient, ownerId: string, expected: number) {
    const record = await tx.availabilityCalendar.findUnique({ where: { ownerId } });
    if ((record?.revision ?? 0) !== expected) {
      throw new PublicError(409, 'REVISION_CONFLICT', 'Reload the calendar before changing it.');
    }
    return record;
  }

  async function ownerView(tx: Prisma.TransactionClient, ownerId: string) {
    const record = await tx.availabilityCalendar.findUnique({
      where: { ownerId }, include: { blocks: { orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] } },
    });
    return { ...settings(record), revision: record?.revision ?? 0,
      blocks: record?.blocks.map(block => ({ ...present(block), reason: block.reason })) ?? [] };
  }

  @ApiTags('Provider availability')
  @ApiBearerAuth()
  @Controller('me/availability')
  class AvailabilityController {
    @Get()
    @ApiOkResponse({ schema: schema(privateCalendar) })
    async get(@Req() req: Request) {
      const actor = await identity(req);
      profiles.providerRole(actor);
      return db.$transaction(tx => ownerView(tx, actor.user.id), { isolationLevel: 'RepeatableRead' });
    }

    @Put()
    @ApiBody({ schema: schema(setHours) })
    @ApiOkResponse({ schema: schema(privateCalendar) })
    update(@Req() req: Request, @Body() body: unknown) {
      const { revision, ...details } = parse(setHours, body);
      return write(req, async (tx, ownerId) => {
        const record = await requireRevision(tx, ownerId, revision);
        if (record) await tx.availabilityCalendar.update({ where: { ownerId }, data: { ...details, revision: { increment: 1 } } });
        else await tx.availabilityCalendar.create({ data: { ...details, ownerId } });
        return ownerView(tx, ownerId);
      });
    }

    @Post('blocks')
    @HttpCode(200)
    @ApiBody({ schema: schema(setBlock) })
    @ApiOkResponse({ schema: schema(privateCalendar) })
    addBlock(@Req() req: Request, @Body() body: unknown) {
      const input = parse(setBlock, body);
      const startsAt = new Date(input.startsAt), endsAt = new Date(input.endsAt);
      return write(req, async (tx, ownerId) => {
        if (!await requireRevision(tx, ownerId, input.revision)) {
          throw new PublicError(409, 'CALENDAR_REQUIRED', 'Set up regular hours before adding blackout dates.');
        }
        if (await tx.availabilityBlock.count({ where: { ownerId } }) >= blockLimit) {
          throw new PublicError(409, 'BLACKOUT_LIMIT', 'Remove an old blackout before adding another.');
        }
        if (await tx.availabilityBlock.findFirst({ where: { ownerId, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } } })) {
          throw new PublicError(409, 'BLACKOUT_OVERLAP', 'This period overlaps an existing blackout.');
        }
        await tx.availabilityBlock.create({ data: { ownerId, startsAt, endsAt, reason: input.reason } });
        await tx.availabilityCalendar.update({ where: { ownerId }, data: { revision: { increment: 1 } } });
        return ownerView(tx, ownerId);
      });
    }

    @Delete('blocks/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(removeBlock) })
    @ApiOkResponse({ schema: schema(privateCalendar) })
    removeBlock(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const blockId = parse(uuid, id);
      const { revision } = parse(removeBlock, body);
      return write(req, async (tx, ownerId) => {
        await requireRevision(tx, ownerId, revision);
        const result = await tx.availabilityBlock.deleteMany({ where: { id: blockId, ownerId } });
        if (result.count === 0) throw new PublicError(404, 'BLACKOUT_NOT_FOUND', 'This blackout is unavailable.');
        await tx.availabilityCalendar.update({ where: { ownerId }, data: { revision: { increment: 1 } } });
        return ownerView(tx, ownerId);
      });
    }
  }

  @ApiTags('Provider availability')
  @Controller('providers')
  class PublicAvailabilityController {
    @Get(':id/availability')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiQuery({ name: 'startsAt', type: String })
    @ApiQuery({ name: 'endsAt', type: String })
    @ApiOkResponse({ schema: schema(publicCalendar) })
    get(@Param('id') id: string, @Query() raw: unknown) {
      const ownerId = parse(uuid, id);
      const window = parse(range, raw);
      return db.$transaction(async tx => {
        const provider = await tx.providerProfile.findFirst({ where: {
          userId: ownerId, kind: { in: ['artist', 'renter'] }, approvedRevision: { not: null }, approvedSnapshot: { not: Prisma.DbNull },
          user: { disabledAt: null, emailVerifiedAt: { not: null } },
          OR: [{ kind: 'artist', user: { roles: { has: 'artist' } } }, { kind: 'renter', user: { roles: { has: 'renter' } } }],
        } });
        if (!provider) throw new PublicError(404, 'PROVIDER_NOT_FOUND', 'This provider is unavailable.');
        const record = await tx.availabilityCalendar.findUnique({
          where: { ownerId }, include: { blocks: {
            where: { startsAt: { lt: new Date(window.endsAt) }, endsAt: { gt: new Date(window.startsAt) } },
            orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
          } },
        });
        return { ...settings(record), blocks: record?.blocks.map(({ startsAt, endsAt }) => ({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() })) ?? [] };
      }, { isolationLevel: 'RepeatableRead' });
    }
  }

  return [AvailabilityController, PublicAvailabilityController];
}
