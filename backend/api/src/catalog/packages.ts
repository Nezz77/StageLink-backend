import { z } from 'zod';

const money = z.number().int().min(100).max(100_000_000);
const title = z.string().trim().min(3).max(60);
const packageTier = z.object({
  id: z.enum(['standard', 'deluxe', 'vip']),
  title,
  pricing: z.enum(['fixed', 'custom']),
  durationMinutes: z.number().int().min(30).max(720).multipleOf(15),
  performers: z.number().int().min(1).max(50),
  basePriceMinor: money.nullable(),
  included: z.string().trim().min(3).max(350),
  excluded: z.string().trim().min(3).max(250),
  addons: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,24}$/),
    title,
    priceMinor: money,
  }).strict()).max(3),
}).strict();

export const gigPackages = z.array(packageTier).max(3).refine(tiers => {
  if (tiers.length === 0) return true;
  if (tiers.length !== 3 || tiers.some((tier, i) => tier.id !== ['standard', 'deluxe', 'vip'][i])) return false;
  return tiers.every(tier => {
    if (tier.pricing === 'custom') return tier.id === 'vip' && tier.basePriceMinor === null && tier.addons.length === 0;
    if (tier.basePriceMinor === null || new Set(tier.addons.map(addon => addon.id)).size !== tier.addons.length) return false;
    return tier.basePriceMinor + tier.addons.reduce((total, addon) => total + addon.priceMinor, 0) <= 100_000_000;
  });
}, 'Configure Standard, Deluxe and VIP with valid pricing and unique add-ons, or remove all packages.');
