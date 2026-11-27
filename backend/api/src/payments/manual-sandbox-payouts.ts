import { z } from 'zod';
import type { ManualSandboxPayout, PayoutOrder, Prisma } from '../../../generated/prisma/client.js';
import { databaseNow } from '../../../shared/database-clock.js';
import { openAccount, postJournal } from '../../../shared/payments/journal.js';
import { PublicError } from '../auth/errors.js';
import { maxMinor } from '../bookings/lifecycle.js';
import { uuid } from './orders.js';
import { payoutFund } from './payout-eligibility.js';

const positive = z.number().int().positive().max(maxMinor);
const reason = z.string().trim().min(10).max(500);
const testReference = z.string().trim().toUpperCase().regex(/^SBX-[A-Z0-9][A-Z0-9-]{3,75}$/);
export const manualSandboxStatus = z.enum(['awaiting_review', 'settled', 'review_required']);
export const manualSandboxRecord = z.object({
  testReference, amountMinor: positive, destinationRevision: positive, reason,
}).strict();
export const manualSandboxCorrection = z.object({ expectedRevision: positive.max(maxMinor - 1), testReference, reason }).strict();
export const manualSandboxReview = z.object({
  decision: z.enum(['confirm', 'flag']), reason, expectedRevision: positive.optional(),
}).strict();
export const manualSandboxView = z.object({
  id: uuid, payoutId: uuid, revision: positive, testReference, amountMinor: positive, destinationRevision: positive,
  environment: z.literal('sandbox'), currency: z.literal('LKR'), state: manualSandboxStatus,
  recordedBy: uuid, recordReason: z.string(), createdAt: z.iso.datetime(),
  reviewedBy: uuid.nullable(), reviewReason: z.string().nullable(), reviewedAt: z.iso.datetime().nullable(),
  journalId: uuid.nullable(),
});
export const latestManualSandboxPayout = {
  orderBy: { revision: 'desc' }, take: 1,
} satisfies Prisma.PayoutOrder$manualSandboxPayoutsArgs;

export function manualSandboxState(row: Pick<ManualSandboxPayout, 'journalId' | 'reviewedAt'>): z.infer<typeof manualSandboxStatus> {
  return row.journalId ? 'settled' : row.reviewedAt ? 'review_required' : 'awaiting_review';
}

export function presentManualSandbox(row: ManualSandboxPayout) {
  return {
    ...row, state: manualSandboxState(row), environment: 'sandbox' as const, currency: 'LKR' as const,
    createdAt: row.createdAt.toISOString(), reviewedAt: row.reviewedAt?.toISOString() ?? null,
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
  const row = await tx.manualSandboxPayout.findUniqueOrThrow({ where: { payoutId_revision: { payoutId, revision } } });
  return presentManualSandbox(row);
}

export async function reviewManualSandboxPayout(
  tx: Prisma.TransactionClient, payout: PayoutOrder, record: ManualSandboxPayout, actorId: string,
  input: z.infer<typeof manualSandboxReview>, reserve: () => Promise<string>,
) {
  if (record.recordedBy === actorId) {
    throw new PublicError(403, 'MANUAL_PAYOUT_INDEPENDENT_REVIEW_REQUIRED', 'A different administrator must review this record.');
  }
  const expectedState = input.decision === 'confirm' ? 'settled' : 'review_required';
  if (record.reviewedAt) {
    if (record.reviewedBy === actorId && record.reviewReason === input.reason && manualSandboxState(record) === expectedState) {
      return presentManualSandbox(record);
    }
    throw new PublicError(409, 'MANUAL_PAYOUT_REVIEW_RECORDED', 'This sandbox review has already been recorded.');
  }

  let journalId: string | undefined;
  if (input.decision === 'confirm') {
    const reserved = await reserve();
    const fund = payoutFund(payout);
    const cleared = await openAccount(tx, { ...fund, scope: 'sandbox:manual-payouts', kind: 'clearing' });
    const entries = [
      { accountId: reserved, amountMinor: -BigInt(payout.grossMinor) },
      { accountId: cleared.id, amountMinor: BigInt(payout.netMinor) },
    ];
    if (payout.platformFeeMinor > 0) {
      const fee = await openAccount(tx, { ...fund, scope: 'platform:sandbox:manual:fees', kind: 'available' });
      entries.push({ accountId: fee.id, amountMinor: BigInt(payout.platformFeeMinor) });
    }
    journalId = await postJournal(tx, { ...fund, source: 'payout.sandbox.manual.settle', reference: record.id }, entries);
  }
  return presentManualSandbox(await tx.manualSandboxPayout.update({
    where: { id: record.id },
    data: { reviewedBy: actorId, reviewReason: input.reason, reviewedAt: await databaseNow(tx), journalId },
  }));
}
