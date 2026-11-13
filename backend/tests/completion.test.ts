import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionAmounts, maxMinor } from '../api/src/bookings/lifecycle.js';

test('approved overtime changes the final balance and preserves the original-price platform fee', () => {
  const terms = { version: 1, currency: 'LKR', totalMinor: 35_011, serviceAdvanceMinor: 17_506, depositMinor: 9_000 } as const;
  assert.deepEqual(completionAmounts(terms, 2_001), {
    originalMinor: 35_011, advanceMinor: 17_506, overtimeMinor: 2_001, balanceMinor: 19_506, platformFeeMinor: 1_751,
  });
  assert.throws(() => completionAmounts(terms, maxMinor), { code: 'OVERTIME_TOTAL_LIMIT' });
});
