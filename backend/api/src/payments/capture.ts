import type { PaymentOrder, Prisma } from '../../../generated/prisma/client.js';
import { issueDocument } from '../../../shared/booking-documents.js';
import { notifyUsers } from '../../../shared/notifications.js';
import { openAccount, postJournal } from '../../../shared/payments/journal.js';

const gateways = {
  stripe: { label: 'Stripe', clearingScope: 'gateway:stripe:test', journalSource: 'stripe.test.capture' },
  payhere: { label: 'PayHere', clearingScope: 'gateway:payhere:sandbox', journalSource: 'payhere.sandbox.capture' },
} as const;

type Order = Pick<PaymentOrder, 'id' | 'bookingId' | 'purpose' | 'amountMinor' | 'currency' | 'status'>;

export async function lockPaymentOrder(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM payment_orders WHERE id=${id}::uuid FOR UPDATE`;
}

export async function recordCapture(
  tx: Prisma.TransactionClient, order: Order, gateway: keyof typeof gateways,
  reference: string, disposition: 'paid' | 'review', at: Date,
) {
  const { label, clearingScope, journalSource } = gateways[gateway];
  const fund = { currency: order.currency, purpose: order.purpose === 'deposit' ? 'deposit' as const : 'service' as const };
  const clearing = await openAccount(tx, { ...fund, scope: clearingScope, kind: 'clearing' });
  const destination = await openAccount(tx, {
    ...fund, scope: disposition === 'paid' ? 'sandbox:booking:' + order.bookingId : 'sandbox:review:' + order.id, kind: 'available',
  });
  const journalId = await postJournal(tx, { ...fund, source: journalSource, reference }, [
    { accountId: clearing.id, amountMinor: -BigInt(order.amountMinor) },
    { accountId: destination.id, amountMinor: BigInt(order.amountMinor) },
  ]);
  await issueDocument(tx, order.bookingId, journalId, {
    version: 1, kind: 'receipt', issuedAt: at.toISOString(), orderId: order.id,
    purpose: order.purpose, amountMinor: order.amountMinor, gateway: label,
    disposition: disposition === 'paid' ? 'captured' : 'review',
  });
  return journalId;
}

export async function updatePaymentStatus(tx: Prisma.TransactionClient, order: Order, status: Order['status']) {
  if (status === order.status) return;
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: order.bookingId }, select: { customerId: true, providerId: true },
  });
  await tx.paymentOrder.update({ where: { id: order.id }, data: { status } });
  await notifyUsers(tx, [booking.customerId, booking.providerId], 'payment', order.bookingId, order.id + ':' + status);
}
