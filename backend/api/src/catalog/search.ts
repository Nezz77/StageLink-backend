import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';
import { Prisma } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import { artistDetails } from '../profiles/schemas.js';

const pageSize = 24;
const price = z.string().regex(/^\d{1,9}$/).transform(Number).pipe(z.number().int().max(100_000_000));
const coordinate = (limit: number) => z.string().regex(/^-?\d{1,3}(\.\d{1,6})?$/)
  .transform(Number).pipe(z.number().min(-limit).max(limit));
const text = (max: number) => z.string().trim().min(1).max(max);
const base = z.object({
  cursor: z.string().uuid().optional(),
  q: text(120).optional(),
  city: text(100).optional(),
  maxPriceMinor: price.optional(),
  minRating: z.string().regex(/^[1-5](\.\d{1,2})?$/).transform(Number).pipe(z.number().max(5)).optional(),
  lat: coordinate(90).optional(),
  lng: coordinate(180).optional(),
  radiusKm: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().min(1).max(500)).optional(),
}).strict();
const hasCompleteRadius = (input: z.output<typeof base>) =>
  [input.lat, input.lng, input.radiusKm].every(value => value === undefined) ||
  [input.lat, input.lng, input.radiusKm].every(value => value !== undefined);
const gigQuery = base.extend({
  genre: text(40).optional(),
  category: artistDetails.shape.category.optional(),
}).refine(hasCompleteRadius);
const rentalCategory = z.enum(['Sound', 'Lighting', 'Instruments', 'Power', 'Stage', 'Other']);
const rentalQuery = base.extend({
  category: rentalCategory.optional(),
  kind: z.enum(['equipment', 'venue', 'bundle']).optional(),
}).refine(hasCompleteRadius);

export const ratingSummary = z.object({
  average: z.number().min(1).max(5).nullable(),
  count: z.number().int().nonnegative(),
});

export function ApiCatalogQuery(type: 'gig' | 'rental') {
  const common = ['cursor', 'q', 'city', 'maxPriceMinor', 'minRating', 'lat', 'lng', 'radiusKm'];
  const fields = type === 'gig' ? [...common, 'genre', 'category'] : [...common, 'category', 'kind'];
  const categoryOptions = type === 'gig' ? artistDetails.shape.category.options : rentalCategory.options;
  return applyDecorators(...fields.map(name => ApiQuery({
    name, required: false, type: String,
    ...(name === 'category' ? { enum: categoryOptions } : {}),
    ...(name === 'radiusKm' ? { description: '1–500 km. Requires lat and lng.' } : {}),
    ...(name === 'minRating' ? { description: 'Minimum average of published verified reviews, from 1 to 5.' } : {}),
    ...(name === 'maxPriceMinor' ? { description: 'Maximum advertised base or daily rate in LKR minor units.' } : {}),
  })));
}

export async function searchPublished(tx: Prisma.TransactionClient, type: 'gig' | 'rental', query: unknown) {
  const parsed = (type === 'gig' ? gigQuery : rentalQuery).safeParse(query);
  if (!parsed.success) throw new PublicError(400, 'INVALID_CATALOG_QUERY', 'Check the search filters and provide latitude, longitude and radius together.');
  const filters = parsed.data;
  const gig = type === 'gig';
  const listing = gig ? Prisma.sql`artist_gigs` : Prisma.sql`rental_listings`;
  const version = gig ? Prisma.sql`artist_gig_versions` : Prisma.sql`rental_listing_versions`;
  const key = gig ? Prisma.sql`v.gig_id` : Prisma.sql`v.listing_id`;
  const rate = gig ? Prisma.sql`v.price_minor` : Prisma.sql`v.daily_rate_minor`;
  const role = gig ? 'artist' : 'renter';
  const clauses = [
    Prisma.sql`l.status = 'published'`,
    Prisma.sql`u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND ${role}::"AuthRole" = ANY(u.roles)`,
    Prisma.sql`p.approved_revision IS NOT NULL AND p.approved_snapshot IS NOT NULL`,
  ];
  if (filters.cursor !== undefined) clauses.push(Prisma.sql`l.id > ${filters.cursor}::uuid`);
  if (filters.maxPriceMinor !== undefined) clauses.push(Prisma.sql`${rate} <= ${filters.maxPriceMinor}`);
  if (filters.minRating !== undefined) {
    clauses.push(Prisma.sql`reviews.average >= ${filters.minRating}::numeric`);
  }
  if (filters.city !== undefined) clauses.push(Prisma.sql`lower(p.approved_snapshot->>'city') = lower(${filters.city})`);
  if (filters.q !== undefined) {
    clauses.push(Prisma.sql`(strpos(lower(v.title), lower(${filters.q})) > 0 OR
      strpos(lower(p.approved_snapshot->>'displayName'), lower(${filters.q})) > 0)`);
  }
  if ('genre' in filters && filters.genre !== undefined) {
    clauses.push(Prisma.sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(p.approved_snapshot->'details'->'genres') AS genres(genre)
      WHERE lower(genre) = lower(${filters.genre})
    )`);
  }
  if ('category' in filters && filters.category !== undefined) {
    const category = gig ? Prisma.sql`p.approved_snapshot->'details'->>'category'` : Prisma.sql`v.category`;
    clauses.push(Prisma.sql`${category} = ${filters.category}`);
  }
  if ('kind' in filters && filters.kind !== undefined) clauses.push(Prisma.sql`l.kind = ${filters.kind}::"RentalKind"`);
  if (filters.lat !== undefined && filters.lng !== undefined && filters.radiusKm !== undefined) {
    clauses.push(Prisma.sql`p.approved_latitude IS NOT NULL AND p.approved_longitude IS NOT NULL AND
      6371 * 2 * asin(sqrt(least(1.0,
        power(sin(radians(p.approved_latitude::double precision - ${filters.lat}::double precision) / 2), 2) +
        cos(radians(p.approved_latitude::double precision)) * cos(radians(${filters.lat}::double precision)) *
        power(sin(radians(p.approved_longitude::double precision - ${filters.lng}::double precision) / 2), 2)
      ))) <= ${filters.radiusKm}`);
  }
  const rows = await tx.$queryRaw<({ id: string } & z.infer<typeof ratingSummary>)[]>`
    SELECT l.id, reviews.average::double precision AS average, reviews.count
    FROM ${listing} l
    JOIN ${version} v ON ${key} = l.id AND v.version = l.published_version
    JOIN auth_users u ON u.id = l.owner_id
    JOIN provider_profiles p ON p.user_id = u.id AND p.kind = ${role}::"AuthRole"
    CROSS JOIN LATERAL (
      SELECT avg(r.rating) AS average, count(*)::int AS count
      FROM booking_reviews r
      WHERE r.target_kind = ${type}::"SavedItemKind" AND r.target_id = l.id AND r.status = 'published'
    ) reviews
    WHERE ${Prisma.join(clauses, ' AND ')}
    ORDER BY l.id LIMIT ${pageSize + 1}
  `;
  return {
    ratings: new Map(rows.slice(0, pageSize).map(({ id, average, count }) => [id, { average, count }])),
    nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null,
  };
}
