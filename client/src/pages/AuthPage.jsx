import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function AuthPage() {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    const res = await fetch(`/api/auth/${mode === 'login' ? 'login' : 'signup'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setError(data.error || 'Something went wrong');
    nav('/');
  };

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
          <h2 style={{ margin: '0 0 4px' }}>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
          <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
            {mode === 'login' ? 'Log in to send and track documents.' : 'Start sending documents for signature.'}
          </p>
          <form onSubmit={submit}>
            {mode === 'signup' && (
              <label className="field">
                <span>Full name</span>
                <input placeholder="Your name" value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </label>
            )}
            <label className="field">
              <span>Work email</span>
              <input type="email" placeholder="you@company.com" value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'} value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={mode === 'signup' ? 8 : undefined} />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="auth-submit" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
            </button>
          </form>
          <p className="muted" style={{ textAlign: 'center', marginTop: 18 }}>
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'login' ? 'signup' : 'login'); setError(''); }}>
              {mode === 'login' ? 'Create one' : 'Log in'}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
