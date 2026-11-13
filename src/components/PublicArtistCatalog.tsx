import { useEffect, useState } from 'react';
import { publicGigClient, type PublicGig, type PublicGigPage } from '../api/publicGigs';
import { Empty, Notice, BackButton } from './DashboardUI';
import { GigPackagePicker } from './GigPackages';
import type { PackageCatalog, PackageChoice } from '../lib/gigPackages';
import { formatLkr } from '../lib/profileMoney';

function PublicGigDetail({ gig }: { gig: PublicGig }) {
  const [choice, setChoice] = useState<PackageChoice>({});
  const catalog: PackageCatalog = {
    gigPackageVersion: String(gig.version),
    gigPackages: gig.packages.map(tier => ({
      id: tier.id, title: tier.title, pricing: tier.pricing, durationMinutes: tier.durationMinutes,
      performers: tier.performers, baseCents: tier.basePriceMinor,
      included: tier.included.split('\n').map(line => line.trim()).filter(Boolean),
      excluded: tier.excluded.split('\n').map(line => line.trim()).filter(Boolean),
      addons: tier.addons.map(addon => ({ id: addon.id, title: addon.title, cents: addon.priceMinor })),
    })),
  };
  return <article className="card p-6 md:p-8">
    <p>{gig.artist.displayName} · {gig.artist.category} · {gig.artist.city}</p>
    <h1 className="text-3xl font-bold mt-2 mb-3">{gig.title}</h1>
    <p className="whitespace-pre-wrap break-words">{gig.description}</p>
    {gig.packages.length > 0
      ? <GigPackagePicker catalog={catalog} choice={choice} onChange={setChoice} currency="LKR"/>
      : <p className="font-semibold mt-5">Base price {formatLkr(gig.priceMinor)}</p>}
  </article>;
}

export default function PublicArtistCatalog() {
  const [items, setItems] = useState<PublicGigPage['items']>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [request, setRequest] = useState<{ cursor: string | null }>({ cursor: null });
  const [selection, setSelection] = useState<{ id: string } | null>(null);
  const [gig, setGig] = useState<PublicGig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    const { cursor } = request;
    publicGigClient.list(cursor, abort.signal).then(page => {
      if (abort.signal.aborted) return;
      setItems(current => cursor ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
      setLoaded(true);
    }).catch(failure => {
      if (!abort.signal.aborted) setError(failure.message);
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [request]);

  useEffect(() => {
    if (!selection) return;
    const abort = new AbortController();
    publicGigClient.detail(selection.id, abort.signal).then(result => {
      if (!abort.signal.aborted) setGig(result);
    }).catch(failure => {
      if (!abort.signal.aborted) setDetailError(failure.message);
    });
    return () => abort.abort();
  }, [selection]);

  function load(cursor: string | null) {
    setLoading(true);
    setError('');
    if (!cursor) {
      setItems([]);
      setNextCursor(null);
    }
    setRequest({ cursor });
  }

  function open(id: string) {
    setGig(null);
    setDetailError('');
    setSelection({ id });
    window.scrollTo({ top: 0 });
  }

  return <main className="sl-account-home min-h-screen mx-auto max-w-6xl px-5 py-8">
    {selection ? <>
      <BackButton onClick={() => { setSelection(null); load(null); }}>Back to artists</BackButton>
      {gig && <PublicGigDetail key={`${gig.id}:${gig.version}`} gig={gig}/>}
      {detailError && <><Notice error>{detailError}</Notice><button className="btn-ghost" onClick={() => open(selection.id)}>Retry</button></>}
      {!gig && !detailError && <Notice>Loading gig…</Notice>}
    </> : <>
      <h1 className="text-3xl font-bold mb-6">Browse artists</h1>
      {loaded && items.length === 0 && !loading && !error && <Empty title="No artist gigs published yet">Check back for new listings.</Empty>}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(item => <li key={item.id} className="card p-5">
          <p className="text-sm">{item.artist.displayName} · {item.artist.city}</p>
          <h2 className="text-xl font-semibold mt-2 mb-2 break-words">{item.title}</h2>
          <p>{item.artist.category} · Base price {formatLkr(item.priceMinor)}</p>
          <button className="btn-primary mt-4" onClick={() => open(item.id)} aria-label={`View gig: ${item.title}`}>View gig</button>
        </li>)}
      </ul>
      {loading && <Notice>Loading artist gigs…</Notice>}
      {error && <><Notice error>{error}</Notice><button className="btn-ghost" onClick={() => load(request.cursor)}>Retry</button></>}
      {!loading && !error && nextCursor && <button className="btn-ghost mt-4" onClick={() => load(nextCursor)}>Load more gigs</button>}
    </>}
  </main>;
}
