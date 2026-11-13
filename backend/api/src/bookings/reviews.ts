import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '../../../generated/prisma/client.js';
import { derivativeKey, type MediaStore } from '../../../shared/media-store.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { publicGigFilter } from '../catalog/gigs.js';
import { publicRentalFilter } from '../catalog/rentals.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';
import { lockBooking, paymentBlocked } from './lifecycle.js';
import { member } from './requests.js';

const kind = z.enum(['gig', 'rental']);
const rating = z.number().int().min(1).max(5);
const photoIds = z.array(uuid).max(4).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length);
const submission = z.object({
  rating, body: z.string().trim().min(10).max(2000), photoIds: photoIds.optional(),
}).strict();
const moderation = z.object({
  revision: z.number().int().positive().max(2_147_483_646),
  status: z.enum(['published', 'hidden']), reason: z.string().trim().min(1).max(500),
}).strict();
const publicReview = z.object({
  id: uuid, rating, body: z.string(), createdAt: z.iso.datetime(), photoIds: z.array(uuid),
});
const view = publicReview.extend({
  bookingId: uuid, targetKind: kind, targetId: uuid, revision: z.number().int(),
  status: z.enum(['pending', 'published', 'hidden']),
});
const publicPage = z.object({
  items: z.array(publicReview), nextCursor: uuid.nullable(),
  average: z.number().nullable(), count: z.number().int().nonnegative(),
});
const adminPage = z.object({ items: z.array(view), nextCursor: uuid.nullable() });
let activePhotoReads = 0;
const photoInclude = { photos: { orderBy: { position: 'asc' } } } as const;
type Review = Prisma.BookingReviewGetPayload<{ include: typeof photoInclude }>;
const pageSize = 30;
const displayMime = z.enum(['image/jpeg', 'image/png', 'image/webp']);

function presentPublic(row: Review) {
  return { id: row.id, rating: row.rating, body: row.body, createdAt: row.createdAt.toISOString(), photoIds: row.photos.map(photo => photo.assetId) };
}

function present(row: Review) {
  return {
    ...presentPublic(row), bookingId: row.bookingId, targetKind: row.targetKind, targetId: row.targetId,
    revision: row.revision, status: row.status,
  };
}

async function requirePublished(tx: Prisma.TransactionClient, listingKind: z.infer<typeof kind>, id: string) {
  const listing = listingKind === 'gig'
    ? await tx.artistGig.findFirst({ where: { ...publicGigFilter, id }, select: { id: true } })
    : await tx.rentalListing.findFirst({ where: { ...publicRentalFilter, id }, select: { id: true } });
  if (!listing) throw new PublicError(404, 'LISTING_NOT_FOUND', 'This listing is unavailable.');
}

