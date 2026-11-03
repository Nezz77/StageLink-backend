import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { csrfFor, hashPassword, opaqueToken, seal, unseal, verifyPassword } from '../api/src/auth/security.js';
test('password hashing uses independent salts and checks the complete password', async () => {
  const first = await hashPassword('A long password with spaces '), second = await hashPassword('A long password with spaces ');
  assert.notEqual(first, second);
  assert.ok(await verifyPassword('A long password with spaces ', first));
  assert.equal(await verifyPassword('A long password with spaces', first), false);
  assert.equal(await verifyPassword('incorrect', first), false);
});
test('encrypted mail payloads reject tampering and CSRF values are session-bound', () => {
  const key = randomBytes(32).toString('hex'), other = randomBytes(32).toString('hex');
  const payload = { token: opaqueToken(), to: 'fixture@stagelink.test', purpose: 'verify_email' };
  const encrypted = seal(key, payload);
  assert.deepEqual(unseal(key, encrypted), payload);
  assert.ok(!encrypted.includes(payload.token) && !encrypted.includes(payload.to));
  assert.throws(() => unseal(other, encrypted));
  const parts = encrypted.split('.'); parts[1] = 'A'.repeat(22);
  assert.throws(() => unseal(key, parts.join('.')));
  assert.notEqual(csrfFor(key, 'session-one'), csrfFor(key, 'session-two'));
});
test('payout encryption cannot be moved between owners, revisions or mail payloads',()=>{
  const key=randomBytes(32).toString('hex'),context='stagelink-payout-v1:owner-a:2';
  const sealed=seal(key,{number:'000012345678'},context);
  assert.deepEqual(unseal(key,sealed,context),{number:'000012345678'});
  assert.throws(()=>unseal(key,sealed,'stagelink-payout-v1:owner-b:2'));
  assert.throws(()=>unseal(key,sealed,'stagelink-payout-v1:owner-a:3'));
  assert.throws(()=>unseal(key,sealed));
});
