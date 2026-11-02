import { useState } from 'react';
import { MailCheck } from 'lucide-react';
import { Modal, Notice } from './DashboardUI';
import { accountClient } from '../api/auth';
export default function PersistentAccountRecovery({ initialEmail = '', initialToken = '', onClose }: { initialEmail?: string; initialToken?: string; onClose: () => void }) {
  const [step, setStep] = useState<'email'|'code'|'password'|'done'>(initialToken ? 'code' : 'email');
  const [email, setEmail] = useState(initialEmail), [token, setToken] = useState(initialToken), [grant, setGrant] = useState('');
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setError(''); setBusy(true);
    try {
      if (step === 'email') { await accountClient.requestReset(email); setStep('code'); }
      else if (step === 'code') { const verified = await accountClient.verifyReset(token.trim()); setGrant(verified.grant); setToken(''); setStep('password'); }
      else if (step === 'password') {
        if (password !== confirmation) throw new Error('The passwords do not match.');
        await accountClient.completeReset(grant, password); setPassword(''); setConfirmation(''); setGrant(''); setStep('done');
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'The request failed. Please try again.'); }
    finally { setBusy(false); }
  }
  return <Modal title={step === 'done' ? 'Password changed' : step === 'password' ? 'Choose a new password' : step === 'code' ? 'Check your inbox' : 'Recover your account'} onClose={onClose}>
    <div className="mg-page">{step === 'done' ? <><MailCheck size={40}/><Notice>Your password has changed and your previous sessions have ended. Sign in with your new password.</Notice><button className="btn-primary" onClick={onClose}>Back to sign in</button></> : <form onSubmit={submit}>
      {step === 'email' ? <><p>We’ll send a one-time recovery link if this address has an eligible account.</p><label className="mg-field">Account email<input type="email" autoComplete="email" required maxLength={200} value={email} onChange={e => setEmail(e.target.value)}/></label></> : step === 'code' ? <><p>Open your recovery email, or paste its one-time code below. The code expires after 15 minutes.</p><label className="mg-field">Recovery code<input autoComplete="one-time-code" required minLength={43} maxLength={43} value={token} onChange={e => setToken(e.target.value)} /></label><button type="button" className="mg-text-link" disabled={busy} onClick={() => { setStep('email'); setError(''); }}>Request another code</button></> : <><p>Your reset session is valid for five minutes.</p><label className="mg-field">New password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)}/></label><label className="mg-field">Confirm new password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={e => setConfirmation(e.target.value)}/></label></>}
      <Notice error>{error}</Notice><div className="mg-actions"><button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Close</button><button className="btn-primary" disabled={busy}>{busy ? 'Please wait…' : step === 'email' ? 'Request recovery email' : step === 'code' ? 'Continue' : 'Change password'}</button></div>
    </form>}</div>
  </Modal>;
}
