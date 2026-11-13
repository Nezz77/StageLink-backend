import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags, type SchemaObject } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Prisma, type RentalGalleryItem } from '../../../generated/prisma/client.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { publicRentalFilter } from './rentals.js';

const uuid = z.string().uuid();
const revision = z.number().int().min(1).max(2_147_483_647);
const metadata = z.object({ caption: z.string().trim().max(240), position: z.number().int().min(0).max(49) }).strict();
const attach = metadata.extend({ portfolioItemId: uuid });
const edit = metadata.extend({ revision });
const detach = z.object({ revision }).strict();
const item = metadata.extend({
  id: uuid, portfolioItemId: uuid, revision, mime: z.string().nullable(), publiclyEligible: z.boolean(),
});
const publicItem = item.omit({ id: true, revision: true, publiclyEligible: true, mime: true }).extend({ mime: z.string() });
const gallery = z.object({ items: z.array(item) });
const publicGallery = z.object({ items: z.array(publicItem) });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;

const galleryInclude = { portfolioItem: { include: { asset: true } } } satisfies Prisma.RentalGalleryItemInclude;
type GalleryRow = Prisma.RentalGalleryItemGetPayload<{ include: typeof galleryInclude }>;
const galleryOrder = [{ position: 'asc' }, { portfolioItemId: 'asc' }] as const;

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const result = type.safeParse(value);
  if (!result.success) throw new PublicError(400, 'INVALID_GALLERY_INPUT', 'Check the gallery item, position, or revision.');
  return result.data;
}

function eligible(row: Pick<GalleryRow, 'ownerId' | 'portfolioItem'>) {
  const media = row.portfolioItem;
  const asset = media.asset;
  return media.ownerId === row.ownerId && media.kind === 'renter' && media.status === 'approved' &&
    asset?.ownerId === row.ownerId && asset.purpose === 'equipment' && asset.status === 'ready' &&
    (asset.mime.startsWith('image/') || asset.mime.startsWith('video/'));
}

function present(link: RentalGalleryItem) {
  const { portfolioItemId, caption, position } = link;
  return { portfolioItemId, caption, position };
}

