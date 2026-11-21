import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { io, type Socket } from 'socket.io-client';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources, ensureRedis } from '../shared/resources.js';

const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'support-live-' + randomUUID() });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) throw Error('Support realtime tests require an isolated test database');
function next(socket: Socket, name: string) {
  return new Promise<unknown>((resolve, reject) => {
    const receive = (value: unknown) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { socket.off(name, receive); reject(Error('Missing ' + name)); }, 5000);
    socket.once(name, receive);
  });
}
async function command(socket: Socket, event: string, body: unknown): Promise<any> {
  return socket.timeout(5000).emitWithAck(event, body);
}

test('support invalidations cross replicas and reauthorize private staff changes without exposing case contents', { timeout: 60000 }, async () => {
  const deps = resources(config), replicaDeps = resources(config);
  const { app } = await createApp(config, deps), { app: replica } = await createApp(config, replicaDeps);
  const users: string[] = [], clients: Socket[] = [], caseIds: string[] = [];
  const settings = await deps.db.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
  await app.listen(0, '127.0.0.1');
  await replica.listen(0, '127.0.0.1');
  const base = await app.getUrl(), otherBase = await replica.getUrl();
  async function actor(role: 'customer' | 'admin', verified = true) {
    const user = await deps.db.authUser.create({ data: { email: randomUUID() + '@stagelink.test', displayName: 'Support realtime fixture', passwordHash: 'unused', roles: [role], emailVerifiedAt: verified ? new Date() : null } });
    users.push(user.id);
    const session = await deps.db.authSession.create({ data: { userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600000) } });
    const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
    return { id: user.id, sessionId: session.id, token, headers: { Authorization: 'Bearer ' + token, Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id) } };
  }
  type Actor = Awaited<ReturnType<typeof actor>>;
  async function call(a: Actor, path: string, body?: unknown, host = base) {
    const response = await fetch(host + '/api/v1/' + path, { method: body === undefined ? 'GET' : 'POST', headers: a.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  }
  async function client(a: Actor, host = base) {
    const socket = io(host, { path: '/api/v1/chat/socket.io', transports: ['websocket'], auth: { accessToken: a.token }, extraHeaders: { Origin: config.WEB_ORIGIN }, autoConnect: false, reconnection: false, forceNew: true });
    clients.push(socket);
    const connected = next(socket, 'connect'); socket.connect(); await connected;
    return socket;
  }
  const pause = () => new Promise(resolve => setTimeout(resolve, 150));
  try {
    const owner = await actor('customer'), outsider = await actor('customer'), admin = await actor('admin'), unverified = await actor('admin', false);
    const created = await call(owner, 'cases', { requestKey: randomUUID(), subject: 'Live support fixture', body: 'This synthetic case verifies live conversation updates.' });
    assert.equal(created.status, 200);
    const id = created.data.id as string; caseIds.push(id);
    const memberSocket = await client(owner), staffSocket = await client(admin, otherBase), outsiderSocket = await client(outsider), unverifiedSocket = await client(unverified);
    const memberEvents: unknown[] = [], staffEvents: unknown[] = [], outsiderEvents: unknown[] = [];
    memberSocket.on('support:changed', value => memberEvents.push(value));
    staffSocket.on('support:changed', value => staffEvents.push(value));
    outsiderSocket.on('support:changed', value => outsiderEvents.push(value));
    assert.equal((await command(outsiderSocket, 'support:join', { caseId: id })).error.code, 'SUPPORT_CASE_NOT_FOUND');
    assert.equal((await command(unverifiedSocket, 'support:join', { caseId: id })).error.code, 'SUPPORT_CASE_NOT_FOUND');
    assert.equal((await command(memberSocket, 'support:join', { caseId: id, staffOnly: true })).error.code, 'INVALID_CHAT_EVENT');
    assert.equal((await command(memberSocket, 'support:join', { caseId: randomUUID() })).error.code, 'SUPPORT_CASE_NOT_FOUND');
    assert.deepEqual((await command(memberSocket, 'support:join', { caseId: id.toUpperCase() })).data, { caseId: id });
    assert.equal((await command(staffSocket, 'support:join', { caseId: id })).ok, true);
    async function publicWrite(a: Actor, path: string, body: object, host = base) {
      const memberSignal = next(memberSocket, 'support:changed'), staffSignal = next(staffSocket, 'support:changed');
      const result = await call(a, path, body, host); assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.deepEqual(await memberSignal, { caseId: id }); assert.deepEqual(await staffSignal, { caseId: id });
      return result;
    }
    const path = 'cases/' + id;
    const channel = 'stagelink:support:v1:' + config.AUTH_RATE_PREFIX + ':' + (deps.redis.options.db ?? 0);
    const beforeInvalid = [memberEvents.length, staffEvents.length];
    await ensureRedis(deps.redis);
    for (const body of ['not-json', 'x'.repeat(257), JSON.stringify({ publisher: randomUUID(), change: { caseId: id, staffOnly: false, body: 'Injected content' } })]) {
      await deps.redis.publish(channel, body);
    }
    await deps.redis.publish(channel + '-other-namespace', JSON.stringify({ publisher: randomUUID(), change: { caseId: id, staffOnly: false } }));
    await pause();
    assert.deepEqual([memberEvents.length, staffEvents.length], beforeInvalid);
    await publicWrite(owner, path + '/replies', { requestKey: randomUUID(), body: 'Member reply with confidential details.' });
    const beforePrivate = memberEvents.length;
    let signal = next(staffSocket, 'support:changed');
    assert.equal((await call(admin, 'admin/' + path + '/notes', { requestKey: randomUUID(), body: 'Staff-only confidential internal note.' })).status, 200);
    assert.deepEqual(await signal, { caseId: id });
    signal = next(staffSocket, 'support:changed');
    assert.equal((await call(admin, 'admin/' + path + '/assignment', { expectedRevision: 1, assigneeId: admin.id, reason: 'Assign this case to the testing administrator.' }, otherBase)).status, 200);
    assert.deepEqual(await signal, { caseId: id }); await pause();
    assert.equal(memberEvents.length, beforePrivate, 'Neither private note nor assignment signals reach members');
    await publicWrite(admin, 'admin/' + path + '/replies', { requestKey: randomUUID(), body: 'Public staff reply.' }, otherBase);
    await publicWrite(admin, 'admin/' + path + '/status', { expectedRevision: 2, status: 'resolved', reason: 'The synthetic issue has been resolved.' });
    const beforeRejected = memberEvents.length;
    assert.equal((await call(owner, path + '/replies', { requestKey: randomUUID(), body: 'Rejected while resolved.' })).status, 409);
    await pause(); assert.equal(memberEvents.length, beforeRejected);
    await publicWrite(admin, 'admin/' + path + '/status', { expectedRevision: 3, status: 'open', reason: 'Reopen for the remaining test checks.' });
    const history = await call(owner, path + '/replies');
    assert.equal(history.status, 200);
    assert.ok(!JSON.stringify(history.data).includes('Staff-only confidential'));
    assert.ok(staffEvents.every(event => JSON.stringify(event) === JSON.stringify({ caseId: id })));
    assert.equal(outsiderEvents.length, 0);

    await deps.db.authUser.update({ where: { id: admin.id }, data: { emailVerifiedAt: null } });
    const staffBeforeRevocation = staffEvents.length;
    signal = next(memberSocket, 'support:changed');
    assert.equal((await call(owner, path + '/replies', { requestKey: randomUUID(), body: 'Only the owner remains authorized for updates.' })).status, 200);
    await signal; await pause(); assert.equal(staffEvents.length, staffBeforeRevocation);
    await deps.db.authUser.update({ where: { id: admin.id }, data: { emailVerifiedAt: new Date() } });
    assert.equal((await command(staffSocket, 'support:join', { caseId: id })).ok, true);
    assert.equal((await command(memberSocket, 'support:leave', { caseId: id })).ok, true);
    const beforeLeave = memberEvents.length;
    signal = next(staffSocket, 'support:changed');
    assert.equal((await call(admin, 'admin/' + path + '/replies', { requestKey: randomUUID(), body: 'Persisted while the member is disconnected.' })).status, 200);
    await signal; await pause(); assert.equal(memberEvents.length, beforeLeave);
    assert.ok((await call(owner, path + '/replies')).data.items.some((row: any) => row.body === 'Persisted while the member is disconnected.'));
    assert.equal((await command(memberSocket, 'support:join', { caseId: id })).ok, true);
    await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: true } });
    assert.equal((await command(memberSocket, 'support:join', { caseId: id })).ok, true);
    assert.equal((await call(owner, path + '/replies', { requestKey: randomUUID(), body: 'New writes blocked in maintenance.' })).status, 503);
    assert.equal((await call(owner, path + '/replies')).status, 200);
    await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: false } });

    await deps.db.authSession.update({ where: { id: owner.sessionId }, data: { revokedAt: new Date() } });
    const disconnected = next(memberSocket, 'disconnect'); signal = next(staffSocket, 'support:changed');
    assert.equal((await call(admin, 'admin/' + path + '/replies', { requestKey: randomUUID(), body: 'Revoked sessions receive no changes.' })).status, 200);
    await signal; await disconnected;
    const boundedIds: string[] = [];
    for (let index = 0; index < 17; index++) {
      const row = await deps.db.supportCase.create({ data: { ownerId: outsider.id, requestKey: randomUUID(), subject: 'Bounded subscription', body: 'Synthetic subscription limit fixture.' } });
      caseIds.push(row.id); boundedIds.push(row.id);
    }
    const joins = await Promise.all(boundedIds.map(caseId => command(outsiderSocket, 'support:join', { caseId })));
    assert.equal(joins.filter(result => result.ok).length, 16);
    assert.deepEqual(joins.filter(result => !result.ok).map(result => result.error.code), ['CHAT_ROOM_LIMIT']);

  } finally {
    for (const socket of clients) socket.disconnect();
    try {
      await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: settings.maintenance, maintenanceMessage: settings.maintenanceMessage } });
      for (const id of caseIds) {
        await deps.db.notification.deleteMany({ where: { sourceId: id } });
        await deps.db.outboxEvent.deleteMany({ where: { topic: 'notification.create.v1', payload: { path: ['sourceId'], equals: id } } });
      }
      await deps.db.supportCase.deleteMany({ where: { id: { in: caseIds } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
      assert.equal(await deps.db.authUser.count({ where: { id: { in: users } } }), 0);
      await ensureRedis(deps.redis); let cursor = '0';
      do { const result = await deps.redis.scan(cursor, 'MATCH', config.AUTH_RATE_PREFIX + ':*', 'COUNT', 100); cursor = result[0]; if (result[1].length) await deps.redis.del(...result[1]); } while (cursor !== '0');
    } finally { await replica.close(); await app.close(); }
  }
});
