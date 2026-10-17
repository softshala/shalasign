import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.5 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.2z"/>
    <path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.7 24c0-1.6.3-3.1.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z"/>
    <path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.7-6c-2.1 1.4-4.8 2.3-7.9 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/>
  </svg>
);
const MicrosoftIcon = () => (
  <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
    <rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
    <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
  </svg>
);

export default function AuthPage() {
  const [mode, setMode] = useState('login');          // 'login' | 'signup' | 'otp'
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [otp, setOtp] = useState({ step: 'email', code: '', newAccount: false, cooldown: 0 });
  const [providers, setProviders] = useState(null);   // { password, google, microsoft, otp }
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    fetch('/api/auth/providers').then((r) => r.json()).then(setProviders).catch(() => setProviders({ password: true }));
    // SSO failures come back as /login?error=...
    const err = new URLSearchParams(window.location.search).get('error');
    if (err) { setError(err); window.history.replaceState({}, '', '/login'); }
  }, []);

  // Resend cooldown ticker for the OTP step.
  useEffect(() => {
    if (otp.cooldown <= 0) return;
    const t = setTimeout(() => setOtp((o) => ({ ...o, cooldown: o.cooldown - 1 })), 1000);
    return () => clearTimeout(t);
  }, [otp.cooldown]);

  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error */ }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  const switchMode = (m) => { setMode(m); setError(''); setNotice(''); setOtp({ step: 'email', code: '', newAccount: false, cooldown: 0 }); };

  const submitPassword = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await post(`/api/auth/${mode === 'login' ? 'login' : 'signup'}`, form);
      nav('/');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const requestCode = async (e) => {
    e?.preventDefault();
    setError(''); setNotice(''); setBusy(true);
    try {
      const d = await post('/api/auth/otp/request', { email: form.email });
      setOtp({ step: 'code', code: '', newAccount: d.new_account, cooldown: 60 });
      setNotice(`We emailed a 6-digit code to ${form.email.trim()}. It expires in ${d.expires_in_minutes} minutes.`);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const verifyCode = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await post('/api/auth/otp/verify', { email: form.email, code: otp.code, name: form.name });
      nav('/');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const hasSso = providers?.google || providers?.microsoft;
  const heading = mode === 'signup' ? 'Create your account' : mode === 'otp' ? 'Sign in with a code' : 'Welcome back';
  const sub = mode === 'signup' ? 'Start sending documents for signature.'
    : mode === 'otp' ? 'No password needed — we\'ll email you a one-time code.'
    : 'Log in to send and track documents.';

  return (
    <div className="auth-wrap">
      <div className="auth-brand">
        <div>
          <div className="auth-logo">✒️ SignFlow</div>
          <h1 className="auth-headline">Get documents signed,<br />without the friction.</h1>
          <p className="auth-sub">Upload a PDF, place signature fields, and send. Signers sign from any device — no account needed. Every completed document comes sealed with a tamper-evident certificate.</p>
          <ul className="auth-points">
            <li>✓ Send to one person or hundreds at once</li>
            <li>✓ Require ID documents from specific signers</li>
            <li>✓ Organize everything into folders</li>
            <li>✓ Protect sensitive documents with an access code</li>
          </ul>
        </div>
        <div className="auth-foot">Softshala Technologies</div>
      </div>

      <div className="auth-form-side">
        <div className="auth-card">
          <div className="auth-logo mobile-only" style={{ marginBottom: 18 }}>✒️ SignFlow</div>
          <h2 style={{ margin: '0 0 4px' }}>{heading}</h2>
          <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>{sub}</p>

          {/* --- Single sign-on buttons --- */}
          {hasSso && mode !== 'otp' && (
            <>
              {providers.google && (
                <a className="sso-btn" href="/api/auth/sso/google"><GoogleIcon /> Continue with Google</a>
              )}
              {providers.microsoft && (
                <a className="sso-btn" href="/api/auth/sso/microsoft"><MicrosoftIcon /> Continue with Microsoft</a>
              )}
              <div className="divider">or</div>
            </>
          )}

          {/* --- Email + password --- */}
          {mode !== 'otp' && (
            <form onSubmit={submitPassword}>
              {mode === 'signup' && (
                <label className="field">
                  <span>Full name</span>
                  <input placeholder="Your name" value={form.name} autoComplete="name"
                    onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                </label>
              )}
              <label className="field">
                <span>Work email</span>
                <input type="email" placeholder="you@company.com" value={form.email} autoComplete="email"
                  onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              </label>
              <label className="field">
                <span>Password</span>
                <input type="password" placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'} value={form.password}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={mode === 'signup' ? 8 : undefined} />
              </label>
              {error && <p className="error">{error}</p>}
              <button className="auth-submit" disabled={busy}>
                {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
              </button>
            </form>
          )}

          {/* --- One-time code --- */}
          {mode === 'otp' && otp.step === 'email' && (
            <form onSubmit={requestCode}>
              <label className="field">
                <span>Work email</span>
                <input type="email" placeholder="you@company.com" value={form.email} autoComplete="email" autoFocus
                  onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              </label>
              {error && <p className="error">{error}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? 'Sending…' : 'Email me a code'}</button>
            </form>
          )}
          {mode === 'otp' && otp.step === 'code' && (
            <form onSubmit={verifyCode}>
              {notice && <p className="notice">{notice}</p>}
              {otp.newAccount && (
                <label className="field">
                  <span>Your name <span className="muted" style={{ fontWeight: 400 }}>(this email is new to SignFlow)</span></span>
                  <input placeholder="Your name" value={form.name} autoComplete="name"
                    onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                </label>
              )}
              <label className="field">
                <span>6-digit code</span>
                <input className="otp-input" inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder="••••••" autoFocus
                  autoComplete="one-time-code" value={otp.code}
                  onChange={(e) => setOtp({ ...otp, code: e.target.value.replace(/\D/g, '').slice(0, 6) })} required />
              </label>
              {error && <p className="error">{error}</p>}
              <button className="auth-submit" disabled={busy || otp.code.length !== 6}>{busy ? 'Checking…' : 'Sign in'}</button>
              <p className="muted" style={{ textAlign: 'center', marginTop: 12 }}>
                {otp.cooldown > 0
                  ? `Resend code in ${otp.cooldown}s`
                  : <a href="#" onClick={(e) => { e.preventDefault(); requestCode(); }}>Resend code</a>}
                {' · '}
                <a href="#" onClick={(e) => { e.preventDefault(); setOtp({ ...otp, step: 'email', code: '' }); setError(''); setNotice(''); }}>Change email</a>
              </p>
            </form>
          )}

          {/* --- Mode switches --- */}
          <p className="muted" style={{ textAlign: 'center', marginTop: 18 }}>
            {mode === 'login' && (
              <>
                {providers?.otp && <><a href="#" onClick={(e) => { e.preventDefault(); switchMode('otp'); }}>Log in with an emailed code</a><br /></>}
                Don't have an account? <a href="#" onClick={(e) => { e.preventDefault(); switchMode('signup'); }}>Create one</a>
              </>
            )}
            {mode === 'signup' && (
              <>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); switchMode('login'); }}>Log in</a></>
            )}
            {mode === 'otp' && (
              <><a href="#" onClick={(e) => { e.preventDefault(); switchMode('login'); }}>Use a password instead</a></>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
