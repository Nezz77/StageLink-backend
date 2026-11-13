import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gigPackages } from '../api/src/catalog/packages.js';

const addon = { id: 'sound', title: 'Sound system', priceMinor: 5000 };
const fixed = {
  title: 'Acoustic performance', pricing: 'fixed', durationMinutes: 120, performers: 2,
  basePriceMinor: 100000, included: 'Acoustic set', excluded: 'Lighting', addons: [addon],
};
const standard = { ...fixed, id: 'standard' };
const deluxe = { ...fixed, id: 'deluxe' };
const vip = { ...fixed, id: 'vip', pricing: 'custom', basePriceMinor: null, addons: [] };

test('package snapshots accept three complete tiers or an empty package catalog', () => {
  assert.equal(gigPackages.safeParse([standard, deluxe, vip]).success, true);
  assert.equal(gigPackages.safeParse([]).success, true);
  assert.equal(gigPackages.safeParse([standard, deluxe, { ...fixed, id: 'vip' }]).success, true);
});

test('package snapshots reject invalid durations, tiers, pricing and add-ons', () => {
  for (const catalog of [
    [standard, deluxe],
    [deluxe, standard, vip],
    [{ ...standard, durationMinutes: 91 }, deluxe, vip],
    [{ ...standard, performers: 0 }, deluxe, vip],
    [{ ...standard, basePriceMinor: null }, deluxe, vip],
    [{ ...vip, id: 'standard' }, deluxe, vip],
    [standard, deluxe, { ...vip, addons: [addon] }],
    [{ ...standard, addons: [addon, addon] }, deluxe, vip],
    [{ ...standard, basePriceMinor: 100_000_000 }, deluxe, vip],
  ]) assert.equal(gigPackages.safeParse(catalog).success, false, JSON.stringify(catalog));
});
