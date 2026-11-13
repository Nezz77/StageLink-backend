import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Prisma, type InventoryUnit } from '../../../generated/prisma/client.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { canMoveUnit } from './inventory-state.js';

const uuid = z.string().uuid();
const status = z.enum(['available', 'out', 'inspection', 'maintenance', 'quarantined', 'retired']);
const revision = z.number().int().min(1).max(2_147_483_647);
const serial = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,99}$/).toUpperCase();
const reason = z.string().trim().min(1).max(500);
const reference = z.string().trim().min(1).max(120);
const timestamp = z.iso.datetime({ offset: true });
const create = z.object({ listingId: uuid, serial }).strict();
const move = z.discriminatedUnion('status', [
  z.object({ revision, reason, status: z.literal('out'), custodyReference: reference, dueAt: timestamp }).strict(),
  z.object({ revision, reason, status: status.exclude(['out']) }).strict(),
]);
const unit = z.object({
  id: uuid, listingId: uuid, serial, revision, status, overdue: z.boolean(),
  custodyReference: reference.nullable(), dueAt: timestamp.nullable(), updatedAt: timestamp,
});
const movement = z.object({
  id: z.string(), unitId: uuid, revision, fromStatus: status.nullable(), toStatus: status,
  reason, custodyReference: reference.nullable(), dueAt: timestamp.nullable(), createdAt: timestamp,
});
const movementCursor = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const unitPage = z.object({ items: z.array(unit), nextCursor: uuid.nullable() });
const movementPage = z.object({ items: z.array(movement), nextCursor: z.string().nullable() });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;
const pageSize = 50;

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const result = type.safeParse(value);
  if (!result.success) throw new PublicError(400, 'INVALID_INVENTORY_INPUT', 'Check the serial, custody details, or page cursor.');
  return result.data;
}

function present(record: InventoryUnit, now: Date) {
  const { id, listingId, serial, revision, status, custodyReference, dueAt, updatedAt } = record;
  return {
    id, listingId, serial, revision, status, custodyReference, dueAt: dueAt?.toISOString() ?? null,
    overdue: status === 'out' && dueAt !== null && dueAt <= now, updatedAt: updatedAt.toISOString(),
  };
}

