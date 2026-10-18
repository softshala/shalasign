import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';

/** /join/:token — accept a workspace invitation (sign up or log in first if needed). */
export default function Join() {
  const { token } = useParams();
  const nav = useNavigate();
  const [info, setInfo] = useState(null);
  const [me, setMe] = useState(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', password: '' });
  const [mode, setMode] = useState('signup');

  useEffect(() => {
    api(`/api/org/join/${token}`).then((i) => { setInfo(i); setMode(i.account_exists ? 'login' : 'signup'); }).catch((e) => setError(e.message));
    api('/api/auth/me', { allow401: true }).then(setMe).catch(() => setMe(null));
  }, [token]);

  const accept = async () => {
    setBusy(true); setError('');
    try { const r = await api(`/api/org/join/${token}`, { method: 'POST' }); nav(`/settings?tab=workspace&joined=${encodeURIComponent(r.org.name)}`); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (mode === 'signup') await api('/api/auth/signup', { method: 'POST', body: { name: form.name, email: info.email, password: form.password, invite: token } });
      else { await api('/api/auth/login', { method: 'POST', body: { email: info.email, password: form.password } }); await api(`/api/org/join/${token}`, { method: 'POST' }); }
      nav('/settings?tab=workspace');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const Box = ({ children }) => (
    <div style={{ minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ maxWidth: 460, width: '100%' }}>{children}</div>
    </div>
  );
  if (error && !info) return <Box><h2 style={{ marginTop: 0 }}>Invitation not valid</h2><p className="muted">{error}</p><Link to="/login" className="btn secondary">Go to log in</Link></Box>;
  if (!info || me === undefined) return <Box><p className="muted">Loading…</p></Box>;

  return (
    <Box>
      <div className="auth-logo" style={{ color: 'var(--brand)', marginBottom: 12 }}>✒️ ShalaSign</div>
      <h2 style={{ margin: '0 0 6px' }}>Join {info.org_name}</h2>
      <p className="muted" style={{ marginTop: 0 }}>{info.inviter} invited <strong>{info.email}</strong> to join as {info.role === 'admin' ? 'an admin' : 'a member'}.</p>
      {me && me.email.toLowerCase() === info.email.toLowerCase() ? (
        <>
          <p>You are logged in as {me.email}.</p>
          {error && <p className="error">{error}</p>}
          <button className="auth-submit" disabled={busy} onClick={accept}>{busy ? 'Joining…' : `Join ${info.org_name}`}</button>
        </>
      ) : me ? (
        <>
          <p className="notice warn">You are logged in as {me.email}, but this invitation is for {info.email}. Log out and sign in with that address.</p>
          <button className="secondary" onClick={async () => { await api('/api/auth/logout', { method: 'POST' }); setMe(null); }}>Log out</button>
        </>
      ) : (
        <form onSubmit={submit}>
          {mode === 'signup' && <label className="field"><span>Your name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus /></label>}
          <label className="field"><span>Email</span><input value={info.email} disabled /></label>
          <label className="field"><span>{mode === 'signup' ? 'Choose a password' : 'Password'}</span><input type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} /></label>
          {error && <p className="error">{error}</p>}
          <button className="auth-submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account & join' : 'Log in & join'}</button>
          <p className="muted" style={{ textAlign: 'center', marginTop: 12 }}>
            {mode === 'signup' ? <>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); setMode('login'); }}>Log in</a></> : <>New here? <a href="#" onClick={(e) => { e.preventDefault(); setMode('signup'); }}>Create an account</a></>}
          </p>
        </form>
      )}
    </Box>
  );
}