export function makeReviewsController(auth: AuthService, store: MediaStore) {
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

  @ApiTags('Booking reviews')
  @Controller()
  class ReviewsController {
    @Post('bookings/:id/reviews')
    @HttpCode(200)
    @ApiBearerAuth()
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(submission) })
    @ApiOkResponse({ schema: schema(view) })
    async submit(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const actor = await mutation(req);
      const bookingId = parse(uuid, id);
      const input = parse(submission, raw);
      const assetIds = (input.photoIds ?? []).map(id => id.toLowerCase());
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, actor);
        profiles.verified(current);
        const booking = await member(tx, bookingId, current.user.id);
        if (booking.customerId !== current.user.id || !current.user.roles.includes('customer')) {
          throw new PublicError(403, 'REVIEW_CUSTOMER_REQUIRED', 'Only the booking customer can submit a review.');
        }
        await lockBooking(tx, bookingId);
        const existing = await tx.bookingReview.findUnique({ where: { bookingId }, include: photoInclude });
        if (existing) {
          if (existing.rating !== input.rating || existing.body !== input.body ||
            existing.photos.length !== assetIds.length || existing.photos.some((photo, index) => photo.assetId !== assetIds[index])) {
            throw new PublicError(409, 'REVIEW_ALREADY_SUBMITTED', 'This booking already has a review.');
          }
          return present(existing);
        }
        const completion = await tx.bookingCompletion.findUnique({ where: { bookingId }, select: { verifiedAt: true } });
        if (!completion?.verifiedAt || await paymentBlocked(tx, bookingId)) {
          throw new PublicError(409, 'REVIEW_NOT_ELIGIBLE', 'A verified completed booking is required.');
        }
        for (const assetId of [...assetIds].sort()) {
          await tx.$queryRaw`SELECT id FROM assets WHERE id=${assetId}::uuid FOR UPDATE`;
          const asset = await tx.asset.findFirst({
            where: { id: assetId, ownerId: current.user.id, status: 'ready', purpose: 'review' },
          });
          const display = (asset?.variants as Record<string, { mime?: string }> | undefined)?.display;
          if (!displayMime.safeParse(display?.mime).success) {
            throw new PublicError(409, 'REVIEW_PHOTO_UNAVAILABLE', 'Choose validated photos from your media library.');
          }
        }
        return present(await tx.bookingReview.create({
          data: {
            bookingId, targetId: booking.targetId, targetKind: booking.targetKind, rating: input.rating, body: input.body,
            photos: { create: assetIds.map((assetId, position) => ({ assetId, position })) },
          },
          include: photoInclude,
        }));
      });
    }

    @Get('bookings/:id/reviews')
    @ApiBearerAuth()
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ review: view.nullable() })) })
    async read(@Req() req: Request, @Param('id') id: string) {
      const { user } = await identity(req);
      const booking = await member(db, parse(uuid, id), user.id);
      const row = await db.bookingReview.findFirst({
        where: { bookingId: booking.id, ...(user.id === booking.customerId ? {} : { status: 'published' }) }, include: photoInclude,
      });
      return { review: row && present(row) };
    }

    @Get('listings/:id/reviews')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiQuery({ name: 'targetKind', enum: kind.options })
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiOkResponse({ schema: schema(publicPage) })
    async publicList(@Param('id') id: string, @Query('targetKind') target: string, @Query('cursor') raw?: string) {
      const targetKind = parse(kind, target);
      const targetId = parse(uuid, id);
      const cursor = raw === undefined ? undefined : parse(uuid, raw);
      return db.$transaction(async tx => {
        await requirePublished(tx, targetKind, targetId);
        const where = { targetKind, targetId, status: 'published' as const };
        const [rows, summary] = await Promise.all([
          tx.bookingReview.findMany({
            where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
            orderBy: { id: 'asc' }, take: pageSize + 1, include: photoInclude,
          }),
          tx.bookingReview.aggregate({ where, _avg: { rating: true }, _count: true }),
        ]);
        const items = rows.slice(0, pageSize).map(presentPublic);
        return { items, nextCursor: rows.length > pageSize ? items[pageSize - 1]!.id : null, average: summary._avg.rating, count: summary._count };
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Get('reviews/:id/photos/:assetId')
    @Header('Cache-Control', 'no-store')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiParam({ name: 'assetId', format: 'uuid' })
    @ApiProduces('image/jpeg', 'image/png', 'image/webp')
    @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
    async publicPhoto(@Req() req: Request, @Param('id') id: string, @Param('assetId') rawAssetId: string) {
      await auth.limits.check('review-photo', req.ip ?? 'unknown', 180, 60);
      const reviewId = parse(uuid, id);
      const assetId = parse(uuid, rawAssetId);
      const mime = await db.$transaction(async tx => {
        const photo = await tx.bookingReviewPhoto.findFirst({
          where: { reviewId, assetId, review: { status: 'published' }, asset: { status: 'ready', purpose: 'review' } },
          include: { review: { select: { targetId: true, targetKind: true } }, asset: { select: { variants: true } } },
        });
        const format = displayMime.safeParse((photo?.asset.variants as Record<string, { mime?: string }> | undefined)?.display?.mime);
        if (!photo || !format.success) throw new PublicError(404, 'REVIEW_PHOTO_NOT_FOUND', 'This review photo is unavailable.');
        await requirePublished(tx, parse(kind, photo.review.targetKind), photo.review.targetId);
        return format.data;
      }, { isolationLevel: 'RepeatableRead' });
      if (activePhotoReads >= 4) throw new PublicError(429, 'MEDIA_READ_BUSY', 'Other previews are loading. Try again shortly.');
      activePhotoReads++;
      try {
        return new StreamableFile(await store.get(derivativeKey(assetId, 'display'), 9 * 1024 * 1024), { type: mime });
      } catch {
        throw new PublicError(503, 'REVIEW_PHOTO_UNAVAILABLE', 'The review photo could not be retrieved.');
      } finally {
        activePhotoReads--;
      }
    }

    @Get('admin/reviews')
    @ApiBearerAuth()
    @ApiQuery({ name: 'status', enum: ['pending', 'published', 'hidden'], required: false })
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiOkResponse({ schema: schema(adminPage) })
    async queue(@Req() req: Request, @Query('cursor') raw?: string, @Query('status') status?: string) {
      const actor = await identity(req);
      const cursor = raw === undefined ? undefined : parse(uuid, raw);
      const filter = status === undefined ? 'pending' : parse(view.shape.status, status);
      return db.$transaction(async tx => {
        profiles.verified(await profiles.actor(tx, actor, undefined, true));
        const rows = await tx.bookingReview.findMany({
          where: { status: filter, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' }, take: pageSize + 1, include: photoInclude,
        });
        const items = rows.slice(0, pageSize).map(present);
        return { items, nextCursor: rows.length > pageSize ? items[pageSize - 1]!.id : null };
      });
    }

    @Patch('admin/reviews/:id/moderation')
    @ApiBearerAuth()
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(moderation) })
    @ApiOkResponse({ schema: schema(view) })
    async moderate(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const actor = await mutation(req);
      const input = parse(moderation, raw);
      const reviewId = parse(uuid, id);
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, actor, undefined, true);
        profiles.verified(current);
        await tx.$queryRaw`SELECT id FROM booking_reviews WHERE id=${reviewId}::uuid FOR UPDATE`;
        const row = await tx.bookingReview.findUnique({
          where: { id: reviewId }, include: { ...photoInclude, booking: { select: { customerId: true, providerId: true } } },
        });
        if (!row) throw new PublicError(404, 'REVIEW_NOT_FOUND', 'This booking review is unavailable.');
        if ([row.booking.customerId, row.booking.providerId].includes(current.user.id)) {
          throw new PublicError(403, 'SELF_REVIEW_FORBIDDEN', 'Another administrator must moderate this review.');
        }
        if (current.session.createdAt.getTime() < Date.now() - 15 * 60_000) {
          throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before moderating reviews.');
        }
        if (row.revision !== input.revision || row.status === input.status) {
          throw new PublicError(409, 'REVIEW_CHANGED', 'Reload the review before moderating.');
        }
        return present(await tx.bookingReview.update({
          where: { id: reviewId },
          data: {
            revision: { increment: 1 }, status: input.status,
            moderations: { create: { revision: input.revision + 1, status: input.status, reason: input.reason, actorId: current.user.id } },
          },
          include: photoInclude,
        }));
      });
    }
  }
  return ReviewsController;
}
