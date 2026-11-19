import type { Prisma } from '../../../generated/prisma/client.js';
import { notifyUsers } from '../../../shared/notifications.js';
import { openAccount, postedBalance, postJournal } from '../../../shared/payments/journal.js';
import { PublicError } from '../auth/errors.js';
import type { Identity } from '../auth/service.js';

const refundOrderInclude = {
  stripeAttempt: { select: {
    id: true, sessionId: true, expiresAt: true, journalId: true,
    journal: { select: { source: true, reference: true, postedAt: true } },
  } },
  payhereAttempt: { select: { id: true, events: {
    where: { statusCode: '2' },
    select: { reportedPaymentId: true, journal: { select: { source: true, reference: true, postedAt: true } } },
  } } },
} satisfies Prisma.PaymentOrderInclude;

const includes = {
  request: { include: { booking: { select: { customerId: true, providerId: true } } } },
  order: { include: refundOrderInclude },
  stripeExecution: true,
  payHereExecution: true,
} satisfies Prisma.RefundItemInclude;

async function refundItem(tx: Prisma.TransactionClient, requestId: string, orderId: string) {
  const row = await tx.refundItem.findUnique({
    where: { requestId_orderId: { requestId, orderId } }, include: includes,
  });
  if (!row) throw new PublicError(404, 'REFUND_ITEM_NOT_FOUND', 'This refund line is unavailable.');
  return row;
}

export type RefundKey = { requestId: string; orderId: string } | { claimId: string };

export async function refundTarget(tx: Prisma.TransactionClient, key: RefundKey) {
  if ('claimId' in key) {
    const claim = await tx.damageClaim.findUnique({
      where: { id: key.claimId },
      include: {
        booking: { select: { id: true, customerId: true, providerId: true, targetKind: true } },
        depositOrder: { include: refundOrderInclude }, stripeExecution: true, payHereExecution: true,
      },
    });
    if (!claim) throw new PublicError(404, 'DAMAGE_CLAIM_NOT_FOUND', 'This deposit claim is unavailable.');
    const order = claim.depositOrder;
    const amountMinor = claim.refundMinor ?? 0;
    return {
      booking: claim.booking, order, reservationId: claim.reservationId, amountMinor,
      stripeExecution: claim.stripeExecution, payHereExecution: claim.payHereExecution,
      requestId: null, damageClaimId: claim.id,
      approved: Boolean(claim.resolvedAt && claim.booking.targetKind === 'rental' && order?.purpose === 'deposit' &&
        order.bookingId === claim.bookingId && order.currency === 'LKR' && order.amountMinor === claim.depositMinor &&
        amountMinor > 0 && claim.deductionMinor !== null && amountMinor + claim.deductionMinor === claim.depositMinor),
      reserve: { purpose: 'deposit' as const, source: 'deposit.sandbox.reserve', scope: 'sandbox:damage:' + claim.id + ':customer', reference: claim.id },
    };
  }
  const item = await refundItem(tx, key.requestId, key.orderId);
  return {
    booking: { id: item.request.bookingId, ...item.request.booking }, order: item.order,
    reservationId: item.reservationId, amountMinor: item.amountMinor,
    stripeExecution: item.stripeExecution, payHereExecution: item.payHereExecution,
    requestId: item.requestId, damageClaimId: null,
    approved: item.request.status === 'approved' && item.order.bookingId === item.request.bookingId &&
      item.order.currency === 'LKR' && item.amountMinor === item.order.amountMinor,
    reserve: {
      purpose: item.order.purpose === 'deposit' ? 'deposit' as const : 'service' as const,
      source: 'refund.sandbox.reserve', scope: 'sandbox:refund:' + item.requestId + ':' + item.orderId,
    },
  };
}

export type RefundTarget = Awaited<ReturnType<typeof refundTarget>>;
type Reserved = { accountId: string; purpose: 'deposit' | 'service' };

export async function findReservedFunds(
  tx: Prisma.TransactionClient, reservationId: string,
  fund: { purpose: Reserved['purpose']; source: string; scope: string; reference?: string }, amountMinor: number,
): Promise<Reserved | null> {
  const { purpose, source, scope, reference } = fund;
  const amount = BigInt(amountMinor);
  const posting = await tx.journalEntry.findFirst({
    where: {
      transactionId: reservationId, amountMinor: amount,
      transaction: { source, reference, postedAt: { not: null } },
      account: { scope, kind: 'reserved', currency: 'LKR', purpose },
    },
    select: { accountId: true },
  });
  if (!posting || await postedBalance(tx, posting.accountId) < amount) return null;
  return { accountId: posting.accountId, purpose };
}

export function requireRecentIndependentAdmin(actor: Identity, booking: { customerId: string; providerId: string }) {
  const { customerId, providerId } = booking;
  if (actor.user.id === customerId || actor.user.id === providerId) {
    throw new PublicError(403, 'SELF_REVIEW_FORBIDDEN', 'Another administrator must execute this refund.');
  }
  if (Date.now() - actor.session.createdAt.getTime() >= 15 * 60_000) {
    throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before executing this refund.');
  }
}

export async function settleRefund(
  tx: Prisma.TransactionClient, booking: { id: string; customerId: string; providerId: string }, reserved: Reserved, gateway: 'stripe' | 'payhere',
  reference: string, executionId: string, amountMinor: number,
) {
  const environment = gateway === 'stripe' ? 'test' : 'sandbox';
  const fund = { currency: 'LKR', purpose: reserved.purpose };
  const clearing = await openAccount(tx, { ...fund, scope: 'gateway:' + gateway + ':' + environment, kind: 'clearing' });
  const amount = BigInt(amountMinor);
  const settlementId = await postJournal(tx, { ...fund, source: gateway + '.' + environment + '.refund.settle', reference }, [
    { accountId: reserved.accountId, amountMinor: -amount }, { accountId: clearing.id, amountMinor: amount },
  ]);
  await notifyUsers(tx, [booking.customerId, booking.providerId], 'payment', booking.id, gateway + '-refund:' + executionId);
  return settlementId;
}
