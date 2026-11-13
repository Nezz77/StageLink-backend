import { useEffect, useState } from 'react';
import { readRentals, type RentalPage } from '../api/rentals';
import { specFields } from '../lib/equipmentSpecs';
import { formatLkr } from '../lib/profileMoney';
import { Empty, Notice } from './DashboardUI';

export default function PublicEquipmentCatalog() {
  const [items, setItems] = useState<RentalPage['items']>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [request, setRequest] = useState<{ cursor: string | null }>({ cursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    const { cursor } = request;
    void readRentals(cursor, abort.signal).then(page => {
      if (abort.signal.aborted) return;
      setItems(current => cursor ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    }).catch(failure => {
      if (!abort.signal.aborted) setError(failure.message);
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [request]);

  function load(cursor: string | null) {
    setLoading(true);
    setError('');
    setRequest({ cursor });
  }

  return <main className="sl-account-home min-h-screen mx-auto max-w-6xl px-5 py-8">
    <h1 className="text-3xl font-bold mb-6">Rent equipment</h1>
    {!loading && !error && items.length === 0 && <Empty title="No equipment listings published yet">Check back for new listings.</Empty>}
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(item => {
        const details = specFields.filter(([key]) => item.specs[key]);
        return <li key={item.id} className="card p-5">
          <p className="text-sm">{item.storefront.displayName} · {item.storefront.city}</p>
          <h2 className="text-xl font-semibold mt-2 break-words">{item.title}</h2>
          <p className="my-2">{item.category} · {formatLkr(item.dailyRateMinor)} per day</p>
          <details className="mt-3">
            <summary className="cursor-pointer">Listing details</summary>
            <p className="mt-2 whitespace-pre-wrap break-words">{item.description}</p>
            {details.length > 0 && <dl className="mt-3">
              {details.map(([key, label]) => <div className="mb-2" key={key}>
                <dt className="font-semibold">{label}</dt><dd className="whitespace-pre-wrap break-words">{item.specs[key]}</dd>
              </div>)}
            </dl>}
          </details>
        </li>;
      })}
    </ul>
    {loading && <Notice>Loading equipment listings…</Notice>}
    {error && <><Notice error>{error}</Notice><button className="btn-ghost" onClick={() => load(request.cursor)}>Retry</button></>}
    {!loading && !error && nextCursor && <button className="btn-ghost mt-4" onClick={() => load(nextCursor)}>Load more equipment</button>}
  </main>;
}
