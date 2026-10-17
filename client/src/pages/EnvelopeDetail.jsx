import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';

export default function EnvelopeDetail() {
  const { id } = useParams();
  const [env, setEnv] = useState(null);
  const nav = useNavigate();

  const load = async () => {
    const r = await fetch(`/api/envelopes/${id}`);
    if (r.status === 401) return nav('/login');
    if (r.ok) setEnv(await r.json());
  };
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [id]);

  if (!env) return null;

  return (
    <>
      <div className="topbar"><Link className="logo" to="/">✒️ SignFlow</Link></div>
      <div className="container">
        <div className="card row spread">
          <div>
            <h2 style={{ margin: '0 0 6px' }}>{env.title} <span className={`pill ${env.status}`}>{env.status}</span></h2>
            <div className="muted">Envelope {env.id} · created {env.created_at} UTC</div>
            {env.sha256_final && <div className="muted" style={{ marginTop: 4 }}>Final SHA-256: <code>{env.sha256_final}</code></div>}
          </div>
          <div className="row">
            {env.status === 'completed' && <a className="btn" href={`/api/envelopes/${id}/download`}>⬇ Download signed PDF</a>}
            {env.status === 'sent' && (
              <button className="secondary" onClick={async () => {
                if (confirm('Void this envelope? Signers will no longer be able to sign.')) {
                  await fetch(`/api/envelopes/${id}/void`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Voided by sender' }) });
                  load();
                }
              }}>Void</button>
            )}
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Signers</h3>
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Signed at</th><th>Signing link</th></tr></thead>
            <tbody>
              {env.signers.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong></td>
                  <td>{s.email}</td>
                  <td><span className={`pill ${s.status === 'signed' ? 'completed' : 'sent'}`}>{s.status}</span></td>
                  <td className="muted">{s.signed_at ? `${s.signed_at} UTC` : '—'}</td>
                  <td>{s.status !== 'signed' && env.status === 'sent'
                    ? <span className="copy-link">{window.location.origin}/sign/{s.token}</span>
                    : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Audit trail</h3>
          {env.events.map((e, i) => (
            <div className="audit-item" key={i}>
              <strong>{e.type}</strong> · {e.actor} {e.ip && <span className="muted">· {e.ip}</span>}
              <span className="muted" style={{ float: 'right' }}>{e.created_at} UTC</span>
              {e.detail && <div className="muted">{e.detail}</div>}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
