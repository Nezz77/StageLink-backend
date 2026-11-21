import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources, ensureRedis } from '../shared/resources.js';
test('communication readiness requires recent verified administrators and verifies SMTP without sending mail', async () => {
    const sockets = new Set<Socket>(), commands: string[] = [];
    let reject = false;
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => { });
        socket.on('close', () => sockets.delete(socket));
        socket.write('220 fixture SMTP\r\n');
        let pending = '';
        socket.on('data', chunk => {
            pending += chunk.toString();
            let end: number;
            while ((end = pending.indexOf('\r\n')) >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 2);
                commands.push(line.split(' ')[0]!);
                if (reject) {
                    socket.end('554 synthetic private-password@example.test\r\n');
                    continue;
                }
                if (/^(EHLO|HELO)\b/.test(line))
                    socket.write('250 fixture\r\n');
                else if (line === 'QUIT')
                    socket.end('221 bye\r\n');
                else
                    socket.end('554 Message submission forbidden\r\n');
            }
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
        throw Error('No fixture SMTP port');
    const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'communications-' + randomUUID(), SMTP_HOST: '127.0.0.1', SMTP_PORT: String(address.port), SMTP_USER: '', SMTP_PASSWORD: '', SMS_VERIFICATION_ENABLED: 'false', BOOKING_SMS_REMINDERS: 'false', PROMOTIONAL_SMS_DELIVERY: 'false', TEXTLK_TOKEN: '', TEXTLK_SENDER: '' });
    if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test'))
        throw Error('Communications integration requires the isolated test database');
    const deps = resources(config), { app } = await createApp(config, deps), users: string[] = [];
    const initial = await deps.db.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
    await app.listen(0, '127.0.0.1');
    const root = (await app.getUrl()) + '/api/v1/admin/communications';
    async function actor(role: 'admin' | 'customer', verified = true, old = false) { const u = await deps.db.authUser.create({ data: { email: randomUUID() + '@stagelink.test', displayName: 'Communications fixture', roles: [role], passwordHash: 'unused', emailVerifiedAt: verified ? new Date() : null } }); users.push(u.id); const s = await deps.db.authSession.create({ data: { userId: u.id, activeRole: role, expiresAt: new Date(Date.now() + 600000), ...(old ? { createdAt: new Date(Date.now() - 3600000) } : {}) } }); const token = await new SignJWT({ sid: s.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(u.id).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex')); return { id: u.id, sessionId: s.id, headers: { Authorization: 'Bearer ' + token, Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, s.id) } }; }
    type Actor = Awaited<ReturnType<typeof actor>>;
    async function call(a: Actor | undefined, body?: unknown, headers: Record<string, string> = {}) { const r = await fetch(root + (body === undefined ? '' : '/smtp-check'), { method: body === undefined ? 'GET' : 'POST', headers: { Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json', ...a?.headers, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() as any }; }
    try {
        const admin = await actor('admin'), member = await actor('customer'), unverified = await actor('admin', false), old = await actor('admin', true, true);
        assert.equal((await call(undefined)).status, 401);
        assert.equal((await call(member)).status, 403);
        assert.equal((await call(unverified)).status, 403);
        const state = await call(admin);
        assert.equal(state.status, 200);
        assert.equal(state.data.sms.providerConfigured, false);
        assert.equal(state.data.email.security, 'development');
        assert.ok(!JSON.stringify(state.data).includes(config.SMTP_HOST));
        assert.equal((await call(member, {})).status, 403);
        assert.equal((await call(unverified, {})).status, 403);
        assert.equal((await call(old, {})).status, 403);
        assert.equal((await call(admin, {}, { 'X-CSRF-Token': 'bad' })).status, 403);
        assert.equal((await call(admin, {}, { Origin: 'https://untrusted.example' })).status, 403);
        assert.equal((await call(admin, { host: 'arbitrary.example' })).status, 400);
        assert.equal(commands.length, 0);
        await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: true, maintenanceMessage: 'Communications test' } });
        const ready = await call(admin, {});
        assert.equal(ready.status, 200);
        assert.equal(ready.data.connection, 'ready');
        assert.equal(ready.data.messageSent, false);
        assert.equal(ready.data.code, null);
        assert.ok(ready.data.checkedAt);
        assert.ok(commands.includes('EHLO'));
        assert.ok(!commands.some(row => ['MAIL', 'RCPT', 'DATA'].includes(row)));
        reject = true;
        const unavailable = await call(admin, {});
        assert.equal(unavailable.status, 200);
        assert.equal(unavailable.data.connection, 'unavailable');
        assert.equal(unavailable.data.code, 'SMTP_CONNECTION_UNAVAILABLE');
        assert.doesNotMatch(JSON.stringify(unavailable.data), /private-password|example.test|127\.0\.0\.1/);
        reject = false;
        assert.equal((await call(admin, {})).status, 200);
        const before = commands.length;
        assert.equal((await call(admin, {})).status, 429);
        assert.equal(commands.length, before);
        const disabled = await actor('admin');
        await deps.db.authUser.update({ where: { id: disabled.id }, data: { disabledAt: new Date() } });
        assert.equal((await call(disabled, {})).status, 401);
        assert.ok(!commands.some(row => ['MAIL', 'RCPT', 'DATA'].includes(row)));
    }
    finally {
        try {
            await deps.db.systemSetting.update({ where: { id: 1 }, data: { maintenance: initial.maintenance, maintenanceMessage: initial.maintenanceMessage } });
            await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
            await ensureRedis(deps.redis);
            let cursor = '0';
            do {
                const next = await deps.redis.scan(cursor, 'MATCH', config.AUTH_RATE_PREFIX + ':*', 'COUNT', 100);
                cursor = next[0];
                if (next[1].length)
                    await deps.redis.del(...next[1]);
            } while (cursor !== '0');
        }
        finally {
            await app.close();
            for (const socket of sockets)
                socket.destroy();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }
});
