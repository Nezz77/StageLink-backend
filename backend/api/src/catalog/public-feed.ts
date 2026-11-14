import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags, type SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';
import type { Resources } from '../../../shared/resources.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { featuredGig, gigSummary, presentFeaturedGig, presentGigSummary, publicGigFilter, publicGigInclude } from './gigs.js';
import { rentalSummary, presentRentalSummary, publicRentalFilter, publicRentalInclude } from './rentals.js';

const announcement = z.object({
  id: z.string().uuid(), title: z.string(), body: z.string(),
  startsAt: z.iso.datetime(), endsAt: z.iso.datetime().nullable(),
});
const featured = z.object({ items: z.array(featuredGig) });
const announcements = z.object({ items: z.array(announcement) });
const feed = z.object({
  gigs: z.array(gigSummary), rentals: z.array(rentalSummary), announcements: z.array(announcement),
  totals: z.object({ gigs: z.number().int().nonnegative(), rentals: z.number().int().nonnegative() }),
});
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;

async function activeAnnouncements(db: Prisma.TransactionClient, now: Date) {
  const rows = await db.publicAnnouncement.findMany({
    where: { publishedAt: { lte: now }, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    select: { id: true, title: true, body: true, startsAt: true, endsAt: true },
    orderBy: [{ startsAt: 'desc' }, { id: 'asc' }], take: 5,
  });
  return rows.map(row => ({
    ...row, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt?.toISOString() ?? null,
  }));
}

export function makePublicFeedController(db: Resources['db']) {
  let cached: { version: bigint; until: number; items: Awaited<ReturnType<typeof activeAnnouncements>> } | undefined;
  @ApiTags('Public catalog')
  @Controller('public')
  class PublicFeedController {
    @Get('feed')
    @ApiOkResponse({ schema: schema(feed) })
    async feed() {
      const now = new Date();
      return db.$transaction(async tx => {
        const gigs = await tx.artistGig.findMany({
          where: publicGigFilter, include: publicGigInclude, orderBy: { id: 'asc' }, take: 6,
        });
        const rentals = await tx.rentalListing.findMany({
          where: publicRentalFilter, include: publicRentalInclude, orderBy: { id: 'asc' }, take: 6,
        });
        return {
          gigs: gigs.map(presentGigSummary), rentals: rentals.map(presentRentalSummary),
          announcements: await activeAnnouncements(tx, now),
          totals: { gigs: await tx.artistGig.count({ where: publicGigFilter }), rentals: await tx.rentalListing.count({ where: publicRentalFilter }) },
        };
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Get('featured-packages')
    @ApiOkResponse({ schema: schema(featured) })
    async featuredPackages() {
      return db.$transaction(async tx => {
        const gigs = await tx.artistGig.findMany({
          where: { ...publicGigFilter, publication: { is: { NOT: { packages: { equals: [] } } } } },
          include: publicGigInclude, orderBy: { id: 'asc' }, take: 6,
        });
        return { items: gigs.map(presentFeaturedGig) };
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Get('announcements')
    @ApiOkResponse({ schema: schema(announcements) })
    async announcements() {
      const settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 1 }, select: { announcementCacheVersion: true } });
      const now = new Date();
      if (cached?.version === settings.announcementCacheVersion && cached.until > now.getTime()) return { items: cached.items };
      const [items, upcoming] = await Promise.all([
        activeAnnouncements(db, now),
        db.publicAnnouncement.findFirst({
          where: { publishedAt: { lte: now }, startsAt: { gt: now } },
          orderBy: { startsAt: 'asc' }, select: { startsAt: true },
        }),
      ]);
      const ends = items.map(item => item.endsAt ? Date.parse(item.endsAt) : Infinity);
      const until = Math.min(now.getTime() + 5000, upcoming?.startsAt.getTime() ?? Infinity, ...ends);
      cached = { version: settings.announcementCacheVersion, until, items };
      return { items };
    }
  }
  return PublicFeedController;
}
