import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';
import { Prisma } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';

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
  lat: coordinate(90).optional(),
  lng: coordinate(180).optional(),
  radiusKm: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().min(1).max(500)).optional(),
}).strict();
const hasCompleteRadius = (input: z.output<typeof base>) =>
  [input.lat, input.lng, input.radiusKm].every(value => value === undefined) ||
  [input.lat, input.lng, input.radiusKm].every(value => value !== undefined);
const gigQuery = base.extend({ genre: text(40).optional() }).refine(hasCompleteRadius);
const rentalQuery = base.extend({
  category: z.enum(['Sound', 'Lighting', 'Instruments', 'Power', 'Stage', 'Other']).optional(),
  kind: z.enum(['equipment', 'venue', 'bundle']).optional(),
}).refine(hasCompleteRadius);

export function ApiCatalogQuery(type: 'gig' | 'rental') {
  const common = ['cursor', 'q', 'city', 'maxPriceMinor', 'lat', 'lng', 'radiusKm'];
  const fields = type === 'gig' ? [...common, 'genre'] : [...common, 'category', 'kind'];
  return applyDecorators(...fields.map(name => ApiQuery({
    name, required: false, type: String,
    ...(name === 'radiusKm' ? { description: '1–500 km. Requires lat and lng.' } : {}),
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
  if ('category' in filters && filters.category !== undefined) clauses.push(Prisma.sql`v.category = ${filters.category}`);
  if ('kind' in filters && filters.kind !== undefined) clauses.push(Prisma.sql`l.kind = ${filters.kind}::"RentalKind"`);
  if (filters.lat !== undefined && filters.lng !== undefined && filters.radiusKm !== undefined) {
    clauses.push(Prisma.sql`p.approved_latitude IS NOT NULL AND p.approved_longitude IS NOT NULL AND
      6371 * 2 * asin(sqrt(least(1.0,
        power(sin(radians(p.approved_latitude::double precision - ${filters.lat}::double precision) / 2), 2) +
        cos(radians(p.approved_latitude::double precision)) * cos(radians(${filters.lat}::double precision)) *
        power(sin(radians(p.approved_longitude::double precision - ${filters.lng}::double precision) / 2), 2)
      ))) <= ${filters.radiusKm}`);
  }
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM ${listing} l
    JOIN ${version} v ON ${key} = l.id AND v.version = l.published_version
    JOIN auth_users u ON u.id = l.owner_id
    JOIN provider_profiles p ON p.user_id = u.id AND p.kind = ${role}::"AuthRole"
    WHERE ${Prisma.join(clauses, ' AND ')}
    ORDER BY l.id LIMIT ${pageSize + 1}
  `;
  return {
    ids: rows.slice(0, pageSize).map(row => row.id),
    nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null,
  };
}
