import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ManualSandboxPayout, ManualSandboxPayoutReversal, PayoutOrder, Prisma } from '../../../generated/prisma/client.js';
import { databaseNow } from '../../../shared/database-clock.js';
import { openAccount, postedBalance, postJournal } from '../../../shared/payments/journal.js';
import { PublicError } from '../auth/errors.js';
import { maxMinor } from '../bookings/lifecycle.js';
import { uuid } from './orders.js';
import { payoutFund, payoutReservationAccount } from './payout-eligibility.js';

const positive = z.number().int().positive().max(maxMinor);
const reason = z.string().trim().min(10).max(500);
const testReference = z.string().trim().toUpperCase().regex(/^SBX-[A-Z0-9][A-Z0-9-]{3,75}$/);
const settlementSource = 'payout.sandbox.manual.settle';
const reversalSource = 'payout.sandbox.manual.reversal';
const clearingScope = 'sandbox:manual-payouts';
const feeScope = 'platform:sandbox:manual:fees';
export const manualSandboxStatus = z.enum(['awaiting_review', 'settled', 'review_required', 'reversed']);
export const manualSandboxRecord = z.object({
  testReference, amountMinor: positive, destinationRevision: positive, reason,
}).strict();
export const manualSandboxCorrection = z.object({ expectedRevision: positive.max(maxMinor - 1), testReference, reason }).strict();
export const manualSandboxReview = z.object({
  decision: z.enum(['confirm', 'flag']), reason, expectedRevision: positive.optional(),
}).strict();
export const manualSandboxReversal = z.object({ expectedRevision: positive, requestKey: uuid, reason }).strict();
const reversalView = z.object({
  id: uuid, settlementId: uuid, requestKey: uuid, actorId: uuid, reason: z.string(), journalId: uuid, createdAt: z.iso.datetime(),
});
export const manualSandboxView = z.object({
  id: uuid, payoutId: uuid, revision: positive, testReference, amountMinor: positive, destinationRevision: positive,
  environment: z.literal('sandbox'), currency: z.literal('LKR'), state: manualSandboxStatus,
  recordedBy: uuid, recordReason: z.string(), createdAt: z.iso.datetime(),
  reviewedBy: uuid.nullable(), reviewReason: z.string().nullable(), reviewedAt: z.iso.datetime().nullable(),
  journalId: uuid.nullable(), reversal: reversalView.nullable(),
});
export const manualEvidenceInclude = { reversal: true } satisfies Prisma.ManualSandboxPayoutInclude;
export const latestManualSandboxPayout = {
  orderBy: { revision: 'desc' }, take: 1,
} satisfies Prisma.PayoutOrder$manualSandboxPayoutsArgs;
type ManualEvidence = ManualSandboxPayout & { reversal: ManualSandboxPayoutReversal | null };

export function manualSandboxState(
  row: Pick<ManualSandboxPayout, 'journalId' | 'reviewedAt'> & { reversal: { id: string } | null },
): z.infer<typeof manualSandboxStatus> {
  if (row.reversal) return 'reversed';
  return row.journalId ? 'settled' : row.reviewedAt ? 'review_required' : 'awaiting_review';
}

export function presentManualSandbox(row: ManualEvidence) {
  return {
    ...row, state: manualSandboxState(row), environment: 'sandbox' as const, currency: 'LKR' as const,
    createdAt: row.createdAt.toISOString(), reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reversal: row.reversal ? { ...row.reversal, createdAt: row.reversal.createdAt.toISOString() } : null,
  };
}

export function assertNoManualSandboxPayout(row: { manualSandboxPayouts: { id: string }[] }) {
  if (row.manualSandboxPayouts.length) {
    throw new PublicError(409, 'MANUAL_SANDBOX_PAYOUT_STARTED', 'This reservation is assigned to manual sandbox reconciliation.');
  }
}

export function matchesManualEvidence(
  row: ManualSandboxPayout, actorId: string, input: { testReference: string; reason: string },
) {
  return row.recordedBy === actorId && row.testReference === input.testReference && row.recordReason === input.reason;
}

export async function createManualEvidence(
  tx: Prisma.TransactionClient, payout: PayoutOrder, revision: number, actorId: string,
  input: { testReference: string; reason: string },
) {
  const payoutId = payout.id;
  const inserted = await tx.manualSandboxPayout.createMany({
    data: {
      payoutId, revision, amountMinor: payout.netMinor, destinationRevision: payout.destinationRevision,
      testReference: input.testReference, recordedBy: actorId, recordReason: input.reason,
    },
    skipDuplicates: true,
  });
  if (!inserted.count) {
    throw new PublicError(409, 'MANUAL_PAYOUT_REFERENCE_REUSED', 'This test reference has already been recorded.');
  }
  const row = await tx.manualSandboxPayout.findUniqueOrThrow({
    where: { payoutId_revision: { payoutId, revision } }, include: manualEvidenceInclude,
  });
  return presentManualSandbox(row);
}

