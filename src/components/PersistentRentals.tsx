import { useEffect, useState, type FormEvent } from 'react';
import { rentalClient, type Rental, type RentalFields } from '../api/rentals';
import { equipmentErrors, specFields } from '../lib/equipmentSpecs';
import { formatLkr, lkrToMinor } from '../lib/profileMoney';
import ConfirmDialog from './ConfirmDialog';
import { BackButton, Notice, requestDashboardNavigation, useDraftGuard } from './DashboardUI';

const categories: RentalFields['category'][] = ['Sound', 'Lighting', 'Instruments', 'Power', 'Stage', 'Other'];
const blank = { title: '', description: '', category: 'Sound' as RentalFields['category'], stock: '', rate: '', specs: {} as RentalFields['specs'] };
type Draft = typeof blank;
function draftOf(record: Rental): Draft {
  return {
    title: record.title, description: record.description, category: record.category,
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
      const stockQuantity = Number(draft.stock);
      if (!/^\d+$/.test(draft.stock) || stockQuantity > 100_000) throw new Error('Enter a stock quantity from 0 to 100,000.');
      const { title, description, category, specs } = draft;
      const fields = { title, description, category, specs, dailyRateMinor, stockQuantity };
      store(await (editing ? rentalClient.edit(editing.id, editing.revision, fields) : rentalClient.create(fields)));
      choose(null);
    }, 'Equipment draft saved.');
  }

  function transition(record: Rental, action: 'publish' | 'pause' | 'archive') {
    void run(async () => {
      const updated = await rentalClient.transition(record.id, record.revision, action);
      store(updated);
      if (editing?.id === record.id) {
        if (action === 'archive') choose(null);
        else setEditing(updated);
      }
    }, { publish: 'Equipment listing published.', pause: 'Equipment listing paused.', archive: 'Equipment listing archived.' }[action]);
  }

  return <main className="sl-account-home min-h-screen mx-auto max-w-5xl px-5 py-8">
    <BackButton onClick={() => requestDashboardNavigation(onBack)}>Back to account</BackButton>
    <h1 className="text-3xl font-bold mb-6">Manage equipment</h1>
    <Notice error>{error}</Notice>
    <Notice>{message}</Notice>
    {!records && (busy ? <Notice>Loading equipment listings…</Notice> :
      <button className="btn-ghost" onClick={() => void run(async () => setRecords(await rentalClient.list()))}>Retry</button>)}
    {records && <>
      <form className="card p-6 mb-6" onSubmit={save}>
        <fieldset disabled={busy}>
          <legend className="text-xl font-semibold mb-4">{editing ? 'Edit equipment draft' : 'Create equipment draft'}</legend>
          <label className="mg-field">Title<input required maxLength={120} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })}/></label>
          <label className="mg-field">Description<textarea required maxLength={2000} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label>
          <div className="mg-fields">
            <label className="mg-field">Category<select value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value as Draft['category'] })}>
              {categories.map(category => <option key={category}>{category}</option>)}
            </select></label>
            <label className="mg-field">Stock quantity<input required type="number" min={0} max={100000} step={1} value={draft.stock} onChange={e => setDraft({ ...draft, stock: e.target.value })}/></label>
            <label className="mg-field">Daily rate (LKR)<input required inputMode="decimal" value={draft.rate} onChange={e => setDraft({ ...draft, rate: e.target.value })}/></label>
          </div>
          <h2 className="text-lg font-semibold mb-3">Technical specs (optional)</h2>
          <div className="mg-fields">
            {specFields.map(([key, label]) => <label key={key} className="mg-field">{label}
              {key === 'packageInclusions'
                ? <textarea maxLength={1000} value={draft.specs[key] ?? ''} onChange={e => setDraft({ ...draft, specs: { ...draft.specs, [key]: e.target.value } })}/>
                : <input maxLength={key === 'specFrequency' ? 120 : 12} inputMode={key === 'specFrequency' ? 'text' : 'decimal'} value={draft.specs[key] ?? ''} onChange={e => setDraft({ ...draft, specs: { ...draft.specs, [key]: e.target.value } })}/>}
            </label>)}
          </div>
          <button className="btn-primary">Save draft</button>
          {editing && <button className="btn-ghost" type="button" onClick={() => requestDashboardNavigation(() => choose(null))}>Cancel edit</button>}
        </fieldset>
      </form>
      {records.length === 0 && <p>You have no equipment listings yet.</p>}
      <ul className="space-y-3">
        {records.map(record => <li key={record.id} className="card p-5">
          <h2 className="text-lg font-semibold">{record.title}</h2>
          <p>{record.status} · {record.stockQuantity} in stock · {formatLkr(record.dailyRateMinor)} per day</p>
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
    {archive && <ConfirmDialog title="Archive equipment listing" confirm="Archive" onClose={() => setArchive(null)} onConfirm={() => {
      transition(archive, 'archive');
      setArchive(null);
    }}>Archive {archive.title}? It will be removed from public browse.</ConfirmDialog>}
  </main>;
}
