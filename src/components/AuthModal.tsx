import { useState, useEffect, useRef } from 'react';
import { accountClient } from '../api/auth';
import { Icon } from './Icons';

type AuthType = 'login' | 'register_customer' | 'register_artist' | 'register_renter';

interface AuthModalProps {
  initialMode: AuthType;
  onClose: () => void;
  onSuccess: (role: string) => void;
  onRecover: (email: string) => void;
}

export default function AuthModal({ initialMode, onClose, onSuccess, onRecover }: AuthModalProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isInitiallySignUp = initialMode.startsWith('register');
  const [rightPanelActive, setRightPanelActive] = useState(isInitiallySignUp);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => {
      const inputs = Array.from(dialog.current?.querySelectorAll<HTMLInputElement>('input') ?? []);
      inputs.find(input => !input.closest('[inert]'))?.focus();
    });
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = overflow; previous?.focus(); };
  }, [rightPanelActive]);
  // Sign In state
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Sign Up state
  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupRole, setSignupRole] = useState<'customer' | 'artist' | 'renter'>(
    initialMode === 'register_artist' ? 'artist' :
    initialMode === 'register_renter' ? 'renter' : 'customer'
  );

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true));
  }, []);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { const user = await accountClient.login(loginEmail, loginPassword); setLoginPassword(''); onSuccess(user.activeRole); }
    catch (error) { setError(error instanceof Error ? error.message : 'Sign in failed. Please try again.'); }
    finally { setBusy(false); }
  };
  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { await accountClient.register(signupName, signupEmail, signupPassword, signupRole); setSignupPassword(''); setLoginEmail(signupEmail); setRightPanelActive(false); setNotice('Account request received. Check your inbox, then sign in with your chosen password.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Registration failed. Please try again.'); }
    finally { setBusy(false); }
  };

  /* shared input style */
  const inputStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(124,58,237,0.2)',
    borderRadius: 8,
    padding: '10px 14px',
    width: '100%',
    fontSize: 13,
    color: '#f1f5f9',
    outline: 'none',
    marginBottom: 10,
    transition: 'border-color 0.2s',
  };

  const solidBtnStyle: React.CSSProperties = {
    background: 'linear-gradient(135deg, #7c3aed, #a78bfa)',
    color: '#fff',
    border: 'none',
    borderRadius: 20,
    padding: '10px 40px',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 1,
    textTransform: 'uppercase',
    cursor: 'pointer',
    transition: 'transform 0.2s, box-shadow 0.2s',
    marginTop: 8,
  };

  const ghostBtnStyle: React.CSSProperties = {
    background: 'transparent',
    color: '#fff',
    border: '2px solid rgba(255,255,255,0.7)',
    borderRadius: 20,
    padding: '10px 40px',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 1,
    textTransform: 'uppercase',
    cursor: 'pointer',
    transition: 'all 0.3s',
  };

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center sl-auth-backdrop"
      ref={dialog} role="dialog" aria-modal="true" aria-label={rightPanelActive ? 'Create StageLink account' : 'Sign in to StageLink'}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        if (event.key === 'Tab') {
          const fields = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]') ?? []).filter(field => !field.closest('[inert]') && field.getClientRects().length);
          const first = fields[0], last = fields[fields.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(10px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* ── Main container ── */}
      <div className="sl-auth-panel"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 820,
          minHeight: 480,
          margin: '0 16px',
          borderRadius: 16,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5), 0 0 40px rgba(124,58,237,0.15)',
          overflow: 'hidden',
          background: '#0d1120',
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'scale(1) translateY(0)' : 'scale(0.95) translateY(20px)',
          transition: 'opacity 0.4s ease, transform 0.4s ease',
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          aria-label="Close sign-in"
          style={{
            position: 'absolute', top: 12, right: 12, zIndex: 100,
            background: 'rgba(0,0,0,0.3)', border: 'none', borderRadius: '50%',
            width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: '#94a3b8', transition: 'color 0.2s',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
          onMouseLeave={e => (e.currentTarget.style.color = '#94a3b8')}
        >
          <Icon.X className="w-4 h-4" />
        </button>

        {/* ═══════════════ SIGN IN FORM (left side) ═══════════════ */}
        <div className="sl-auth-form" inert={rightPanelActive} aria-hidden={rightPanelActive}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '50%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.6s ease-in-out',
            transform: rightPanelActive ? 'translateX(100%)' : 'translateX(0)',
            opacity: rightPanelActive ? 0 : 1,
            zIndex: rightPanelActive ? 1 : 5,
          }}
        >
          <form
            onSubmit={handleSignIn}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '0 40px',
              width: '100%',
            }}
          >
            <h1
              style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 26,
                fontWeight: 700,
                color: '#f1f5f9',
                marginBottom: 16,
              }}
            >
              Sign In
            </h1>



            <span style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
              Use your StageLink email and password
            </span>

            <input
              type="email"
              autoComplete="email" maxLength={200}
              placeholder="Email Address"
              required
              aria-label="Sign-in email" value={loginEmail}
              onChange={e => setLoginEmail(e.target.value)}
              style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7c3aed')}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.2)')}
            />
            <input
              type="password"
              maxLength={128}
              placeholder="Password"
              required
              autoComplete="current-password"
              aria-label="Sign-in password" value={loginPassword}
              onChange={e => setLoginPassword(e.target.value)}
              style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7c3aed')}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.2)')}
            />

            <a
              href="#"
              onClick={e => { e.preventDefault(); onRecover(loginEmail); }}
              style={{
                fontSize: 12,
                color: '#a78bfa',
                textDecoration: 'none',
                marginBottom: 12,
                transition: 'color 0.2s',
              }}
            >
              Forgot your password?
            </a>

            <p role="alert" style={{ color: '#fda4af', fontSize: 12 }}>{error}</p><p role="status" style={{ color: '#c4b5fd', fontSize: 12 }}>{notice}</p>
            <button type="submit" disabled={busy} style={solidBtnStyle}>
              {busy ? 'PLEASE WAIT…' : 'SIGN IN'}
            </button>
          </form>
        </div>

        {/* ═══════════════ SIGN UP FORM (right side) ═══════════════ */}
        <div className="sl-auth-form" inert={!rightPanelActive} aria-hidden={!rightPanelActive}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '50%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.6s ease-in-out',
            transform: rightPanelActive ? 'translateX(100%)' : 'translateX(200%)',
            opacity: rightPanelActive ? 1 : 0,
            zIndex: rightPanelActive ? 5 : 1,
          }}
        >
          <form
            onSubmit={handleSignUp}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '0 40px',
              width: '100%',
            }}
          >
            <h1
              style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 26,
                fontWeight: 700,
                color: '#f1f5f9',
                marginBottom: 16,
              }}
            >
              Create Account
            </h1>



            <span style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>
              Create your StageLink account
            </span>

            <input
              type="text"
              placeholder="Full Name"
              required minLength={2} maxLength={80}
              aria-label="Full name" value={signupName}
              onChange={e => setSignupName(e.target.value)}
              style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7c3aed')}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.2)')}
            />
            <input
              type="email"
              autoComplete="email" maxLength={200}
              placeholder="Email Address"
              required
              aria-label="Registration email" value={signupEmail}
              onChange={e => setSignupEmail(e.target.value)}
              style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7c3aed')}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.2)')}
            />
            <input
              type="password"
              maxLength={128}
              placeholder="Password"
              required
              minLength={12}
              autoComplete="new-password"
              aria-label="Registration password" value={signupPassword}
              onChange={e => setSignupPassword(e.target.value)}
              style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7c3aed')}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(124,58,237,0.2)')}
            />

            {/* Role selector */}
            <div style={{ display: 'flex', gap: 8, width: '100%', marginBottom: 8 }}>
              {([
                { value: 'customer' as const, label: 'Customer' },
                { value: 'artist' as const, label: 'Artist' },
                { value: 'renter' as const, label: 'Renter' },
              ]).map(r => (
                <button
                  key={r.value}
                  type="button"
                  disabled={busy} onClick={() => setSignupRole(r.value)}
                  style={{
                    flex: 1,
                    padding: '7px 0',
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 8,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    border: signupRole === r.value
                      ? '1px solid #7c3aed'
                      : '1px solid rgba(124,58,237,0.2)',
                    background: signupRole === r.value
                      ? 'rgba(124,58,237,0.15)'
                      : 'transparent',
                    color: signupRole === r.value ? '#a78bfa' : '#64748b',
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <p role="alert" style={{ color: '#fda4af', fontSize: 12 }}>{error}</p><p role="status" style={{ color: '#c4b5fd', fontSize: 12 }}>{notice}</p>
            <button type="submit" disabled={busy} style={solidBtnStyle}>
              {busy ? 'PLEASE WAIT…' : 'SIGN UP'}
            </button>
          </form>
        </div>

        {/* ═══════════════ SLIDING OVERLAY ═══════════════ */}
        <div className="sl-auth-overlay"
          style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            width: '50%',
            height: '100%',
            overflow: 'hidden',
            transition: 'transform 0.6s ease-in-out',
            transform: rightPanelActive ? 'translateX(-100%)' : 'translateX(0)',
            zIndex: 10,
            borderRadius: rightPanelActive ? '0 16px 16px 0' : '16px 0 0 16px',
          }}
        >
          {/* Gradient background */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(135deg, #4c1d95 0%, #7c3aed 50%, #6d28d9 100%)',
            }}
          />

          {/* Subtle pattern overlay */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(circle at 30% 70%, rgba(245,158,11,0.15) 0%, transparent 50%)',
            }}
          />

          {/* Inner sliding wrapper (200% width, slides 50%) */}
          <div
            style={{
              position: 'relative',
              display: 'flex',
              width: '200%',
              height: '100%',
              transition: 'transform 0.6s ease-in-out',
              transform: rightPanelActive ? 'translateX(0)' : 'translateX(-50%)',
            }}
          >
            {/* LEFT OVERLAY PANEL — "Welcome Back!" */}
            <div inert={!rightPanelActive}
              style={{
                width: '50%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 40px',
                textAlign: 'center',
              }}
            >
              <h1
                style={{
                  fontFamily: "'Fraunces', Georgia, serif",
                  fontSize: 28,
                  fontWeight: 700,
                  color: '#fff',
                  marginBottom: 16,
                }}
              >
                Welcome Back!
              </h1>
              <p
                style={{
                  fontSize: 13,
                  color: 'rgba(255,255,255,0.75)',
                  lineHeight: 1.6,
                  marginBottom: 28,
                  maxWidth: 260,
                }}
              >
                Stay connected by logging in with your credentials and continue your StageLink experience
              </p>
              <button
                style={ghostBtnStyle}
                disabled={busy} onClick={() => setRightPanelActive(false)}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.15)';
                  e.currentTarget.style.transform = 'scale(1.03)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.transform = 'scale(1)';
                }}
              >
                {busy ? 'PLEASE WAIT…' : 'SIGN IN'}
              </button>
            </div>

            {/* RIGHT OVERLAY PANEL — "Hey There!" */}
            <div inert={rightPanelActive}
              style={{
                width: '50%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 40px',
                textAlign: 'center',
              }}
            >
              <h1
                style={{
                  fontFamily: "'Fraunces', Georgia, serif",
                  fontSize: 28,
                  fontWeight: 700,
                  color: '#fff',
                  marginBottom: 16,
                }}
              >
                Hey There!
              </h1>
              <p
                style={{
                  fontSize: 13,
                  color: 'rgba(255,255,255,0.75)',
                  lineHeight: 1.6,
                  marginBottom: 28,
                  maxWidth: 260,
                }}
              >
                Begin your amazing journey by creating an account with us today
              </p>
              <button
                style={ghostBtnStyle}
                disabled={busy} onClick={() => setRightPanelActive(true)}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.15)';
                  e.currentTarget.style.transform = 'scale(1.03)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.transform = 'scale(1)';
                }}
              >
                {busy ? 'PLEASE WAIT…' : 'SIGN UP'}
              </button>
            </div>
          </div>
        </div>
        <button className="sl-auth-mobile-switch" type="button" disabled={busy} onClick={() => { setRightPanelActive(value => !value); setError(''); }}>{rightPanelActive ? 'Already have an account? Sign in' : 'New to StageLink? Create an account'}</button>
      </div>
    </div>
    </>
  );
}
