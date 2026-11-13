import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { gigClient, type Gig } from '../api/gigs';
import { lkrToMinor } from '../lib/profileMoney';
import ConfirmDialog from './ConfirmDialog';
import { Notice } from './DashboardUI';

const blank = { title: '', description: '', price: '' };

export default function PersistentGigs({ onBack }: { onBack: () => void }) {
  const [gigs, setGigs] = useState<Gig[]>([]);
  const [editing, setEditing] = useState<Gig | null>(null);
  const [archive, setArchive] = useState<Gig | null>(null);
  const [fields, setFields] = useState(blank);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void gigClient.list().then(
      records => { if (active) { setGigs(records); setLoaded(true); } },
      failure => { if (active) setError(failure.message); },
    ).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  function reset() {
    setEditing(null);
    setFields(blank);
  }

  async function run(work: () => Promise<void>, message: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(message);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The gig could not be updated.');
    } finally {
      setBusy(false);
    }
  }

  function store(gig: Gig) {
    setGigs(current => gig.status === 'archived'
      ? current.filter(item => item.id !== gig.id)
      : [gig, ...current.filter(item => item.id !== gig.id)]);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const priceMinor = lkrToMinor(fields.price);
      if (priceMinor <= 0) throw new Error('Enter a positive LKR amount with up to two decimals.');
      const body = { title: fields.title, description: fields.description, priceMinor };
      store(await (editing ? gigClient.edit(editing.id, editing.revision, body) : gigClient.create(body)));
      reset();
    }, 'Gig draft saved.');
  }

  function transition(gig: Gig, action: 'publish' | 'pause' | 'archive') {
    const messages = { publish: 'Gig published.', pause: 'Gig paused.', archive: 'Gig archived.' };
    void run(async () => {
      store(await gigClient.transition(gig.id, gig.revision, action));
      if (editing?.id === gig.id) reset();
    }, messages[action]);
  }

  return <main className="sl-account-home min-h-screen mx-auto max-w-5xl px-5 py-8">
    <button className="btn-ghost mb-5" onClick={onBack}>Back to account</button>
    <h1 className="text-3xl font-bold mb-6">Manage artist gigs</h1>
    <Notice error>{error}</Notice>
    <Notice>{notice}</Notice>
    {!loaded && <button className="btn-ghost" disabled={busy} onClick={() => void run(async () => {
      setGigs(await gigClient.list());
      setLoaded(true);
    }, 'Gigs loaded.')}>{busy ? 'Loading gigs…' : 'Retry loading gigs'}</button>}
    {loaded && <>
      <form className="card p-6 mb-6" onSubmit={save}>
        <h2 className="text-xl font-semibold mb-4">{editing ? 'Edit gig draft' : 'Create gig draft'}</h2>
        <label className="mg-field">Title<input required maxLength={120} value={fields.title} onChange={event => setFields({ ...fields, title: event.target.value })}/></label>
        <label className="mg-field">Description<textarea required maxLength={2000} value={fields.description} onChange={event => setFields({ ...fields, description: event.target.value })}/></label>
        <label className="mg-field">Base price (LKR)<input required inputMode="decimal" value={fields.price} onChange={event => setFields({ ...fields, price: event.target.value })}/></label>
        <button className="btn-primary" disabled={busy}>Save draft</button>
        {editing && <button className="btn-ghost" type="button" disabled={busy} onClick={reset}>Cancel edit</button>}
      </form>
      {!gigs.length && <p>You have no gigs yet.</p>}
      <ul className="space-y-3">
        {gigs.map(gig => <li key={gig.id} className="card p-5">
          <h2 className="font-semibold">{gig.title}</h2>
          <p>{gig.status} · LKR {(gig.priceMinor / 100).toFixed(2)}</p>
          {gig.status === 'published' && gig.version !== gig.publishedVersion && <p>Unpublished changes</p>}
          <div className="flex flex-wrap gap-2 mt-3">
            <button className="btn-ghost" disabled={busy} onClick={() => {
              setEditing(gig);
              setFields({ title: gig.title, description: gig.description, price: (gig.priceMinor / 100).toFixed(2) });
            }}>Edit</button>
            {(gig.status !== 'published' || gig.version !== gig.publishedVersion) &&
              <button className="btn-primary" disabled={busy} onClick={() => transition(gig, 'publish')}>Publish</button>}
            {gig.status === 'published' && <button className="btn-ghost" disabled={busy} onClick={() => transition(gig, 'pause')}>Pause</button>}
            <button className="btn-ghost" disabled={busy} onClick={() => setArchive(gig)}>Archive</button>
          </div>
        </li>)}
      </ul>
    </>}
    {archive && <ConfirmDialog title="Archive gig" confirm="Archive" onClose={() => setArchive(null)} onConfirm={() => {
      transition(archive, 'archive');
      setArchive(null);
    }}>Archive {archive.title}? This gig will be removed from the catalog.</ConfirmDialog>}
  </main>;
}
