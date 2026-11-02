import { useState } from 'react';
import { MailCheck, ShieldCheck, LogOut, Music2, ArrowUpRight } from 'lucide-react';
import type { Account } from '../api/auth';
import { accountClient } from '../api/auth';
import { Modal, Notice } from './DashboardUI';
import { useAppearance } from '../lib/AppearanceContext';
import { SwitchMode } from './SwitchMode';
export function ConfirmAccountEmail({ initialToken = '', onClose }: { initialToken?: string; onClose: () => void }) {
  const [token, setToken] = useState(initialToken), [done, setDone] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title="Verify your email" onClose={onClose}><div className="mg-page">{done ? <><MailCheck size={40}/><Notice>Your email is verified.</Notice><button className="btn-primary" onClick={onClose}>Continue</button></> : <form onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { await accountClient.confirmEmail(token.trim()); setToken(''); setDone(true); }
    catch (error) { setError(error instanceof Error ? error.message : 'Verification failed.'); }
    finally { setBusy(false); }
  }}><p>Paste the one-time code from your StageLink verification email.</p><label className="mg-field">Verification code<input autoComplete="one-time-code" required minLength={43} maxLength={43} value={token} onChange={e => setToken(e.target.value)}/></label><Notice error>{error}</Notice><button className="btn-primary" disabled={busy}>{busy ? 'Verifying…' : 'Verify email'}</button></form>}</div></Modal>;
}
const roleLabel = { customer: 'Customer', artist: 'Artist', renter: 'Equipment renter', admin: 'Administrator' };
export default function AccountHome({ user, onBrowse, onVerify, onRecover }: { user: Account; onBrowse: () => void; onVerify: () => void; onRecover: () => void }) {
  const appearance = useAppearance();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function act(work: () => Promise<unknown>, message = '') {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(message); } catch (error) { setError(error instanceof Error ? error.message : 'Please try again.'); }
    finally { setBusy(false); }
  }
  return <main className="sl-account-home min-h-screen mx-auto max-w-5xl px-5 py-8">
    <header className="flex items-center justify-between gap-4 mb-12"><div className="flex items-center gap-3"><Music2 className="text-violet-400"/><span className="text-xl font-bold">Stage<span className="text-violet-400">Link</span></span></div><div className="flex items-center gap-2 shrink-0"><SwitchMode width={44} height={24} isDark={appearance.isDark} onChange={appearance.onThemeChange}/><button aria-label="Sign out" className="btn-ghost flex gap-2 items-center" disabled={busy} onClick={() => void act(() => accountClient.logout())}><LogOut size={17}/><span className="hidden min-[400px]:inline">Sign out</span></button></div></header>
    <p className="uppercase text-xs tracking-[0.25em] text-violet-300 mb-4">Your StageLink account</p>
    <h1 className="text-4xl font-bold mb-4">Welcome, {user.displayName}.</h1>
    <p className="text-slate-400 mb-9">Manage your account and get ready for your next event.</p>
    <section className="card p-7 md:p-10 mb-6" aria-label="Account details"><div className="flex items-center gap-3 mb-6"><ShieldCheck className="text-violet-400"/><h2 className="text-xl font-semibold">Account details</h2></div>
      <dl className="grid sm:grid-cols-2 gap-6"><div><dt className="text-sm text-slate-400 mb-1">Name</dt><dd>{user.displayName}</dd></div><div><dt className="text-sm text-slate-400 mb-1">Email</dt><dd className="break-all">{user.email}</dd></div><div><dt className="text-sm text-slate-400 mb-1">Email status</dt><dd className={user.emailVerified ? 'text-emerald-300' : 'text-amber-300'}>{user.emailVerified ? 'Verified' : 'Verification required'}</dd></div><div><dt className="text-sm text-slate-400 mb-1">Active role</dt><dd>{roleLabel[user.activeRole]}</dd></div></dl>
      <div className="flex flex-wrap gap-3 mt-7">{!user.emailVerified && <><button className="btn-primary" disabled={busy} onClick={() => void act(() => accountClient.requestVerification(), 'Verification email requested. Check your inbox.')}>Request verification email</button><button className="btn-ghost" onClick={onVerify}>Enter verification code</button></>}<button className="btn-ghost" onClick={onRecover}>Reset password</button></div>
    </section>
    {user.roles.length > 1 && <section className="card p-7 mb-6"><h2 className="text-lg font-semibold mb-3">Choose how you use StageLink</h2><div className="flex flex-wrap gap-3">{user.roles.map(role => <button key={role} disabled={busy || role === user.activeRole} className={role === user.activeRole ? 'btn-primary' : 'btn-ghost'} aria-pressed={role === user.activeRole} onClick={() => void act(() => accountClient.selectRole(role))}>{roleLabel[role]}</button>)}</div></section>}
    <section className="card p-7 flex flex-wrap items-center justify-between gap-5"><div><h2 className="text-lg font-semibold mb-2">Find your next event partner</h2><p className="text-slate-400">Explore the StageLink marketplace preview.</p></div><button className="btn-primary flex items-center gap-2" onClick={onBrowse}>Explore StageLink <ArrowUpRight size={17}/></button></section>
    <Notice error>{error}</Notice><Notice>{notice}</Notice>
  </main>;
}
