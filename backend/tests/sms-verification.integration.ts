import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
import { csrfFor, unseal } from '../api/src/auth/security.js';
import { processSmsVerifications, payloadContext, contactContext } from '../shared/sms-verification.js';
const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'sms-test-' + randomUUID(), SMS_VERIFICATION_ENABLED: 'true', SMS_HOURLY_LIMIT: '20', TEXTLK_TOKEN: 'fixture-token', TEXTLK_SENDER: 'StageLink' });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test'))
    throw Error('SMS integration requires the isolated test database');
test('SMS verification, encrypted contact, explicit consent and uncertain delivery stay account scoped', async (t) => {
    const deps = resources(config), { app } = await createApp(config, deps), users: string[] = [];
    await app.listen(0, '127.0.0.1');
    const root = await app.getUrl();
    const sent = new Map<string, {
        number: string;
        message: string;
    }>();
    let sends = 0, reads = 0, mode = 'accepted';
    t.mock.method(globalThis, 'fetch', ((localFetch) => async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.hostname !== 'app.text.lk')
            return localFetch(input, init);
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-token');
        if (init?.method === 'POST') {
            sends++;
            const body = JSON.parse(String(init.body));
            assert.equal(body.sender_id, 'StageLink');
            assert.equal(body.type, 'plain');
            const id = 'fixture-' + sends;
            sent.set(id, { number: body.recipient, message: body.message });
            if (mode === 'timeout')
                throw Error('Possible accepted message');
            if (mode === 'reject')
                return Response.json({ status: 'error', message: 'Rejected' }, { status: 422 });
            return Response.json({ status: 'success', data: { uid: id, to: body.recipient, from: 'StageLink', status: 'Queued' } });
        }
        reads++;
        const id = url.pathname.split('/').at(-1)!, message = sent.get(id)!;
        return Response.json({ status: 'success', data: { uid: id, to: mode === 'mismatch' ? '94779999999' : message.number, from: 'StageLink', status: 'Delivered' } });
    })(globalThis.fetch));
    async function actor(verified = true) { const user = await deps.db.authUser.create({ data: { email: randomUUID() + '@stagelink.test', displayName: 'SMS fixture', roles: ['customer'], passwordHash: 'unused', emailVerifiedAt: verified ? new Date() : null } }); users.push(user.id); const session = await deps.db.authSession.create({ data: { userId: user.id, activeRole: 'customer', expiresAt: new Date(Date.now() + 600000) } }); const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex')); return { id: user.id, headers: { Authorization: 'Bearer ' + token, 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id), Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json' } }; }
    type Actor = Awaited<ReturnType<typeof actor>>;
    async function call(a: Actor, path: string, body?: unknown, method?: string, headers: Record<string, string> = {}) { const response = await fetch(root + '/api/v1/' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { ...a.headers, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as any }; }
    async function request(a: Actor, number: string) { const r = await call(a, 'me/sms-contact/verification', { revision: 0, number }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.pending.id as string; }
    async function code(id: string) { const row = await deps.db.smsVerification.findUniqueOrThrow({ where: { id } }); const payload = unseal(config.AUTH_MAIL_KEY, row.sealedPayload!, payloadContext(id)) as {
        number: string;
        message: string;
    }; return /code is (\d{6})/.exec(payload.message)![1]!; }
    try {
        const a = await actor(), b = await actor(), unverified = await actor(false);
        assert.equal((await call(a, 'me/sms-contact')).data.verified, false);
        assert.equal((await call(unverified, 'me/sms-contact/verification', { revision: 0, number: '0771234567' })).status, 403);
        assert.equal((await call(a, 'me/sms-contact/verification', { revision: 0, number: '0771234567' }, undefined, { 'X-CSRF-Token': 'invalid' })).status, 403);
        assert.equal((await call(a, 'me/sms-contact/verification', { revision: 0, number: '0771234567' }, undefined, { Origin: 'https://untrusted.example' })).status, 403);
        assert.equal((await call(a, 'me/sms-contact/verification', { revision: 0, number: '0771234567', userId: b.id })).status, 400);
        const id = await request(a, '0771234567'), otp = await code(id), stored = await deps.db.smsVerification.findUniqueOrThrow({ where: { id } });
        assert.ok(!stored.sealedPayload!.includes(otp));
        assert.notEqual(stored.codeDigest, otp);
        assert.ok(!stored.sealedPayload!.includes('94771234567'));
        assert.equal((await call(a, 'me/sms-contact/confirm', { challengeId: id, code: otp })).status, 400, 'Queued challenges cannot verify before sending');
        await Promise.all([processSmsVerifications(deps.db, config), processSmsVerifications(deps.db, config)]);
        assert.equal(sends, 1);
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id } })).status, 'accepted');
        assert.equal((await call(b, 'me/sms-contact/confirm', { challengeId: id, code: otp })).status, 400);
        assert.equal((await call(b, 'me/sms-verifications')).data.items.length, 0);
        assert.equal((await call(a, 'me/sms-contact/confirm', { challengeId: id, code: otp === '000000' ? '000001' : '000000' })).status, 400);
        const confirmed = await call(a, 'me/sms-contact/confirm', { challengeId: id, code: otp });
        assert.equal(confirmed.status, 200);
        assert.equal(confirmed.data.last4, '4567');
        assert.equal(confirmed.data.bookingConsent, false);
        assert.equal(confirmed.data.marketingConsent, false);
        assert.ok(!JSON.stringify(confirmed.data).includes('94771234567'));
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id } })).sealedPayload, null);
        assert.equal((await call(a, 'me/sms-contact/confirm', { challengeId: id, code: otp })).status, 400);
        const contact = await deps.db.smsContact.findUniqueOrThrow({ where: { userId: a.id } });
        assert.ok(!contact.sealedNumber!.includes('94771234567'));
        assert.equal((unseal(config.AUTH_MAIL_KEY, contact.sealedNumber!, contactContext(a.id)) as any).number, '94771234567');
        assert.throws(() => unseal(config.AUTH_MAIL_KEY, contact.sealedNumber!, contactContext(b.id)));
        const opted = await call(a, 'me/sms-contact/consent', { revision: confirmed.data.revision, bookingConsent: true, marketingConsent: false }, 'PUT');
        assert.equal(opted.status, 200);
        assert.equal(opted.data.bookingConsent, true);
        assert.equal((await call(a, 'me/sms-contact/consent', { revision: confirmed.data.revision, bookingConsent: true, marketingConsent: true }, 'PUT')).status, 409);
        const audit = await deps.db.smsConsentEvent.findMany({ where: { userId: a.id }, orderBy: { revision: 'asc' } });
        assert.deepEqual(audit.map(e => e.action), ['verified', 'consent']);
        assert.equal(audit[1]!.marketingConsent, false);
        await deps.db.smsVerification.update({ where: { id }, data: { checkedAt: new Date(Date.now() - 60000) } });
        mode = 'mismatch';
        await processSmsVerifications(deps.db, config);
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id } })).status, 'accepted');
        assert.equal(sends, 1);
        await deps.db.smsVerification.update({ where: { id }, data: { checkedAt: new Date(Date.now() - 60000) } });
        mode = 'accepted';
        await processSmsVerifications(deps.db, config);
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id } })).status, 'delivered');
        assert.ok(reads >= 2);
        const revoked = await call(a, 'me/sms-contact/revoke', { revision: opted.data.revision });
        assert.equal(revoked.data.verified, false);
        assert.equal(revoked.data.bookingConsent, false);
        assert.equal((await deps.db.smsContact.findUniqueOrThrow({ where: { userId: a.id } })).sealedNumber, null);
        const timeoutUser = await actor();
        mode = 'timeout';
        const timeoutId = await request(timeoutUser, '0771234568'), timeoutCode = await code(timeoutId);
        await processSmsVerifications(deps.db, config);
        const afterTimeout = sends;
        await processSmsVerifications(deps.db, config);
        assert.equal(sends, afterTimeout);
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id: timeoutId } })).status, 'unknown');
        assert.equal((await call(timeoutUser, 'me/sms-contact/confirm', { challengeId: timeoutId, code: timeoutCode })).status, 200, 'Possession of the actual delivered code can verify an uncertain send');
        const capped = await actor(), cappedId = await request(capped, '0771234569');
        await processSmsVerifications(deps.db, { ...config, SMS_HOURLY_LIMIT: 1 });
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id: cappedId } })).status, 'queued');
        mode = 'accepted';
        await processSmsVerifications(deps.db, config);
        for (let n = 0; n < 5; n++)
            assert.equal((await call(capped, 'me/sms-contact/confirm', { challengeId: cappedId, code: 'invalid' })).status, 400);
        // Valid-format wrong codes persist the attempt limit; malformed bodies do not consume an OTP attempt.
        const actual = await code(cappedId), wrong = actual === '000000' ? '000001' : '000000';
        for (let n = 0; n < 5; n++)
            await call(capped, 'me/sms-contact/confirm', { challengeId: cappedId, code: wrong });
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id: cappedId } })).attempts, 5);
        assert.equal((await call(capped, 'me/sms-contact/confirm', { challengeId: cappedId, code: actual })).status, 400);
        const expired = await actor(), expiredId = await request(expired, '0771234570');
        await deps.db.smsVerification.update({ where: { id: expiredId }, data: { expiresAt: new Date(Date.now() - 1000) } });
        await processSmsVerifications(deps.db, config);
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id: expiredId } })).status, 'cancelled');
        const disabled = await actor(), disabledId = await request(disabled, '0771234571');
        await deps.db.authUser.update({ where: { id: disabled.id }, data: { disabledAt: new Date() } });
        await processSmsVerifications(deps.db, config);
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id: disabledId } })).status, 'cancelled');
        const rejected = await actor();
        mode = 'reject';
        const rejectedId = await request(rejected, '0771234573');
        await processSmsVerifications(deps.db, config);
        const afterRejection = sends;
        await processSmsVerifications(deps.db, config);
        assert.equal(sends, afterRejection);
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id: rejectedId } })).status, 'failed');
        mode = 'accepted';
        const paused = await actor(), pausedId = await request(paused, '0771234572');
        await processSmsVerifications(deps.db, { ...config, SMS_VERIFICATION_ENABLED: 'false' });
        assert.equal((await deps.db.smsVerification.findUniqueOrThrow({ where: { id: pausedId } })).status, 'queued');
        await call(paused, 'me/sms-contact/revoke', { revision: 1 });
        const beforeCancel = sends;
        await processSmsVerifications(deps.db, config);
        assert.equal(sends, beforeCancel);
    }
    finally {
        await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
        await app.close();
    }
});
