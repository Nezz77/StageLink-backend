import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Prisma, type RentalListing, type RentalListingVersion } from '../../../generated/prisma/client.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { providerPublic } from '../profiles/schemas.js';

const uuid = z.string().uuid();
const revision = z.number().int().positive().max(2_147_483_647);
const measurement = (max: number) => z.string().trim().refine(value =>
  value === '' || (/^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0 && Number(value) <= max),
);
const specs = z.object({
  specWattage: measurement(1_000_000).optional(),
  specSpl: measurement(250).optional(),
  specFrequency: z.string().trim().max(120).optional(),
  specWeight: measurement(100_000).optional(),
  packageInclusions: z.string().trim().max(1000).optional(),
}).strict();
const fields = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  category: z.enum(['Sound', 'Lighting', 'Instruments', 'Power', 'Stage', 'Other']),
  dailyRateMinor: z.number().int().positive().max(100_000_000),
  stockQuantity: z.number().int().min(0).max(100_000),
  specs,
}).strict();
const edit = fields.extend({ revision });
const status = z.enum(['draft', 'published', 'paused', 'archived']);
const transition = z.object({ revision, action: z.enum(['publish', 'pause', 'archive']) }).strict();
const listing = fields.extend({ id: uuid, version: revision, currency: z.literal('LKR') });
const ownerListing = listing.extend({ revision, status, publishedVersion: revision.nullable() });
const publicListing = listing.omit({ stockQuantity: true }).extend({
  storefront: z.object({ displayName: z.string(), city: z.string() }),
});
const publicPage = z.object({ items: z.array(publicListing), nextCursor: uuid.nullable() });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;
const pageSize = 24;

const publishedProfile = { kind: 'renter', approvedRevision: { not: null }, approvedSnapshot: { not: Prisma.DbNull } } as const;
const visible = {
  status: 'published',
  publishedVersion: { not: null },
  owner: {
    disabledAt: null, emailVerifiedAt: { not: null }, roles: { has: 'renter' },
    providers: { some: publishedProfile },
  },
} satisfies Prisma.RentalListingWhereInput;
const publicInclude = {
  publication: true,
  owner: { select: { providers: { where: publishedProfile, select: { approvedSnapshot: true } } } },
} satisfies Prisma.RentalListingInclude;
const draftInclude = { versions: { orderBy: { version: 'desc' }, take: 1 } } as const;

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const result = type.safeParse(value);
  if (!result.success) throw new PublicError(400, 'INVALID_RENTAL_INPUT', 'Check the equipment details, stock, rate and measurements.');
  return result.data;
}

function ownerView(record: RentalListing, version: RentalListingVersion | undefined) {
  if (!version) throw new Error('Equipment listing version is missing.');
  return {
    id: record.id, version: version.version, revision: record.revision, status: record.status,
    publishedVersion: record.publishedVersion, title: version.title, description: version.description,
    category: version.category, currency: 'LKR' as const, dailyRateMinor: version.dailyRateMinor,
    stockQuantity: version.stockQuantity, specs: specs.parse(version.specs),
  };
}

