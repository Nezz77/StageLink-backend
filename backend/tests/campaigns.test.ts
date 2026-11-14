import { test } from 'node:test';
import assert from 'node:assert/strict';
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
