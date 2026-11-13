import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateRental } from '../src/lib/rentalPricing.ts';

test('estimates hourly, multi-day and weekly rental rates in LKR minor units', () => {
  const rates = { hourlyRateMinor: 12550, dailyRateMinor: 240000, weeklyRateMinor: 1450000 };
  assert.equal(estimateRental(rates, 'hour', 3), 37650);
  assert.equal(estimateRental(rates, 'day', 3), 720000);
  assert.equal(estimateRental(rates, 'week', 2), 2900000);
});

test('rejects unavailable rates and incomplete or fractional periods', () => {
  const rates = { hourlyRateMinor: null, dailyRateMinor: 500, weeklyRateMinor: null };
  assert.equal(estimateRental(rates, 'hour', 1), null);
  for (const periods of [0, 1.5, 1001, NaN]) assert.equal(estimateRental(rates, 'day', periods), null);
});
