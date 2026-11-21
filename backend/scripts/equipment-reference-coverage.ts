import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { equipmentKey, equipmentReferenceBundle } from '../shared/equipment-reference-bundle.js';

const httpsOrigin = z.url({ protocol: /^https$/ }).refine(raw => {
  const { origin } = new URL(raw);
  return raw === origin || raw === origin + '/';
}).transform(raw => new URL(raw).origin);
const settings = z.object({
  origin: httpsOrigin,
  session: z.object({ accessToken: z.string().max(2048).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/) }).strict(),
});
const uuid = z.uuid().transform(value => value.toLowerCase());
const version = z.number().int().positive();
const label = z.string().trim().min(1).max(120).refine(value => !value.includes('\0'));
const identity = z.object({ manufacturer: label, model: label });
const review = identity.extend({ id: uuid, version }).strict();
const reviews = z.array(review).refine(items => new Set(items.map(item => item.id)).size === items.length);
const listing = z.object({
  id: uuid, version, title: label, category: z.enum(['Sound', 'Lighting', 'Instruments', 'Power', 'Stage', 'Other']),
  kind: z.literal('equipment'),
});
const source = identity.extend({ id: uuid, retiredAt: z.iso.datetime().nullable() });
type Config = z.output<typeof settings>;
type Identity = z.output<typeof identity>;
type ReferenceState = 'covered' | 'retired' | 'needs_source';

class CoverageError extends Error {}
const referenceKey = ({ manufacturer, model }: Identity) => JSON.stringify([equipmentKey(manufacturer), equipmentKey(model)]);
const bundled = new Set(equipmentReferenceBundle.entries.map(referenceKey));

export async function runEquipmentReferenceCoverage(config: Config, rawReviews: unknown, send = fetch) {
  const reviewed = new Map(reviews.parse(rawReviews).map(row => [row.id, row]));

  async function pages<T extends { id: string }>(path: string, schema: z.ZodType<T>, name: string, admin = false) {
    const envelope = z.object({ items: z.array(schema), nextCursor: uuid.nullable() });
    const url = new URL(path, config.origin);
    const items: T[] = [];
    let previous = '';
    for (;;) {
      let parsed: z.output<typeof envelope>;
      try {
        const response = await send(url, {
          method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
          headers: admin ? { Authorization: 'Bearer ' + config.session.accessToken } : {},
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new CoverageError(`Could not read ${name} (HTTP ${response.status}).`);
        }
        parsed = envelope.parse(await response.json());
      } catch (error) {
        if (error instanceof CoverageError) throw error;
        throw new CoverageError(`Could not read a valid ${name} page.`);
      }
      for (const item of parsed.items) {
        if (item.id <= previous) throw new CoverageError(`The ${name} page did not advance.`);
        previous = item.id;
        items.push(item);
      }
      if (!parsed.nextCursor) return items;
      if (!parsed.items.length || parsed.nextCursor !== previous) {
        throw new CoverageError(`The ${name} cursor did not match its last item.`);
      }
      url.searchParams.set('cursor', parsed.nextCursor);
    }
  }

  const [catalog, sources] = await Promise.all([
    pages('/api/v1/rentals?kind=equipment', listing, 'published equipment'),
    pages('/api/v1/admin/equipment-spec-sources', source, 'equipment references', true),
  ]);
  const references = new Map<string, ReferenceState>();
  for (const record of sources) {
    const key = referenceKey(record);
    if (!references.has(key) || !record.retiredAt) references.set(key, record.retiredAt ? 'retired' : 'covered');
  }

  const counts = { covered: 0, retired: 0, needs_source: 0, needs_review: 0, listing_changed: 0 };
  const missing = new Map<string, Identity & { status: 'retired' | 'needs_source'; listings: number; inBundle: boolean }>();
  const listings = catalog.map(({ kind: _kind, ...row }) => {
    const match = reviewed.get(row.id);
    if (!match) {
      counts.needs_review++;
      return { ...row, status: 'needs_review' as const, identity: null };
    }
    reviewed.delete(row.id);
    if (match.version !== row.version) {
      counts.listing_changed++;
      return { ...row, status: 'listing_changed' as const, identity: null };
    }
    const identified = { manufacturer: match.manufacturer, model: match.model };
    const key = referenceKey(identified);
    const status = references.get(key) ?? 'needs_source';
    const inBundle = bundled.has(key);
    counts[status]++;
    if (status !== 'covered') {
      const group = missing.get(key);
      if (group) group.listings++;
      else missing.set(key, { ...identified, status, listings: 1, inBundle });
    }
    return { ...row, status, identity: identified, inBundle };
  });
  const referenceGaps = [...missing.values()].sort((a, b) => b.listings - a.listings || referenceKey(a).localeCompare(referenceKey(b)));
  return { counts, listings, referenceGaps, reviewedOutsideCatalog: reviewed.size };
}

if (import.meta.main) {
  async function main() {
    if (process.argv.length > 3) throw new CoverageError('Supply at most one reviewed equipment JSON file.');
    const session: unknown = process.stdin.isTTY ? null : JSON.parse(readFileSync(0, 'utf8'));
    const config = settings.parse({ origin: process.env.STAGELINK_SMOKE_ORIGIN, session });
    const filename = process.argv[2];
    const reviewed: unknown = filename ? JSON.parse(readFileSync(filename, 'utf8')) : [];
    console.log(JSON.stringify(await runEquipmentReferenceCoverage(config, reviewed), null, 2));
  }
  main().catch(error => {
    console.error(error instanceof CoverageError ? error.message : 'Check the staging HTTPS origin, protected administrator token and reviewed equipment JSON.');
    process.exitCode = 1;
  });
}
