import type { AuthRole, Booking, PayoutOrder, Prisma, VerificationStatus } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import { paymentBlocked } from '../bookings/lifecycle.js';
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

export async function payoutReservationAccount(tx: Prisma.TransactionClient, payout: PayoutOrder) {
  const { purpose, currency } = payoutFund(payout);
  const posting = await tx.journalEntry.findFirst({
    where: {
      transactionId: payout.reservationId, amountMinor: BigInt(payout.grossMinor),
      transaction: {
        postedAt: { not: null }, source: payoutReservationSource(payout),
        reference: payout.arbitrationId ?? payout.damageClaimId ?? payout.bookingId,
      },
      account: { scope: 'sandbox:payout:' + payout.id, kind: 'reserved', currency, purpose },
    }, select: { accountId: true },
  });
  return posting?.accountId ?? null;
}

export function payoutFund(payout: Pick<PayoutOrder, 'damageClaimId'>) {
  return { currency: 'LKR', purpose: payout.damageClaimId ? 'deposit' as const : 'service' as const };
}

export function payoutReservationSource(payout: Pick<PayoutOrder, 'damageClaimId' | 'arbitrationId'>) {
  if (payout.arbitrationId) return 'payout.sandbox.arbitration.reserve';
  return payout.damageClaimId ? 'payout.sandbox.deduction.reserve' : 'payout.sandbox.reserve';
}

export async function payoutBlocked(tx: Prisma.TransactionClient, bookingId: string, arbitrationId?: string | null) {
  if (arbitrationId && !await tx.arbitrationDecision.count({
    where: { id: arbitrationId, dispute: { bookingId, dismissedAt: null } },
  })) return true;
  const hold = await tx.bookingPayoutHold.findFirst({ where: { bookingId }, orderBy: { revision: 'desc' }, select: { held: true } });
  return hold?.held || await paymentBlocked(tx, bookingId, !arbitrationId);
}

export const stripePayoutCaptureInclude = {
  payhereAttempt: { select: { id: true } },
  stripeAttempt: { include: { journal: { select: { postedAt: true, source: true, reference: true } } } },
} satisfies Prisma.PaymentOrderInclude;

export function stripePayoutCapture(order: Prisma.PaymentOrderGetPayload<{ include: typeof stripePayoutCaptureInclude }>, amountMinor: number) {
  const attempt = order.stripeAttempt;
  if (order.status !== 'paid' || order.currency !== 'LKR' || order.amountMinor !== amountMinor ||
    order.payhereAttempt || !attempt?.sessionId || !attempt.journal?.postedAt ||
    attempt.journal.reference !== attempt.sessionId || attempt.journal.source !== 'stripe.test.capture') return null;
  return { id: attempt.id, sessionId: attempt.sessionId, amountMinor, expiresAt: attempt.expiresAt };
}

export async function approvedStripeDeduction(tx: Prisma.TransactionClient, claimId: string, bookingId: string) {
  const claim = await tx.damageClaim.findUnique({
    where: { id: claimId, bookingId },
    include: {
      booking: { select: { targetKind: true } }, depositOrder: { include: stripePayoutCaptureInclude },
      stripeExecution: { include: { settlement: { select: { postedAt: true, source: true, reference: true } } } },
    },
  });
  if (!claim?.resolvedAt || !claim.reservationId || claim.booking.targetKind !== 'rental' || !claim.deductionMinor ||
    claim.refundMinor === null || claim.deductionMinor + claim.refundMinor !== claim.depositMinor ||
    claim.depositOrder?.purpose !== 'deposit' || claim.depositOrder.bookingId !== bookingId) return null;
  const capture = stripePayoutCapture(claim.depositOrder, claim.depositMinor);
  if (!capture) return null;
  const refund = claim.stripeExecution;
  if (claim.refundMinor > 0 && (refund?.status !== 'succeeded' || refund.orderId !== claim.depositOrder.id ||
    refund.amountMinor !== claim.refundMinor || !refund.settlement?.postedAt ||
    refund.settlement.source !== 'stripe.test.refund.settle' || refund.settlement.reference !== refund.providerRefundId)) return null;
  return {
    reservationId: claim.reservationId, amountMinor: claim.deductionMinor,
    capture: { ...capture, refundMinor: claim.refundMinor, refundPaymentIntentId: refund?.paymentIntentId },
  };
}

export async function approvedStripeArbitration(tx: Prisma.TransactionClient, arbitrationId: string, bookingId: string) {
  const decision = await tx.arbitrationDecision.findUnique({
    where: { id: arbitrationId, dispute: { bookingId } },
    include: {
      dispute: { select: { id: true, dismissedAt: true, booking: { select: { providerId: true } } } },
      sources: { orderBy: { orderId: 'asc' }, include: {
        order: { include: stripePayoutCaptureInclude },
        stripeExecution: { include: { settlement: { select: { source: true, reference: true, postedAt: true } } } },
      } },
    },
  });
  if (!decision || decision.dispute.dismissedAt || decision.providerId !== decision.dispute.booking.providerId ||
    decision.payoutMinor <= 0 || decision.sources.reduce((sum, source) => sum + source.capturedMinor, 0) !== decision.heldMinor ||
    decision.sources.reduce((sum, source) => sum + source.refundMinor, 0) !== decision.refundMinor) return null;
  const captures = [];
  for (const source of decision.sources) {
    if (source.order.bookingId !== bookingId || source.order.purpose === 'deposit') return null;
    const capture = stripePayoutCapture(source.order, source.capturedMinor);
    if (!capture) return null;
    const refund = source.stripeExecution;
    if (source.refundMinor > 0 && (refund?.status !== 'succeeded' || refund.amountMinor !== source.refundMinor ||
      !refund.settlement?.postedAt || refund.settlement.source !== 'stripe.test.refund.settle' ||
      refund.settlement.reference !== refund.providerRefundId)) return null;
    captures.push({ ...capture, refundMinor: source.refundMinor, refundPaymentIntentId: refund?.paymentIntentId });
  }
  return { decision, captures };
}
