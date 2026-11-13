import { useEffect, useRef, useState } from 'react';
import DemoApp from './DemoApp';
import { useAccount } from './api/AccountContext';
import { accountClient } from './api/auth';
import AuthModal from './components/AuthModal';
import AccountHome, { ConfirmAccountEmail, type AccountWorkspace } from './components/AccountHome';
import PersistentAccountRecovery from './components/PersistentAccountRecovery';
import PersistentProfiles, { ConfirmEmailChange } from './components/PersistentProfiles';
import PersistentGigs from './components/PersistentGigs';
import LandingPage from './components/LandingPage';
import SplashScreen from './components/SplashScreen';
import { DashboardProvider } from './lib/DashboardContext';
import { BookingProvider } from './lib/BookingContext';
import { AppearanceProvider } from './lib/AppearanceContext';
type AuthMode = 'login' | 'register_customer' | 'register_artist' | 'register_renter';
function PersistentApp() {
  const account = useAccount();
  const [authMode, setAuthMode] = useState<AuthMode | null>(null), [browse, setBrowse] = useState(false), [loaded, setLoaded] = useState(false);
  const [workspace,setWorkspace]=useState<AccountWorkspace|null>(null);
  const [dark, setDark] = useState(true), [link, setLink] = useState<{ purpose: 'verify'|'reset'|'emailchange'; token: string; email?: string } | null>(null);
  const inspectedLink = useRef(false);
  useEffect(() => { void accountClient.restore(); }, []);
  useEffect(() => {
    if (inspectedLink.current) return; inspectedLink.current = true;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const purpose = hash.has('verify') ? 'verify' : hash.has('reset') ? 'reset' : hash.has('emailchange') ? 'emailchange' : null;
    if (purpose) {
      const token = hash.get(purpose) ?? '';
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setLink({ purpose, token: /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '' });
    }
  }, []);
  useEffect(() => { if (account.status === 'authenticated') { setAuthMode(null); setBrowse(false); setWorkspace(null); } }, [account.status, account.user?.id,account.user?.activeRole]);
  return <AppearanceProvider isDark={dark} onThemeChange={next => { setDark(next); document.documentElement.dataset.theme = next ? 'dark' : 'light'; }}>
    {!loaded && <SplashScreen onComplete={() => setLoaded(true)}/>}
    {loaded && <div className="theme-root min-h-screen" style={{ background: 'var(--color-bg)' }}>
      {account.status === 'checking' ? <main className="min-h-screen flex justify-center items-center text-violet-200" role="status">Restoring your account…</main> : account.user && !browse ? workspace === 'gigs' ? <PersistentGigs key={account.user.id} onBack={() => setWorkspace(null)}/> : workspace?<PersistentProfiles key={account.user.id+account.user.activeRole} user={account.user} initialTab={workspace} onBack={()=>setWorkspace(null)}/>:<AccountHome key={account.user.id} user={account.user} onManage={setWorkspace} onBrowse={() => setBrowse(true)} onVerify={() => setLink({ purpose: 'verify', token: '' })} onRecover={() => setLink({ purpose: 'reset', token: '', email: account.user!.email })}/> : <>
        <div className="relative z-30 px-4 py-2 text-center text-xs text-violet-200 bg-violet-950">Marketplace preview · Sample artists and equipment</div>
        <DashboardProvider actor="visitor"><BookingProvider actor="visitor"><LandingPage onAuth={mode => { if (account.user) setBrowse(false); else setAuthMode(mode); }} isDark={dark} onThemeChange={next => { setDark(next); document.documentElement.dataset.theme = next ? 'dark' : 'light'; }} isSplashLogoTransition={false} onReturnToDashboard={account.user ? () => setBrowse(false) : undefined}/></BookingProvider></DashboardProvider>
        {account.status === 'unavailable' && <div className="fixed bottom-5 left-5 right-5 z-50 card p-5 flex flex-wrap items-center justify-between gap-3" role="alert"><p>{account.error}</p><button className="btn-primary" onClick={() => void accountClient.restore()}>Retry connection</button></div>}
        {account.error && account.status === 'anonymous' && <p role="status" className="text-center text-amber-200 p-3">{account.error}</p>}
        {authMode && <AuthModal initialMode={authMode} onClose={() => setAuthMode(null)} onSuccess={() => setAuthMode(null)} onRecover={email => { setAuthMode(null); setLink({ purpose: 'reset', token: '', email }); }}/>}
      </>}
    </div>}
    {loaded && link?.purpose === 'verify' && <ConfirmAccountEmail initialToken={link.token} onClose={() => setLink(null)}/>}
    {loaded && link?.purpose === 'reset' && <PersistentAccountRecovery initialEmail={link.email} initialToken={link.token} onClose={() => setLink(null)}/>}
    {loaded && link?.purpose === 'emailchange' && <ConfirmEmailChange initialToken={link.token} onClose={()=>setLink(null)}/>}
  </AppearanceProvider>;
}
export default function App() { return import.meta.env.VITE_AUTH_MODE === 'demo' ? <DemoApp/> : <PersistentApp/>; }
