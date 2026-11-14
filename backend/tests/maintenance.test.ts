import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionContext } from '@nestjs/common';
import type { Resources } from '../shared/resources.js';
import { makeMaintenanceGuard } from '../api/src/operations/maintenance.js';

test('maintenance rejects business writes and preserves payments and recovery routes', async () => {
  let maintenance = true;
  let reads = 0;
  const db = { systemSetting: { findUniqueOrThrow: async () => {
    reads++;
    return { maintenance, maintenanceMessage: null };
  } } } as unknown as Resources['db'];
  const guard = makeMaintenanceGuard(db);
  const headers = new Map<string, string>();
  const context = (method: string, path: string) => ({
    switchToHttp: () => ({
      getRequest: () => ({ method, route: { path } }),
      getResponse: () => ({ setHeader: (name: string, value: string) => headers.set(name, value) }),
    }),
  } as ExecutionContext);
  const check = async (method: string, path: string) => guard.canActivate(context(method, path));

  assert.equal(await check('GET', '/api/v1/me'), true);
  assert.equal(await check('POST', '/api/v1/payments/webhooks/payhere'), true);
  assert.equal(await check('POST', '/api/v1/payments/webhooks/stripe'), true);
  assert.equal(await check('POST', '/api/v1/auth/login'), true);
  assert.equal(await check('POST', '/api/v1/assets/:id/access'), true);
  assert.equal(await check('PUT', '/api/v1/admin/system/maintenance'), true);
  assert.equal(await check('POST', '/api/v1/discovery/intent'), true);
  assert.equal(reads, 0);
  await assert.rejects(check('POST', '/api/v1/payment-orders/:id/sessions/stripe'), { code: 'MAINTENANCE_MODE' });
  assert.equal(headers.get('Retry-After'), '60');
  maintenance = false;
  assert.equal(await check('POST', '/api/v1/payment-orders/:id/sessions/stripe'), true);
});
