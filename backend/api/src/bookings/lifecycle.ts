import { z } from 'zod';
import type { Booking, Prisma } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';

export const maxMinor = 2_147_483_647;
const minor = z.number().int().min(0).max(maxMinor);
const amounts = z.object({
  version: z.literal(1), currency: z.literal('LKR'),
  totalMinor: minor.positive(), serviceAdvanceMinor: minor.positive(), depositMinor: minor,
}).refine(terms => terms.serviceAdvanceMinor === Math.ceil(terms.totalMinor / 2));

export async function agreementAmounts(tx: Prisma.TransactionClient, bookingId: string) {
  const agreement = await tx.bookingAgreement.findUniqueOrThrow({ where: { bookingId } });
  return amounts.parse(JSON.parse(agreement.artifact));
}

export function completionAmounts(terms: z.infer<typeof amounts>, overtimeMinor: number) {
  if (terms.totalMinor + overtimeMinor > maxMinor) {
    throw new PublicError(409, 'OVERTIME_TOTAL_LIMIT', 'The booking total exceeds the supported LKR amount.');
  }
  return {
    originalMinor: terms.totalMinor, advanceMinor: terms.serviceAdvanceMinor, overtimeMinor,
    balanceMinor: terms.totalMinor - terms.serviceAdvanceMinor + overtimeMinor,
    platformFeeMinor: Math.floor((terms.totalMinor * 5 + 50) / 100),
  };
}

export async function lockBooking(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM bookings WHERE id=${id}::uuid FOR UPDATE`;
}

export async function paidAdvance(tx: Prisma.TransactionClient, bookingId: string) {
  return (await tx.paymentOrder.findUnique({
    where: { bookingId_purpose: { bookingId, purpose: 'advance' } }, select: { status: true },
  }))?.status === 'paid';
}

export async function paymentBlocked(tx: Prisma.TransactionClient, bookingId: string, includeDispute = true) {
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId }, select: { cancelledAt: true, dispute: { select: { dismissedAt: true } }, refundRequest: { select: { status: true } } },
  });
  return Boolean(booking.cancelledAt || (includeDispute && booking.dispute?.dismissedAt === null) ||
    booking.refundRequest?.status === 'requested' || booking.refundRequest?.status === 'approved');
}

export async function checkoutExpiry(
  tx: Prisma.TransactionClient, booking: Pick<Booking, 'id' | 'agreedAt' | 'startsAt'>,
  purpose: 'advance' | 'balance' | 'deposit', now: Date, lifetimeMs: number,
) {
  if (!booking.agreedAt || await paymentBlocked(tx, booking.id)) return null;
  if (purpose === 'balance') {
    const completion = await tx.bookingCompletion.findUnique({ where: { bookingId: booking.id } });
    return completion && await paidAdvance(tx, booking.id) ? new Date(now.getTime() + lifetimeMs) : null;
  }
  return booking.startsAt > now ? new Date(Math.min(booking.startsAt.getTime(), now.getTime() + lifetimeMs)) : null;
}
