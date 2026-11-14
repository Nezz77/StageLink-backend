import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../shared/config.js';
import { promotionalUnsubscribeHeaders, readPromotionalUnsubscribeToken } from '../shared/promotional-unsubscribe.js';
import { seal } from '../api/src/auth/security.js';
import { audienceFingerprint } from '../api/src/operations/campaigns.js';

test('campaign approval binds the previewed recipient IDs and consent revisions', () => {
  const campaign = 'cc0fdefd-01c1-41d4-860b-2b1ca3ec6fc3';
  const original = [{ user_id: '95d758cb-f9da-4812-b5b1-951d986f89fd', revision: 1 }];
  const tag = audienceFingerprint(campaign, original);
  assert.equal(tag, audienceFingerprint(campaign, original));
  assert.notEqual(tag, audienceFingerprint(campaign, []));
  assert.notEqual(tag, audienceFingerprint(campaign, [{ ...original[0]!, revision: 2 }]));
  assert.notEqual(tag, audienceFingerprint(campaign, [{ user_id: '1fe08d5b-f3d1-4d5f-a03f-38f1ba82ec32', revision: 1 }]));
});

test('promotional unsubscribe headers protect the recipient and bind the consent revision', () => {
  const env = {
    NODE_ENV: 'test', AUTH_JWT_SECRET: '01'.repeat(32), AUTH_MAIL_KEY: '02'.repeat(32),
    PAYOUT_DATA_KEY: '03'.repeat(32), DATABASE_URL: 'postgresql://unused:unused@localhost/test',
    REDIS_URL: 'redis://localhost:6379',
  };
  const origin = 'https://api.stagelink.test';
  const recipient = { userId: '95d758cb-f9da-4812-b5b1-951d986f89fd', email: 'member@stagelink.test', consentRevision: 3 };
  assert.deepEqual(promotionalUnsubscribeHeaders(readConfig(env), recipient), {});
  for (const invalid of ['not-a-url', 'http://localhost:4000', origin + '/other', 'https://user:pass@api.stagelink.test']) {
    assert.throws(() => readConfig({ ...env, PROMOTIONAL_UNSUBSCRIBE_ORIGIN: invalid }), /PROMOTIONAL_UNSUBSCRIBE_ORIGIN/);
  }

  const config = readConfig({ ...env, PROMOTIONAL_UNSUBSCRIBE_ORIGIN: origin });
  const headers = promotionalUnsubscribeHeaders(config, recipient);
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const url = new URL(headers['List-Unsubscribe']!.slice(1, -1));
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, '/api/v1/marketing/unsubscribe');
  assert.ok(!url.href.includes(recipient.email) && !url.href.includes(recipient.userId));

  const token = url.searchParams.get('token')!;
  assert.deepEqual(readPromotionalUnsubscribeToken(config.AUTH_MAIL_KEY, token), recipient);
  const tampered = (token[0] === 'a' ? 'b' : 'a') + token.slice(1);
  for (const invalid of [tampered, [token, token], seal(config.AUTH_MAIL_KEY, recipient), undefined]) {
    assert.equal(readPromotionalUnsubscribeToken(config.AUTH_MAIL_KEY, invalid), null);
  }
});
