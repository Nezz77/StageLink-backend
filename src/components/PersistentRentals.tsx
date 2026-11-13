import { useEffect, useState, type FormEvent } from 'react';
import { rentalClient, type Rental, type RentalFields } from '../api/rentals';
import { equipmentErrors, specFields } from '../lib/equipmentSpecs';
import { formatLkr, lkrToMinor } from '../lib/profileMoney';
import ConfirmDialog from './ConfirmDialog';
import { BackButton, Notice, requestDashboardNavigation, useDraftGuard } from './DashboardUI';

const categories: RentalFields['category'][] = ['Sound', 'Lighting', 'Instruments', 'Power', 'Stage', 'Other'];
const kindLabels = { equipment: 'Equipment', venue: 'Venue', bundle: 'Equipment bundle' };
const blank = {
  title: '', description: '', kind: 'equipment' as Rental['kind'], category: 'Sound' as RentalFields['category'],
  stock: '', rate: '', hourly: '', weekly: '', capacity: '', specs: {} as RentalFields['specs'],
  items: {} as Record<string, string>,
};
type Draft = typeof blank;
function draftOf(record: Rental): Draft {
  return {
    title: record.title, description: record.description, kind: record.kind, category: record.category,
    hourly: record.hourlyRateMinor === null ? '' : (record.hourlyRateMinor / 100).toFixed(2),
    weekly: record.weeklyRateMinor === null ? '' : (record.weeklyRateMinor / 100).toFixed(2),
    capacity: record.venueCapacity === null ? '' : String(record.venueCapacity),
    items: Object.fromEntries(record.bundleItems.map(item => [item.listingId, String(item.quantity)])),
    stock: String(record.stockQuantity), rate: (record.dailyRateMinor / 100).toFixed(2), specs: record.specs,
  };
}

