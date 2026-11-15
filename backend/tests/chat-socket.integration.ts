import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { io, type Socket } from 'socket.io-client';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { publishNotificationChange } from '../shared/notification-signals.js';
import { notifyUsers } from '../shared/notifications.js';
import { consume } from '../shared/outbox.js';
import { resources } from '../shared/resources.js';

const config = readConfig();
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Booking chat integration requires an isolated *_test database.');
}

function next(socket: Socket, name: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, receive);
      reject(new Error('Missing socket event ' + name));
    }, 5000);
    const receive = (value: unknown) => { clearTimeout(timer); resolve(value); };
    socket.once(name, receive);
  });
}

test('booking sockets and notification subscriptions enforce scopes and check revoked sessions before delivery', async () => {
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const clients: Socket[] = [];
  const outboxIds: string[] = [];
  let replica: typeof app | undefined;
  const users: string[] = [];
  let bookingId: string | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    async function fixture(role: 'customer' | 'artist') {
      const user = await deps.db.authUser.create({ data: {
        roles: [role], email: randomUUID() + '@stagelink.test', emailVerifiedAt: new Date(),
        displayName: 'Chat fixture', passwordHash: 'unused',
      } });
      users.push(user.id);
      const session = await deps.db.authSession.create({ data: {
        userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 900_000),
      } });
      const accessToken = await new SignJWT({ sid: session.id })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user.id)
        .setIssuer('stagelink-api').setAudience('stagelink-web').setIssuedAt().setExpirationTime('10m')
        .sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
      return { userId: user.id, sessionId: session.id, accessToken, csrfToken: csrfFor(config.AUTH_JWT_SECRET, session.id) };
    }
    function client(accessToken: string, origin = config.WEB_ORIGIN, host = base) {
      const socket = io(host, {
        transports: ['websocket'], path: '/api/v1/chat/socket.io', extraHeaders: { Origin: origin },
        auth: { accessToken }, reconnection: false, autoConnect: false, forceNew: true,
      });
      clients.push(socket);
      return socket;
    }
    async function connect(socket: Socket) {
      const connected = next(socket, 'connect');
      socket.connect();
      await connected;
      return socket;
    }
    async function call(actor: Awaited<ReturnType<typeof fixture>>, suffix: string, body?: object) {
      const res = await fetch(base + '/api/v1/conversations/' + bookingId + '/' + suffix, {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json', Origin: config.WEB_ORIGIN,
          Authorization: 'Bearer ' + actor.accessToken, 'X-CSRF-Token': actor.csrfToken,
        },
        body: body && JSON.stringify(body),
      });
      assert.equal(res.status, 200);
      return res.json();
    }

    const customer = await fixture('customer');
    const provider = await fixture('artist');
    const outsider = await fixture('customer');
    const startsAt = new Date(Date.now() + 60_000);
    const booking = await deps.db.booking.create({ data: {
      customerId: customer.userId, providerId: provider.userId, requestKey: randomUUID(), requestDigest: '0'.repeat(64),
      targetKind: 'gig', targetId: randomUUID(), targetVersion: 1, startsAt, endsAt: new Date(Date.now() + 120_000),
      holdExpiresAt: startsAt, snapshot: {},
    } });
    bookingId = booking.id;
    for (const socket of [client('invalid'), client(customer.accessToken, 'https://untrusted.example')]) {
      const rejected = next(socket, 'connect_error');
      socket.connect();
      assert.ok(await rejected);
      assert.equal(socket.connected, false);
    }

    const [buyer, seller, stranger] = await Promise.all([
      connect(client(customer.accessToken)), connect(client(provider.accessToken)), connect(client(outsider.accessToken)),
    ]);
    const room = { bookingId };
    const payload = { ...room, data: { requestKey: randomUUID(), body: 'Can we confirm the setup time?' } };
    const send = () => buyer.timeout(5000).emitWithAck('chat:send', payload);
    assert.equal((await send()).error.code, 'CHAT_JOIN_REQUIRED');
    assert.equal((await stranger.timeout(5000).emitWithAck('chat:join', room)).error.code, 'BOOKING_NOT_FOUND');
    for (const socket of [buyer, seller]) assert.deepEqual(await socket.timeout(5000).emitWithAck('chat:join', room), { ok: true, data: room });

    const system = await deps.db.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
    await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: true } });
    try {
      assert.equal((await send()).error.code, 'MAINTENANCE_MODE');
    } finally {
      await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: system.maintenance } });
    }

    const typing = next(seller, 'chat:typing');
    await buyer.timeout(5000).emitWithAck('chat:typing', { ...room, typing: true });
    assert.deepEqual(await typing, { ...room, userId: customer.userId, typing: true });
    const changed = next(seller, 'chat:changed');
    const sent = await send();
    assert.equal(sent.ok, true);
    assert.deepEqual(await changed, { ...room, kind: 'message', messageId: sent.data.id });
    assert.deepEqual(await send(), sent);
    const receiptEvent = next(buyer, 'chat:changed');
    const receipt = await seller.timeout(5000).emitWithAck('chat:read', { ...room, data: { throughId: sent.data.id } });
    assert.deepEqual(receipt, { ok: true, data: { readerId: provider.userId, throughId: sent.data.id } });
    assert.deepEqual(await receiptEvent, { ...room, kind: 'read', ...receipt.data });

    await deps.db.authSession.update({ where: { id: provider.sessionId }, data: { revokedAt: new Date() } });
    const disconnected = next(seller, 'disconnect');
    const httpEvent = next(buyer, 'chat:changed');
    const another = await call(customer, 'messages', { requestKey: randomUUID(), body: 'Setup starts at 4.' });
    assert.deepEqual(await httpEvent, { ...room, kind: 'message', messageId: another.id });
    assert.equal(await disconnected, 'io server disconnect');
    const since = await call(customer, 'messages?after=' + sent.data.id);
    assert.deepEqual(since.items, [another]);

    replica = (await createApp(config)).app;
    await replica.listen(0, '127.0.0.1');
    const secondTab = await connect(client(customer.accessToken, config.WEB_ORIGIN, await replica.getUrl()));
    const subscribe = (socket: Socket, payload: object) => socket.timeout(5000).emitWithAck('notifications:subscribe', payload);
    assert.equal((await subscribe(stranger, { userId: customer.userId })).error.code, 'INVALID_CHAT_EVENT');
    for (const socket of [buyer, secondTab, stranger]) {
      assert.deepEqual(await subscribe(socket, {}), { ok: true, data: {} });
    }
    let unexpected = 0;
    stranger.on('notifications:changed', () => unexpected++);
    const sourceId = randomUUID();
    await deps.db.$transaction(tx => notifyUsers(tx, [customer.userId], 'support', sourceId, sourceId));
    const event = await deps.db.outboxEvent.findFirstOrThrow({ where: { payload: { path: ['sourceId'], equals: sourceId } } });
    outboxIds.push(event.id);

    const inboxChanges = [next(buyer, 'notifications:changed'), next(secondTab, 'notifications:changed')];
    const recipients = await consume(deps.db, event.id);
    assert.deepEqual(recipients, [customer.userId]);
    await publishNotificationChange(deps.redis, recipients);
    assert.deepEqual(await Promise.all(inboxChanges), [{}, {}]);
    assert.deepEqual(await consume(deps.db, event.id), []);

    async function inbox(actor: Awaited<ReturnType<typeof fixture>>, itemId?: string) {
      const path = itemId ? '/' + itemId + '/read' : '';
      const response = await fetch(base + '/api/v1/me/notifications' + path, {
        method: itemId ? 'PUT' : 'GET',
        headers: {
          'Content-Type': 'application/json', Origin: config.WEB_ORIGIN, 'X-CSRF-Token': actor.csrfToken,
          Authorization: 'Bearer ' + actor.accessToken,
        },
        body: itemId ? '{}' : undefined,
      });
      assert.equal(response.status, 200);
      return response.json();
    }
    const unread = await inbox(customer);
    assert.equal(unread.unread, 1);
    assert.equal(unread.items[0].sourceId, sourceId);
    assert.equal((await inbox(outsider)).unread, 0);
    const readChanged = next(secondTab, 'notifications:changed');
    const readNotification = await inbox(customer, unread.items[0].id);
    assert.ok(readNotification.readAt);
    assert.deepEqual(await readChanged, {});
    assert.equal((await inbox(customer)).unread, 0);

    await deps.db.authSession.update({ where: { id: customer.sessionId }, data: { revokedAt: new Date() } });
    let revokedEvents = 0;
    secondTab.on('notifications:changed', () => revokedEvents++);
    const tabDisconnected = next(secondTab, 'disconnect');
    await publishNotificationChange(deps.redis, [customer.userId]);
    assert.equal(await tabDisconnected, 'io server disconnect');
    assert.equal(revokedEvents, 0);
    assert.equal(unexpected, 0);
  } finally {
    for (const client of clients) client.close();
    try {
      if (bookingId) {
        await deps.db.bookingMessageRead.deleteMany({ where: { bookingId } });
        await deps.db.bookingMessage.deleteMany({ where: { bookingId } });
        await deps.db.booking.delete({ where: { id: bookingId } });
      }
      await deps.db.outboxEvent.deleteMany({ where: { id: { in: outboxIds } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally {
      if (replica) await replica.close();
      await app.close();
    }
  }
});