export function makeRentalGalleryControllers(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);

  async function ownRental(tx: Prisma.TransactionClient, ownerId: string, id: string) {
    const listing = await tx.rentalListing.findFirst({ where: { id, ownerId, status: { not: 'archived' } }, select: { id: true } });
    if (!listing) throw new PublicError(404, 'RENTAL_NOT_FOUND', 'This rental listing is unavailable.');
  }

  async function write<T>(req: Request, work: (tx: Prisma.TransactionClient, ownerId: string) => Promise<T>) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const identity = await auth.authenticate(req.get('Authorization'));
    profiles.checkCsrf(identity, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      const actor = await profiles.actor(tx, identity);
      profiles.providerRole(actor, 'renter');
      return work(tx, actor.user.id);
    });
  }

  async function readOwner(tx: Prisma.TransactionClient, listingId: string, ownerId: string) {
    const rows = await tx.rentalGalleryItem.findMany({
      where: { listingId, ownerId }, include: galleryInclude, orderBy: [...galleryOrder],
    });
    return { items: rows.map(row => ({
      ...present(row), id: row.id, revision: row.revision, mime: row.portfolioItem.asset?.mime ?? null, publiclyEligible: eligible(row),
    })) };
  }

  @ApiTags('Rental galleries')
  @ApiBearerAuth()
  @Controller('me/rentals/:id/media')
  @ApiParam({ name: 'id', format: 'uuid' })
  class RentalGalleryController {
    @Get()
    @ApiOkResponse({ schema: schema(gallery) })
    async list(@Req() req: Request, @Param('id') id: string) {
      const actor = await auth.authenticate(req.get('Authorization'));
      profiles.providerRole(actor, 'renter');
      const listingId = parse(uuid, id);
      await ownRental(db, actor.user.id, listingId);
      return readOwner(db, listingId, actor.user.id);
    }

    @Post()
    @HttpCode(200)
    @ApiBody({ schema: schema(attach) })
    @ApiOkResponse({ schema: schema(gallery) })
    add(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const listingId = parse(uuid, id);
      const input = parse(attach, body);
      return write(req, async (tx, ownerId) => {
        await ownRental(tx, ownerId, listingId);
        const portfolioItem = await tx.portfolioItem.findFirst({
          where: { id: input.portfolioItemId, ownerId }, include: { asset: true },
        });
        if (!portfolioItem || !eligible({ ownerId, portfolioItem })) {
          throw new PublicError(404, 'APPROVED_MEDIA_NOT_FOUND', 'Choose an approved equipment photo or video from your portfolio.');
        }
        const key = { listingId, portfolioItemId: input.portfolioItemId };
        if (await tx.rentalGalleryItem.findUnique({ where: { listingId_portfolioItemId: key } })) {
          throw new PublicError(409, 'MEDIA_ALREADY_ATTACHED', 'This media item is already in the gallery.');
        }
        if (await tx.rentalGalleryItem.count({ where: { listingId } }) >= 50) {
          throw new PublicError(409, 'GALLERY_LIMIT', 'A rental gallery can contain up to 50 items.');
        }
        await tx.rentalGalleryItem.create({ data: { ...input, ownerId, listingId } });
        return readOwner(tx, listingId, ownerId);
      });
    }

    @Patch(':linkId')
    @ApiParam({ name: 'linkId', format: 'uuid' })
    @ApiBody({ schema: schema(edit) })
    @ApiOkResponse({ schema: schema(gallery) })
    update(@Req() req: Request, @Param('id') id: string, @Param('linkId') mediaId: string, @Body() body: unknown) {
      const { revision, ...details } = parse(edit, body);
      return change(req, id, mediaId, revision, details);
    }

    @Delete(':linkId')
    @ApiParam({ name: 'linkId', format: 'uuid' })
    @ApiBody({ schema: schema(detach) })
    @ApiOkResponse({ schema: schema(gallery) })
    remove(@Req() req: Request, @Param('id') id: string, @Param('linkId') mediaId: string, @Body() body: unknown) {
      return change(req, id, mediaId, parse(detach, body).revision);
    }
  }

  function change(req: Request, id: string, mediaId: string, revision: number, details?: z.infer<typeof metadata>) {
    const listingId = parse(uuid, id);
    const linkId = parse(uuid, mediaId);
    return write(req, async (tx, ownerId) => {
      await ownRental(tx, ownerId, listingId);
      const where = { id: linkId, listingId, ownerId };
      const link = await tx.rentalGalleryItem.findUnique({ where });
      if (!link) throw new PublicError(404, 'GALLERY_ITEM_NOT_FOUND', 'This rental gallery item is unavailable.');
      if (link.revision !== revision) throw new PublicError(409, 'REVISION_CONFLICT', 'Reload the gallery before changing this item.');
      if (details) await tx.rentalGalleryItem.update({ where, data: { ...details, revision: { increment: 1 } } });
      else await tx.rentalGalleryItem.delete({ where });
      return readOwner(tx, listingId, ownerId);
    });
  }

  @ApiTags('Public catalog')
  @Controller('rentals/:id/media')
  class PublicRentalGalleryController {
    @Get()
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(publicGallery) })
    async list(@Param('id') id: string) {
      const listingId = parse(uuid, id);
      return db.$transaction(async tx => {
        const rental = await tx.rentalListing.findFirst({
          where: { ...publicRentalFilter, id: listingId },
          select: { gallery: { include: galleryInclude, orderBy: [...galleryOrder] } },
        });
        if (!rental) throw new PublicError(404, 'RENTAL_NOT_FOUND', 'This rental listing is unavailable.');
        return { items: rental.gallery.filter(eligible).map(row => ({
          ...present(row), mime: row.portfolioItem.asset!.mime,
        })) };
      }, { isolationLevel: 'RepeatableRead' });
    }
  }

  return [RentalGalleryController, PublicRentalGalleryController];
}
