import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, fmtDate, daysLeft, copyText } from '../api.js';

const STATUS_LABEL = { draft: 'Draft', sent: 'Awaiting signature', completed: 'Completed', voided: 'Voided', declined: 'Declined', expired: 'Expired' };

export default function EnvelopeDetail() {
  const { id } = useParams();
  const [env, setEnv] = useState(null);
  const [folders, setFolders] = useState([]);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null); // signer id being edited
  const [editForm, setEditForm] = useState({ name: '', email: '' });
  const [showAudit, setShowAudit] = useState(false);
  const nav = useNavigate();
  const toast = useToast();

  const load = async () => {
    try { const [e, f] = await Promise.all([api(`/api/envelopes/${id}`), api('/api/folders')]); setEnv(e); setFolders(f); }
    catch (e) { if (e.status === 404) nav('/'); else toast(e.message, { bad: true }); }
  };
  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    if (env?.status !== 'sent') return;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [env?.status, id]);

  const act = async (label, fn, ok) => {
    setBusy(label);
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); await load(); }
    catch (e) { toast(e.message, { bad: true, ms: 6000 }); }
    finally { setBusy(''); }
  };

  if (!env) return <Layout><p className="muted">Loading…</p></Layout>;
  if (env.status === 'draft') { nav(`/prepare/${id}`); return null; }

  const left = env.status === 'sent' ? daysLeft(env.expires_at) : null;
  const pendingNow = env.signers.filter((s) => s.your_turn);

  return (
    <Layout>
      <div className="card">
        <div className="row spread" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: '0 0 6px', wordBreak: 'break-word' }}>{env.title} <span className={`pill ${env.status}`}>{STATUS_LABEL[env.status] || env.status}</span></h2>
            <dl className="kv">
              <dt>Envelope</dt><dd><code>{env.id}</code>{env.page_count ? ` · ${env.page_count} page${env.page_count > 1 ? 's' : ''}` : ''}</dd>
              {env.owner && !env.owner.mine && <><dt>Sent by</dt><dd>{env.owner.name} <span className="muted">{env.owner.email}</span>{!env.can_edit && <span className="muted"> · view only</span>}</dd></>}
              <dt>Sent</dt><dd>{fmtDate(env.sent_at || env.created_at)}{env.sequential && env.signers.length > 1 ? ' · signers in order' : ''}{env.mail_route ? <span className="muted"> · emails from {env.mail_route.account}</span> : <span className="error"> · no email route — share links manually</span>}</dd>
              {env.status === 'sent' && <><dt>Deadline</dt><dd style={{ color: left != null && left <= 3 ? 'var(--warn)' : undefined }}>{env.expires_at ? `${fmtDate(env.expires_at)}${left != null ? ` (${left <= 0 ? 'passed' : `${left} day${left === 1 ? '' : 's'} left`})` : ''}` : 'none'}{env.reminder_days ? ` · auto-reminders every ${env.reminder_days}d` : ''}</dd></>}
              {env.completed_at && <><dt>Completed</dt><dd>{fmtDate(env.completed_at)}</dd></>}
              {env.cc?.length > 0 && <><dt>CC</dt><dd>{env.cc.map((c) => c.email).join(', ')}</dd></>}
              <dt>Folder</dt><dd>
                <select value={env.folder_id || ''} style={{ padding: '3px 8px', fontSize: 13 }} onChange={(e) => act('folder', () => api(`/api/envelopes/${id}/folder`, { method: 'POST', body: { folder_id: e.target.value || null } }), 'Moved')}>
                  <option value="">— No folder —</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </dd>
              {env.sha256_final && <><dt>Final SHA-256</dt><dd><code style={{ wordBreak: 'break-all' }}>{env.sha256_final}</code></dd></>}
              {env.archive_enabled && env.status === 'completed' && <><dt>Archive</dt><dd>{env.archive_url ? <>☁️ <a href={env.archive_url} target="_blank" rel="noopener noreferrer">Open in OneDrive ↗</a> <span className="muted">· {fmtDate(env.archived_at)}</span></> : <span className="muted">not yet copied to {env.archive_target}</span>}</dd></>}
            </dl>
            {env.seal_error && <div className="notice warn" style={{ marginTop: 10 }}>⚠️ Everyone has signed but the final PDF could not be created: <em>{env.seal_error}</em>. Try again below; if it keeps failing, re-export the original PDF and resend.</div>}
          </div>
          <div className="stack" style={{ alignItems: 'stretch', minWidth: 220 }}>
            {env.status === 'completed' && !env.seal_error && <a className="btn" href={`/api/envelopes/${id}/download`}>⬇ Download signed PDF</a>}
            {env.status === 'completed' && !env.seal_error && <a className="btn secondary small" href={`/api/envelopes/${id}/download?copy=signer`}>Signers' copy (no audit trail)</a>}
            {env.can_seal && <button disabled={!!busy} onClick={() => act('seal', () => api(`/api/envelopes/${id}/seal`, { method: 'POST' }), 'Document sealed')}>{busy === 'seal' ? 'Sealing…' : '🔏 Create final PDF'}</button>}
            {env.status === 'completed' && env.archive_enabled && !env.archive_url && <button className="secondary" disabled={!!busy} onClick={() => act('archive', () => api(`/api/envelopes/${id}/archive`, { method: 'POST' }), 'Copied to OneDrive')}>{busy === 'archive' ? 'Copying…' : '☁️ Copy to OneDrive'}</button>}
            {env.status === 'sent' && pendingNow.length > 0 && <button className="secondary" disabled={!!busy} onClick={() => act('remind', () => api(`/api/envelopes/${id}/remind`, { method: 'POST' }), (r) => (r.emailed ? `Reminder sent to ${r.reminded.join(', ')}` : 'Email is not configured — share the link manually'))}>{busy === 'remind' ? 'Sending…' : '🔔 Send reminder'}</button>}
            <a className="btn secondary small" href={`/api/envelopes/${id}/original`}>Original PDF</a>
            {env.status === 'sent' && <button className="danger small" disabled={!!busy} onClick={() => { const reason = prompt('Void this envelope? Signers will no longer be able to sign.\n\nReason (optional):'); if (reason !== null) act('void', () => api(`/api/envelopes/${id}/void`, { method: 'POST', body: { reason } }), 'Envelope voided'); }}>Void</button>}
            {['voided', 'declined', 'expired'].includes(env.status) && <button className="danger small" disabled={!!busy} onClick={() => { if (confirm('Delete this envelope permanently?')) act('delete', async () => { await api(`/api/envelopes/${id}`, { method: 'DELETE' }); nav('/'); }); }}>Delete</button>}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Signers</h3>
        <ul className="timeline">
          {env.signers.map((s, i) => (
            <li key={s.id} style={{ flexWrap: 'wrap' }}>
              <span className={`dot ${s.status} ${s.your_turn ? 'turn' : ''}`} />
              <div style={{ flex: 1, minWidth: 200 }}>
                {editing === s.id ? (
                  <div className="row">
                    <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} placeholder="Name" style={{ width: 160 }} />
                    <input value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} placeholder="Email" style={{ width: 220 }} />
                    <button className="small" disabled={!!busy} onClick={() => act('edit', () => api(`/api/envelopes/${id}/signers/${s.id}`, { method: 'PATCH', body: editForm }).then((r) => { setEditing(null); return r; }), (r) => (r.emailed ? 'Signer updated and new link emailed' : 'Signer updated — share the new link'))}>Save</button>
                    <button className="ghost small" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <strong>{env.sequential && env.signers.length > 1 ? `${i + 1}. ` : ''}{s.name}</strong> <span className="muted">{s.email}</span>
                    <div className="muted small">
                      {s.status === 'signed' && `Signed ${fmtDate(s.signed_at)}${s.ip ? ` · IP ${s.ip}` : ''}`}
                      {s.status === 'declined' && `Declined ${fmtDate(s.declined_at)}${s.decline_reason ? ` · "${s.decline_reason}"` : ''}`}
                      {s.status === 'pending' && (s.your_turn ? `Waiting · ${s.viewed_at ? `opened ${fmtDate(s.viewed_at)}` : 'not opened yet'}${s.notified_at ? ` · emailed ${fmtDate(s.notified_at)}` : ''}${s.reminders_sent ? ` · ${s.reminders_sent} reminder${s.reminders_sent === 1 ? '' : 's'}` : ''}` : env.status === 'sent' ? 'Not their turn yet' : '—')}
                    </div>
                  </>
                )}
              </div>
              <span className={`pill ${s.status}`}>{s.status}</span>
              {env.status === 'sent' && s.status === 'pending' && editing !== s.id && (
                <span className="row" style={{ gap: 4 }}>
                  <button className="ghost small" title="Copy signing link" onClick={() => copyText(s.signing_url).then(() => toast('Signing link copied'))}>⧉ Link</button>
                  {s.your_turn && <button className="ghost small" disabled={!!busy} onClick={() => act('resend', () => api(`/api/envelopes/${id}/signers/${s.id}/resend`, { method: 'POST' }), (r) => (r.emailed ? 'Link re-sent' : 'Email not configured — link copied instead'))}>Resend</button>}
                  <button className="ghost small" onClick={() => { setEditing(s.id); setEditForm({ name: s.name, email: s.email }); }}>Edit</button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {env.attachments?.length > 0 && (
          <>
            <h4 style={{ marginBottom: 6 }}>Required documents</h4>
            <ul className="timeline">
              {env.attachments.map((a) => {
                const s = env.signers.find((x) => x.id === a.signer_id);
                return <li key={a.id}><span className={`dot ${a.uploaded ? 'signed' : ''}`} /><span>{a.label} <span className="muted">· {s?.name}</span></span>{a.uploaded ? <a style={{ marginLeft: 'auto' }} href={`/api/envelopes/${id}/attachments/${a.id}`}>⬇ {a.original_name || 'file'}</a> : <span className="muted" style={{ marginLeft: 'auto' }}>not uploaded yet</span>}</li>;
              })}
            </ul>
          </>
        )}
      </div>

      <div className="card">
        <div className="row spread"><h3 style={{ margin: 0 }}>Audit trail</h3><button className="ghost small" onClick={() => setShowAudit(!showAudit)}>{showAudit ? 'Hide' : `Show ${env.events.length} events`}</button></div>
        {showAudit && env.events.map((e, i) => (
          <div className="audit-item" key={i}>
            <strong>{e.type}</strong><span>{e.actor}</span>{e.ip && <span className="muted">{e.ip}</span>}
            <span className="when" title={`${e.created_at} UTC`}>{fmtDate(e.created_at)}</span>
            {e.detail && <div className="muted" style={{ width: '100%' }}>{e.detail}</div>}
          </div>
        ))}
      </div>
      <p className="muted"><Link to="/">← Back to documents</Link></p>
    </Layout>
  );
}
