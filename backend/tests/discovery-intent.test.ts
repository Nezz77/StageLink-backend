import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiscoveryIntentController, parseDiscoveryIntent } from '../api/src/catalog/discovery-intent.js';

test('discovery intent supports an act, city and explicit LKR price ceiling', () => {
  assert.deepEqual(parseDiscoveryIntent('Please find me a Hip Hop DJ in Sri Jayawardenepura Kotte under Rs. 25,000.50.'), {
    filters: { genre: 'Hip Hop', category: 'DJ', city: 'Sri Jayawardenepura Kotte', maxPriceMinor: 2_500_049 },
    unparsed: null,
  });
  assert.deepEqual(parseDiscoveryIntent('Show me “Acoustic set” in “Mount Lavinia” at most LKR 15000'), {
    filters: { q: 'Acoustic set', city: 'Mount Lavinia', maxPriceMinor: 1_500_000 },
    unparsed: null,
  });
  assert.deepEqual(parseDiscoveryIntent('up to LKR 1,000,000'), {
    filters: { maxPriceMinor: 100_000_000 }, unparsed: null,
  });
});

test('discovery intent preserves unsupported requirements and avoids guessed filters', () => {
  for (const query of [
    'Jazz or Soul', 'Band in Colombo or Kandy', 'Band in two weeks', 'Band under USD 100',
    'DJ under LKR 12,34', 'Jazz up to LKR 1,000,000.01', 'Jazz under LKR 0', '!',
  ]) {
    assert.deepEqual(parseDiscoveryIntent(query), { filters: {}, unparsed: query });
  }
  assert.deepEqual(parseDiscoveryIntent('Band for a wedding in Kandy below LKR 12.01'), {
    filters: { city: 'Kandy', maxPriceMinor: 1_200 }, unparsed: 'Band for a wedding',
  });
});

test('discovery endpoint rejects empty, oversized and extra input', () => {
  const controller = new DiscoveryIntentController();
  for (const body of [{ query: ' ' }, { query: 'a'.repeat(241) }, { query: 'DJ', city: 'Kandy' }]) {
    assert.throws(() => controller.parse(body), { code: 'INVALID_DISCOVERY_INTENT' });
  }
});
