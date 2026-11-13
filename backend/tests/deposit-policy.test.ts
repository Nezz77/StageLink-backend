import assert from 'node:assert/strict';
import { test } from 'node:test';
import { depositPolicy } from '../api/src/catalog/deposit-policy.js';

const none = { mode: 'none', currency: 'LKR' };
const terms = 'Refundable after the agreed return inspection.';
const fixed = { mode: 'fixed', currency: 'LKR', amountMinor: 250_000, terms };
const percentage = { mode: 'percentage', currency: 'LKR', basis: 'rental_subtotal', basisPoints: 1250, terms };

test('accepts canonical LKR deposit policies and trims the refund terms', () => {
  for (const policy of [none, fixed, percentage]) assert.deepEqual(depositPolicy.parse(policy), policy);
  assert.deepEqual(depositPolicy.parse({ ...fixed, terms: ' ' + terms + ' ' }), fixed);
  assert.equal(depositPolicy.safeParse({ ...percentage, basisPoints: 10_000 }).success, true);
});

test('rejects mixed modes, wrong currencies and bases, and invalid amounts', () => {
  for (const invalid of [
    { ...none, amountMinor: 1 },
    { ...fixed, currency: 'USD' },
    { ...fixed, amountMinor: 0 },
    { ...fixed, amountMinor: 1.5 },
    { ...fixed, amountMinor: 100_000_001 },
    { ...fixed, terms: '   ' },
    { ...percentage, basis: 'checkout_total' },
    { ...percentage, basisPoints: 12.5 },
    { ...percentage, basisPoints: 0 },
    { ...percentage, basisPoints: 10_001 },
  ]) assert.equal(depositPolicy.safeParse(invalid).success, false, JSON.stringify(invalid));
});
