import { z } from 'zod';

const currency = z.literal('LKR');
const terms = z.string().trim().min(20).max(1000);

export const depositPolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none'), currency }).strict(),
  z.object({
    mode: z.literal('fixed'), currency,
    amountMinor: z.number().int().min(1).max(100_000_000), terms,
  }).strict(),
  z.object({
    mode: z.literal('percentage'), currency,
    basis: z.literal('rental_subtotal'),
    basisPoints: z.number().int().min(1).max(10_000), terms,
  }).strict(),
]);
