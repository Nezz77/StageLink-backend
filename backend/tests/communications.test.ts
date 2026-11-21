import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../shared/config.js';
import { checkSmtp } from '../shared/communications.js';
import { communicationsSmokeSettings, runCommunicationsSmoke } from '../scripts/communications-smoke.js';
const config = readConfig({ NODE_ENV: 'test', AUTH_JWT_SECRET: '01'.repeat(32), AUTH_MAIL_KEY: '02'.repeat(32), PAYOUT_DATA_KEY: '03'.repeat(32), DATABASE_URL: 'postgresql://unused:unused@localhost/test', REDIS_URL: 'redis://localhost:6379' });
const smoke = { origin: 'https://api.staging.example.test', webOrigin: 'https://staging.example.test', session: { accessToken: 'synthetic.fixture.signature', csrfToken: 'a'.repeat(43) } };
const counts = { queued: 0, sending: 0, accepted: 0, failed: 0, unknown: 0, cancelled: 0 };
const state = { checkedAt: new Date().toISOString(), email: { bookingRemindersEnabled: false, promotionalEnabled: false, security: 'starttls_required', authenticationConfigured: true }, sms: { providerConfigured: false, verificationEnabled: false, bookingRemindersEnabled: false, promotionalEnabled: false, hourlyLimit: 20 } };
test('SMTP connection checks close transports and redact connection/authentication failures', async () => {
    let verified = 0, closed = 0;
    const ok = await checkSmtp(config, () => ({ async verify() { verified++; return true; }, close() { closed++; } }));
    assert.equal(ok.connection, 'ready');
    assert.equal(ok.messageSent, false);
    assert.equal(verified, 1);
    assert.equal(closed, 1);
    const failed = await checkSmtp(config, () => ({ async verify() { throw Error('private password smtp.example.test'); }, close() { closed++; } }));
    assert.equal(failed.connection, 'unavailable');
    assert.equal(closed, 2);
    assert.doesNotMatch(JSON.stringify(failed), /private|password|smtp.example/);
    assert.equal((await checkSmtp(config, () => { throw Error('private config'); })).connection, 'unavailable');
    assert.equal((await checkSmtp(config, () => ({ async verify() { return true; }, close() { throw Error('private close'); } }))).connection, 'unavailable');
});
function responses(mode = 'ready') {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        assert.equal(url.origin, smoke.origin);
        assert.equal(init?.redirect, 'error');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + smoke.session.accessToken);
        if (url.pathname.endsWith('health/ready'))
            return Response.json({ status: 'ready', dependencies: { postgres: 'up', redis: 'up' } });
        if (url.pathname.endsWith('/communications'))
            return Response.json(state);
        if (url.pathname.endsWith('/smtp-check')) {
            assert.equal(init?.method, 'POST');
            assert.equal(init?.body, '{}');
            assert.equal(new Headers(init?.headers).get('X-CSRF-Token'), smoke.session.csrfToken);
            return Response.json({ connection: mode === 'unavailable' ? 'unavailable' : 'ready', security: mode === 'plaintext' ? 'development' : 'starttls_required', messageSent: mode === 'sent', latencyMs: 3, checkedAt: new Date().toISOString(), code: null, private: 'must not print' });
        }
        return Response.json({ enabled: false, counts: { ...counts, ...(url.pathname.includes('sms-') ? { delivered: 0 } : {}) }, items: [{ private: 'must not print' }] });
    };
}
test('communication smoke validates secure connection and queue reads without printing tokens or message data', async () => {
    const result = await runCommunicationsSmoke(smoke, responses());
    assert.equal(result.passed, true);
    assert.equal(result.messageSent, false);
    assert.equal(result.smsDeliveryVerified, false);
    assert.doesNotMatch(JSON.stringify(result), /fixture.signature|must not print/);
    for (const mode of ['unavailable', 'plaintext', 'sent'])
        assert.equal((await runCommunicationsSmoke(smoke, responses(mode))).passed, false);
});
test('communication smoke rejects unsafe origins, unauthorized reads and malformed provider output', async () => {
    for (const origin of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path'])
        assert.equal(communicationsSmokeSettings.safeParse({ ...smoke, origin }).success, false);
    const denied = await runCommunicationsSmoke(smoke, async () => new Response('private error', { status: 403 }));
    assert.equal(denied.passed, false);
    assert.doesNotMatch(JSON.stringify(denied), /private error/);
    const malformed = await runCommunicationsSmoke(smoke, async () => Response.json({ password: 'secret' }));
    assert.equal(malformed.passed, false);
    assert.doesNotMatch(JSON.stringify(malformed), /secret|password/);
});
