import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma } from '../generated/prisma/client.js';
import { analyticsPeriod, readAnalytics } from '../api/src/operations/analytics.js';

test('analytics validates bounded UTC windows, currency and environment', () => {
  const period = analyticsPeriod({}, new Date('2024-03-01T08:30:00Z'));
  assert.equal(period.from.toISOString(), '2024-02-01T00:00:00.000Z');
  assert.equal(period.to.toISOString(), '2024-03-02T00:00:00.000Z');
  assert.equal(period.environment, 'sandbox');
  assert.throws(() => analyticsPeriod({ from: '2024-03-01', to: '2024-03-01' }), { code: 'INVALID_ANALYTICS_PERIOD' });
  assert.throws(() => analyticsPeriod({ from: '2023-01-01', to: '2024-03-01' }), { code: 'INVALID_ANALYTICS_PERIOD' });
  assert.throws(() => analyticsPeriod({ currency: 'USD' }), { code: 'INVALID_ANALYTICS_FILTER' });
});

test('analytics fills empty days and preserves the exact totals of posted amounts', async () => {
  const period = analyticsPeriod({ from: '2024-02-28', to: '2024-03-01' });
  const tx = { $queryRaw: async (strings: TemplateStringsArray) => strings.join('').includes('WITH journal') ? [
    { day: '2024-02-28', metric: 'serviceCapturedMinor', total: '9007199254740993' },
    { day: '2024-02-29', metric: 'serviceCapturedMinor', total: '10' },
    { day: '2024-02-29', metric: 'refundedMinor', total: '9007199254741001' },
  ] : [{ day: '2024-02-28', metric: 'requested', total: '3' }] } as unknown as Prisma.TransactionClient;
  const report = await readAnalytics(tx, period);
  assert.equal(report.bookings.requested, 3);
  assert.equal(report.days[1]?.bookings.requested, 0);
  assert.equal(report.money?.serviceCapturedMinor, '9007199254741003');
  assert.equal(report.settled.refundedMinor, '9007199254741001');
  assert.equal(report.days[0]?.settled.refundedMinor, '0');
  assert.equal(report.days[1]?.settled.refundedMinor, '9007199254741001');
  assert.equal(report.settled.paidOutMinor, null);
  const live = await readAnalytics(tx, { ...period, environment: 'live' }, '6ca57815-ee96-4737-8522-4730d8b11483');
  assert.equal(live.money, null);
  assert.equal(live.settled.refundedMinor, null);
  assert.equal(live.newUsers, null);
});
