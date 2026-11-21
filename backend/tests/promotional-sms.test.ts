import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promotionalSmsBody, promotionalSmsMessage } from '../shared/promotional-sms.js';
import { readConfig } from '../shared/config.js';
import { TextLk, smsDigest } from '../shared/sms.js';
const base = { AUTH_JWT_SECRET: '01'.repeat(32), AUTH_MAIL_KEY: '02'.repeat(32), PAYOUT_DATA_KEY: '03'.repeat(32), DATABASE_URL: 'postgresql://unused:unused@localhost/test', REDIS_URL: 'redis://localhost:6379' };
test('promotional SMS stays in one basic-alphabet segment including sender and opt-out instructions', () => {
    const maximum = promotionalSmsMessage('a'.repeat(100));
    assert.ok(maximum.length <= 160);
    assert.match(maximum, /Stop SMS:/);
    for (const value of ['a'.repeat(101), 'සිංහල', 'Offer 🎵', 'new\nline', 'GSM extension ^', 'brackets[]', 'backtick`', '']) {
        assert.equal(promotionalSmsBody.safeParse(value).success, false);
    }
    assert.equal(readConfig(base).PROMOTIONAL_SMS_DELIVERY, 'false');
    assert.throws(() => readConfig({ ...base, PROMOTIONAL_SMS_DELIVERY: 'true' }));
});
test('promotional delivery can be enabled independently and uses the existing single-recipient adapter', async (t) => {
    const config = readConfig({ ...base, PROMOTIONAL_SMS_DELIVERY: 'true', TEXTLK_TOKEN: 'fixture-token', TEXTLK_SENDER: 'StageLink' });
    let sends = 0;
    t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
        assert.equal(String(input), 'https://app.text.lk/api/v3/sms/send');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.recipient, '94771234567');
        assert.equal(body.message, promotionalSmsMessage('Synthetic offer.'));
        sends++;
        return Response.json({ status: 'success', data: { uid: 'fixture-promo', to: body.recipient, from: 'StageLink', status: 'Queued' } });
    });
    const result = await new TextLk(config).send({ number: '94771234567', message: promotionalSmsMessage('Synthetic offer.') }, smsDigest(config, '94771234567'));
    assert.equal(result.status, 'accepted');
    assert.equal(sends, 1);
});
