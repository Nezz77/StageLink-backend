import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const config = readConfig({
  ...process.env, AUTH_RATE_PREFIX: 'stripe-destination-test-' + randomUUID(),
  STRIPE_TEST_SECRET_KEY: 'sk_test_destination', STRIPE_TEST_WEBHOOK_SECRET: 'whsec_destination',
});
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Stripe destination integration requires an isolated *_test database.');
}

test('Stripe test destinations are bound to reviewed revisions with auditable and replay-safe changes', async t => {
  const original = globalThis.fetch;
  const firstAccount = 'acct_' + randomUUID().replaceAll('-', '');
  const secondAccount = 'acct_' + randomUUID().replaceAll('-', '');
  let gatewayReads = 0;
  const accounts = new Set([firstAccount, secondAccount]);
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== 'api.stripe.com') return original(input, init);
    gatewayReads++;
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer sk_test_destination');
    if (url.pathname === '/v1/balance') {
      return Promise.resolve(Response.json({ object: 'balance', livemode: false, available: [] }));
    }
    const id = url.pathname === '/v1/account' ? 'acct_platform' : url.pathname.split('/').at(-1)!;
    return Promise.resolve(Response.json({
      object: 'account', id, country: 'US', charges_enabled: true, payouts_enabled: false,
      controller: { is_controller: accounts.has(id) }, capabilities: { transfers: 'pending' },
    }));
  });
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const users: string[] = [];

  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl() + '/api/v1/admin/providers/';
    async function fixture(role: 'admin' | 'artist', recent = true) {
      const user = await deps.db.authUser.create({ data: {
        email: randomUUID() + '@stagelink.test', displayName: 'Stripe link fixture', roles: [role],
        passwordHash: 'unused', emailVerifiedAt: new Date(),
      } });
      users.push(user.id);
      const session = await deps.db.authSession.create({ data: {
        userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600_000),
        createdAt: recent ? new Date() : new Date(Date.now() - 20 * 60_000),
      } });
      const accessToken = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id).setIssuedAt().setExpirationTime('10m')
        .sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
      return { id: user.id, headers: {
        Authorization: 'Bearer ' + accessToken, Origin: config.WEB_ORIGIN,
        'Content-Type': 'application/json', 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id),
      } };
    }
    const admin = await fixture('admin');
    const old = await fixture('admin', false);
    const provider = await fixture('artist');
    const other = await fixture('artist');
    async function destination(userId: string, revision: number, status: 'pending' | 'approved') {
      const data = { revision, status, accountLast4: '1234', sealedDetails: 'opaque-fixture' };
      await deps.db.payoutDestination.upsert({ where: { userId }, create: { userId, ...data }, update: data });
      await deps.db.payoutDestinationVersion.create({
        data: { userId, ...data, ...(status === 'approved' ? {
          reviewerId: admin.id, reviewReason: 'Reviewed destination fixture.', reviewedAt: new Date(),
        } : {}) },
      });
    }
    const path = (id: string) => base + id + '/stripe-destination';
    const command = (accountId: string, destinationRevision = 1, expectedLinkId: string | null = null) => ({
      requestKey: randomUUID(), accountId, destinationRevision, expectedLinkId, reason: 'Verified the provider test account.',
    });
    const post = (id: string, body: object, actor = admin, suffix = '') => fetch(path(id) + suffix, {
      method: 'POST', headers: actor.headers, body: JSON.stringify(body),
    });
    const read = async (id: string) => {
      const response = await fetch(path(id), admin);
      assert.equal(response.status, 200);
      return response.json();
    };
    await destination(provider.id, 1, 'approved');
    await destination(other.id, 1, 'approved');
    const first = command(firstAccount);
    assert.equal((await fetch(path(provider.id), provider)).status, 403);
    assert.equal((await post(provider.id, first, provider)).status, 403);
    assert.equal((await post(provider.id, first, old)).status, 403);
    assert.equal((await post(provider.id, first, { ...admin, headers: { ...admin.headers, 'X-CSRF-Token': 'invalid' } })).status, 403);
    assert.equal(gatewayReads, 0);

    const uncontrolled = await post(provider.id, command('acct_uncontrolled'));
    assert.equal(uncontrolled.status, 409);
    assert.equal((await uncontrolled.json()).code, 'STRIPE_DESTINATION_UNVERIFIED');
    const accepted = await post(provider.id, first);
    assert.equal(accepted.status, 200);
    const linked = await accepted.json();
    assert.equal(linked.linkedBy, admin.id);
    assert.equal(linked.destinationRevision, 1);
    assert.equal(linked.platformAccountId, 'acct_platform');
    assert.deepEqual(await (await post(provider.id, first)).json(), linked);
    assert.equal(gatewayReads, 6);
    assert.equal((await (await post(provider.id, { ...first, reason: 'Different reason same request key.' })).json()).code, 'REQUEST_KEY_REUSED');

    const separate = await post(other.id, command(secondAccount));
    assert.equal(separate.status, 200);
    const otherLink = await separate.json();
    const conflict = await post(other.id, command(firstAccount, 1, otherLink.id));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'STRIPE_DESTINATION_IN_USE');
    assert.deepEqual(await read(other.id), { activeLink: otherLink, matchesApprovedDestination: true, history: [] });

    await destination(provider.id, 2, 'pending');
    assert.equal((await read(provider.id)).matchesApprovedDestination, false);
    const replacement = command(firstAccount, 2, linked.id);
    const pending = await post(provider.id, replacement);
    assert.equal(pending.status, 409);
    assert.equal((await pending.json()).code, 'DESTINATION_NOT_APPROVED');
    await deps.db.$transaction([
      deps.db.payoutDestination.update({ where: { userId: provider.id }, data: { status: 'approved' } }),
      deps.db.payoutDestinationVersion.update({
        where: { userId_revision: { userId: provider.id, revision: 2 } },
        data: { status: 'approved', reviewerId: admin.id, reviewReason: 'Reviewed replacement fixture.', reviewedAt: new Date() },
      }),
    ]);
    const replaced = await post(provider.id, replacement);
    assert.equal(replaced.status, 200);
    const latest = await replaced.json();
    assert.equal(latest.replacesId, linked.id);
    assert.equal(latest.destinationRevision, 2);
    const audit = await read(provider.id);
    assert.equal(audit.matchesApprovedDestination, true);
    assert.equal(audit.history[0]?.endKind, 'replace');
    assert.equal(audit.history[0]?.endedBy, admin.id);
    assert.deepEqual(audit.activeLink, latest);

    const revoke = { expectedLinkId: latest.id, reason: 'Operator revoked the linked test destination.' };
    assert.equal((await post(provider.id, { ...revoke, expectedLinkId: linked.id }, admin, '/revoke')).status, 409);
    const revoked = await post(provider.id, revoke, admin, '/revoke');
    assert.equal(revoked.status, 200);
    const saved = await revoked.json();
    assert.equal(saved.endKind, 'revoke');
    assert.equal(saved.endedBy, admin.id);
    assert.deepEqual(await (await post(provider.id, revoke, admin, '/revoke')).json(), saved);
    assert.equal((await read(provider.id)).activeLink, null);
  } finally {
    try {
      await deps.db.stripePayoutDestinationLink.deleteMany({ where: { providerId: { in: users } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app.close();
    }
  }
});
