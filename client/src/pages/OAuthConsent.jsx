import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

/** /oauth/consent — "Allow <app> to use SignFlow as you?" for MCP clients such as claude.ai. */
export default function OAuthConsent() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const q = Object.fromEntries(params.entries());

  useEffect(() => {
    api(`/api/oauth/consent?client_id=${encodeURIComponent(q.client_id || '')}&redirect_uri=${encodeURIComponent(q.redirect_uri || '')}`, { allow401: true })
      .then(setInfo)
      .catch((e) => { if (e.status === 401) nav(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`); else setError(e.message); });
  }, []);

  const decide = async (approve) => {
    setBusy(true); setError('');
    try {
      const r = await api('/api/oauth/approve', { method: 'POST', body: { client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state, code_challenge: q.code_challenge, scope: q.scope, resource: q.resource, approve } });
      window.location.assign(r.redirect);
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <div style={{ minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ maxWidth: 460, width: '100%' }}>
        <div className="auth-logo" style={{ color: 'var(--brand)', marginBottom: 12 }}>✒️ SignFlow</div>
        {error && !info && <><h2 style={{ marginTop: 0 }}>Cannot continue</h2><p className="error">{error}</p></>}
        {!info && !error && <p className="muted">Loading…</p>}
        {info && (
          <>
            <h2 style={{ margin: '0 0 6px' }}>Allow {info.client.name} to use SignFlow?</h2>
            <p className="muted" style={{ marginTop: 0 }}>Requested by <strong>{info.client.redirect_host}</strong>. You are signed in as <strong>{info.user.email}</strong>.</p>
            <p style={{ fontSize: 14 }}>{info.client.name} will be able to act as you in SignFlow:</p>
            <ul style={{ fontSize: 14, paddingLeft: 20, marginTop: 0 }}>
              <li>See your documents, templates and their status</li>
              <li>Send documents and templates for signature, remind and void</li>
              <li>Everything it does is recorded in your audit trail</li>
            </ul>
            <p className="muted small">You can revoke this at any time in Settings → Claude &amp; MCP.</p>
            {error && <p className="error">{error}</p>}
            <div className="row spread" style={{ marginTop: 14 }}>
              <button className="secondary" disabled={busy} onClick={() => decide(false)}>Deny</button>
              <button disabled={busy} onClick={() => decide(true)}>{busy ? 'Please wait…' : 'Allow'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