export function makeInventoryController(auth: AuthService) {
  const profiles = new ProfileService(auth);
  const db = auth.deps.db;

  async function actor(req: Request, mutating = false) {
    if (mutating && (req.get('Origin') !== auth.config.WEB_ORIGIN ||
      req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json'))) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const identity = await auth.authenticate(req.get('Authorization'));
    profiles.providerRole(identity, 'renter');
    if (mutating) profiles.checkCsrf(identity, req.get('X-CSRF-Token'));
    return identity;
  }

  @ApiTags('Equipment inventory')
  @ApiBearerAuth()
  @Controller('me')
  class InventoryController {
    @Get('inventory-units')
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiQuery({ name: 'listingId', required: false, type: String })
    @ApiOkResponse({ schema: schema(unitPage) })
    async list(@Req() req: Request, @Query('cursor') cursor?: string, @Query('listingId') listingId?: string) {
      const { user } = await actor(req);
      const records = await db.inventoryUnit.findMany({
        where: {
          ownerId: user.id,
          ...(cursor === undefined ? {} : { id: { gt: parse(uuid, cursor) } }),
          ...(listingId === undefined ? {} : { listingId: parse(uuid, listingId) }),
        },
        orderBy: { id: 'asc' }, take: pageSize + 1,
      });
      const now = new Date();
      const items = records.slice(0, pageSize).map(record => present(record, now));
      return { items, nextCursor: records.length > pageSize ? items[pageSize - 1]!.id : null };
    }

    @Post('inventory-units')
    @HttpCode(200)
    @ApiBody({ schema: schema(create) })
    @ApiOkResponse({ schema: schema(unit) })
    async register(@Req() req: Request, @Body() body: unknown) {
      const identity = await actor(req, true);
      const input = parse(create, body);
      try {
        return await db.$transaction(async tx => {
          const current = await profiles.actor(tx, identity);
          profiles.providerRole(current, 'renter');
          const listing = await tx.rentalListing.findFirst({
            where: { id: input.listingId, ownerId: current.user.id, kind: 'equipment', status: { not: 'archived' } },
          });
          if (!listing) throw new PublicError(404, 'EQUIPMENT_NOT_FOUND', 'This equipment listing is unavailable.');
          const record = await tx.inventoryUnit.create({
            data: {
              ...input, ownerId: current.user.id,
              movements: { create: { revision: 1, toStatus: 'available', reason: 'Unit registered' } },
            },
          });
          return present(record, new Date());
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new PublicError(409, 'SERIAL_ALREADY_REGISTERED', 'This serial is already registered to your storefront.');
        }
        throw error;
      }
    }

    @Patch('inventory-units/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(move) })
    @ApiOkResponse({ schema: schema(unit) })
    async change(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const identity = await actor(req, true);
      const input = parse(move, body);
      const unitId = parse(uuid, id);
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, identity);
        profiles.providerRole(current, 'renter');
        const record = await tx.inventoryUnit.findFirst({
          where: { id: unitId, ownerId: current.user.id }, include: { listing: { select: { status: true } } },
        });
        if (!record) throw new PublicError(404, 'INVENTORY_UNIT_NOT_FOUND', 'This equipment unit is unavailable.');
        if (await tx.equipmentInspectionUnit.count({ where: { unitId, releasedAt: null } })) {
          throw new PublicError(409, 'INVENTORY_INSPECTION_ACTIVE', 'Use the booking inspection to move this allocated unit.');
        }
        if (record.revision !== input.revision) throw new PublicError(409, 'REVISION_CONFLICT', 'Reload the equipment unit before changing its status.');
        if (!canMoveUnit(record.status, input.status) || (input.status === 'out' && record.listing.status !== 'published')) {
          throw new PublicError(409, 'INVALID_INVENTORY_TRANSITION', 'This equipment unit cannot move to that status.');
        }

        const now = new Date();
        const dueAt = input.status === 'out' ? new Date(input.dueAt) : null;
        if (dueAt && (!Number.isFinite(dueAt.getTime()) || dueAt <= now)) {
          throw new PublicError(400, 'INVALID_RETURN_DATE', 'Enter an expected return time in the future.');
        }
        const custodyReference = input.status === 'out' ? input.custodyReference : null;
        const updated = await tx.inventoryUnit.update({
          where: { id: unitId, revision: input.revision },
          data: {
            status: input.status, revision: { increment: 1 }, custodyReference, dueAt, updatedAt: now,
            movements: { create: {
              revision: record.revision + 1, fromStatus: record.status, toStatus: input.status, reason: input.reason,
              custodyReference: custodyReference ?? record.custodyReference, dueAt: dueAt ?? record.dueAt,
            } },
          },
        });
        return present(updated, now);
      });
    }

    @Get('inventory-movements')
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiQuery({ name: 'unitId', required: false, type: String })
    @ApiOkResponse({ schema: schema(movementPage) })
    async history(@Req() req: Request, @Query('cursor') cursor?: string, @Query('unitId') unitId?: string) {
      const { user } = await actor(req);
      const records = await db.inventoryMovement.findMany({
        where: {
          unit: { ownerId: user.id },
          ...(cursor === undefined ? {} : { id: { lt: BigInt(parse(movementCursor, cursor)) } }),
          ...(unitId === undefined ? {} : { unitId: parse(uuid, unitId) }),
        },
        orderBy: { id: 'desc' }, take: pageSize + 1,
      });
      const items = records.slice(0, pageSize).map(record => ({
        ...record, id: String(record.id), dueAt: record.dueAt?.toISOString() ?? null, createdAt: record.createdAt.toISOString(),
      }));
      return { items, nextCursor: records.length > pageSize ? items[pageSize - 1]!.id : null };
    }
  }

  return InventoryController;
}