export default function PersistentRentals({ onBack }: { onBack: () => void }) {
  const [records, setRecords] = useState<Rental[] | null>(null);
  const [editing, setEditing] = useState<Rental | null>(null);
  const [draft, setDraft] = useState(blank);
  const [archive, setArchive] = useState<Rental | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const guard = useDraftGuard(JSON.stringify(draft) !== JSON.stringify(editing ? draftOf(editing) : blank));

  useEffect(() => {
    let active = true;
    void rentalClient.list().then(items => {
      if (active) setRecords(items);
    }).catch(failure => {
      if (active) setError(failure.message);
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, []);

  const equipment = records?.filter(record => record.kind === 'equipment' && record.status === 'published') ?? [];

  function choose(record: Rental | null) {
    setEditing(record);
    setDraft(record ? draftOf(record) : blank);
  }

  async function run(work: () => Promise<void>, success = '') {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      setMessage(success);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not update the equipment listing.');
    } finally {
      setBusy(false);
    }
  }

  function store(record: Rental) {
    setRecords(current => {
      const others = (current ?? []).filter(item => item.id !== record.id);
      return record.status === 'archived' ? others : [record, ...others];
    });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const issue = Object.values(equipmentErrors(draft.specs))[0];
      if (issue) throw new Error(issue);
      const dailyRateMinor = lkrToMinor(draft.rate);
      if (dailyRateMinor <= 0) throw new Error('Enter a positive daily rate in LKR.');
      const { kind, title, description, category, specs } = draft;
      const stockQuantity = kind === 'equipment' ? Number(draft.stock) : kind === 'venue' ? 1 : 0;
      if (kind === 'equipment' && (!/^\d+$/.test(draft.stock) || stockQuantity > 100_000)) throw new Error('Enter a stock quantity from 0 to 100,000.');
      const venueCapacity = kind === 'venue' ? Number(draft.capacity) : null;
      if (venueCapacity !== null && (!Number.isInteger(venueCapacity) || venueCapacity < 1 || venueCapacity > 100_000)) {
        throw new Error('Enter a venue capacity from 1 to 100,000.');
      }
      const bundleItems = kind === 'bundle'
        ? Object.entries(draft.items).filter(([, quantity]) => quantity !== '').map(([listingId, quantity]) => ({ listingId, quantity: Number(quantity) }))
        : [];
      if (kind === 'bundle' && (bundleItems.length < 1 || bundleItems.length > 12 ||
        bundleItems.some(item => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100_000))) {
        throw new Error('Choose quantities for 1–12 equipment listings in the bundle.');
      }
      const hourlyRateMinor = draft.hourly.trim() ? lkrToMinor(draft.hourly) : null;
      const weeklyRateMinor = draft.weekly.trim() ? lkrToMinor(draft.weekly) : null;
      if (hourlyRateMinor === 0 || weeklyRateMinor === 0) throw new Error('Enter a positive rate or leave the optional rate blank.');
      const fields = {
        title, description, category: kind === 'equipment' ? category : 'Other' as const,
        specs: kind === 'equipment' ? specs : {}, dailyRateMinor, hourlyRateMinor, weeklyRateMinor,
        stockQuantity, venueCapacity, bundleItems,
      };
      store(await (editing ? rentalClient.edit(editing.id, editing.revision, fields) : rentalClient.create({ ...fields, kind })));
      choose(null);
    }, 'Rental draft saved.');
  }

  function transition(record: Rental, action: 'publish' | 'pause' | 'archive') {
    void run(async () => {
      const updated = await rentalClient.transition(record.id, record.revision, action);
      store(updated);
      if (editing?.id === record.id) {
        if (action === 'archive') choose(null);
        else setEditing(updated);
      }
      if (record.kind === 'equipment') {
        try { setRecords(await rentalClient.list()); }
        catch { setError('The listing was updated. Reopen rentals to refresh dependent bundle statuses.'); }
      }
    }, { publish: 'Rental listing published.', pause: 'Rental listing paused.', archive: 'Rental listing archived.' }[action]);
  }

  return <main className="sl-account-home min-h-screen mx-auto max-w-5xl px-5 py-8">
    <BackButton onClick={() => requestDashboardNavigation(onBack)}>Back to account</BackButton>
    <h1 className="text-3xl font-bold mb-6">Manage rentals</h1>
    <Notice error>{error}</Notice>
    <Notice>{message}</Notice>
    {!records && (busy ? <Notice>Loading equipment listings…</Notice> :
      <button className="btn-ghost" onClick={() => void run(async () => setRecords(await rentalClient.list()))}>Retry</button>)}
    {records && <>
      <form className="card p-6 mb-6" onSubmit={save}>
        <fieldset disabled={busy}>
          <legend className="text-xl font-semibold mb-4">{editing ? 'Edit rental draft' : 'Create rental draft'}</legend>
          <label className="mg-field">Listing type<select disabled={!!editing} value={draft.kind} onChange={e => setDraft({ ...blank, title: draft.title, description: draft.description, kind: e.target.value as Draft['kind'] })}>
            {Object.entries(kindLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select></label>
          <label className="mg-field">Title<input required maxLength={120} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })}/></label>
          <label className="mg-field">Description<textarea required maxLength={2000} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label>
          <div className="mg-fields">
            {draft.kind === 'equipment' && <>
            <label className="mg-field">Category<select value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value as Draft['category'] })}>
              {categories.map(category => <option key={category}>{category}</option>)}
            </select></label>
            <label className="mg-field">Stock quantity<input required type="number" min={0} max={100000} step={1} value={draft.stock} onChange={e => setDraft({ ...draft, stock: e.target.value })}/></label>
            </>}
            {draft.kind === 'venue' && <label className="mg-field">Guest capacity<input required type="number" min={1} max={100000} step={1} value={draft.capacity} onChange={e => setDraft({ ...draft, capacity: e.target.value })}/><span>Each booking reserves the whole venue.</span></label>}
            <label className="mg-field">Hourly rate (LKR, optional)<input inputMode="decimal" value={draft.hourly} onChange={e => setDraft({ ...draft, hourly: e.target.value })}/></label>
            <label className="mg-field">Daily rate (LKR)<input required inputMode="decimal" value={draft.rate} onChange={e => setDraft({ ...draft, rate: e.target.value })}/></label>
            <label className="mg-field">Weekly rate (LKR, optional)<input inputMode="decimal" value={draft.weekly} onChange={e => setDraft({ ...draft, weekly: e.target.value })}/></label>
          </div>
          {draft.kind === 'bundle' && <fieldset className="mb-4">
            <legend className="font-semibold">Bundle equipment</legend>
            <p className="mb-2">Enter a quantity for each published item to include.</p>
            {equipment.length === 0 && <p>Publish equipment before creating a bundle.</p>}
            {equipment.map(record => <label key={record.id} className="mg-field">{record.title} quantity
              <input type="number" min={1} max={100000} step={1} value={draft.items[record.id] ?? ''} onChange={e => setDraft({ ...draft, items: { ...draft.items, [record.id]: e.target.value } })}/>
            </label>)}
            {Object.keys(draft.items).filter(id => draft.items[id] && !equipment.some(record => record.id === id)).map(id => (
              <p key={id} className="mb-2">{editing?.bundleItems.find(item => item.listingId === id)?.title ?? 'Equipment'} is unavailable. <button type="button" className="btn-ghost" onClick={() => setDraft({ ...draft, items: { ...draft.items, [id]: '' } })}>Remove</button></p>
            ))}
          </fieldset>}
          {draft.kind === 'equipment' && <>
          <h2 className="text-lg font-semibold mb-3">Technical specs (optional)</h2>
          <div className="mg-fields">
            {specFields.map(([key, label]) => <label key={key} className="mg-field">{label}
              {key === 'packageInclusions'
                ? <textarea maxLength={1000} value={draft.specs[key] ?? ''} onChange={e => setDraft({ ...draft, specs: { ...draft.specs, [key]: e.target.value } })}/>
                : <input maxLength={key === 'specFrequency' ? 120 : 12} inputMode={key === 'specFrequency' ? 'text' : 'decimal'} value={draft.specs[key] ?? ''} onChange={e => setDraft({ ...draft, specs: { ...draft.specs, [key]: e.target.value } })}/>}
            </label>)}
          </div>
          </>}
          <button className="btn-primary">Save draft</button>
          {editing && <button className="btn-ghost" type="button" onClick={() => requestDashboardNavigation(() => choose(null))}>Cancel edit</button>}
        </fieldset>
      </form>
      {records.length === 0 && <p>You have no rental listings yet.</p>}
      <ul className="space-y-3">
        {records.map(record => <li key={record.id} className="card p-5">
          <h2 className="text-lg font-semibold">{record.title}</h2>
          <p>{kindLabels[record.kind]} · {record.status} · {formatLkr(record.dailyRateMinor)} per day
            {record.kind === 'equipment' && ` · ${record.stockQuantity} in stock`}
            {record.kind === 'venue' && ` · Up to ${record.venueCapacity} guests`}
            {record.kind === 'bundle' && ` · ${record.bundleItems.length} equipment listings`}</p>
          {record.status === 'published' && record.version !== record.publishedVersion && <p>Unpublished changes</p>}
          <div className="flex flex-wrap gap-2 mt-3">
            <button className="btn-ghost" disabled={busy} onClick={() => requestDashboardNavigation(() => { choose(record); window.scrollTo({ top: 0 }); })}>Edit</button>
            {(record.status !== 'published' || record.version !== record.publishedVersion) &&
              <button className="btn-primary" disabled={busy} onClick={() => transition(record, 'publish')}>Publish saved draft</button>}
            {record.status === 'published' && <button className="btn-ghost" disabled={busy} onClick={() => transition(record, 'pause')}>Pause</button>}
            <button className="btn-ghost" disabled={busy} onClick={() => requestDashboardNavigation(() => setArchive(record))}>Archive</button>
          </div>
        </li>)}
      </ul>
    </>}
    {guard}
    {archive && <ConfirmDialog title="Archive rental listing" confirm="Archive" onClose={() => setArchive(null)} onConfirm={() => {
      transition(archive, 'archive');
      setArchive(null);
    }}>Archive {archive.title}? It will be removed from public browse.</ConfirmDialog>}
  </main>;
}
