import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags, type SchemaObject } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Prisma, type RentalListing, type RentalListingVersion } from '../../../generated/prisma/client.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { providerPublic } from '../profiles/schemas.js';
import { rentalSpecs as specs } from './equipment-specs.js';
import { depositPolicy } from './deposit-policy.js';
import { ApiCatalogQuery, ratingSummary, searchPublished } from './search.js';

const uuid = z.string().uuid();
const revision = z.number().int().positive().max(2_147_483_647);
const kind = z.enum(['equipment', 'venue', 'bundle']);
const optionalRate = z.number().int().positive().max(100_000_000).nullable();
const component = z.object({
  listingId: uuid, quantity: z.number().int().min(1).max(100_000),
}).strict();
const bundleItems = z.array(component).max(12).refine(items =>
  new Set(items.map(item => item.listingId)).size === items.length, 'Use each equipment listing once.',
);
const storedBundle = z.array(component.extend({ title: z.string(), version: revision })).max(12);
const capacity = z.number().int().min(1).max(100_000).nullable();
const fields = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  category: z.enum(['Sound', 'Lighting', 'Instruments', 'Power', 'Stage', 'Other']),
  dailyRateMinor: z.number().int().positive().max(100_000_000),
  stockQuantity: z.number().int().min(0).max(100_000),
  specs,
}).strict();
const options = {
  hourlyRateMinor: optionalRate.optional(), weeklyRateMinor: optionalRate.optional(),
  venueCapacity: capacity.optional(), bundleItems: bundleItems.optional(),
};
const create = fields.extend({ kind: kind.optional(), ...options });
const edit = fields.extend({ revision, ...options });
const status = z.enum(['draft', 'published', 'paused', 'archived']);
const transition = z.object({ revision, action: z.enum(['publish', 'pause', 'archive']) }).strict();
const updateDeposit = z.object({ revision, depositPolicy }).strict();
const listing = fields.extend({
  id: uuid, version: revision, currency: z.literal('LKR'), kind,
  hourlyRateMinor: optionalRate, weeklyRateMinor: optionalRate, venueCapacity: capacity,
  bundleItems: storedBundle, depositPolicy,
});
const ownerListing = listing.extend({ revision, status, publishedVersion: revision.nullable() });
const publicListing = listing.omit({ stockQuantity: true }).extend({
  storefront: z.object({ displayName: z.string(), city: z.string() }),
});
export const rentalSummary = publicListing.omit({ description: true, specs: true, bundleItems: true, depositPolicy: true });
const publicPage = z.object({ items: z.array(publicListing.extend({ ratingSummary })), nextCursor: uuid.nullable() });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;

const publishedProfile = { kind: 'renter', approvedRevision: { not: null }, approvedSnapshot: { not: Prisma.DbNull } } as const;
export const publicRentalFilter = {
  status: 'published',
  publishedVersion: { not: null },
  owner: {
    disabledAt: null, emailVerifiedAt: { not: null }, roles: { has: 'renter' },
    providers: { some: publishedProfile },
  },
} satisfies Prisma.RentalListingWhereInput;
export const publicRentalInclude = {
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
    id: record.id, kind: record.kind, version: version.version, revision: record.revision, status: record.status,
    hourlyRateMinor: version.hourlyRateMinor, weeklyRateMinor: version.weeklyRateMinor,
    venueCapacity: version.venueCapacity, bundleItems: storedBundle.parse(version.bundleItems),
    depositPolicy: depositPolicy.parse(version.depositPolicy),
    publishedVersion: record.publishedVersion, title: version.title, description: version.description,
    category: version.category, currency: 'LKR' as const, dailyRateMinor: version.dailyRateMinor,
    stockQuantity: version.stockQuantity, specs: specs.parse(version.specs),
  };
}

type PublicRentalRow = Prisma.RentalListingGetPayload<{ include: typeof publicRentalInclude }>;

function presentPublicRental(record: PublicRentalRow) {
  const profile = providerPublic.parse(record.owner.providers[0]?.approvedSnapshot);
  const { revision: _revision, status: _status, publishedVersion: _publication, stockQuantity: _stock, ...published } =
    ownerView(record, record.publication ?? undefined);
  return { ...published, storefront: { displayName: profile.displayName, city: profile.city } };
}

export function presentRentalSummary(record: PublicRentalRow) {
  const { description: _description, specs: _specs, bundleItems: _items, depositPolicy: _policy, ...summary } = presentPublicRental(record);
  return summary;
}

async function versionDetails(
  tx: Prisma.TransactionClient,
  ownerId: string,
  listingKind: z.infer<typeof kind>,
  details: Omit<z.infer<typeof create>, 'kind'>,
  previous?: RentalListingVersion,
) {
  const { hourlyRateMinor, weeklyRateMinor, venueCapacity, bundleItems: items, ...base } = details;
  const guests = venueCapacity === undefined ? previous?.venueCapacity ?? null : venueCapacity;
  const selected = items ?? (previous ? storedBundle.parse(previous.bundleItems).map(({ listingId, quantity }) => ({ listingId, quantity })) : []);
  if ((listingKind === 'venue') !== (guests !== null) || (listingKind === 'bundle') !== (selected.length > 0)) {
    throw new PublicError(400, 'INVALID_RENTAL_OPTIONS', 'Enter a venue capacity or select equipment quantities for a bundle.');
  }
  return {
    ...base,
    stockQuantity: listingKind === 'equipment' ? base.stockQuantity : listingKind === 'venue' ? 1 : 0,
    hourlyRateMinor: hourlyRateMinor === undefined ? previous?.hourlyRateMinor ?? null : hourlyRateMinor,
    weeklyRateMinor: weeklyRateMinor === undefined ? previous?.weeklyRateMinor ?? null : weeklyRateMinor,
    venueCapacity: guests,
    bundleItems: await resolveBundle(tx, ownerId, selected),
  };
}

