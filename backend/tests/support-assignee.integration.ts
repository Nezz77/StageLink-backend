import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
import { consume } from '../shared/outbox.js';

const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'support-assignee-' + randomUUID() });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) throw Error('Support notifications require an isolated test database');

test('support assignee alerts are durable, deduplicated and omit confidential content and ineligible recipients', async () => {
  const deps = resources(config), { app } = await createApp(config, deps), users: string[] = [];
  let caseId: string | undefined;
  await app.listen(0, '127.0.0.1'); const root = await app.getUrl() + '/api/v1/';
  async function actor(role: 'customer' | 'admin') {
    const user = await deps.db.authUser.create({ data: { email: randomUUID() + '@stagelink.test', displayName: 'Support assignee fixture', passwordHash: 'unused', roles: [role], emailVerifiedAt: new Date() } }); users.push(user.id);
    const session = await deps.db.authSession.create({ data: { userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600000) } });
    const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
    return { id: user.id, headers: { Authorization: 'Bearer ' + token, Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id) } };
  }
  type Actor = Awaited<ReturnType<typeof actor>>;
  async function call(actor: Actor, path: string, body?: unknown) {
    const response = await fetch(root + path, { method: body === undefined ? 'GET' : 'POST', headers: actor.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  }
  async function events() { return deps.db.outboxEvent.findMany({ where: { topic: 'notification.create.v1', payload: { path: ['sourceId'], equals: caseId! } }, orderBy: { createdAt: 'asc' } }); }
  try {
    const member = await actor('customer'), dispatcher = await actor('admin'), first = await actor('admin'), second = await actor('admin'), outsider = await actor('customer');
    const created = await call(member, 'cases', { requestKey: randomUUID(), subject: 'Assigned case fixture', body: 'Synthetic confidential details never included in an alert.' });
    assert.equal(created.status, 200); caseId = created.data.id;
    const path = 'cases/' + caseId, assignment = 'admin/' + path + '/assignment';
    const assign = { expectedRevision: 1, assigneeId: first.id, reason: 'Assign to the first support administrator.' };
    const concurrent = await Promise.all([call(dispatcher, assignment, assign), call(dispatcher, assignment, assign)]);
    assert.deepEqual(concurrent.map(row => row.status).sort(), [200, 409]);
    assert.equal((await events()).length, 1);
    assert.equal((await call(dispatcher, assignment, { ...assign, expectedRevision: 2 })).status, 200);
    assert.equal((await events()).length, 1, 'No-op assignment adds no notification');
    const reply = { requestKey: randomUUID(), body: 'Confidential member reply, not notification text.' };
    assert.ok((await Promise.all([call(member, path + '/replies', reply), call(member, path + '/replies', reply)])).every(row => row.status === 200));
    assert.equal((await events()).length, 2, 'Duplicate member command creates one alert');
    assert.equal((await call(member, path + '/replies', { ...reply, body: 'Changed request key payload.' })).status, 409);
    assert.equal((await call(outsider, path + '/replies', { requestKey: randomUUID(), body: 'Unauthorized reply.' })).status, 404);
    assert.equal((await call(dispatcher, 'admin/' + path + '/notes', { requestKey: randomUUID(), body: 'Never notify the member about this internal note.' })).status, 200);
    assert.equal((await events()).length, 2);
    assert.equal((await call(dispatcher, assignment, { expectedRevision: 2, assigneeId: second.id, reason: 'Reassign to the second support administrator.' })).status, 200);
    assert.equal((await call(member, path + '/replies', { requestKey: randomUUID(), body: 'Reply to the new assignee.' })).status, 200);
    let queued = await events(); assert.equal(queued.length, 4);
    assert.deepEqual(queued.map(row => (row.payload as any).recipients), [[first.id], [first.id], [second.id], [second.id]]);
    assert.ok(queued.every(row => !JSON.stringify(row.payload).includes('Confidential') && Object.keys(row.payload as object).sort().join(',') === 'eventKey,kind,recipients,sourceId'));
    for (const state of [{ roles: ['customer'] as ('customer' | 'admin')[] }, { roles: ['admin'] as ('customer' | 'admin')[], emailVerifiedAt: null }, { emailVerifiedAt: new Date(), disabledAt: new Date() }]) {
      await deps.db.authUser.update({ where: { id: second.id }, data: state });
      assert.equal((await call(member, path + '/replies', { requestKey: randomUUID(), body: 'No alert to an ineligible assignee.' })).status, 200);
      assert.equal((await events()).length, 4);
    }
    assert.equal((await call(dispatcher, assignment, { expectedRevision: 3, assigneeId: null, reason: 'Return this case to the unassigned queue.' })).status, 200);
    assert.equal((await call(member, path + '/replies', { requestKey: randomUUID(), body: 'No assigned administrator to notify.' })).status, 200);
    assert.equal((await events()).length, 4);
    assert.equal((await call(dispatcher, assignment, { expectedRevision: 4, assigneeId: dispatcher.id, reason: 'Take ownership of this support case.' })).status, 200);
    assert.equal((await events()).length, 4, 'Self-assignment creates no self-alert');
    assert.equal((await call(member, path + '/replies', { requestKey: randomUUID(), body: 'Notify the newly assigned dispatcher.' })).status, 200);
    assert.equal((await call(dispatcher, 'admin/' + path + '/replies', { requestKey: randomUUID(), body: 'Public reply still notifies the member.' })).status, 200);
    queued = await events(); assert.equal(queued.length, 6);
    for (const event of queued) { await consume(deps.db, event.id); assert.deepEqual(await consume(deps.db, event.id), []); }
    const notifications = await deps.db.notification.findMany({ where: { sourceId: caseId } });
    assert.equal(notifications.length, 6);
    assert.equal(notifications.filter(row => row.recipientId === member.id).length, 1, 'Only the public staff reply notifies the member');
    assert.equal(notifications.filter(row => row.recipientId === first.id).length, 2);
    assert.equal(notifications.filter(row => row.recipientId === second.id).length, 2);
    assert.equal(notifications.filter(row => row.recipientId === dispatcher.id).length, 1);
    assert.equal((await call(outsider, 'me/notifications')).data.items.length, 0);
    const inbox = await call(first, 'me/notifications'); assert.equal(inbox.data.unread, 2);
    assert.ok(inbox.data.items.every((item: any) => Object.keys(item).sort().join(',') === 'createdAt,id,kind,readAt,sourceId'));
  } finally {
    try {
      if (caseId) {
        await deps.db.notification.deleteMany({ where: { sourceId: caseId } });
        await deps.db.outboxEvent.deleteMany({ where: { topic: 'notification.create.v1', payload: { path: ['sourceId'], equals: caseId } } });
        await deps.db.supportCase.deleteMany({ where: { id: caseId } });
      }
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
      assert.equal(await deps.db.authUser.count({ where: { id: { in: users } } }), 0);
    } finally { await app.close(); }
  }
});
