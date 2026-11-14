import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arbitrationAmounts } from '../api/src/bookings/arbitration.js';

test('arbitration allocates the entire eligible balance and caps the original-price fee', () => {
  assert.deepEqual(arbitrationAmounts('refund', 1000, 1000, 75), { heldMinor: 1000, refundMinor: 1000, feeMinor: 0, payoutMinor: 0 });
  assert.deepEqual(arbitrationAmounts('provider', 1000, 0, 75), { heldMinor: 1000, refundMinor: 0, feeMinor: 75, payoutMinor: 925 });
  assert.deepEqual(arbitrationAmounts('split', 1000, 950, 75), { heldMinor: 1000, refundMinor: 950, feeMinor: 50, payoutMinor: 0 });
  assert.throws(() => arbitrationAmounts('split', 1000, 1001, 75), { code: 'INVALID_ARBITRATION_ALLOCATION' });
  assert.throws(() => arbitrationAmounts('provider', 1000, 1, 75), { code: 'INVALID_ARBITRATION_ALLOCATION' });
});
