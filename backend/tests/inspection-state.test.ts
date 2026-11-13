import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgmentPhase, draftPhase, hasDiscrepancy } from '../api/src/bookings/inspection-state.js';

test('return discrepancies require quarantine and clearance evidence', () => {
  assert.equal(hasDiscrepancy({ units: [{ condition: 'good' }, { condition: 'worn' }], accessories: [true] }), false);
  assert.equal(hasDiscrepancy({ units: [{ condition: 'missing' }], accessories: [true] }), true);
  assert.equal(hasDiscrepancy({ units: [{ condition: 'damaged' }], accessories: [true] }), true);
  assert.equal(hasDiscrepancy({ units: [{ condition: 'good' }], accessories: [false] }), true);
  assert.equal(draftPhase.quarantined, undefined);
  assert.equal(draftPhase.clearance_draft, 'clearance');
  assert.equal(acknowledgmentPhase.return_ack, 'return');
});
