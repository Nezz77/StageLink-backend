import type { Prisma } from '../../../generated/prisma/client.js';
import { z } from 'zod';
import { depositPolicy } from '../catalog/deposit-policy.js';
import { gigPackages, packageTier } from '../catalog/packages.js';
import { publicGigFilter } from '../catalog/gigs.js';
import { publicRentalFilter } from '../catalog/rentals.js';
import { PublicError } from '../auth/errors.js';
import type { ReservationLine } from './reservations.js';

export const selection = z.object({
  targetKind: z.enum(['gig', 'rental']),
  targetId: z.string().uuid(),
  targetVersion: z.number().int().min(1).max(2_147_483_647),
  quantity: z.number().int().min(1).max(100_000),
  packageId: z.enum(['standard', 'deluxe', 'vip']).optional(),
  addonIds: z.array(z.string().regex(/^[a-z0-9-]{1,24}$/)).max(3).default([]),
  rateUnit: z.enum(['hour', 'day', 'week']).optional(),
  guestCount: z.number().int().min(1).max(100_000).optional(),
}).strict();

export const snapshot = z.object({
  title: z.string(), currency: z.literal('LKR'), quantity: z.number().int(),
  rateMinor: z.number().int().nullable(), periods: z.number().int(),
  rateUnit: z.enum(['hour', 'day', 'week']).nullable(), guestCount: z.number().int().nullable(),
  subtotalMinor: z.number().int().nullable(), depositMinor: z.number().int().nullable(),
  depositPolicy,
  package: packageTier.nullable(),
  bundleItems: z.array(z.object({ listingId: z.string().uuid(), version: z.number().int(), quantity: z.number().int() })),
});

function invalid(): never {
  throw new PublicError(400, 'INVALID_BOOKING_SELECTION', 'Choose a valid package, quantity, rate period and guest count for the listing.');
}

function stale(): never {
  throw new PublicError(409, 'LISTING_VERSION_CHANGED', 'Reload the listing before booking.');
}

export async function publishedTarget(tx: Prisma.TransactionClient, input: Pick<z.infer<typeof selection>, 'targetKind' | 'targetId'>) {
  const target = input.targetKind === 'gig'
    ? await tx.artistGig.findFirst({ where: { ...publicGigFilter, id: input.targetId }, select: { ownerId: true } })
    : await tx.rentalListing.findFirst({ where: { ...publicRentalFilter, id: input.targetId }, select: { ownerId: true } });
  if (!target) throw new PublicError(404, 'BOOKING_TARGET_UNAVAILABLE', 'This listing is unavailable.');
  return target.ownerId;
}

export async function bookingSelection(tx: Prisma.TransactionClient, input: z.infer<typeof selection>, duration: number) {
  const base = { currency: 'LKR' as const, quantity: input.quantity, guestCount: input.guestCount ?? null };
  if (input.targetKind === 'gig') {
    if (input.quantity !== 1 || input.rateUnit || input.guestCount) invalid();
    const gig = await tx.artistGig.findFirst({ where: { ...publicGigFilter, id: input.targetId }, include: { publication: true } });
    const version = gig?.publication;
    if (!version || version.version !== input.targetVersion) stale();
    const packages = gigPackages.parse(version.packages);
    const selected = packages.find(tier => tier.id === input.packageId);
    if (Boolean(packages.length) !== Boolean(selected) || (input.packageId && !selected) ||
      new Set(input.addonIds).size !== input.addonIds.length ||
      input.addonIds.some(id => !selected?.addons.some(addon => addon.id === id)) ||
      (selected && duration !== selected.durationMinutes * 60000)) invalid();
    const packageSnapshot = selected ? { ...selected, addons: selected.addons.filter(addon => input.addonIds.includes(addon.id)) } : null;
    const rate = packageSnapshot ? packageSnapshot.basePriceMinor : version.priceMinor;
    const subtotal = rate === null ? null : rate + (packageSnapshot?.addons.reduce((sum, item) => sum + item.priceMinor, 0) ?? 0);
    return {
      lines: [{ resource: 'artist', resourceId: gig.ownerId, quantity: 1, capacity: 1 }] satisfies ReservationLine[],
      snapshot: {
        ...base, title: version.title, rateMinor: rate, periods: 1, rateUnit: null, subtotalMinor: subtotal,
        depositPolicy: { mode: 'none' as const, currency: 'LKR' as const }, depositMinor: 0, package: packageSnapshot, bundleItems: [],
      },
    };
  }

  if (input.packageId || input.addonIds.length || !input.rateUnit) invalid();
  const rental = await tx.rentalListing.findFirst({ where: { ...publicRentalFilter, id: input.targetId }, include: { publication: true } });
  const version = rental?.publication;
  if (!version || version.version !== input.targetVersion) stale();
  if (rental.kind === 'venue') {
    if (input.quantity !== 1 || !input.guestCount || input.guestCount > (version.venueCapacity ?? 0)) invalid();
  } else if (input.guestCount) invalid();
  const unitMs = { hour: 3600000, day: 86400000, week: 604800000 }[input.rateUnit];
  const rate = { hour: version.hourlyRateMinor, day: version.dailyRateMinor, week: version.weeklyRateMinor }[input.rateUnit];
  if (rate === null || duration % unitMs !== 0) invalid();
  const periods = duration / unitMs;
  const subtotal = rate * periods * input.quantity;
  if (!Number.isSafeInteger(subtotal)) invalid();
  const policy = depositPolicy.parse(version.depositPolicy);
  const deposit = policy.mode === 'none' ? 0 : policy.mode === 'fixed' ? policy.amountMinor
    : Number((BigInt(subtotal) * BigInt(policy.basisPoints) + 5000n) / 10000n);
  const bundleItems = snapshot.shape.bundleItems.parse(version.bundleItems);
  const lines: ReservationLine[] = [];
  if (rental.kind === 'bundle') {
    const records = await tx.rentalListing.findMany({
      where: { ownerId: rental.ownerId, kind: 'equipment', status: 'published', id: { in: bundleItems.map(item => item.listingId) } },
      include: { publication: true },
    });
    for (const item of bundleItems) {
      const equipment = records.find(record => record.id === item.listingId)?.publication;
      if (!equipment || equipment.version !== item.version) stale();
      lines.push({ resource: 'equipment', resourceId: item.listingId, quantity: item.quantity * input.quantity, capacity: equipment.stockQuantity });
    }
  } else {
    lines.push({ resource: rental.kind, resourceId: rental.id, quantity: input.quantity, capacity: version.stockQuantity });
  }
  return {
    lines,
    snapshot: {
      ...base, title: version.title, rateMinor: rate, periods, rateUnit: input.rateUnit, subtotalMinor: subtotal,
      depositPolicy: policy, depositMinor: deposit, package: null, bundleItems,
    },
  };
}
