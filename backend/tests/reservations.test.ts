import assert from 'node:assert/strict';
import { test } from 'node:test';
import { peakReserved } from '../api/src/bookings/reservations.js';

const time = (hour: number) => new Date(Date.UTC(2030, 0, 1, hour));
const held = (start: number, end: number, quantity: number) => ({ startsAt: time(start), endsAt: time(end), quantity });

test('capacity uses peak concurrent allocations across a half-open booking interval', () => {
  const window = { startsAt: time(8), endsAt: time(17) };
  assert.equal(peakReserved([held(6, 8, 90), held(8, 10, 2), held(10, 12, 3), held(17, 18, 90)], window), 3);
  assert.equal(peakReserved([held(6, 12, 2), held(10, 19, 3)], window), 5);
  assert.equal(peakReserved([], window), 0);
});
