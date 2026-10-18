import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../api.js';

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

export default function AuthPage({ mode: initialMode = 'login' }) {
  const { token: resetToken } = useParams();
  const [mode, setMode] = useState(initialMode);          // login | signup | otp | forgot | reset
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [otp, setOtp] = useState({ step: 'email', code: '', newAccount: false, cooldown: 0 });
  const [providers, setProviders] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const nextUrl = (() => { const n = new URLSearchParams(window.location.search).get('next'); return n && n.startsWith('/') && !n.startsWith('//') ? n : '/'; })();
  const go = () => (nextUrl !== '/' ? window.location.assign(nextUrl) : nav('/'));

  useEffect(() => {
    api('/api/auth/providers').then(setProviders).catch(() => setProviders({ password: true }));
    const err = new URLSearchParams(window.location.search).get('error');
    if (err) { setError(err); const u = new URL(window.location.href); u.searchParams.delete('error'); window.history.replaceState({}, '', u.pathname + u.search); }
  }, []);

  useEffect(() => {
    if (otp.cooldown <= 0) return;
    const t = setTimeout(() => setOtp((o) => ({ ...o, cooldown: o.cooldown - 1 })), 1000);
    return () => clearTimeout(t);
  }, [otp.cooldown]);

  const run = async (fn) => {
    setError(''); setBusy(true);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const switchMode = (m) => { setMode(m); setError(''); setNotice(''); setOtp({ step: 'email', code: '', newAccount: false, cooldown: 0 }); };

  const submitPassword = (e) => { e.preventDefault(); run(async () => { await api(`/api/auth/${mode === 'login' ? 'login' : 'signup'}`, { method: 'POST', body: form }); go(); }); };
  const requestCode = (e) => { e?.preventDefault(); run(async () => {
    const d = await api('/api/auth/otp/request', { method: 'POST', body: { email: form.email } });
    setOtp({ step: 'code', code: '', newAccount: d.new_account, cooldown: 60 });
    setNotice(`We emailed a 6-digit code to ${form.email.trim()}. It expires in ${d.expires_in_minutes} minutes.`);
  }); };
  const verifyCode = (e) => { e.preventDefault(); run(async () => { await api('/api/auth/otp/verify', { method: 'POST', body: { email: form.email, code: otp.code, name: form.name } }); go(); }); };
  const forgot = (e) => { e.preventDefault(); run(async () => { await api('/api/auth/forgot', { method: 'POST', body: { email: form.email } }); setNotice(`If an account exists for ${form.email.trim()}, a reset link is on its way. Check your inbox (and spam).`); }); };
  const reset = (e) => { e.preventDefault(); run(async () => { await api('/api/auth/reset', { method: 'POST', body: { token: resetToken, password: form.password } }); go(); }); };

  const hasSso = providers?.google || providers?.microsoft;
  const headings = {
    login: ['Welcome back', 'Log in to send and track documents.'],
    signup: ['Create your account', 'Start sending documents for signature.'],
    otp: ['Sign in with a code', "No password needed — we'll email you a one-time code."],
    forgot: ['Reset your password', "Enter your email and we'll send a reset link."],
    reset: ['Choose a new password', 'At least 8 characters.'],
  }[mode];

  return (
    <div className="auth-wrap">
      <div className="auth-brand">
        <div>
          <div className="auth-logo">✒️ SignFlow</div>
          <h1 className="auth-headline">Get documents signed,<br />without the friction.</h1>
          <p className="auth-sub">Upload a PDF, place signature fields, and send. Signers sign from any device — no account needed. Every completed document comes sealed with a tamper-evident certificate.</p>
          <ul className="auth-points">
            <li>✓ Templates, reminders and deadlines</li>
            <li>✓ Send to one person or hundreds at once</li>
            <li>✓ Require ID documents from specific signers</li>
            <li>✓ Automatic archive to OneDrive / SharePoint</li>
          </ul>
        </div>
        <div className="auth-foot">Softshala Technologies</div>
      </div>

      <div className="auth-form-side">
        <div className="auth-card">
          <div className="auth-logo mobile-only" style={{ marginBottom: 18 }}>✒️ SignFlow</div>
          {providers?.platform_name && providers.platform_name !== 'SignFlow' && <div className="muted small" style={{ marginBottom: 6 }}>{providers.platform_name}</div>}
          <h2 style={{ margin: '0 0 4px' }}>{headings[0]}</h2>
          {mode === 'signup' && providers?.signup_mode === 'invite_only' && <p className="notice warn">Sign-up is by invitation only. Use the link from your invitation email.</p>}
          <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>{headings[1]}</p>

          {hasSso && (mode === 'login' || mode === 'signup') && (
            <>
              {providers.google && <a className="sso-btn" href="/api/auth/sso/google"><GoogleIcon /> Continue with Google</a>}
              {providers.microsoft && <a className="sso-btn" href="/api/auth/sso/microsoft"><MicrosoftIcon /> Continue with Microsoft</a>}
              <div className="divider">or</div>
            </>
          )}

          {(mode === 'login' || mode === 'signup') && (
            <form onSubmit={submitPassword}>
              {mode === 'signup' && (
                <label className="field"><span>Full name</span>
                  <input placeholder="Your name" value={form.name} autoComplete="name" onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                </label>
              )}
              <label className="field"><span>Work email</span>
                <input type="email" placeholder="you@company.com" value={form.email} autoComplete="email" onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              </label>
              <label className="field">
                <span className="row spread">Password {mode === 'login' && providers?.password_reset && <a href="#" className="small" style={{ fontWeight: 400 }} onClick={(e) => { e.preventDefault(); switchMode('forgot'); }}>Forgot password?</a>}</span>
                <input type="password" placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'} value={form.password}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={mode === 'signup' ? 8 : undefined} />
              </label>
              {error && <p className="error">{error}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}</button>
            </form>
          )}

          {mode === 'otp' && otp.step === 'email' && (
            <form onSubmit={requestCode}>
              <label className="field"><span>Work email</span>
                <input type="email" placeholder="you@company.com" value={form.email} autoComplete="email" autoFocus onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              </label>
              {error && <p className="error">{error}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? 'Sending…' : 'Email me a code'}</button>
            </form>
          )}
          {mode === 'otp' && otp.step === 'code' && (
            <form onSubmit={verifyCode}>
              {notice && <p className="notice">{notice}</p>}
              {otp.newAccount && (
                <label className="field"><span>Your name <span className="muted" style={{ fontWeight: 400 }}>(this email is new to SignFlow)</span></span>
                  <input placeholder="Your name" value={form.name} autoComplete="name" onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                </label>
              )}
              <label className="field"><span>6-digit code</span>
                <input className="otp-input" inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder="••••••" autoFocus autoComplete="one-time-code" value={otp.code}
                  onChange={(e) => setOtp({ ...otp, code: e.target.value.replace(/\D/g, '').slice(0, 6) })} required />
              </label>
              {error && <p className="error">{error}</p>}
              <button className="auth-submit" disabled={busy || otp.code.length !== 6}>{busy ? 'Checking…' : 'Sign in'}</button>
              <p className="muted" style={{ textAlign: 'center', marginTop: 12 }}>
                {otp.cooldown > 0 ? `Resend code in ${otp.cooldown}s` : <a href="#" onClick={(e) => { e.preventDefault(); requestCode(); }}>Resend code</a>}
                {' · '}<a href="#" onClick={(e) => { e.preventDefault(); setOtp({ ...otp, step: 'email', code: '' }); setError(''); setNotice(''); }}>Change email</a>
              </p>
            </form>
          )}

          {mode === 'forgot' && (
            <form onSubmit={forgot}>
              {notice ? <p className="notice ok">{notice}</p> : (
                <label className="field"><span>Work email</span>
                  <input type="email" placeholder="you@company.com" value={form.email} autoComplete="email" autoFocus onChange={(e) => setForm({ ...form, email: e.target.value })} required />
                </label>
              )}
              {error && <p className="error">{error}</p>}
              {!notice && <button className="auth-submit" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>}
            </form>
          )}

          {mode === 'reset' && (
            <form onSubmit={reset}>
              <label className="field"><span>New password</span>
                <input type="password" placeholder="At least 8 characters" value={form.password} autoComplete="new-password" autoFocus minLength={8} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
              </label>
              {error && <p className="error">{error}</p>}
              <button className="auth-submit" disabled={busy}>{busy ? 'Saving…' : 'Set password and log in'}</button>
            </form>
          )}

          <p className="muted" style={{ textAlign: 'center', marginTop: 18 }}>
            {mode === 'login' && (<>
              {providers?.otp && <><a href="#" onClick={(e) => { e.preventDefault(); switchMode('otp'); }}>Log in with an emailed code</a><br /></>}
              Don't have an account? <a href="#" onClick={(e) => { e.preventDefault(); switchMode('signup'); }}>Create one</a>
            </>)}
            {mode === 'signup' && (<>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); switchMode('login'); }}>Log in</a></>)}
            {(mode === 'otp' || mode === 'forgot') && (<a href="#" onClick={(e) => { e.preventDefault(); switchMode('login'); }}>Back to log in</a>)}
            {mode === 'reset' && (<Link to="/login">Back to log in</Link>)}
          </p>
        </div>
      </div>
    </div>
  );
}
