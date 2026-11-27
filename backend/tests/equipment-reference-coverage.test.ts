import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runEquipmentReferenceCoverage } from '../scripts/equipment-reference-coverage.js';

const config = { origin: 'https://staging.example.test', session: { accessToken: 'synthetic.coverage.signature' } };
const id = (number: number) => '823c182c-554a-4ebd-80f5-' + String(number).padStart(12, '0');
const rental = (n: number, title: string, version = 1) => ({ id: id(n), version, title, category: 'Sound', kind: 'equipment' });
const reference = (n: number, manufacturer: string, model: string, retiredAt: string | null = null) => ({
  id: id(n), manufacturer, model, retiredAt,
});
const confirmed = (n: number, manufacturer: string, model: string) => ({ id: id(n), version: 1, manufacturer, model });
const retiredAt = '2026-11-21T00:00:00.000Z';

test('equipment coverage follows both cursors and reports exact-model gaps from reviewed listing versions', async () => {
  const calls: string[] = [];
  const report = await runEquipmentReferenceCoverage(config, [
    confirmed(1, '  YAMAHA ', 'dbr12'), confirmed(2, 'Yamaha', 'DXR15'),
    confirmed(3, 'Shure', 'SM57'), confirmed(4, 'Shure', 'SM58'),
    confirmed(6, 'yamaha', 'dxr15'), confirmed(20, 'Shure', 'SM58'),
  ], async (input, options) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get('cursor');
    assert.equal(url.origin, config.origin);
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.method, 'GET');
    calls.push(url.pathname);
    const authorization = new Headers(options?.headers).get('Authorization');
    if (url.pathname === '/api/v1/rentals') {
      assert.equal(authorization, null);
      assert.equal(url.searchParams.get('kind'), 'equipment');
      if (cursor === null) return Response.json({ items: [rental(1, 'One'), rental(2, 'Two')], nextCursor: id(2) });
      assert.equal(cursor, id(2));
      return Response.json({
        items: [rental(3, 'Three'), rental(4, 'Changed', 2), rental(5, 'Shure SM58'), rental(6, 'Six')],
        nextCursor: null,
      });
    }
    assert.equal(url.pathname, '/api/v1/admin/equipment-spec-sources');
    assert.equal(authorization, 'Bearer ' + config.session.accessToken);
    if (cursor === null) return Response.json({
      items: [reference(100, 'Yamaha', 'DBR12', retiredAt), reference(101, 'Yamaha', 'DXR15mkII')],
      nextCursor: id(101),
    });
    assert.equal(cursor, id(101));
    return Response.json({
      items: [reference(102, 'Yamaha', 'DBR12'), reference(103, 'Shure', 'SM57', retiredAt), reference(104, 'Shure', 'SM58')],
      nextCursor: null,
    });
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(report.counts, { covered: 1, retired: 1, needs_source: 2, needs_review: 1, listing_changed: 1 });
  assert.deepEqual(report.listings.map(row => row.status), ['covered', 'needs_source', 'retired', 'listing_changed', 'needs_review', 'needs_source']);
  assert.equal(report.reviewedOutsideCatalog, 1);
  assert.deepEqual(report.referenceGaps, [
    { manufacturer: 'Yamaha', model: 'DXR15', status: 'needs_source', listings: 2, inBundle: true },
    { manufacturer: 'Shure', model: 'SM57', status: 'retired', listings: 1, inBundle: true },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /synthetic.coverage.signature/);
});

test('equipment coverage rejects duplicate identity reviews and a non-advancing catalog page', async () => {
  await assert.rejects(runEquipmentReferenceCoverage(config, [
    confirmed(1, 'Yamaha', 'DXR15'), confirmed(1, 'Yamaha', 'DXR15mkII'),
  ], async () => assert.fail('Duplicate review must fail before any request.')));

  await assert.rejects(runEquipmentReferenceCoverage(config, [], async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rentals')) return Response.json({ items: [rental(1, 'Same row')], nextCursor: id(1) });
    return Response.json({ items: [], nextCursor: null });
  }), /published equipment page did not advance/);
});
