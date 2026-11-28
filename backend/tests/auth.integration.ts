import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
import { createMailer, deliverAuthMail } from '../shared/auth-mail.js';
import { databaseNow } from '../shared/database-clock.js';
import { digest, opaqueToken, seal } from '../api/src/auth/security.js';
import { serverClock } from './fixtures/server-clock.js';
const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'auth-test-' + randomUUID() });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test') || !process.env.MAILPIT_API_URL) {
  throw new Error('Authentication integration requires a *_test database and explicit local mail-catcher URL');
}
const mailBase = process.env.MAILPIT_API_URL;
async function pause() { await new Promise(resolve => setTimeout(resolve, 100)); }
test('two accounts, role guards, cookie rotation/replay, real SMTP recovery and revocation', { timeout: 90000 }, async () => {
  const deps = resources(config), transport = createMailer(config);
  const { app } = await createApp(config, deps);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const suffix = randomUUID();
  const emailA = `customer-${suffix}@stagelink.test`, emailB = `artist-${suffix}@stagelink.test`, adminEmail = `admin-${suffix}@stagelink.test`;
  const allEmails = [emailA, emailB, adminEmail];
  const password = 'A private fixture password 12!', newPassword = 'A changed fixture password 34!';
  type Login = { accessToken: string; csrfToken: string; cookie: string; user: { id: string; roles: string[]; activeRole: string; email: string; emailVerified: boolean } };
  async function call(path: string, body?: unknown, auth?: Login, options: { cookie?: string; csrf?: string; origin?: string; method?: string } = {}) {
    const headers: Record<string,string> = { 'Content-Type': 'application/json', Origin: options.origin ?? config.WEB_ORIGIN };
    if (auth) { headers.Authorization = 'Bearer ' + auth.accessToken; headers['X-CSRF-Token'] = auth.csrfToken; }
    if (options.csrf !== undefined) headers['X-CSRF-Token'] = options.csrf;
    if (options.cookie ?? auth?.cookie) headers.Cookie = options.cookie ?? auth!.cookie;
    const response = await fetch(base + '/api/v1/' + path, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { response, data: text ? JSON.parse(text) : null };
  }
  async function login(email: string, pass = password): Promise<Login> {
    const result = await call('auth/login', { email, password: pass });
    assert.equal(result.response.status, 200);
    const cookie = result.response.headers.get('set-cookie');
    assert.ok(cookie?.includes('HttpOnly') && cookie.includes('SameSite=Strict') && cookie.includes('Path=/'));
    assert.ok(!('refreshToken' in result.data));
    return { ...result.data, cookie: cookie!.split(';')[0]! };
  }
  async function emailMessage(email: string, subject: string, deliverPending = true): Promise<string> {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (deliverPending) await deliverAuthMail(deps, config, transport);
      const list = await fetch(mailBase + '/api/v1/messages').then(r => r.json()) as any;
      const message = list.messages?.find((item: any) => item.Subject === subject && item.To?.some((to: any) => to.Address === email));
      if (message) {
        const detail = await fetch(mailBase + '/api/v1/message/' + message.ID).then(r => r.json()) as any;
        assert.equal(typeof detail.Text, 'string');
        return detail.Text;
      }
      await pause();
    }
    throw new Error('SMTP message did not reach the isolated mail catcher');
  }
  async function emailToken(email: string, subject: string): Promise<string> {
    const token = /one-time code: ([A-Za-z0-9_-]{43})/.exec(await emailMessage(email, subject))?.[1];
    assert.ok(token, 'SMTP message must contain its real one-time token');
    return token;
  }
  try {
    const probeRecipient = `smtp-probe-${suffix}@stagelink.test`;
    const probe = spawnSync(process.execPath, ['dist/scripts/smtp-smoke.js'], {
      input: probeRecipient, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(probe.status, 0, probe.stderr);
    const report = JSON.parse(probe.stdout);
    assert.equal(report.status, 'accepted');
    assert.match(report.probeId, /^[0-9a-f-]{36}$/);
    assert.ok(!probe.stdout.includes(probeRecipient));
    assert.match(await emailMessage(probeRecipient, 'StageLink SMTP smoke ' + report.probeId, false),
      /Synthetic StageLink SMTP delivery probe/);

    assert.equal((await call('me')).response.status, 401);
    assert.equal((await call('auth/register', { email: emailA, password, displayName: 'Customer A', role: 'admin' })).response.status, 400);
    assert.equal((await call('auth/register', { email: emailA, password, displayName: 'Customer A', role: 'customer' }, undefined, { origin: 'http://untrusted.example' })).response.status, 403);
    const registered = await call('auth/register', { email: ' ' + emailA.toUpperCase() + ' ', password, displayName: 'Customer A', role: 'customer' });
    assert.equal(registered.response.status, 202);
    const duplicate = await call('auth/register', { email: emailA, password: newPassword, displayName: 'Do not overwrite', role: 'renter' });
    assert.equal(duplicate.response.status, 202); assert.deepEqual(registered.data, duplicate.data);
    assert.equal((await call('auth/register', { email: emailB, password, displayName: 'Artist B', role: 'artist' })).response.status, 202);
    const a = await login(emailA), b = await login(emailB);
    assert.notEqual(a.user.id, b.user.id); assert.deepEqual(b.user.roles, ['customer', 'artist']);
    assert.equal((await call('me', undefined, a)).data.email, emailA);
    assert.equal((await call('me', undefined, b)).data.email, emailB);
    assert.equal((await call('admin/access', undefined, a)).response.status, 403);
    assert.equal((await call('me/active-role', { role: 'admin' }, a)).response.status, 403);
    assert.equal((await call('me/active-role', { role: 'customer' }, b, { csrf: 'invalid' })).response.status, 403);
    assert.equal((await call('me/active-role', { role: 'customer', userId: a.user.id }, b)).response.status, 400);
    assert.equal((await call('me/active-role', { role: 'customer' }, b)).data.activeRole, 'customer');
    assert.equal((await call('me/active-role', { role: 'artist' }, b)).data.activeRole, 'artist');

    const verifyA = await emailToken(emailA, 'Verify your StageLink email');
    assert.equal((await serverClock(25 * 3_600_000, () => call('auth/email-verification/confirm', { token: verifyA }))).response.status, 200);
    assert.equal((await call('me', undefined, a)).data.emailVerified, true);
    assert.equal((await call('auth/email-verification/confirm', { token: verifyA })).response.status, 401);
    const verifyB = await emailToken(emailB, 'Verify your StageLink email');
    await deps.db.authToken.update({ where: { digest: digest(verifyB) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await serverClock(-3_600_000, () => call('auth/email-verification/confirm', { token: verifyB }))).response.status, 401);
    assert.equal((await call('me', undefined, b)).data.emailVerified, false);

    const boot = await call('auth/csrf', undefined, undefined, { cookie: a.cookie });
    assert.equal(boot.response.status, 200);
    const rotated = await call('auth/refresh', {}, undefined, { cookie: a.cookie, csrf: boot.data.csrfToken });
    assert.equal(rotated.response.status, 200);
    const nextA: Login = { ...rotated.data, cookie: rotated.response.headers.get('set-cookie')!.split(';')[0]! };
    assert.notEqual(nextA.cookie, a.cookie);
    assert.equal((await call('auth/refresh', {}, undefined, { cookie: a.cookie, csrf: a.csrfToken })).response.status, 401);
    assert.equal((await call('me', undefined, nextA)).response.status, 401, 'Replay revokes the entire token family');
    assert.equal((await call('me', undefined, b)).response.status, 200, 'Another account remains signed in');

    const beforeReset = await login(emailA);
    const known = await serverClock(-3_600_000, () => call('auth/password-reset', { email: emailA }));
    const unknown = await call('auth/password-reset', { email: `unknown-${suffix}@stagelink.test` });
    assert.equal(known.response.status, 202); assert.deepEqual(known.data, unknown.data);
    const resetToken = await emailToken(emailA, 'Reset your StageLink password');
    const verified = await serverClock(3_600_000, () => call('auth/password-reset/verify', { token: resetToken }));
    assert.equal(verified.response.status, 200);
    const grant = await deps.db.authToken.findUniqueOrThrow({ where: { digest: digest(verified.data.grant) } });
    const reset = await deps.db.authToken.findUniqueOrThrow({ where: { digest: digest(resetToken) } });
    assert.equal(grant.expiresAt.getTime() - reset.usedAt!.getTime(), 300_000);
    assert.equal((await call('auth/password-reset/verify', { token: resetToken })).response.status, 401);
    assert.equal((await call('auth/password-reset/complete', { grant: verified.data.grant, password: newPassword })).response.status, 200);
    assert.equal((await call('auth/password-reset/complete', { grant: verified.data.grant, password })).response.status, 401);
    assert.equal((await call('me', undefined, beforeReset)).response.status, 401);
    assert.equal((await call('auth/refresh', {}, undefined, { cookie: beforeReset.cookie, csrf: beforeReset.csrfToken })).response.status, 401);
    assert.equal((await call('auth/login', { email: emailA, password })).response.status, 401);
    const changed = await login(emailA, newPassword);
    assert.equal((await call('auth/logout', {}, changed)).response.status, 204);
    assert.equal((await call('me', undefined, changed)).response.status, 401);
    const withoutCookie = await login(emailA, newPassword);
    assert.equal((await call('auth/logout', {}, withoutCookie, { cookie: '' })).response.status, 204);
    assert.equal((await call('me', undefined, withoutCookie)).response.status, 401, 'Logout also revokes the access session when cookies are blocked');

    const forgedParts = b.accessToken.split('.');
    forgedParts[2] = (forgedParts[2]![0] === 'A' ? 'B' : 'A') + forgedParts[2]!.slice(1);
    assert.equal((await call('me', undefined, { ...b, accessToken: forgedParts.join('.') })).response.status, 401);
    const expiredJwt = await new SignJWT({ sid: (await deps.db.authSession.findFirstOrThrow({ where: { userId: b.user.id } })).id })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(b.user.id)
      .setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)-1).sign(Buffer.from(config.AUTH_JWT_SECRET,'hex'));
    assert.equal((await call('me', undefined, { ...b, accessToken: expiredJwt })).response.status, 401);
    const stored = await deps.db.authUser.findUniqueOrThrow({ where: { email: emailA } });
    assert.ok(stored.passwordHash.startsWith('scrypt-v1$') && stored.passwordHash !== newPassword);
    assert.ok(!JSON.stringify((await call('me', undefined, b)).data).includes('passwordHash'));
    await deps.db.authUser.update({ where: { id: b.user.id }, data: { disabledAt: new Date() } });
    assert.equal((await call('me', undefined, b)).response.status, 401);

    const bootstrap = spawnSync(process.execPath, ['dist/scripts/bootstrap-admin.js', '--email', adminEmail, '--name', 'Fixture administrator'], { env: process.env, input: password, encoding: 'utf8' });
    assert.equal(bootstrap.status, 0, 'Controlled administrator creation must succeed');
    const admin = await login(adminEmail);
    assert.equal((await call('admin/access', undefined, admin)).response.status, 200);
    assert.equal(spawnSync(process.execPath, ['dist/scripts/bootstrap-admin.js', '--email', adminEmail, '--name', 'Overwrite'], { env: process.env, input: newPassword, encoding: 'utf8' }).status, 1);

    const { AuthRateLimit } = await import('../api/src/auth/rate-limit.js');
    const limiter = new AuthRateLimit(deps.redis, config.AUTH_RATE_PREFIX, config.AUTH_JWT_SECRET);
    await limiter.check('fixture', 'scope-one', 1, 60);
    await assert.rejects(limiter.check('fixture', 'scope-one', 1, 60), error => (error as any).getStatus() === 429);
  } finally {
    transport.close();
    await deps.db.authUser.deleteMany({ where: { email: { in: allEmails } } });
    let cursor = '0';
    do { const [next, keys] = await deps.redis.scan(cursor, 'MATCH', config.AUTH_RATE_PREFIX + ':*', 'COUNT', 100); cursor = next; if (keys.length) await deps.redis.del(...keys); } while (cursor !== '0');
    await app.close();
  }
});

test('account email retries and expiry use PostgreSQL time', async () => {
  const deps = resources(config);
  const email = randomUUID() + '@stagelink.test';
  const user = await deps.db.authUser.create({
    data: { email, displayName: 'Mail worker fixture', passwordHash: 'unused' },
  });
  const mailbox = deps.db.authMail;
  let submissions = 0;
  let reject = true;
  const relay = {
    async sendMail() {
      submissions += 1;
      if (reject) throw new Error('Local relay fixture rejection');
      return {
        accepted: [email], rejected: [], response: '250 fixture accepted', messageId: 'auth-mail-worker-fixture',
        envelope: { from: config.SMTP_FROM, to: [email] }, envelopeTime: 0, messageTime: 0, messageSize: 0,
      };
    },
  };
  try {
    const token = opaqueToken();
    const initial = await databaseNow(deps.db);
    const expiresAt = new Date(initial.getTime() + 120_000);
    await deps.db.authToken.create({
      data: { userId: user.id, email, purpose: 'password_reset', digest: digest(token), expiresAt },
    });
    const data = {
      userId: user.id, expiresAt,
      sealedPayload: seal(config.AUTH_MAIL_KEY, { to: email, token, purpose: 'password_reset' }),
    };
    const delayed = await mailbox.create({ data });
    await serverClock(3_600_000, () => deliverAuthMail(deps, config, relay));
    const queued = await mailbox.findUniqueOrThrow({ where: { id: delayed.id } });
    assert.equal(queued.status, 'pending', 'A fast worker keeps an unexpired job eligible');
    assert.equal(queued.attempts, 1);
    const retryDelay = queued.availableAt.getTime() - (await databaseNow(deps.db)).getTime();
    assert.ok(retryDelay > 0 && retryDelay <= 10_000);
    await serverClock(3_600_000, () => deliverAuthMail(deps, config, relay));
    assert.equal(submissions, 1, 'A fast worker honors the retry delay');

    await mailbox.update({ where: { id: delayed.id }, data: { availableAt: initial } });
    reject = false;
    await serverClock(-3_600_000, () => deliverAuthMail(deps, config, relay));
    const delivered = await mailbox.findUniqueOrThrow({ where: { id: delayed.id } });
    assert.equal(delivered.status, 'delivered');
    assert.ok(delivered.deliveredAt! >= initial);
    assert.equal(delivered.sealedPayload, null);

    reject = true;
    const lastAttempt = await mailbox.create({ data: { ...data, attempts: 4 } });
    const interrupted = await mailbox.create({ data: { ...data, attempts: 5, leaseOwner: randomUUID(), lockedUntil: initial } });
    const expired = await mailbox.create({ data: { ...data, expiresAt: new Date(initial.getTime() - 1000) } });
    await serverClock(-3_600_000, () => deliverAuthMail(deps, config, relay));
    assert.equal(submissions, 3, 'Only the final scheduled attempt reaches the relay');
    for (const { id, status } of [
      { id: lastAttempt.id, status: 'failed' },
      { id: interrupted.id, status: 'failed' },
      { id: expired.id, status: 'expired' },
    ]) {
      const row = await mailbox.findUniqueOrThrow({ where: { id } });
      assert.equal(row.status, status);
      assert.equal(row.sealedPayload, null);
      assert.equal(row.leaseOwner, null);
      assert.equal(row.lockedUntil, null);
    }
  } finally {
    try {
      await deps.db.authUser.delete({ where: { id: user.id } });
    } finally {
      await deps.db.$disconnect();
    }
  }
});
