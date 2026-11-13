import { Controller, Delete, Get, Param, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Prisma, type SavedItem } from '../../../generated/prisma/client.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { providerPublic } from '../profiles/schemas.js';
import { publicGigFilter } from './gigs.js';
import { publicRentalFilter } from './rentals.js';

const uuid = z.string().uuid();
const kind = z.enum(['artist', 'gig', 'rental']);
const item = z.object({
  id: uuid, kind, targetId: uuid, createdAt: z.iso.datetime(), title: z.string().nullable(), available: z.boolean(),
});
const page = z.object({ items: z.array(item), nextCursor: uuid.nullable() });
const removed = z.object({ deleted: z.literal(true) });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;
const pageSize = 30;
const publicArtist = {
  kind: 'artist',
  approvedRevision: { not: null },
  approvedSnapshot: { not: Prisma.DbNull },
  user: { disabledAt: null, emailVerifiedAt: { not: null }, roles: { has: 'artist' } },
} satisfies Prisma.ProviderProfileWhereInput;

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const result = type.safeParse(value);
  if (!result.success) throw new PublicError(400, 'INVALID_SAVED_ITEM', 'Check the saved item type, identifier, or page cursor.');
  return result.data;
}

async function titles(tx: Prisma.TransactionClient, entries: Pick<SavedItem, 'kind' | 'targetId'>[]) {
  const ids = (type: SavedItem['kind']) => entries.filter(entry => entry.kind === type).map(entry => entry.targetId);
  const artistIds = ids('artist'), gigIds = ids('gig'), rentalIds = ids('rental');
  const artists = artistIds.length ? await tx.providerProfile.findMany({
    where: { ...publicArtist, userId: { in: artistIds } }, select: { userId: true, approvedSnapshot: true },
  }) : [];
  const gigs = gigIds.length ? await tx.artistGig.findMany({
    where: { ...publicGigFilter, id: { in: gigIds } }, select: { id: true, publication: { select: { title: true } } },
  }) : [];
  const rentals = rentalIds.length ? await tx.rentalListing.findMany({
    where: { ...publicRentalFilter, id: { in: rentalIds } }, select: { id: true, publication: { select: { title: true } } },
  }) : [];
  const lookup = new Map<string, string>();
  for (const artist of artists) lookup.set('artist:' + artist.userId, providerPublic.parse(artist.approvedSnapshot).displayName);
  for (const gig of gigs) if (gig.publication) lookup.set('gig:' + gig.id, gig.publication.title);
  for (const rental of rentals) if (rental.publication) lookup.set('rental:' + rental.id, rental.publication.title);
  return lookup;
}

function present(record: SavedItem, title: string | null) {
  const { id, kind, targetId, createdAt } = record;
  return { id, kind, targetId, createdAt: createdAt.toISOString(), title, available: title !== null };
}

export function makeSavedItemsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function write<T>(req: Request, work: (tx: Prisma.TransactionClient, ownerId: string) => Promise<T>) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site') {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, actor);
      return work(tx, current.user.id);
    });
  }

  @ApiTags('Saved items')
  @ApiBearerAuth()
  @Controller('me/saved-items')
  class SavedItemsController {
    @Get()
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiQuery({ name: 'kind', required: false, enum: kind.options })
    @ApiOkResponse({ schema: schema(page) })
    async list(@Req() req: Request, @Query('cursor') cursor?: string, @Query('kind') category?: string) {
      const { user } = await identity(req);
      return db.$transaction(async tx => {
        const records = await tx.savedItem.findMany({
          where: { ownerId: user.id, kind: category === undefined ? undefined : parse(kind, category),
            ...(cursor === undefined ? {} : { id: { gt: parse(uuid, cursor) } }) },
          orderBy: { id: 'asc' }, take: pageSize + 1,
        });
        const results = records.slice(0, pageSize);
        const lookup = await titles(tx, results);
        const items = results.map(record => present(record, lookup.get(record.kind + ':' + record.targetId) ?? null));
        return { items, nextCursor: records.length > pageSize ? items[pageSize - 1]!.id : null };
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Put(':kind/:targetId')
    @ApiParam({ name: 'kind', enum: kind.options })
    @ApiParam({ name: 'targetId', format: 'uuid' })
    @ApiOkResponse({ schema: schema(item) })
    save(@Req() req: Request, @Param('kind') category: string, @Param('targetId') id: string) {
      const target = { kind: parse(kind, category), targetId: parse(uuid, id) };
      return write(req, async (tx, ownerId) => {
        const key = { ownerId, ...target };
        const existing = await tx.savedItem.findUnique({ where: { ownerId_kind_targetId: key } });
        const title = (await titles(tx, [target])).get(target.kind + ':' + target.targetId) ?? null;
        if (existing) return present(existing, title);
        if (title === null) throw new PublicError(404, 'SAVED_TARGET_UNAVAILABLE', 'This listing or artist is unavailable.');
        return present(await tx.savedItem.create({ data: key }), title);
      });
    }

    @Delete(':kind/:targetId')
    @ApiParam({ name: 'kind', enum: kind.options })
    @ApiParam({ name: 'targetId', format: 'uuid' })
    @ApiOkResponse({ schema: schema(removed) })
    remove(@Req() req: Request, @Param('kind') category: string, @Param('targetId') id: string) {
      const target = { kind: parse(kind, category), targetId: parse(uuid, id) };
      return write(req, async (tx, ownerId) => {
        await tx.savedItem.deleteMany({ where: { ownerId, ...target } });
        return { deleted: true };
      });
    }
  }
  return SavedItemsController;
}
