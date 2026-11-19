import { randomUUID } from 'node:crypto';
import type { PayoutOrder, Prisma, StripeBankPayoutSettlement, StripePayoutTransfer } from '../../../generated/prisma/client.js';
import { openAccount, postedBalance, postJournal } from '../../../shared/payments/journal.js';
import type { checkStripeBankPayout } from '../../../shared/payments/stripe-bank-payouts.js';
import { PublicError } from '../auth/errors.js';
import { payoutBlocked, payoutFund, payoutReservationAccount } from './payout-eligibility.js';

type Evidence = Awaited<ReturnType<typeof checkStripeBankPayout>>;

export function activeBankSettlement(tx: Prisma.TransactionClient, transferId: string) {
  return tx.stripeBankPayoutSettlement.findFirst({ where: { transferId, reviewReason: null } });
}

// Both transfer reconciliation and bank settlement hold the same booking lock.
export async function reverseBankSettlement(
  tx: Prisma.TransactionClient, row: StripeBankPayoutSettlement,
  reason: 'bank_payout_failed' | 'transfer_reversed', actorId: string | null,
) {
  const journal = await tx.journalTransaction.findUniqueOrThrow({
    where: { id: row.journalId! }, include: { entries: true },
  });
  const reversalJournalId = await postJournal(tx, {
    currency: journal.currency, purpose: journal.purpose, source: 'stripe.test.bank_payout.reversal', reference: row.id,
  }, journal.entries.map(entry => ({ accountId: entry.accountId, amountMinor: -entry.amountMinor })));
  return tx.stripeBankPayoutSettlement.update({
    where: { id: row.id }, data: {
      reversalJournalId, reviewReason: reason, reviewActorId: actorId, updatedAt: new Date(),
    },
  });
}

export async function reconcileBankSettlement(
  tx: Prisma.TransactionClient, payout: PayoutOrder, transfer: StripePayoutTransfer,
  bankPayoutId: string, evidence: Evidence, actorId: string,
) {
  const identity = { transferId: transfer.id, bankPayoutId };
  const previous = await tx.stripeBankPayoutSettlement.findUnique({ where: { transferId_bankPayoutId: identity } });
  if (evidence.payoutFailed) {
    if (previous) return previous.reviewReason ? previous : reverseBankSettlement(tx, previous, 'bank_payout_failed', actorId);
    return tx.stripeBankPayoutSettlement.create({
      data: { ...identity, actorId, reviewActorId: actorId, reviewReason: 'bank_payout_failed' },
    });
  }
  if (previous || evidence.status !== 'included' || !evidence.balanceTransactionId) return previous;
  if (await activeBankSettlement(tx, transfer.id)) {
    throw new PublicError(409, 'STRIPE_BANK_PAYOUT_ALREADY_SETTLED', 'Reconcile the recorded bank payout before posting another.');
  }
  const reserved = await payoutReservationAccount(tx, payout);
  const fee = BigInt(payout.platformFeeMinor);
  if (await payoutBlocked(tx, payout.bookingId, payout.arbitrationId) || !reserved || reserved !== transfer.reservedAccountId ||
    transfer.amountMinor !== payout.netMinor || await postedBalance(tx, reserved) !== fee) {
    throw new PublicError(409, 'STRIPE_BANK_SETTLEMENT_NOT_ELIGIBLE', 'Review the booking hold, payment status, and payout reserve.');
  }

  const id = randomUUID();
  const fund = payoutFund(payout);
  const stripe = await openAccount(tx, { ...fund, scope: 'gateway:stripe:test', kind: 'clearing' });
  const bank = await openAccount(tx, { ...fund, scope: 'gateway:stripe:test:bank', kind: 'clearing' });
  const amount = BigInt(transfer.amountMinor);
  const entries = [{ accountId: stripe.id, amountMinor: -amount }, { accountId: bank.id, amountMinor: amount }];
  if (fee > 0n) {
    const revenue = await openAccount(tx, { ...fund, scope: 'platform:stripe:test:fees', kind: 'available' });
    entries.push({ accountId: reserved, amountMinor: -fee }, { accountId: revenue.id, amountMinor: fee });
  }
  const journalId = await postJournal(tx, { ...fund, source: 'stripe.test.bank_payout.settled', reference: id }, entries);
  return tx.stripeBankPayoutSettlement.create({
    data: { ...identity, id, actorId, journalId, balanceTransactionId: evidence.balanceTransactionId },
  });
}
