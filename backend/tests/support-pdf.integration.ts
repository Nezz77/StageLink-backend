import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { jsPDF } from 'jspdf';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources, ensureRedis } from '../shared/resources.js';
import { MediaStore, originalKey, derivativeKey } from '../shared/media-store.js';
import { processMediaBatch } from '../shared/media-processing.js';

const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'support-pdf-' + randomUUID() });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test') || !config.S3_BUCKET.endsWith('-test')) {
  throw Error('Support PDF tests require isolated test services');
}

test('support PDFs are rebuilt, privately bound to the owner case and reauthorized at download', { timeout: 60000 }, async () => {
  const deps = resources(config), store = new MediaStore(config), { app } = await createApp(config, deps);
  const users: string[] = [];
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function actor(role: 'customer' | 'admin', verified = true) {
    const user = await deps.db.authUser.create({ data: { email: randomUUID() + '@stagelink.test', displayName: 'Support PDF fixture', passwordHash: 'unused', roles: [role], emailVerifiedAt: verified ? new Date() : null } });
    users.push(user.id);
    const session = await deps.db.authSession.create({ data: { userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600000) } });
    const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
    return { id: user.id, sessionId: session.id, headers: { Authorization: 'Bearer ' + token, Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id) } };
  }
  type Actor = Awaited<ReturnType<typeof actor>>;
  async function call(a: Actor, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + '/api/v1/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...a.headers, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  }
  async function upload(a: Actor, bytes: Buffer) {
    const started = await call(a, 'assets/uploads', { filename: 'original-private-name.pdf', mime: 'application/pdf', purpose: 'support', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    const id = started.data.id as string;
    const sent = await fetch(base + `/api/v1/assets/${id}/content`, { method: 'PUT', headers: { ...a.headers, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
    assert.equal(sent.status, 200);
    assert.equal((await call(a, `assets/${id}/finalize`, {})).status, 200);
    return id;
  }
  function caseInput(assetId: string) { return { requestKey: randomUUID(), subject: 'Private rental receipt', body: 'Please review this synthetic supporting receipt for my rental.', assetIds: [assetId] }; }
  try {
    await store.ready();
    const owner = await actor('customer'), outsider = await actor('customer'), admin = await actor('admin'), unverifiedAdmin = await actor('admin', false);
    const document = new jsPDF();
    document.text('Synthetic support receipt page one', 15, 25);
    document.addPage().text('Synthetic support receipt page two', 15, 25);
    document.addJS('app.alert("must-be-removed")');
    const original = Buffer.from(document.output('arraybuffer'));
    const input = { filename: 'receipt.pdf', mime: 'application/pdf', purpose: 'support', bytes: original.length, sha256: createHash('sha256').update(original).digest('hex') };
    assert.equal((await call(owner, 'assets/uploads', { ...input, purpose: 'chat' })).status, 400);
    assert.equal((await call(owner, 'assets/uploads', { ...input, bytes: 5 * 1024 * 1024 + 1 })).status, 400);
    assert.equal((await call(owner, 'assets/uploads', { ...input, purpose: 'verification' })).status, 403);
    const id = await upload(owner, original);
    assert.equal((await call(owner, 'cases', caseInput(id))).status, 409, 'Unprocessed files cannot be bound');
    await processMediaBatch(deps, store);
    const ready = await deps.db.asset.findUniqueOrThrow({ where: { id } });
    assert.equal(ready.status, 'ready', String(ready.reason));
    assert.deepEqual(ready.metadata, { pages: 2 });
    const cap = await call(owner, `assets/${id}/access`, { variant: 'display' });
    assert.equal(cap.status, 200);
    assert.equal((await call(admin, `assets/${id}/access`, { variant: 'display' })).status, 404, 'Unattached private library content is not visible to staff');
    assert.equal((await call(outsider, 'cases', caseInput(id))).status, 409);
    const created = await call(owner, 'cases', caseInput(id));
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.deepEqual(created.data.assetIds, [id]);
    assert.equal((await call(owner, `assets/${id}/remove`, {})).status, 409);
    assert.equal((await call(outsider, `assets/${id}/access`, { variant: 'display' })).status, 404);
    assert.equal((await call(unverifiedAdmin, `assets/${id}/access`, { variant: 'display' })).status, 404);
    assert.equal((await call(admin, `assets/${id}/access`, { variant: 'display' }, { 'X-CSRF-Token': 'wrong' })).status, 403);
    assert.equal((await call(admin, `assets/${id}/access`, { variant: 'display' }, { Origin: 'https://wrong.example.test' })).status, 403);
    const staffCap = await call(admin, `assets/${id}/access`, { variant: 'display' });
    assert.equal(staffCap.status, 200);
    const downloaded = await fetch(base + staffCap.data.url);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('Content-Type'), 'application/pdf');
    assert.equal(downloaded.headers.get('Content-Disposition'), 'attachment; filename="support-attachment.pdf"');
    assert.equal(downloaded.headers.get('Cache-Control'), 'no-store');
    const rebuilt = Buffer.from(await downloaded.arrayBuffer());
    assert.ok(rebuilt.subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.ok(!rebuilt.equals(original));
    for (const text of ['/JavaScript', 'must-be-removed']) assert.ok(!rebuilt.includes(Buffer.from(text)));
    const poster = await call(admin, `assets/${id}/access`, { variant: 'poster' });
    assert.equal(poster.status, 200);
    assert.equal((await fetch(base + poster.data.url)).headers.get('Content-Type'), 'image/webp');
    assert.equal((await fetch(base + `/api/v1/public/media/${id}/access?variant=display`)).status, 404);

    await deps.db.authUser.update({ where: { id: admin.id }, data: { emailVerifiedAt: null } });
    assert.equal((await fetch(base + staffCap.data.url)).status, 401, 'The existing capability rechecks staff verification');
    await deps.db.authUser.update({ where: { id: admin.id }, data: { emailVerifiedAt: new Date(), roles: ['admin', 'customer'] } });
    await deps.db.authSession.update({ where: { id: admin.sessionId }, data: { activeRole: 'customer' } });
    assert.equal((await fetch(base + staffCap.data.url)).status, 401, 'The existing capability rechecks active administrator role');
    await deps.db.authSession.update({ where: { id: admin.sessionId }, data: { activeRole: 'admin' } });
    assert.equal((await fetch(base + staffCap.data.url)).status, 200);
    await deps.db.authSession.update({ where: { id: admin.sessionId }, data: { revokedAt: new Date() } });
    assert.equal((await fetch(base + staffCap.data.url)).status, 401);
    await deps.db.authUser.update({ where: { id: owner.id }, data: { disabledAt: new Date() } });
    assert.equal((await fetch(base + cap.data.url)).status, 401);
    await deps.db.authUser.update({ where: { id: owner.id }, data: { disabledAt: null } });

    const tooMany = new jsPDF();
    for (let page = 1; page < 9; page++) tooMany.addPage().text('Too many pages', 15, 25);
    for (const bytes of [Buffer.from('%PDF-1.7\nNot a real PDF'), Buffer.from(tooMany.output('arraybuffer'))]) {
      const bad = await upload(owner, bytes);
      await processMediaBatch(deps, store);
      assert.equal((await deps.db.asset.findUniqueOrThrow({ where: { id: bad } })).status, 'rejected');
      assert.equal((await call(owner, 'cases', caseInput(bad))).status, 409);
      assert.equal((await call(owner, `assets/${bad}/access`, { variant: 'display' })).status, 404);
    }
  } finally {
    try {
      const assets = await deps.db.asset.findMany({ where: { ownerId: { in: users } } });
      for (const asset of assets) for (const key of [originalKey(asset.id), ...['display', 'preview', 'poster'].map(variant => derivativeKey(asset.id, variant))]) await store.remove(key);
      await deps.db.supportCase.deleteMany({ where: { ownerId: { in: users } } });
      await deps.db.asset.deleteMany({ where: { ownerId: { in: users } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
      assert.equal(await deps.db.authUser.count({ where: { id: { in: users } } }), 0);
      await ensureRedis(deps.redis);
      let cursor = '0';
      do {
        const next = await deps.redis.scan(cursor, 'MATCH', config.AUTH_RATE_PREFIX + ':*', 'COUNT', 100);
        cursor = next[0];
        if (next[1].length) await deps.redis.del(...next[1]);
      } while (cursor !== '0');
    } finally { store.close(); await app.close(); }
  }
});
