import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { runSmsDeliverySmoke } from '../scripts/sms-delivery-smoke.js';

const config = {
  origin: 'https://staging.example.test', verificationId: randomUUID(), reminderId: randomUUID(), campaignId: randomUUID(),
  expectedRecipients: 2, sessions: { member: 'fixture.member.signature', admin: 'fixture.admin.signature' },
};
const stamp = '2026-11-21T08:00:00.000Z';

test('SMS smoke rejects accepted messages, other fixture IDs and an incompletely delivered campaign', async () => {
  const report = await runSmsDeliverySmoke(config, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, config.origin);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    const auth = new Headers(init?.headers).get('Authorization');
    if (url.pathname.endsWith('/sms-verifications')) {
      assert.equal(auth, 'Bearer ' + config.sessions.member);
      return Response.json({ items: [{ id: config.verificationId, status: 'accepted', confirmedAt: stamp }] });
    }
    if (url.pathname.endsWith('/booking-sms-reminders')) {
      assert.equal(auth, 'Bearer ' + config.sessions.member);
      return Response.json({ items: [{ id: randomUUID(), status: 'delivered', checkedAt: stamp }] });
    }
    assert.equal(url.pathname, '/api/v1/admin/sms-campaigns/' + config.campaignId);
    assert.equal(auth, 'Bearer ' + config.sessions.admin);
    return Response.json({
      id: config.campaignId, state: 'scheduled', recipientCount: 2, message: 'Private campaign text',
      deliveryCounts: { queued: 0, sending: 0, accepted: 1, delivered: 1, failed: 0, unknown: 0, skipped: 0 },
    });
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks.map(item => item.passed), [false, false, false]);
  assert.doesNotMatch(JSON.stringify(report), /signature|Private campaign text|staging.example.test/);
  assert.ok(!JSON.stringify(report).includes(config.verificationId));
});