async function resolveBundle(tx: Prisma.TransactionClient, ownerId: string, items: z.infer<typeof bundleItems>) {
  if (!items.length) return [];
  const equipment = await tx.rentalListing.findMany({
    where: { ownerId, kind: 'equipment', status: 'published', id: { in: items.map(item => item.listingId) } },
    include: { publication: true },
  });
  return items.map(item => {
    const version = equipment.find(record => record.id === item.listingId)?.publication;
    if (!version || version.stockQuantity < item.quantity) {
      throw new PublicError(409, 'BUNDLE_EQUIPMENT_UNAVAILABLE', 'Use published equipment from your storefront with enough stock for each bundle item.');
    }
    return { ...item, title: version.title, version: version.version };
  });
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

  async function change(req: Request, id: string, input: z.infer<typeof edit> | z.infer<typeof transition> | z.infer<typeof updateDeposit>) {
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
            if (record.kind === 'bundle') {
              const savedItems = storedBundle.parse(version.bundleItems);
              const currentItems = await resolveBundle(tx, current.user.id, savedItems);
              if (currentItems.some((item, index) => item.version !== savedItems[index]?.version)) {
                throw new PublicError(409, 'BUNDLE_EQUIPMENT_CHANGED', 'Equipment versions changed. Save the bundle draft again before publishing.');
              }
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
      } else if ('depositPolicy' in input) {
        version = await tx.rentalListingVersion.create({
          data: {
            ...version, version: nextRevision,
            specs: specs.parse(version.specs),
            bundleItems: storedBundle.parse(version.bundleItems),
            depositPolicy: input.depositPolicy,
          },
        });
      } else {
        const { revision: _revision, ...details } = input;
        const values = await versionDetails(tx, current.user.id, record.kind, details, version);
        version = await tx.rentalListingVersion.create({
          data: {
            ...values, listingId: id, version: nextRevision,
            depositPolicy: depositPolicy.parse(version.depositPolicy),
          },
        });
      }
      const updated = await tx.rentalListing.update({
        where: { id }, data: { ...data, revision: nextRevision, updatedAt: new Date() },
      });
      if (record.kind === 'equipment' && record.status === 'published' &&
        (updated.status !== 'published' || updated.publishedVersion !== record.publishedVersion)) {
        // The owner row lock also serializes bundle publication with changes to its equipment.
        await tx.rentalListing.updateMany({
          where: {
            ownerId: current.user.id, kind: 'bundle', status: 'published',
            publication: { is: { bundleItems: { array_contains: [{ listingId: id }] } } },
          },
          data: { status: 'paused', revision: { increment: 1 }, updatedAt: new Date() },
        });
      }
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
    @ApiBody({ schema: schema(create) })
    @ApiOkResponse({ schema: schema(ownerListing) })
    async create(@Req() req: Request, @Body() body: unknown) {
      const identity = await mutation(req);
      const { kind: listingKind = 'equipment', ...details } = parse(create, body);
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, identity);
        profiles.providerRole(current, 'renter');
        const values = await versionDetails(tx, current.user.id, listingKind, details);
        const record = await tx.rentalListing.create({ data: { ownerId: current.user.id, kind: listingKind } });
        const version = await tx.rentalListingVersion.create({ data: { ...values, listingId: record.id, version: 1 } });
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

    @Put(':id/deposit-policy')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(updateDeposit) })
    @ApiOkResponse({ schema: schema(ownerListing) })
    updateDepositPolicy(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const policy = updateDeposit.safeParse(body);
      if (!policy.success) {
        throw new PublicError(400, 'INVALID_DEPOSIT_POLICY', 'Use an LKR deposit policy with a valid listing revision, amount or percentage, and refund terms.');
      }
      return change(req, parse(uuid, id), policy.data);
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
    @ApiCatalogQuery('rental')
    @ApiOkResponse({ schema: schema(publicPage) })
    async list(@Query() query: unknown) {
      return db.$transaction(async tx => {
        const { ratings, nextCursor } = await searchPublished(tx, 'rental', query);
        const records = await tx.rentalListing.findMany({
          where: { ...publicRentalFilter, id: { in: [...ratings.keys()] } },
          include: publicRentalInclude, orderBy: { id: 'asc' },
        });
        return { items: records.map(record => ({ ...presentPublicRental(record), ratingSummary: ratings.get(record.id)! })), nextCursor };
      }, { isolationLevel: 'RepeatableRead' });
    }
  }

  return [RentalsController, PublicRentalsController];
}
