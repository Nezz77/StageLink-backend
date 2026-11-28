import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../api/src/app.js';
import { hashPassword } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { databaseNow } from '../shared/database-clock.js';
import { NOTIFICATION_TOPIC } from '../shared/notifications.js';
import { resources } from '../shared/resources.js';

const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'gigs-test-' + randomUUID() });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Gig integration requires an isolated *_test database.');
}

test('gig ownership, publication snapshots and concurrent revisions', async t => {
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const ids: string[] = [];
  let bookingId: string | undefined;
  const password = 'A private fixture password 12!';
  type Login = { accessToken: string; csrfToken: string; user: { id: string } };

  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();

    async function call(path: string, body?: unknown, login?: Login, method = body === undefined ? 'GET' : 'POST', origin = base) {
      const response = await fetch(origin + '/api/v1/' + path, {
        method,
        headers: {
          'Content-Type': 'application/json', Origin: config.WEB_ORIGIN,
          ...(login ? { Authorization: 'Bearer ' + login.accessToken, 'X-CSRF-Token': login.csrfToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }

    async function fixture(role: 'artist' | 'admin' | 'customer'): Promise<Login> {
      const user = await deps.db.authUser.create({ data: {
        email: randomUUID() + '@stagelink.test', displayName: 'Gig fixture', roles: [role],
        passwordHash: await hashPassword(password), emailVerifiedAt: new Date(),
      } });
      ids.push(user.id);
      const result = await call('auth/login', { email: user.email, password });
      assert.equal(result.status, 200);
      return result.data;
    }

    const artist = await fixture('artist');
    const other = await fixture('artist');
    const admin = await fixture('admin');
    const fields = { title: 'Acoustic set', description: 'A live performance', priceMinor: 1500000 };
    assert.equal((await call('me/gigs', fields, admin)).status, 403);
    const created = await call('me/gigs', fields, artist);
    assert.equal(created.status, 200);
    const privatePath = 'me/gigs/' + created.data.id;
    const publicPath = 'listings/' + created.data.id;
    assert.deepEqual((await call('me/gigs', undefined, other)).data, []);
    assert.equal((await call(privatePath, { ...fields, revision: 1 }, other, 'PATCH')).status, 404);
    assert.equal((await call(publicPath)).status, 404);
    const listed = async () => (await call('listings')).data.items.find((item: { id: string }) => item.id === created.data.id);
    assert.equal(await listed(), undefined);
    assert.equal((await call('listings?cursor=invalid')).status, 400);
    assert.equal((await call(privatePath + '/status', { revision: 1, action: 'publish' }, artist)).status, 409);

    const profile = {
      revision: 0, displayName: 'Acoustic fixture', bio: 'Acoustic music for events.', city: 'Colombo',
      serviceRadiusKm: 45, address: 'Private fixture address', latitude: 6.927111, longitude: 79.861234,
      details: { category: 'Vocalist', genres: ['Jazz'], experienceYears: 5, baseRateMinor: 1500000, currency: 'LKR' },
    };
    assert.equal((await call('me/providers/artist', profile, artist, 'PUT')).status, 200);
    assert.equal((await call('me/providers/artist/submit', { revision: 1 }, artist)).status, 200);
    const decision = { revision: 2, approved: true, reason: 'Approved artist profile for the catalog fixture' };
    assert.equal((await call(`admin/providers/${artist.user.id}/artist/decision`, decision, admin)).status, 200);

    const calendarPath = `providers/${artist.user.id}/availability?startsAt=2028-01-01T00%3A00%3A00Z&endsAt=2028-02-01T00%3A00%3A00Z`;
    assert.equal((await call(calendarPath)).data.configured, false);
    const hours = Array.from({ length: 7 }, (_, day) => ({ day, opens: '09:00', closes: '17:00' }));
    const calendar = { revision: 0, timezone: 'Asia/Colombo', hours };
    assert.equal((await call('me/availability', { ...calendar, timezone: 'Not/AZone' }, artist, 'PUT')).status, 400);
    assert.equal((await call('me/availability', calendar, artist, 'PUT')).status, 200);
    const block = { revision: 1, startsAt: '2028-01-10T09:00:00+05:30', endsAt: '2028-01-10T17:00:00+05:30', reason: 'Private leave' };
    const savedBlock = await call('me/availability/blocks', block, artist);
    assert.equal(savedBlock.status, 200);
    assert.equal(savedBlock.data.blocks[0].reason, block.reason);
    assert.equal((await call('me/availability/blocks', { ...block, revision: 2 }, artist)).status, 409);
    const publicCalendar = await call(calendarPath);
    assert.equal(publicCalendar.status, 200);
    assert.equal(publicCalendar.data.timezone, 'Asia/Colombo');
    assert.deepEqual(publicCalendar.data.blocks, [{ startsAt: '2028-01-10T03:30:00.000Z', endsAt: '2028-01-10T11:30:00.000Z' }]);
    const blackoutPath = 'me/availability/blocks/' + savedBlock.data.blocks[0].id;
    assert.equal((await call(blackoutPath, { revision: 1 }, artist, 'DELETE')).status, 409);
    const cleared = await call(blackoutPath, { revision: 2 }, artist, 'DELETE');
    assert.equal(cleared.status, 200);
    let calendarRevision = cleared.data.revision;
    assert.deepEqual((await call(calendarPath)).data.blocks, []);

    assert.equal((await call(privatePath + '/status', { revision: 1, action: 'publish' }, artist)).status, 200);
    const customer = await fixture('customer');
    const window = { startsAt: '2090-01-10T09:00:00+05:30', endsAt: '2090-01-10T11:00:00+05:30' };
    const booking = await call('bookings', {
      ...window, targetKind: 'gig', targetId: created.data.id, targetVersion: (await call(publicPath)).data.version,
      quantity: 1, requestKey: randomUUID(),
    }, customer);
    assert.equal(booking.status, 200);
    assert.equal(booking.data.state, 'held');
    bookingId = booking.data.id as string;
    const bookingDecision = `bookings/${bookingId}/provider-decisions`;
    const accept = { revision: 1, decision: 'accepted' };
    const bookingBlock = { ...window, reason: 'Private schedule conflict' };
    const earlyBlock = await call('me/availability/blocks', { ...bookingBlock, revision: calendarRevision }, artist);
    assert.equal(earlyBlock.status, 200);
    const unavailable = await call(bookingDecision, accept, artist);
    assert.equal(unavailable.status, 409);
    assert.equal(unavailable.data.code, 'RESERVATION_UNAVAILABLE');
    const reopened = await call('me/availability/blocks/' + earlyBlock.data.blocks[0].id, { revision: earlyBlock.data.revision }, artist, 'DELETE');
    assert.equal(reopened.status, 200);
    calendarRevision = reopened.data.revision;

    const { app: replica } = await createApp(config);
    t.after(() => replica.close());
    await replica.listen(0, '127.0.0.1');
    const [accepted, blocked] = await Promise.all([
      call(bookingDecision, accept, artist),
      call('me/availability/blocks', { ...bookingBlock, revision: calendarRevision }, artist, 'POST', await replica.getUrl()),
    ]);
    assert.deepEqual([accepted.status, blocked.status].sort(), [200, 409]);
    if (blocked.status === 200) {
      assert.equal(accepted.data.code, 'RESERVATION_UNAVAILABLE');
      const removed = await call('me/availability/blocks/' + blocked.data.blocks[0].id, { revision: blocked.data.revision }, artist, 'DELETE');
      assert.equal(removed.status, 200);
      calendarRevision = removed.data.revision;
      assert.equal((await call(bookingDecision, accept, artist)).data.state, 'accepted');
    } else {
      assert.equal(blocked.data.code, 'BLACKOUT_BOOKING_CONFLICT');
    }
    const conflict = await call('me/availability/blocks', { ...bookingBlock, revision: calendarRevision }, artist);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, 'BLACKOUT_BOOKING_CONFLICT');
    assert.doesNotMatch(JSON.stringify(conflict.data), /Private schedule conflict/);
    const adjacent = await call('me/availability/blocks', {
      ...bookingBlock, revision: calendarRevision, startsAt: window.endsAt, endsAt: '2090-01-10T12:00:00+05:30',
    }, artist);
    assert.equal(adjacent.status, 200);
    const removedAdjacent = await call('me/availability/blocks/' + adjacent.data.blocks[0].id, { revision: adjacent.data.revision }, artist, 'DELETE');
    assert.equal(removedAdjacent.status, 200);
    const databaseTime = await databaseNow(deps.db);
    await deps.db.booking.update({ where: { id: bookingId }, data: { holdExpiresAt: new Date(databaseTime.getTime() - 1000) } });
    const afterExpiry = await call('me/availability/blocks', { ...bookingBlock, revision: removedAdjacent.data.revision }, artist);
    assert.equal(afterExpiry.status, 200);
    const removedExpired = await call('me/availability/blocks/' + afterExpiry.data.blocks[0].id, { revision: afterExpiry.data.revision }, artist, 'DELETE');
    assert.equal(removedExpired.status, 200);
    // Historical agreements can have an expired hold and no provider decision recorded.
    await deps.db.booking.update({
      where: { id: bookingId },
      data: { agreedAt: databaseTime, providerDecision: null, decidedAt: null, decisionReason: null },
    });
    const agreedBlock = await call('me/availability/blocks', { ...bookingBlock, revision: removedExpired.data.revision }, artist);
    assert.equal(agreedBlock.status, 409);
    assert.equal(agreedBlock.data.code, 'BLACKOUT_BOOKING_CONFLICT');
    const schedule = await call('me/calendar?' + new URLSearchParams({ from: window.startsAt, to: window.endsAt }), undefined, artist);
    assert.equal(schedule.status, 200);
    assert.ok(schedule.data.items.some((item: { id: string; state: string }) => item.id === bookingId && item.state === 'agreed'));

    const fixed = {
      title: 'Acoustic package', pricing: 'fixed', durationMinutes: 120, performers: 2,
      basePriceMinor: 1500000, included: 'Acoustic set', excluded: 'Lighting',
      addons: [{ id: 'sound', title: 'Sound system', priceMinor: 100000 }],
    };
    const packages = [
      { ...fixed, id: 'standard' },
      { ...fixed, id: 'deluxe', performers: 4 },
      { ...fixed, id: 'vip', pricing: 'custom', basePriceMinor: null, addons: [] },
    ];
    async function featured() {
      const response = await call('public/featured-packages');
      assert.equal(response.status, 200);
      return response.data.items.find((item: { id: string }) => item.id === created.data.id);
    }
    assert.equal(await featured(), undefined);
    const change = { ...fields, packages, title: 'Revised acoustic set', revision: 2 };
    assert.equal((await call(privatePath, { ...change, packages: [packages[0]] }, artist, 'PATCH')).status, 400);
    const attempts = await Promise.all([
      call(privatePath, change, artist, 'PATCH'),
      call(privatePath, change, artist, 'PATCH'),
    ]);
    assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
    const stillPublished = await call(publicPath);
    assert.equal(stillPublished.data.title, fields.title);
    assert.deepEqual(stillPublished.data.artist, { displayName: profile.displayName, city: profile.city, category: 'Vocalist' });
    assert.ok(!JSON.stringify(stillPublished.data).includes(profile.address));
    const summary = await listed();
    assert.equal(summary.title, fields.title);
    assert.equal('packages' in summary, false);
    const matching = await call('listings?q=acoustic&city=colombo&genre=jazz&lat=6.93&lng=79.86&radiusKm=5&maxPriceMinor=1500000');
    assert.equal(matching.status, 200);
    assert.ok(matching.data.items.some((item: { id: string }) => item.id === created.data.id));
    assert.ok(!JSON.stringify(matching.data).includes('6.927111'));

    const discovery = await call('discovery/intent', { query: 'Find a Jazz singer in Colombo with LKR 15,000.' });
    assert.equal(discovery.status, 200);
    assert.equal(discovery.data.unparsed, 'Find a Jazz singer in Colombo with LKR 15,000');
    const intent = await call('discovery/intent', { query: 'Find a Jazz singer in Colombo up to LKR 15,000.' });
    assert.deepEqual(intent.data, { filters: { city: 'Colombo', genre: 'Jazz', category: 'Vocalist', maxPriceMinor: 1500000 }, unparsed: null });
    const confirmed = new URLSearchParams(Object.fromEntries(
      Object.entries(intent.data.filters).map(([name, value]) => [name, String(value)]),
    ));
    const exactMatch = await call('listings?' + confirmed);
    assert.equal(exactMatch.status, 200);
    assert.ok(exactMatch.data.items.some((item: { id: string }) => item.id === created.data.id));
    confirmed.set('category', 'DJ');
    const wrongCategory = await call('listings?' + confirmed);
    assert.equal(wrongCategory.status, 200);
    assert.ok(!wrongCategory.data.items.some((item: { id: string }) => item.id === created.data.id));
    for (const query of ['genre=rock', 'maxPriceMinor=1499999', 'lat=7.3&lng=80.6&radiusKm=5']) {
      const excluded = await call('listings?' + query);
      assert.equal(excluded.status, 200);
      assert.ok(!excluded.data.items.some((item: { id: string }) => item.id === created.data.id));
    }
    assert.equal((await call('listings?lat=6.93')).status, 400);
    const afterGig = await call('listings?cursor=' + created.data.id);
    assert.equal(afterGig.status, 200);
    assert.ok(afterGig.data.items.every((item: { id: string }) => item.id > created.data.id));
    assert.deepEqual(stillPublished.data.packages, []);
    assert.deepEqual((await call('me/gigs', undefined, artist)).data[0].packages, packages);
    assert.equal((await call(privatePath + '/status', { revision: 3, action: 'publish' }, artist)).status, 200);
    const republished = await call(publicPath);
    assert.equal(republished.data.title, change.title);
    assert.deepEqual(republished.data.packages, packages);
    const preview = await featured();
    assert.deepEqual(preview.packages, packages);
    assert.equal(preview.version, republished.data.version);
    assert.equal('description' in preview, false);
    await deps.db.authUser.update({ where: { id: artist.user.id }, data: { disabledAt: new Date() } });
    assert.equal((await call(publicPath)).status, 404);
    assert.equal(await listed(), undefined);
    assert.equal(await featured(), undefined);
    await deps.db.authUser.update({ where: { id: artist.user.id }, data: { disabledAt: null } });
    assert.equal((await call(privatePath + '/status', { revision: 4, action: 'pause' }, artist)).status, 200);
    assert.equal((await call(publicPath)).status, 404);
    assert.equal(await listed(), undefined);
    assert.equal((await call(privatePath + '/status', { revision: 5, action: 'archive' }, artist)).status, 200);
    assert.deepEqual((await call('me/gigs', undefined, artist)).data, []);
    assert.equal(await deps.db.artistGigVersion.count({ where: { gigId: created.data.id } }), 2);
  } finally {
    try {
      const owned = { ownerId: { in: ids } };
      if (bookingId) {
        await deps.db.outboxEvent.deleteMany({ where: { topic: NOTIFICATION_TOPIC, payload: { path: ['sourceId'], equals: bookingId } } });
        await deps.db.booking.deleteMany({ where: { id: bookingId } });
      }
      await deps.db.artistGig.updateMany({ where: owned, data: { status: 'archived', publishedVersion: null } });
      await deps.db.artistGigVersion.deleteMany({ where: { gig: owned } });
      await deps.db.artistGig.deleteMany({ where: owned });
      await deps.db.profileAudit.deleteMany({ where: { targetUserId: { in: ids } } });
      await deps.db.authUser.deleteMany({ where: { id: { in: ids } } });
      let cursor = '0';
      do {
        const [next, keys] = await deps.redis.scan(cursor, 'MATCH', config.AUTH_RATE_PREFIX + ':*', 'COUNT', 100);
        cursor = next;
        if (keys.length) await deps.redis.del(...keys);
      } while (cursor !== '0');
    } finally {
      await app.close();
    }
  }
});