export async function reviewManualSandboxPayout(
  tx: Prisma.TransactionClient, payout: PayoutOrder, record: ManualEvidence, actorId: string,
  input: z.infer<typeof manualSandboxReview>, reserve: () => Promise<string>,
) {
  if (record.recordedBy === actorId) {
    throw new PublicError(403, 'MANUAL_PAYOUT_INDEPENDENT_REVIEW_REQUIRED', 'A different administrator must review this record.');
  }
  if (record.reviewedAt) {
    if (record.reviewedBy === actorId && record.reviewReason === input.reason &&
      Boolean(record.journalId) === (input.decision === 'confirm')) {
      return presentManualSandbox(record);
    }
    throw new PublicError(409, 'MANUAL_PAYOUT_REVIEW_RECORDED', 'This sandbox review has already been recorded.');
  }

  let journalId: string | undefined;
  if (input.decision === 'confirm') {
    const reserved = await reserve();
    const fund = payoutFund(payout);
    const cleared = await openAccount(tx, { ...fund, scope: clearingScope, kind: 'clearing' });
    const entries = [
      { accountId: reserved, amountMinor: -BigInt(payout.grossMinor) },
      { accountId: cleared.id, amountMinor: BigInt(payout.netMinor) },
    ];
    if (payout.platformFeeMinor > 0) {
      const fee = await openAccount(tx, { ...fund, scope: feeScope, kind: 'available' });
      entries.push({ accountId: fee.id, amountMinor: BigInt(payout.platformFeeMinor) });
    }
    journalId = await postJournal(tx, { ...fund, source: settlementSource, reference: record.id }, entries);
  }
  return presentManualSandbox(await tx.manualSandboxPayout.update({
    where: { id: record.id },
    data: { reviewedBy: actorId, reviewReason: input.reason, reviewedAt: await databaseNow(tx), journalId },
    include: manualEvidenceInclude,
  }));
}

export async function reverseManualSandboxPayout(
  tx: Prisma.TransactionClient, payout: PayoutOrder, record: ManualEvidence, actorId: string,
  input: z.infer<typeof manualSandboxReversal>,
) {
  const requestKey = input.requestKey.toLowerCase();
  const prior = record.reversal;
  if (prior) {
    if (prior.requestKey === requestKey && prior.actorId === actorId && prior.reason === input.reason) {
      return presentManualSandbox(record);
    }
    throw new PublicError(409, 'MANUAL_PAYOUT_REVERSAL_RECORDED', 'This sandbox reversal has already been recorded.');
  }
  if (!record.journalId || !record.reviewedBy) {
    throw new PublicError(409, 'MANUAL_PAYOUT_NOT_SETTLED', 'Only a posted manual sandbox settlement can be reversed.');
  }
  if (record.reviewedBy === actorId) {
    throw new PublicError(403, 'MANUAL_PAYOUT_INDEPENDENT_REVERSAL_REQUIRED', 'A different administrator must record the reversal.');
  }

  const fund = payoutFund(payout);
  const [original, reserve] = await Promise.all([
    tx.journalTransaction.findUnique({
      where: { id: record.journalId },
      include: { entries: { include: { account: { select: { scope: true, kind: true } } } } },
    }),
    payoutReservationAccount(tx, payout),
  ]);
  const debit = original?.entries.find(entry => entry.accountId === reserve);
  const net = original?.entries.find(entry => entry.account.scope === clearingScope && entry.account.kind === 'clearing');
  const fee = original?.entries.find(entry => entry.account.scope === feeScope && entry.account.kind === 'available');
  const feeMinor = BigInt(payout.platformFeeMinor);
  if (!original?.postedAt || original.source !== settlementSource || original.reference !== record.id ||
    original.currency !== fund.currency || original.purpose !== fund.purpose || record.amountMinor !== payout.netMinor ||
    !reserve || debit?.amountMinor !== -BigInt(payout.grossMinor) || net?.amountMinor !== BigInt(payout.netMinor) ||
    fee?.amountMinor !== (feeMinor > 0n ? feeMinor : undefined) || original.entries.length !== (feeMinor > 0n ? 3 : 2) ||
    await postedBalance(tx, reserve) !== 0n) {
    throw new PublicError(409, 'MANUAL_PAYOUT_REVERSAL_NOT_ELIGIBLE', 'Review the original settlement journal and reserve before reversing.');
  }

  const id = randomUUID();
  const journalId = await postJournal(tx, { ...fund, source: reversalSource, reference: id },
    original.entries.map(entry => ({ accountId: entry.accountId, amountMinor: -entry.amountMinor })));
  const reversal = await tx.manualSandboxPayoutReversal.create({
    data: { id, settlementId: record.id, requestKey, actorId, reason: input.reason, journalId },
  });
  return presentManualSandbox({ ...record, reversal });
}
