import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb } from '../shared/resources.js';
import { readConfig } from '../shared/config.js';
import { hasJournalSqlState, openAccount, postedBalance, postJournal, reserveFunds } from '../shared/payments/journal.js';

const config = readConfig();
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Journal integration requires an isolated *_test database.');
}

test('journal posting is balanced, replay-safe, append-only, and cannot over-reserve', async () => {
  const db = createDb(config);
  const scope = randomUUID();
  const fund = { scope, currency: 'LKR', purpose: 'service' as const };
  const command = { ...fund, source: 'fixture-gateway', reference: scope };
  const rollback = new Error('Rollback journal fixture');
  try {
    await assert.rejects(db.$transaction(async tx => {
      const clearing = await openAccount(tx, { ...fund, kind: 'clearing' });
      const available = await openAccount(tx, { ...fund, kind: 'available' });
      const reserved = await openAccount(tx, { ...fund, kind: 'reserved' });
      const entries = [{ accountId: clearing.id, amountMinor: -1000n }, { accountId: available.id, amountMinor: 1000n }];

      async function rejectsStatement(work: () => Promise<unknown>, code: string) {
        await tx.$executeRaw`SAVEPOINT journal_test`;
        try {
          await assert.rejects(work, error => hasJournalSqlState(error, code));
        } finally {
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT journal_test`;
          await tx.$executeRaw`RELEASE SAVEPOINT journal_test`;
        }
      }

      const id = await postJournal(tx, command, entries);
      assert.equal(await postJournal(tx, command, [...entries].reverse()), id);
      await rejectsStatement(() => postJournal(tx, command, [
        { ...entries[0]!, amountMinor: -999n }, { ...entries[1]!, amountMinor: 999n },
      ]), 'SL002');
      await rejectsStatement(() => tx.$executeRaw`UPDATE journal_entries SET amount_minor=1 WHERE transaction_id=${id}::uuid`, '23514');

      const reservation = { source: 'fixture-reservation', reference: scope };
      const reservedId = await reserveFunds(tx, reservation, fund, 700n);
      assert.equal(await reserveFunds(tx, reservation, fund, 700n), reservedId);
      await rejectsStatement(() => reserveFunds(tx, { ...reservation, reference: scope + ':overspend' }, fund, 301n), 'SL001');
      assert.equal(await postedBalance(tx, available.id), 300n);
      assert.equal(await postedBalance(tx, reserved.id), 700n);
      assert.equal(await postedBalance(tx, clearing.id), -1000n);
      throw rollback;
    }, { timeout: 15000 }), error => error === rollback);
    assert.equal(await db.financialAccount.count({ where: { scope } }), 0);
  } finally {
    await db.$disconnect();
  }
});
