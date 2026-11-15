import { randomUUID } from 'node:crypto';
import type { JournalPurpose, Prisma } from '../../generated/prisma/client.js';

type FundScope = { scope: string; currency: string; purpose: JournalPurpose };
type Command = { source: string; reference: string };
type Entry = { accountId: string; amountMinor: bigint };
type AccountKind = 'clearing' | 'available' | 'reserved';

const maxMinor = 9_223_372_036_854_775_807n;
const minMinor = -maxMinor - 1n;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function hasJournalSqlState(error: unknown, code: string) {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as {
    code?: string;
    meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } };
  };
  return failure.code === 'P2010' && (failure.meta?.driverAdapterError?.cause?.originalCode ?? failure.meta?.code) === code;
}

function entryPayload(entries: Entry[]) {
  const values: Record<string, string> = {};
  let balance = 0n;
  for (const { accountId, amountMinor } of entries) {
    const id = accountId.toLowerCase();
    if (!uuid.test(id) || Object.hasOwn(values, id) || amountMinor === 0n ||
        amountMinor < minMinor || amountMinor > maxMinor) {
      throw new Error('Journal entries require distinct accounts and nonzero signed minor units.');
    }
    values[id] = amountMinor.toString();
    balance += amountMinor;
  }
  if (entries.length < 2 || balance !== 0n) throw new Error('Journal entries must balance.');
  return JSON.stringify(values);
}

// This function accepts an existing transaction so the caller can post alongside its business state.
export async function postJournal(
  tx: Prisma.TransactionClient,
  command: Command & Pick<FundScope, 'currency' | 'purpose'>,
  entries: Entry[],
) {
  if (!command.source.trim() || !command.reference.trim() || command.source.length > 60 ||
      command.reference.length > 160 || !/^[A-Z]{3}$/.test(command.currency)) {
    throw new Error('A source, reference and uppercase currency code are required.');
  }
  const result = await tx.$queryRaw<{ id: string }[]>`
    SELECT post_financial_journal(
      ${randomUUID()}::uuid, ${command.source}::varchar, ${command.reference}::varchar,
      ${command.currency}::char(3), ${command.purpose}::"JournalPurpose", ${entryPayload(entries)}::jsonb
    ) AS id
  `;
  if (!result[0]) throw new Error('Journal posting returned no transaction.');
  return result[0].id;
}

export async function openAccount(tx: Prisma.TransactionClient, identity: FundScope & { kind: AccountKind }) {
  if (!identity.scope.trim() || identity.scope.length > 120 || !/^[A-Z]{3}$/.test(identity.currency)) {
    throw new Error('A scope and uppercase currency code are required.');
  }
  await tx.financialAccount.createMany({ data: identity, skipDuplicates: true });
  return tx.financialAccount.findUniqueOrThrow({ where: { scope_currency_purpose_kind: identity } });
}

export async function reserveFunds(tx: Prisma.TransactionClient, command: Command, fund: FundScope, amountMinor: bigint) {
  if (amountMinor < 1n || amountMinor > maxMinor) throw new Error('Reserve a positive amount in minor units.');
  // Acquire accounts in a consistent order even on the first reservation for a scope.
  const available = await openAccount(tx, { ...fund, kind: 'available' });
  const reserved = await openAccount(tx, { ...fund, kind: 'reserved' });
  return postJournal(tx, { ...command, currency: fund.currency, purpose: fund.purpose }, [
    { accountId: available.id, amountMinor: -amountMinor },
    { accountId: reserved.id, amountMinor },
  ]);
}

export async function postedBalance(tx: Prisma.TransactionClient, accountId: string) {
  const rows = await tx.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(sum(e.amount_minor), 0)::text AS balance
    FROM journal_entries e JOIN journal_transactions j ON j.id = e.transaction_id
    WHERE e.account_id = ${accountId}::uuid AND j.posted_at IS NOT NULL
  `;
  return BigInt(rows[0]!.balance);
}
