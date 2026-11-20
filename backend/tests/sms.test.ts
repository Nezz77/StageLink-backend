import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../shared/config.js';
import { sriLankaMobile, checkedSmsReceipt, smsDigest, TextLk } from '../shared/sms.js';
const base = { AUTH_JWT_SECRET: '01'.repeat(32), AUTH_MAIL_KEY: '02'.repeat(32), PAYOUT_DATA_KEY: '03'.repeat(32), DATABASE_URL: 'postgresql://unused:unused@localhost/test', REDIS_URL: 'redis://localhost:6379' };
const config = readConfig({ ...base, SMS_VERIFICATION_ENABLED: 'true', TEXTLK_TOKEN: 'fixture-token', TEXTLK_SENDER: 'StageLink' });
test('SMS contacts accept only one normalized Sri Lankan mobile and require explicit provider configuration', () => {
    for (const input of ['077 123 4567', '+94 77 123 4567', '94771234567'])
        assert.equal(sriLankaMobile.parse(input), '94771234567');
    for (const input of ['94771234567,94771234568', '+12025550123', '0112345678', '94771234567\nmessage', 'https://example.test'])
        assert.ok(!sriLankaMobile.safeParse(input).success);
    assert.throws(() => readConfig({ ...base, SMS_VERIFICATION_ENABLED: 'true' }));
    assert.throws(() => readConfig({ ...base, SMS_HOURLY_LIMIT: '0' }));
    assert.equal(readConfig(base).SMS_VERIFICATION_ENABLED, 'false');
});
test('SMS receipts bind sender, recipient and provider ID and distinguish accepted from delivered', () => {
    const raw = { status: 'success', data: { uid: 'fixture-1', to: '94771234567', from: 'StageLink', status: 'Queued' } }, target = smsDigest(config, raw.data.to);
    assert.equal(checkedSmsReceipt(raw, config, target).status, 'accepted');
    assert.equal(checkedSmsReceipt({ ...raw, data: { ...raw.data, status: 'Delivered' } }, config, target).status, 'delivered');
    for (const data of [{ ...raw.data, to: '94771234568' }, { ...raw.data, from: 'Other' }, { ...raw.data, uid: 'different' }])
        assert.equal(checkedSmsReceipt({ ...raw, data }, config, target, 'fixture-1').status, 'unknown');
    assert.equal(checkedSmsReceipt({ ...raw, data: { ...raw.data, status: 'unrecognized' } }, config, target).status, 'unknown');
});
test('text.lk uses a fixed HTTPS endpoint and never retries an uncertain send', async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => { calls++; assert.equal(String(input), 'https://app.text.lk/api/v3/sms/send'); assert.equal(init?.method, 'POST'); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-token'); assert.equal(init?.redirect, 'error'); throw Error('timeout after possible acceptance'); });
    const result = await new TextLk(config).send({ number: '94771234567', message: 'Synthetic fixture' }, smsDigest(config, '94771234567'));
    assert.equal(result.status, 'unknown');
    assert.equal(calls, 1);
    assert.equal((await new TextLk({ ...config, SMS_VERIFICATION_ENABLED: 'false' }).send({ number: '94771234567', message: 'Synthetic fixture' }, 'unused')).code, 'SMS_DISABLED');
    assert.equal(calls, 1);
});
