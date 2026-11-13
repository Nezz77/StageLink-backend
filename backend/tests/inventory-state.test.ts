import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canMoveUnit } from '../api/src/catalog/inventory-state.js';

test('dispatch and clearance require the correct physical custody state', () => {
  assert.equal(canMoveUnit('available', 'out'), true);
  assert.equal(canMoveUnit('out', 'out'), false);
  assert.equal(canMoveUnit('out', 'available'), false);
  assert.equal(canMoveUnit('out', 'inspection'), true);
  assert.equal(canMoveUnit('quarantined', 'available'), false);
  assert.equal(canMoveUnit('inspection', 'available'), true);
  assert.equal(canMoveUnit('maintenance', 'out'), false);
  assert.equal(canMoveUnit('retired', 'available'), false);
});
