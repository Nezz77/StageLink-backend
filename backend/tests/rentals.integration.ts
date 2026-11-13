import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../api/src/app.js';
import { hashPassword } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';

const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'rentals-test-' + randomUUID() });
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Equipment listing integration requires an isolated *_test database.');
}

test('renter owns revisions and public browse only shows approved published equipment', async () => {
  const deps = resources(config);
  const { app } = await createApp(config, deps);
  const ids: string[] = [];
  const announcements: string[] = [];
  const password = 'A private fixture password 12!';
  type Login = { accessToken: string; csrfToken: string; user: { id: string } };

  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    async function call(path: string, body?: unknown, login?: Login, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + '/api/v1/' + path, {
        method, headers: {
          'Content-Type': 'application/json', Origin: config.WEB_ORIGIN,
          ...(login ? { Authorization: 'Bearer ' + login.accessToken, 'X-CSRF-Token': login.csrfToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }

    async function fixture(role: 'renter' | 'admin' | 'customer'): Promise<Login> {
      const user = await deps.db.authUser.create({ data: {
        email: randomUUID() + '@stagelink.test', displayName: 'Equipment fixture', roles: [role],
        passwordHash: await hashPassword(password), emailVerifiedAt: new Date(),
      } });
      ids.push(user.id);
      const result = await call('auth/login', { email: user.email, password });
      assert.equal(result.status, 200);
      return result.data;
    }

    const renter = await fixture('renter');
    const other = await fixture('renter');
    const admin = await fixture('admin');
    const fields = {
      title: 'Powered speaker', description: 'Speaker for indoor events', category: 'Sound',
      dailyRateMinor: 200000, stockQuantity: 4, specs: { specWattage: '1100', specWeight: '22.50' },
    };
    assert.equal((await call('me/rentals', fields, admin)).status, 403);
    assert.equal((await call('me/rentals', { ...fields, stockQuantity: -1 }, renter)).status, 400);
    assert.equal((await call('me/rentals', { ...fields, specs: { specSpl: '251' } }, renter)).status, 400);
    const created = await call('me/rentals', fields, renter);
    assert.equal(created.status, 200);
    const noDeposit = { mode: 'none', currency: 'LKR' };
    assert.deepEqual(created.data.depositPolicy, noDeposit);
    const id = created.data.id;
    const savedPath = 'me/saved-items/rental/' + id;
    assert.equal((await call(savedPath, {}, other, 'PUT')).status, 404);
    const path = 'me/rentals/' + id;
    async function publicItem() {
      const page = await call('rentals');
      assert.equal(page.status, 200);
      return page.data.items.find((item: { id: string }) => item.id === id);
    }
    assert.equal(await publicItem(), undefined);
    const beforePublish = await call('public/feed');
    assert.equal(beforePublish.status, 200);
    assert.ok(!beforePublish.data.rentals.some((item: { id: string }) => item.id === id));
    const now = Date.now();
    const notice = { title: 'Catalog fixture', body: 'A public catalog announcement' };
    for (const schedule of [
      { publishedAt: new Date(now - 10000), startsAt: new Date(now - 10000), endsAt: null },
      { publishedAt: null, startsAt: new Date(now - 10000), endsAt: null },
      { publishedAt: new Date(now - 10000), startsAt: new Date(now + 86400000), endsAt: null },
      { publishedAt: new Date(now - 10000), startsAt: new Date(now - 10000), endsAt: new Date(now - 1000) },
    ]) {
      const announcement = await deps.db.publicAnnouncement.create({ data: { ...notice, ...schedule } });
      announcements.push(announcement.id);
    }
    const notices = await call('public/announcements');
    assert.equal(notices.status, 200);
    assert.deepEqual(notices.data.items.filter((item: { id: string }) => announcements.includes(item.id))
      .map((item: { id: string }) => item.id), [announcements[0]]);
    assert.equal((await call(path, { ...fields, revision: 1 }, other, 'PATCH')).status, 404);
    assert.equal((await call(path + '/status', { revision: 1, action: 'publish' }, renter)).status, 409);

    const storefront = {
      revision: 0, displayName: 'Audio rentals', bio: 'Sound equipment for indoor events.', city: 'Colombo',
      serviceRadiusKm: 40, address: 'Private pickup address', latitude: null, longitude: null,
      details: {
        equipmentCategories: ['Sound'],
        operatingHours: Array.from({ length: 7 }, (_, day) => ({ day, opens: '09:00', closes: '17:00' })),
        rentalTerms: 'Equipment must be returned by the agreed time.', deliveryOffered: true,
      },
    };
    assert.equal((await call('me/providers/renter', storefront, renter, 'PUT')).status, 200);
    assert.equal((await call('me/providers/renter/submit', { revision: 1 }, renter)).status, 200);
    const decision = { revision: 2, approved: true, reason: 'Approved storefront for the catalog fixture' };
    assert.equal((await call(`admin/providers/${renter.user.id}/renter/decision`, decision, admin)).status, 200);
    assert.equal((await call(path + '/status', { revision: 1, action: 'publish' }, renter)).status, 200);

    const edit = { ...fields, revision: 2, dailyRateMinor: 250000, stockQuantity: 2, specs: { specWattage: '1200' } };
    const writes = await Promise.all([call(path, edit, renter, 'PATCH'), call(path, edit, renter, 'PATCH')]);
    assert.deepEqual(writes.map(result => result.status).sort(), [200, 409]);
    const original = await publicItem();
    assert.equal(original.dailyRateMinor, fields.dailyRateMinor);
    assert.deepEqual(original.specs, fields.specs);
    assert.equal('stockQuantity' in original, false);
    assert.deepEqual(original.storefront, { displayName: storefront.displayName, city: storefront.city });
    assert.equal((await call(path + '/status', { revision: 3, action: 'publish' }, renter)).status, 200);
    assert.deepEqual((await publicItem()).specs, edit.specs);
    assert.equal((await publicItem()).kind, 'equipment');
    assert.equal((await publicItem()).weeklyRateMinor, null);
    const saved = await Promise.all([call(savedPath, {}, other, 'PUT'), call(savedPath, {}, other, 'PUT')]);
    assert.deepEqual(saved.map(result => result.status), [200, 200]);
    assert.equal(saved[0]?.data.id, saved[1]?.data.id);
    assert.deepEqual((await call('me/saved-items', undefined, renter)).data.items, []);
    assert.equal((await call('me/saved-items?kind=rental', undefined, other)).data.items[0].targetId, id);
    const feed = await call('public/feed');
    assert.equal(feed.status, 200);
    assert.equal(feed.data.totals.rentals, beforePublish.data.totals.rentals + 1);
    const summary = feed.data.rentals.find((item: { id: string }) => item.id === id);
    assert.equal(summary.title, fields.title);
    assert.equal(summary.dailyRateMinor, edit.dailyRateMinor);
    assert.equal('stockQuantity' in summary, false);
    assert.equal('specs' in summary, false);
    assert.ok(feed.data.announcements.some((item: { id: string }) => item.id === announcements[0]));

    const asset = await deps.db.asset.create({ data: {
      ownerId: renter.user.id, purpose: 'equipment', filename: 'speaker.png', mime: 'image/png',
      bytes: 128, sha256: 'a'.repeat(64), status: 'ready', expiresAt: new Date(Date.now() + 3600000),
    } });
    const portfolio = await deps.db.portfolioItem.create({ data: {
      ownerId: renter.user.id, kind: 'renter', assetId: asset.id, caption: 'Speaker photo', transcript: '', status: 'pending',
    } });
    const gallery = path + '/media';
    const publicGallery = 'rentals/' + id + '/media';
    const picture = { portfolioItemId: portfolio.id, position: 0, caption: 'Speaker front' };
    assert.equal((await call(gallery, picture, renter)).status, 404);
    await deps.db.portfolioItem.update({ where: { id: portfolio.id }, data: { status: 'approved' } });
    assert.equal((await call(gallery, picture, other)).status, 404);
    const attached = await call(gallery, picture, renter);
    assert.equal(attached.status, 200);
    const link = attached.data.items[0];
    assert.equal((await call(gallery, picture, renter)).status, 409);
    const publishedGallery = await call(publicGallery);
    assert.deepEqual(publishedGallery.data.items, [{ ...picture, mime: 'image/png' }]);
    const linkPath = gallery + '/' + link.id;
    const editedLink = await call(linkPath, { revision: 1, position: 2, caption: 'Front grille' }, renter, 'PATCH');
    assert.equal(editedLink.status, 200);
    assert.equal((await call(linkPath, { revision: 1 }, renter, 'DELETE')).status, 409);
    await deps.db.portfolioItem.update({ where: { id: portfolio.id }, data: { status: 'draft' } });
    assert.deepEqual((await call(publicGallery)).data.items, []);
    assert.equal((await call(gallery, undefined, renter)).data.items[0].publiclyEligible, false);
    assert.equal((await call(linkPath, { revision: 2 }, renter, 'DELETE')).status, 200);
    assert.ok(await deps.db.asset.findUnique({ where: { id: asset.id } }));

    const customer = await fixture('customer');
    const firstRequest = { requestKey: randomUUID(), targetKind: 'rental', targetId: id, message: 'Is a pair available?' };
    const opened = await Promise.all([call('inquiries', firstRequest, customer), call('inquiries', firstRequest, customer)]);
    assert.deepEqual(opened.map(result => result.status), [200, 200]);
    assert.equal(opened[0]?.data.id, opened[1]?.data.id);
    const messages = 'inquiries/' + opened[0]?.data.id + '/messages';
    assert.equal((await call(messages, undefined, other)).status, 404);
    assert.equal((await call('me/conversations', undefined, renter)).data.items[0].targetId, id);
    const reply = { requestKey: randomUUID(), message: 'Yes, two units are listed.' };
    assert.equal((await call(messages, reply, renter)).status, 200);
    assert.equal((await call(messages, { ...reply, message: 'Changed reply' }, renter)).status, 409);
    assert.deepEqual((await call(messages, undefined, customer)).data.items.map((message: { body: string }) => message.body),
      [reply.message, firstRequest.message]);

    const units = 'me/inventory-units';
    const unit = await call(units, { listingId: id, serial: ' sn-01 ' }, renter);
    assert.equal(unit.status, 200);
    assert.equal(unit.data.serial, 'SN-01');
    assert.equal((await call(units, { listingId: id, serial: 'sn-01' }, renter)).status, 409);
    assert.equal((await call(units, { listingId: id, serial: 'sn-02' }, other)).status, 404);
    const unitPath = units + '/' + unit.data.id;
    const dispatch = { revision: 1, status: 'out', reason: 'Released to customer', custodyReference: 'pickup-123',
      dueAt: new Date(Date.now() + 3600000).toISOString() };
    const dispatches = await Promise.all([call(unitPath, dispatch, renter, 'PATCH'), call(unitPath, dispatch, renter, 'PATCH')]);
    assert.deepEqual(dispatches.map(result => result.status).sort(), [200, 409]);
    assert.equal((await call(unitPath, { revision: 2, status: 'available', reason: 'Skip inspection' }, renter, 'PATCH')).status, 409);
    await deps.db.inventoryUnit.update({ where: { id: unit.data.id }, data: { dueAt: new Date(Date.now() - 1000) } });
    const listedUnits = await call(units + '?listingId=' + id, undefined, renter);
    assert.equal(listedUnits.data.items[0].overdue, true);
    assert.equal((await call(unitPath, { revision: 2, status: 'inspection', reason: 'Returned for inspection' }, renter, 'PATCH')).status, 200);
    assert.equal((await call(unitPath, { revision: 3, status: 'quarantined', reason: 'Damaged on return' }, renter, 'PATCH')).status, 200);
    assert.equal((await call(unitPath, { revision: 4, status: 'maintenance', reason: 'Repair underway' }, renter, 'PATCH')).status, 200);
    assert.equal((await call(unitPath, { revision: 5, status: 'available', reason: 'Repair complete' }, renter, 'PATCH')).status, 200);
    const history = await call('me/inventory-movements?unitId=' + unit.data.id, undefined, renter);
    assert.deepEqual(history.data.items.map((item: { toStatus: string }) => item.toStatus),
      ['available', 'maintenance', 'quarantined', 'inspection', 'out', 'available']);
    assert.equal(history.data.items[3].custodyReference, 'pickup-123');
    assert.deepEqual((await call('me/inventory-movements?unitId=' + unit.data.id, undefined, other)).data.items, []);

    const venue = { ...fields, title: 'Event hall', kind: 'venue', venueCapacity: 120, specs: {},
      hourlyRateMinor: 80000, dailyRateMinor: 450000, weeklyRateMinor: 2300000 };
    assert.equal((await call('me/rentals', { ...venue, venueCapacity: 0 }, renter)).status, 400);
    const venueDraft = await call('me/rentals', venue, renter);
    assert.equal(venueDraft.status, 200);
    assert.equal(venueDraft.data.stockQuantity, 1);
    assert.equal((await call(`me/rentals/${venueDraft.data.id}/status`, { revision: 1, action: 'publish' }, renter)).status, 200);
    const listedVenue = (await call('rentals')).data.items.find((item: { id: string }) => item.id === venueDraft.data.id);
    assert.equal(listedVenue.venueCapacity, 120);
    assert.equal(listedVenue.hourlyRateMinor, 80000);
    assert.equal(listedVenue.weeklyRateMinor, 2300000);
    const venues = await call('rentals?kind=venue&q=event&maxPriceMinor=450000');
    assert.equal(venues.status, 200);
    assert.ok(venues.data.items.some((item: { id: string }) => item.id === venueDraft.data.id));
    assert.ok(!venues.data.items.some((item: { id: string }) => item.id === id));
    assert.equal((await call('rentals?kind=invalid')).status, 400);

    const venuePath = `me/rentals/${venueDraft.data.id}`;
    const depositPath = venuePath + '/deposit-policy';
    const terms = 'Refundable after the agreed venue inspection.';
    const fixed = { mode: 'fixed', currency: 'LKR', amountMinor: 300000, terms };
    const percentage = { mode: 'percentage', currency: 'LKR', basis: 'rental_subtotal', basisPoints: 1250, terms };
    async function publicVenuePolicy() {
      const page = await call('rentals');
      return page.data.items.find((item: { id: string }) => item.id === venueDraft.data.id).depositPolicy;
    }
    assert.equal((await call(depositPath, { revision: 2, depositPolicy: fixed }, other, 'PUT')).status, 404);
    assert.equal((await call(depositPath, { revision: 2, depositPolicy: { ...fixed, currency: 'USD' } }, renter, 'PUT')).status, 400);
    const writesToPolicy = await Promise.all([
      call(depositPath, { revision: 2, depositPolicy: fixed }, renter, 'PUT'),
      call(depositPath, { revision: 2, depositPolicy: fixed }, renter, 'PUT'),
    ]);
    assert.deepEqual(writesToPolicy.map(result => result.status).sort(), [200, 409]);
    assert.deepEqual(await publicVenuePolicy(), noDeposit);

    const { kind: _venueKind, ...venueFields } = venue;
    const listingEdit = await call(venuePath, { ...venueFields, title: 'Updated event hall', revision: 3 }, renter, 'PATCH');
    assert.equal(listingEdit.status, 200);
    assert.deepEqual(listingEdit.data.depositPolicy, fixed);
    assert.equal((await call(venuePath + '/status', { revision: 4, action: 'publish' }, renter)).status, 200);
    assert.deepEqual(await publicVenuePolicy(), fixed);

    assert.equal((await call(depositPath, { revision: 5, depositPolicy: percentage }, renter, 'PUT')).status, 200);
    const draftVenue = (await call('me/rentals', undefined, renter)).data.find((item: { id: string }) => item.id === venueDraft.data.id);
    assert.deepEqual(draftVenue.depositPolicy, percentage);
    assert.deepEqual(await publicVenuePolicy(), fixed);
    assert.equal((await call(venuePath + '/status', { revision: 6, action: 'publish' }, renter)).status, 200);
    assert.deepEqual(await publicVenuePolicy(), percentage);

    assert.equal((await call(depositPath, { revision: 7, depositPolicy: noDeposit }, renter, 'PUT')).status, 200);
    assert.equal((await call(venuePath + '/status', { revision: 8, action: 'publish' }, renter)).status, 200);
    assert.deepEqual(await publicVenuePolicy(), noDeposit);
    const retainedVersion = await deps.db.rentalListingVersion.findUniqueOrThrow({
      where: { listingId_version: { listingId: venueDraft.data.id, version: 4 } },
    });
    assert.deepEqual(retainedVersion.depositPolicy, fixed);

    const bundle = { ...fields, title: 'Speaker pair', kind: 'bundle', specs: {}, bundleItems: [{ listingId: id, quantity: 2 }] };
    assert.equal((await call('me/rentals', bundle, other)).status, 409);
    assert.equal((await call('me/rentals', { ...bundle, bundleItems: [{ listingId: id, quantity: 3 }] }, renter)).status, 409);
    assert.equal((await call('me/rentals', { ...bundle, bundleItems: [{ listingId: venueDraft.data.id, quantity: 1 }] }, renter)).status, 409);
    const bundleDraft = await call('me/rentals', bundle, renter);
    assert.equal(bundleDraft.status, 200);
    assert.deepEqual(bundleDraft.data.bundleItems, [{ listingId: id, quantity: 2, title: fields.title, version: 3 }]);
    assert.equal((await call(`me/rentals/${bundleDraft.data.id}/status`, { revision: 1, action: 'publish' }, renter)).status, 200);
    assert.equal((await call(units, { listingId: id, serial: 'SN-02' }, renter)).status, 200);
    const secondCustomer = await fixture('customer');
    const bookingFields = {
      targetKind: 'rental', targetId: id, targetVersion: 3, quantity: 1, rateUnit: 'day',
      startsAt: '2090-03-01T09:00:00Z', endsAt: '2090-03-03T09:00:00Z',
    };
    const bookingRequest = { ...bookingFields, requestKey: randomUUID(), inquiryId: opened[0]?.data.id };
    const booked = await call('bookings', bookingRequest, customer);
    assert.equal(booked.status, 200);
    assert.equal(booked.data.snapshot.subtotalMinor, 500000);
    assert.equal(booked.data.snapshot.depositMinor, 0);
    assert.equal((await call('bookings', bookingRequest, customer)).data.id, booked.data.id);
    assert.equal((await call('bookings', { ...bookingRequest, quantity: 2 }, customer)).status, 409);
    assert.equal((await call('bookings/' + booked.data.id, undefined, other)).status, 404);
    assert.equal((await call('bookings/' + booked.data.id, undefined, renter)).status, 200);

    const bundleRequest = { ...bookingFields, targetId: bundleDraft.data.id, targetVersion: 1, requestKey: randomUUID() };
    assert.equal((await call('bookings', bundleRequest, secondCustomer)).status, 409);
    const availabilityQuery = new URLSearchParams({
      targetKind: 'rental', targetVersion: '1', quantity: '1', rateUnit: 'day',
      startsAt: bookingFields.startsAt, endsAt: bookingFields.endsAt,
    });
    const availabilityPath = 'listings/' + bundleDraft.data.id + '/availability?' + availabilityQuery;
    assert.deepEqual((await call(availabilityPath)).data, { available: false });
    await deps.db.booking.update({ where: { id: booked.data.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    assert.deepEqual((await call(availabilityPath)).data, { available: true });
    const competing = await Promise.all([
      call('bookings', bundleRequest, secondCustomer),
      call('bookings', { ...bookingFields, quantity: 2, requestKey: randomUUID() }, customer),
    ]);
    assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
    assert.equal((await call('bookings/' + booked.data.id + '/reservation-renewals', {
      expectedHoldExpiresAt: (await call('bookings/' + booked.data.id, undefined, customer)).data.holdExpiresAt,
    }, customer)).status, 409);
    const winner = competing.find(result => result.status === 200)!.data;
    const decisions = 'bookings/' + winner.id + '/provider-decisions';
    const accept = { revision: 1, decision: 'accepted' };
    assert.equal((await call(decisions, accept, other)).status, 404);
    const decided = await Promise.all([call(decisions, accept, renter), call(decisions, accept, renter)]);
    assert.deepEqual(decided.map(result => result.status).sort(), [200, 409]);
    assert.equal(decided.find(result => result.status === 200)?.data.state, 'accepted');
    const calendar = await call('me/calendar?' + new URLSearchParams({ from: bookingFields.startsAt, to: bookingFields.endsAt }), undefined, renter);
    assert.equal(calendar.status, 200);
    assert.ok(calendar.data.items.some((item: { id: string }) => item.id === winner.id));
    assert.equal((await call('me/bookings?status=expired', undefined, customer)).data.items[0].id, booked.data.id);
    const winnerCustomer = winner.customerId === customer.user.id ? customer : secondCustomer;
    const quotations = 'bookings/' + winner.id + '/quotations';
    const quoteTerms = 'Two units for the agreed dates.';
    const offer = { revision: 2, terms: quoteTerms, lines: [{ description: 'Equipment hire', quantity: 2, unitPriceMinor: 200000 }] };
    assert.equal((await call(quotations, offer, winnerCustomer)).status, 403);
    const proposed = await call(quotations, offer, renter);
    assert.equal(proposed.status, 200);
    assert.equal(proposed.data.quotation.totalMinor, 400000);
    const firstDecision = 'quotations/' + proposed.data.quotation.id + '/decisions';
    assert.equal((await call(firstDecision, { revision: 3, decision: 'accepted' }, renter)).status, 403);
    const countered = await call(quotations, { ...offer, revision: 3, lines: [{ ...offer.lines[0], unitPriceMinor: 175000 }] }, winnerCustomer);
    assert.equal(countered.status, 200);
    assert.equal((await call(firstDecision, { revision: 4, decision: 'accepted' }, winnerCustomer)).status, 409);
    const counterDecision = 'quotations/' + countered.data.quotation.id + '/decisions';
    assert.equal((await call(counterDecision, { revision: 4, decision: 'accepted' }, other)).status, 404);
    const acceptances = await Promise.all([
      call(counterDecision, { revision: 4, decision: 'accepted' }, renter),
      call(counterDecision, { revision: 4, decision: 'accepted' }, renter),
    ]);
    assert.deepEqual(acceptances.map(item => item.status).sort(), [200, 409]);
    const agreed = acceptances.find(item => item.status === 200)!.data;
    const agreement = await call('bookings/' + winner.id + '/agreement', undefined, winnerCustomer);
    assert.equal(agreement.data.id, agreed.agreement.id);
    const artifactPath = 'agreements/' + agreement.data.id + '/artifact';
    assert.equal((await call(artifactPath, undefined, other)).status, 404);
    const artifact = await call(artifactPath, undefined, winnerCustomer);
    assert.equal(createHash('sha256').update(artifact.data.artifact).digest('hex'), agreement.data.digest);
    assert.equal(JSON.parse(artifact.data.artifact).serviceAdvanceMinor, 175000);
    assert.equal((await call('bookings/' + winner.id, undefined, renter)).data.state, 'agreed');
    const chat = 'conversations/' + winner.id;
    assert.equal((await call(chat + '/messages', undefined, other)).status, 404);
    const message = { requestKey: randomUUID(), body: 'Please confirm the pickup time.' };
    const sent = await call(chat + '/messages', message, winnerCustomer);
    assert.equal(sent.status, 200);
    assert.equal((await call(chat + '/messages', message, winnerCustomer)).data.id, sent.data.id);
    assert.equal((await call(chat + '/messages', { ...message, body: 'Different message' }, winnerCustomer)).status, 409);
    const response = await call(chat + '/messages', { requestKey: randomUUID(), body: 'Pickup is confirmed.' }, renter);
    assert.equal(response.status, 200);
    const resumed = await call(chat + '/messages?after=' + sent.data.id, undefined, winnerCustomer);
    assert.deepEqual(resumed.data.items.map((item: { id: string }) => item.id), [response.data.id]);
    assert.equal((await call(chat + '/read', { throughId: response.data.id }, winnerCustomer, 'PUT')).status, 200);
    const older = await call(chat + '/read', { throughId: sent.data.id }, winnerCustomer, 'PUT');
    assert.equal(older.data.throughId, response.data.id);
    const history = await call(chat + '/messages', undefined, renter);
    assert.ok(history.data.receipts.some((receipt: { readerId: string; throughId: string }) =>
      receipt.readerId === winnerCustomer.user.id && receipt.throughId === response.data.id));
    const versions = await call(quotations, undefined, renter);
    assert.deepEqual(versions.data.items.map((item: { status: string }) => item.status), ['accepted', 'superseded']);
    await deps.db.booking.update({ where: { id: winner.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    assert.deepEqual((await call(availabilityPath)).data, { available: false });
    const rejected = await call('bookings/' + booked.data.id + '/provider-decisions', { revision: 1, decision: 'rejected' }, renter);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.state, 'rejected');
    const staleBundle = await call('me/rentals', bundle, renter);
    assert.equal(staleBundle.status, 200);
    assert.equal((await publicItem()).dailyRateMinor, edit.dailyRateMinor);
    assert.equal((await call(path + '/status', { revision: 4, action: 'pause' }, renter)).status, 200);
    assert.equal(await publicItem(), undefined);
    assert.equal((await call(publicGallery)).status, 404);
    const remaining = await call('rentals');
    assert.ok(!remaining.data.items.some((item: { id: string }) => item.id === bundleDraft.data.id));
    const owned = await call('me/rentals', undefined, renter);
    assert.equal(owned.data.find((item: { id: string }) => item.id === bundleDraft.data.id).status, 'paused');
    assert.equal((await call(`me/rentals/${staleBundle.data.id}/status`, { revision: 1, action: 'publish' }, renter)).status, 409);
    assert.equal((await call(path + '/status', { revision: 5, action: 'archive' }, renter)).status, 200);
    const savedAfterArchive = (await call('me/saved-items', undefined, other)).data.items[0];
    assert.equal((await call(messages, undefined, customer)).data.items.length, 2);
    assert.equal(savedAfterArchive.available, false);
    assert.equal(savedAfterArchive.title, null);
    assert.equal((await call(savedPath, {}, other, 'DELETE')).status, 200);
    assert.equal((await call(savedPath, {}, other, 'DELETE')).status, 200);
    assert.deepEqual((await call('me/saved-items', undefined, other)).data.items, []);
    assert.equal(await deps.db.rentalListingVersion.count({ where: { listingId: id } }), 2);
  } finally {
    try {
      await deps.db.publicAnnouncement.deleteMany({ where: { id: { in: announcements } } });
      const owned = { ownerId: { in: ids } };
      await deps.db.rentalListing.updateMany({ where: owned, data: { status: 'archived', publishedVersion: null } });
      await deps.db.inventoryMovement.deleteMany({ where: { unit: owned } });
      await deps.db.inventoryUnit.deleteMany({ where: owned });
      await deps.db.rentalListingVersion.deleteMany({ where: { listing: owned } });
      await deps.db.rentalListing.deleteMany({ where: owned });
      await deps.db.profileAudit.deleteMany({ where: { targetUserId: { in: ids } } });
      await deps.db.portfolioItem.deleteMany({ where: owned });
      await deps.db.asset.deleteMany({ where: owned });
      await deps.db.bookingMessageRead.deleteMany({ where: { booking: { customerId: { in: ids } } } });
      await deps.db.bookingMessage.deleteMany({ where: { booking: { customerId: { in: ids } } } });
      await deps.db.bookingAgreement.deleteMany({ where: { booking: { customerId: { in: ids } } } });
      await deps.db.bookingQuotation.deleteMany({ where: { booking: { customerId: { in: ids } } } });
      await deps.db.booking.deleteMany({ where: { customerId: { in: ids } } });
      await deps.db.inquiry.deleteMany({ where: { customerId: { in: ids } } });
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