export function makeRentalControllers(auth: AuthService) {
  const profiles = new ProfileService(auth);
  const db = auth.deps.db;
  const actor = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function mutation(req: Request) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const identity = await actor(req);
    profiles.checkCsrf(identity, req.get('X-CSRF-Token'));
    return identity;
  }

  async function change(req: Request, id: string, input: z.infer<typeof edit> | z.infer<typeof transition>) {
    const identity = await mutation(req);
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, identity);
      profiles.providerRole(current, 'renter');
      const record = await tx.rentalListing.findFirst({
        where: { id, ownerId: current.user.id }, include: draftInclude,
      });
      if (!record) throw new PublicError(404, 'RENTAL_NOT_FOUND', 'This equipment listing is unavailable.');
      if (record.revision !== input.revision) throw new PublicError(409, 'REVISION_CONFLICT', 'Reload the latest equipment listing before saving.');
      if (record.status === 'archived') throw new PublicError(409, 'RENTAL_ARCHIVED', 'Archived equipment listings cannot be changed.');

      let [version] = record.versions;
      if (!version) throw new Error('Equipment listing version is missing.');
      const nextRevision = record.revision + 1;
      const data: Partial<Pick<RentalListing, 'status' | 'publishedVersion'>> = {};
      if ('action' in input) {
        switch (input.action) {
          case 'publish': {
            profiles.verified(current);
            const profile = await tx.providerProfile.findUnique({ where: { userId_kind: { userId: current.user.id, kind: 'renter' } } });
            if (!profile?.approvedRevision || !profile.approvedSnapshot) {
              throw new PublicError(409, 'RENTER_PROFILE_NOT_APPROVED', 'An approved equipment storefront is required to publish.');
            }
            data.status = 'published';
            data.publishedVersion = version.version;
            break;
          }
          case 'pause':
            if (record.status !== 'published') throw new PublicError(409, 'RENTAL_NOT_PUBLISHED', 'Only published equipment listings can be paused.');
            data.status = 'paused';
            break;
          case 'archive':
            data.status = 'archived';
            break;
        }
      } else {
        const { revision: _revision, ...details } = input;
        version = await tx.rentalListingVersion.create({ data: { ...details, listingId: id, version: nextRevision } });
      }
      const updated = await tx.rentalListing.update({
        where: { id }, data: { ...data, revision: nextRevision, updatedAt: new Date() },
      });
      return ownerView(updated, version);
    });
  }

  @ApiTags('Equipment listings')
  @ApiBearerAuth()
  @Controller('me/rentals')
  class RentalsController {
    @Get()
    @ApiOkResponse({ schema: schema(z.array(ownerListing)) })
    async list(@Req() req: Request) {
      const identity = await actor(req);
      profiles.providerRole(identity, 'renter');
      const records = await db.rentalListing.findMany({
        where: { ownerId: identity.user.id, status: { not: 'archived' } },
        include: draftInclude, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      });
      return records.map(record => ownerView(record, record.versions[0]));
    }

    @Post()
    @HttpCode(200)
    @ApiBody({ schema: schema(fields) })
    @ApiOkResponse({ schema: schema(ownerListing) })
    async create(@Req() req: Request, @Body() body: unknown) {
      const identity = await mutation(req);
      const details = parse(fields, body);
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, identity);
        profiles.providerRole(current, 'renter');
        const record = await tx.rentalListing.create({ data: { ownerId: current.user.id } });
        const version = await tx.rentalListingVersion.create({ data: { ...details, listingId: record.id, version: 1 } });
        return ownerView(record, version);
      });
    }

    @Patch(':id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(edit) })
    @ApiOkResponse({ schema: schema(ownerListing) })
    update(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      return change(req, parse(uuid, id), parse(edit, body));
    }

    @Post(':id/status')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(transition) })
    @ApiOkResponse({ schema: schema(ownerListing) })
    setStatus(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      return change(req, parse(uuid, id), parse(transition, body));
    }
  }

  @ApiTags('Public catalog')
  @Controller('rentals')
  class PublicRentalsController {
    @Get()
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiOkResponse({ schema: schema(publicPage) })
    async list(@Query('cursor') cursor?: string) {
      const records = await db.$transaction(tx => tx.rentalListing.findMany({
        where: { ...visible, ...(cursor === undefined ? {} : { id: { gt: parse(uuid, cursor) } }) },
        include: publicInclude, orderBy: { id: 'asc' }, take: pageSize + 1,
      }), { isolationLevel: 'RepeatableRead' });
      const items = records.slice(0, pageSize).map(record => {
        const profile = providerPublic.parse(record.owner.providers[0]?.approvedSnapshot);
        const { id, version, title, description, category, currency, dailyRateMinor, specs } = ownerView(record, record.publication ?? undefined);
        return { id, version, title, description, category, currency, dailyRateMinor, specs,
          storefront: { displayName: profile.displayName, city: profile.city } };
      });
      return { items, nextCursor: records.length > pageSize ? items.at(-1)!.id : null };
    }
  }

  return [RentalsController, PublicRentalsController];
}
