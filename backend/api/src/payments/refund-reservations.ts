import type { Prisma } from '../../../generated/prisma/client.js';
import { notifyUsers } from '../../../shared/notifications.js';
import { openAccount, postedBalance, postJournal } from '../../../shared/payments/journal.js';
import { PublicError } from '../auth/errors.js';
import type { Identity } from '../auth/service.js';

export const refundOrderInclude = {
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

export async function refundItem(tx: Prisma.TransactionClient, requestId: string, orderId: string) {
  const row = await tx.refundItem.findUnique({
    where: { requestId_orderId: { requestId, orderId } }, include: includes,
  });
  if (!row) throw new PublicError(404, 'REFUND_ITEM_NOT_FOUND', 'This refund line is unavailable.');
  return row;
}

export type Item = Awaited<ReturnType<typeof refundItem>>;
export type Reserved = { accountId: string; purpose: 'deposit' | 'service' };

export function validApprovedRefund(item: Item) {
  return item.request.status === 'approved' && item.order.bookingId === item.request.bookingId &&
    item.order.currency === 'LKR' && item.amountMinor === item.order.amountMinor;
}

export async function reservedFunds(tx: Prisma.TransactionClient, item: Item): Promise<Reserved | null> {
  if (!item.reservationId || !validApprovedRefund(item)) return null;
  const purpose = item.order.purpose === 'deposit' ? 'deposit' : 'service';
  return findRefundReserve(tx, item.reservationId, {
    purpose, source: 'refund.sandbox.reserve', scope: 'sandbox:refund:' + item.requestId + ':' + item.orderId,
  }, item.amountMinor);
}

export async function findRefundReserve(
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
