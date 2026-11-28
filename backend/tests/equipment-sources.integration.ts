import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
import { equipmentReferenceBundle, equipmentReferenceBundleDigest } from '../shared/equipment-reference-bundle.js';
import { runEquipmentReferenceCoverage } from '../scripts/equipment-reference-coverage.js';

const baseConfig = readConfig();
if (baseConfig.NODE_ENV !== 'test' || !new URL(baseConfig.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Equipment reference tests require an isolated *_test database.');
}

test('equipment lookup retains approved sources, matches exact models and hides retired specifications', async () => {
  const config = { ...baseConfig, AI_SERVICE_ORIGIN: undefined, AI_INTERNAL_TOKEN: undefined };
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const users: string[] = [];
  const sourceIds: string[] = [];
  let listingId: string | undefined;
  try {
    await app.listen(0, '127.0.0.1');
    const root = (await app.getUrl()) + '/api/v1/';
    async function actor(role: 'admin' | 'renter' | 'customer', verified = true) {
      const user = await deps.db.authUser.create({ data: {
        roles: [role], email: randomUUID() + '@stagelink.test', displayName: 'Equipment reference fixture',
        passwordHash: 'unused', emailVerifiedAt: verified ? new Date() : null,
      } });
      users.push(user.id);
      const session = await deps.db.authSession.create({ data: {
        userId: user.id, activeRole: role, expiresAt: new Date(Date.now() + 600_000),
      } });
      const access = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id)
        .setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET, 'hex'));
      return {
        Authorization: 'Bearer ' + access, 'X-CSRF-Token': csrfFor(config.AUTH_JWT_SECRET, session.id),
        Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json',
      };
    }
    async function request(headers: Awaited<ReturnType<typeof actor>>, path: string, body?: object) {
      const response = await fetch(root + path, {
        headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() };
    }
    const admin = await actor('admin');
    const renter = await actor('renter');
    const other = await actor('renter');
    const customer = await actor('customer');
    const catalog = 'admin/equipment-spec-sources';
    const search = 'ai/generations/equipment-specs';
    const source = {
      manufacturer: 'Fixture Audio', model: 'X-12', specs: { specWattage: '240', specWeight: '14.25' },
      url: 'https://vendor.example/specification', title: 'Fixture specification sheet', locator: 'Page 8',
    };
    assert.equal((await request(renter, catalog, source)).status, 403);
    assert.equal((await request({ ...admin, 'X-CSRF-Token': 'invalid' }, catalog, source)).status, 403);
    for (const invalid of [
      { ...source, specs: {} },
      { ...source, specs: { specSpl: '500' } },
      { ...source, specs: { packageInclusions: 'Rental-specific accessories' } },
      { ...source, url: 'http://vendor.example/specification' },
    ]) {
      assert.equal((await request(admin, catalog, invalid)).status, 400);
    }
    const approved = await request(admin, catalog, source);
    assert.equal(approved.status, 200);
    sourceIds.push(approved.data.id);
    assert.equal((await request(admin, catalog, { ...source, model: 'x-12' })).status, 409);
    assert.equal((await request(admin, catalog)).data.items.some((item: { id: string }) => item.id === approved.data.id), true);

    const input = { requestKey: randomUUID(), manufacturer: ' fixture   AUDIO ', model: 'x-12' };
    assert.equal((await request(customer, search, input)).status, 403);
    const matched = await request(renter, search, input);
    assert.equal(matched.status, 200);
    assert.equal(matched.data.kind, 'equipment-specs');
    assert.equal(matched.data.promptVersion, null);
    const snapshot = matched.data.suggestion;
    assert.equal(snapshot.match, 'matched');
    assert.deepEqual(snapshot.specs, source.specs);
    assert.deepEqual(snapshot.source, {
      id: approved.data.id, url: source.url, title: source.title, locator: source.locator, approvedAt: approved.data.approvedAt,
    });
    const lookup = 'ai/generations/' + matched.data.id;
    assert.deepEqual(await request(renter, lookup), matched);
    assert.equal((await request(other, lookup)).status, 404);
    assert.deepEqual(await request(renter, search, { ...input, manufacturer: 'Fixture Audio', model: 'X-12' }), matched);
    assert.equal((await request(renter, search, { ...input, model: 'X-12 MKII' })).status, 409);

    const unknown = await request(renter, search, { requestKey: randomUUID(), model: 'X-12 MKII' });
    assert.deepEqual(unknown.data.suggestion, {
      match: 'unknown', manufacturer: null, model: 'X-12 MKII', specs: {}, source: null,
    });
    const alternate = await request(admin, catalog, { ...source, manufacturer: 'Other fixture manufacturer' });
    assert.equal(alternate.status, 200);
    sourceIds.push(alternate.data.id);
    const ambiguous = await request(renter, search, { requestKey: randomUUID(), model: source.model });
    assert.equal(ambiguous.data.suggestion.match, 'ambiguous');
    assert.deepEqual(ambiguous.data.suggestion.specs, {});

    const retired = await request(admin, catalog + '/' + approved.data.id + '/retire', { reason: 'Reference was withdrawn.' });
    assert.equal(retired.status, 200);
    assert.ok(retired.data.retiredAt);
    const withdrawn = await request(renter, lookup);
    assert.deepEqual(withdrawn.data.suggestion, { ...snapshot, match: 'withdrawn', specs: {} });
    assert.deepEqual(await request(renter, search, input), withdrawn);

    const replacement = await request(admin, catalog, { ...source, specs: { specWeight: '14.50' }, locator: 'Page 10' });
    assert.equal(replacement.status, 200);
    sourceIds.push(replacement.data.id);
    const refreshed = await request(renter, search, { ...input, requestKey: randomUUID() });
    assert.deepEqual(refreshed.data.suggestion.specs, { specWeight: '14.50' });
    assert.equal(refreshed.data.suggestion.source.id, replacement.data.id);
    assert.equal((await request(renter, lookup)).data.suggestion.match, 'withdrawn');
    assert.equal(await deps.db.aiModelCall.count({ where: { generation: { ownerId: { in: users } } } }), 0);
    assert.equal(await deps.db.rentalListing.count({ where: { ownerId: { in: users } } }), 0);

    const bundlePath = catalog + '/reference-bundle';
    const importPath = bundlePath + '/approve';
    const bundleCommand = { digest: equipmentReferenceBundleDigest };
    const allModels = equipmentReferenceBundle.entries.map(entry => entry.model);
    assert.equal((await request(renter, bundlePath)).status, 403);
    assert.equal((await request(renter, importPath, bundleCommand)).status, 403);
    assert.equal((await request(await actor('admin', false), importPath, bundleCommand)).status, 403);
    assert.equal((await request({ ...admin, 'X-CSRF-Token': 'invalid' }, importPath, bundleCommand)).status, 403);
    assert.equal((await request({ ...admin, Origin: 'https://untrusted.example' }, importPath, bundleCommand)).status, 403);
    assert.equal((await request(admin, importPath, { digest: '0'.repeat(64) })).status, 409);
    assert.equal((await request(admin, importPath, { ...bundleCommand, approvedBy: users[1] })).status, 400);
    for (const models of [[], ['Unknown model'], ['DXR15mkII', 'DXR15mkII']]) {
      assert.equal((await request(admin, importPath, { ...bundleCommand, models })).status, 400);
    }
    const preview = await request(admin, bundlePath);
    assert.equal(preview.status, 200);
    assert.equal(preview.data.entries.length, allModels.length);
    assert.ok(preview.data.entries.every((entry: { state: string }) => entry.state === 'new'));
    assert.equal(preview.data.digest, equipmentReferenceBundleDigest);

    // A conflict in the last entry cannot cause earlier entries to be partially imported.
    const { notes: _notes, ...last } = equipmentReferenceBundle.entries.at(-1)!;
    const conflicting = await request(admin, catalog, { ...last, specs: { specWeight: '5' } });
    assert.equal(conflicting.status, 200);
    sourceIds.push(conflicting.data.id);
    assert.equal((await request(admin, importPath, bundleCommand)).status, 409);
    assert.equal((await request(admin, bundlePath)).data.entries.filter((entry: { state: string }) => entry.state === 'new').length, allModels.length - 1);
    await request(admin, `${catalog}/${conflicting.data.id}/retire`, { reason: 'Fixture withdrawal must survive bulk approval.' });
    assert.equal((await request(admin, importPath, bundleCommand)).status, 409);
    assert.equal((await request(admin, bundlePath)).data.entries.at(-1).state, 'retired');
    await deps.db.equipmentSpecSource.delete({ where: { id: conflicting.data.id } });

    const anotherAdmin = await actor('admin');
    const imports = await Promise.all([
      request(admin, importPath, { ...bundleCommand, models: allModels }),
      request(anotherAdmin, importPath, bundleCommand),
    ]);
    assert.deepEqual(imports.map(result => result.status), [200, 200]);
    assert.deepEqual(imports.map(result => result.data.created).sort(), [0, allModels.length]);
    const imported = imports.find(result => result.data.created === allModels.length)!.data.items;
    sourceIds.push(...imported.map((entry: { id: string }) => entry.id));
    const retry = await request(admin, importPath, bundleCommand);
    assert.equal(retry.data.created, 0);
    assert.equal(retry.data.unchanged, allModels.length);
    assert.deepEqual(retry.data.items.map((entry: { id: string }) => entry.id), imported.map((entry: { id: string }) => entry.id));
    assert.deepEqual(retry.data.items.map((entry: { approvedBy: string }) => entry.approvedBy), imported.map((entry: { approvedBy: string }) => entry.approvedBy));
    const bundleRenter = await actor('renter');
    for (const entry of equipmentReferenceBundle.entries) {
      const result = await request(bundleRenter, search, { requestKey: randomUUID(), manufacturer: entry.manufacturer, model: entry.model });
      assert.equal(result.status, 200);
      assert.equal(result.data.suggestion.match, 'matched');
      assert.deepEqual(result.data.suggestion.specs, entry.specs);
      assert.equal(result.data.suggestion.source.url, entry.url);
      assert.equal('packageInclusions' in result.data.suggestion.specs, false);
    }
    const original = await request(renter, search, { requestKey: randomUUID(), manufacturer: 'Yamaha', model: 'DXR15' });
    const mkII = await request(renter, search, { requestKey: randomUUID(), manufacturer: 'Yamaha', model: 'DXR15mkII' });
    assert.equal(original.data.suggestion.specs.specSpl, '133');
    assert.equal(mkII.data.suggestion.specs.specSpl, '134');
    assert.notEqual(original.data.suggestion.source.id, mkII.data.suggestion.source.id);
    const originalSubwoofer = await request(renter, search, { requestKey: randomUUID(), manufacturer: 'Yamaha', model: 'DXS15' });
    const revisedSubwoofer = await request(renter, search, { requestKey: randomUUID(), manufacturer: 'Yamaha', model: 'DXS15mkII' });
    assert.equal(originalSubwoofer.data.suggestion.specs.specWattage, '950');
    assert.equal(revisedSubwoofer.data.suggestion.specs.specWattage, '1020');
    assert.notEqual(originalSubwoofer.data.suggestion.source.id, revisedSubwoofer.data.suggestion.source.id);
    const unreviewedVariant = await request(renter, search, { requestKey: randomUUID(), manufacturer: 'Yamaha', model: 'DXS15 mk3' });
    assert.equal(unreviewedVariant.data.suggestion.match, 'unknown', 'An approved source cannot fill a different model generation');
    await request(admin, `${catalog}/${mkII.data.suggestion.source.id}/retire`, { reason: 'Keep this reference withdrawn on future imports.' });
    assert.equal((await request(admin, importPath, bundleCommand)).status, 409);
    const subset = await request(admin, importPath, { ...bundleCommand, models: ['Intimidator Spot 160 ILS'] });
    assert.equal(subset.status, 200, 'A retired unselected source cannot block reviewed unrelated selections');
    assert.equal(subset.data.items.length, 1);
    assert.equal(subset.data.unchanged, 1);
    assert.equal((await request(renter, search, { requestKey: randomUUID(), model: 'DXR15mkII' })).data.suggestion.match, 'unknown');
    assert.equal((await request(renter, search, { requestKey: randomUUID(), model: 'DXR15' })).data.suggestion.match, 'matched');

    const ownerId = users[1]!;
    const details = {
      equipmentCategories: ['Sound'], rentalTerms: 'Synthetic rental terms for coverage.', deliveryOffered: false,
      operatingHours: Array.from({ length: 7 }, (_, day) => ({ day, opens: '09:00', closes: '17:00' })),
    };
    const profile = { displayName: 'Fixture storefront', bio: 'Equipment coverage fixture profile.', city: 'Colombo', serviceRadiusKm: 20 };
    await deps.db.providerProfile.create({ data: {
      userId: ownerId, kind: 'renter', ...profile, ...details, approvedRevision: 1, reviewStatus: 'approved',
      address: '', category: '', genres: [], experienceYears: 0, baseRateMinor: 0,
      approvedSnapshot: { userId: ownerId, kind: 'renter', revision: 1, ...profile, details },
    } });
    const listing = await deps.db.rentalListing.create({ data: { ownerId, versions: { create: {
      version: 1, title: 'Published equipment fixture', description: 'A synthetic published listing.', category: 'Sound',
      dailyRateMinor: 5000, stockQuantity: 1,
    } } } });
    listingId = listing.id;
    await deps.db.rentalListing.update({ where: { id: listing.id }, data: { publishedVersion: 1, status: 'published' } });
    const report = await runEquipmentReferenceCoverage({
      origin: await app.getUrl(), session: { accessToken: admin.Authorization.slice('Bearer '.length) },
    }, [{ id: listing.id, version: 1, manufacturer: 'yamaha', model: 'dbr12' }]);
    assert.deepEqual(report.listings.find(item => item.id === listing.id), {
      id: listing.id, version: 1, title: 'Published equipment fixture', category: 'Sound',
      status: 'covered', identity: { manufacturer: 'yamaha', model: 'dbr12' }, inBundle: true,
    });
  } finally {
    try {
      if (listingId) {
        await deps.db.rentalListing.update({ where: { id: listingId }, data: { status: 'draft', publishedVersion: null } });
        await deps.db.rentalListingVersion.deleteMany({ where: { listingId } });
        await deps.db.rentalListing.delete({ where: { id: listingId } });
      }
      await deps.db.aiGenerationJob.deleteMany({ where: { ownerId: { in: users } } });
      await deps.db.equipmentSpecSource.deleteMany({ where: { OR: [{ id: { in: sourceIds } }, { approvedBy: { in: users } }] } });
      await deps.db.authUser.deleteMany({ where: { id: { in: users } } });
    } finally {
      await app.close();
    }
  }
});
