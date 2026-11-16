import type { Prisma, StripePayoutTransfer } from '../../../generated/prisma/client.js';
import { openAccount, postJournal } from '../../../shared/payments/journal.js';
import type { ConfirmedStripeTransfer } from '../../../shared/payments/stripe-transfers.js';

// The caller holds the booking lock and has matched the observations to this attempt.
export async function recordConfirmedStripeTransfer(
  tx: Prisma.TransactionClient, current: StripePayoutTransfer, observed: ConfirmedStripeTransfer,
) {
  if (current.status === 'rejected' || current.retryAuthorizedAt ||
    (current.providerTransferId && current.providerTransferId !== observed.id) ||
    (current.status === 'review_required' && observed.reversedMinor === 0) ||
    observed.reversedMinor < current.reversedMinor) return current;

  const returned = observed.reversedMinor - current.reversedMinor;
  let journalId = current.journalId;
  if (journalId && returned === 0) return current;

  const fund = { currency: 'LKR', purpose: 'service' } as const;
  const clearing = await openAccount(tx, { ...fund, scope: 'gateway:stripe:test', kind: 'clearing' });
  if (!journalId) {
    const amount = BigInt(current.amountMinor);
    journalId = await postJournal(tx, { ...fund, source: 'stripe.test.payout.transfer', reference: observed.id }, [
      { accountId: current.reservedAccountId, amountMinor: -amount }, { accountId: clearing.id, amountMinor: amount },
    ]);
  }
  if (returned > 0) {
    const amount = BigInt(returned);
    await postJournal(tx, {
      ...fund, source: 'stripe.test.payout.transfer_reversal', reference: current.id + ':' + observed.reversedMinor,
    }, [
      { accountId: clearing.id, amountMinor: -amount }, { accountId: current.reservedAccountId, amountMinor: amount },
    ]);
  }
  return tx.stripePayoutTransfer.update({
    where: { id: current.id }, data: {
      status: observed.reversedMinor > 0 ? 'review_required' : 'transferred',
      journalId, reversedMinor: observed.reversedMinor, providerTransferId: observed.id,
      leaseId: null, leaseUntil: null, updatedAt: new Date(),
    },
  });
}
