import type { AuthRole, Booking, Prisma, VerificationStatus } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import { assertReviewedDestination } from '../profiles/service.js';

type BookingProvider = Pick<Booking, 'providerId' | 'targetKind'>;
type Verification = { kind: AuthRole; status: VerificationStatus };

const payoutProviderKind = (targetKind: Booking['targetKind']) => targetKind === 'rental' ? 'renter' : 'artist';

export function providerVerifiedForPayout(
  targetKind: Booking['targetKind'], roles: AuthRole[], latestCases: Verification[],
) {
  const kind = payoutProviderKind(targetKind);
  return roles.includes(kind) && latestCases.find(row => row.kind === kind)?.status === 'approved';
}

// Call after locking the provider account and booking in the financial transaction.
export async function assertPayoutProvider(
  tx: Prisma.TransactionClient, booking: BookingProvider, destinationRevision: number,
) {
  const destination = await assertReviewedDestination(tx, booking.providerId, destinationRevision);
  const kind = payoutProviderKind(booking.targetKind);
  const latest = await tx.verificationCase.findFirst({
    where: { providerId: booking.providerId, kind, provider: { roles: { has: kind } } },
    orderBy: { version: 'desc' },
    select: { status: true },
  });
  if (latest?.status !== 'approved') {
    throw new PublicError(409, 'PAYOUT_PROVIDER_VERIFICATION_REQUIRED', 'Approve the provider’s identity verification for this booking role before reserving a payout.');
  }
  return destination.revision;
}
