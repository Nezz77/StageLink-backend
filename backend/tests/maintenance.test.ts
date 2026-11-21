import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionContext } from '@nestjs/common';
import type { Resources } from '../shared/resources.js';
import { makeMaintenanceGuard } from '../api/src/operations/maintenance.js';

test('maintenance preserves payments, recovery and SMS cancellation while blocking other writes', async () => {
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
  for (const path of ['/api/v1/admin/reminders/:id/cancel','/api/v1/admin/campaigns/:id/cancel','/api/v1/admin/sms-campaigns/:id/cancel']) assert.equal(await check('POST',path),true);
  assert.equal(await check('POST', '/api/v1/payments/webhooks/payhere'), true);
  assert.equal(await check('POST', '/api/v1/payments/webhooks/stripe'), true);
  assert.equal(await check('POST', '/api/v1/auth/login'), true);
  assert.equal(await check('POST', '/api/v1/assets/:id/access'), true);
  assert.equal(await check('PUT', '/api/v1/admin/system/maintenance'), true);
  assert.equal(await check('POST', '/api/v1/discovery/intent'), true);
  assert.equal(await check('POST', '/api/v1/admin/sms-reminders/:id/cancel'), true);
  assert.equal(await check('POST', '/api/v1/me/sms-contact/opt-out'), true);
  assert.equal(await check('POST', '/api/v1/me/sms-contact/revoke'), true);
  assert.equal(await check('POST', '/api/v1/admin/communications/smtp-check'), true);
  assert.equal(reads, 0);
  await assert.rejects(check('POST', '/api/v1/admin/sms-reminders/:id/retry'), { code: 'MAINTENANCE_MODE' });
  for (const [method, path] of [['PUT', '/api/v1/me/sms-contact/consent'], ['POST', '/api/v1/me/sms-contact/verification'], ['POST', '/api/v1/me/sms-contact/confirm']]) {
    await assert.rejects(check(method!, path!), { code: 'MAINTENANCE_MODE' });
  }
  for (const path of ['/api/v1/admin/reminders/:id/retry','/api/v1/admin/campaigns/:id/schedule','/api/v1/admin/sms-campaigns/:id/schedule']) await assert.rejects(check('POST',path), { code: 'MAINTENANCE_MODE' });
  await assert.rejects(check('POST', '/api/v1/payment-orders/:id/sessions/stripe'), { code: 'MAINTENANCE_MODE' });
  assert.equal(headers.get('Retry-After'), '60');
  maintenance = false;
  assert.equal(await check('POST', '/api/v1/payment-orders/:id/sessions/stripe'), true);
});
