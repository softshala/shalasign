import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, fmtDate, copyText } from '../api.js';

const TABS = [['connections', 'Connected accounts'], ['workspace', 'Workspace'], ['claude', 'Claude & MCP'], ['profile', 'Profile'], ['branding', 'Branding'], ['defaults', 'Sending defaults'], ['integrations', 'API & webhooks']];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'connections';
  const setTab = (t) => setParams({ tab: t });
  const toast = useToast();
  useEffect(() => {
    const err = params.get('error'); const ok = params.get('connected');
    if (err) toast(err, { bad: true, ms: 7000 });
    if (ok) toast(`${ok === 'google' ? 'Google' : 'Microsoft 365'} connected`);
    if (err || ok) setParams({ tab });
  }, []);
  return (
    <Layout subtitle="Account & integrations">
      <h2 style={{ margin: '0 0 12px' }}>Settings</h2>
      <div className="tabs">{TABS.map(([k, v]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{v}</button>)}</div>
      {tab === 'connections' && <Connections />}
      {tab === 'workspace' && <Workspace />}
      {tab === 'claude' && <ClaudeTab />}
      {['profile', 'branding', 'defaults', 'integrations'].includes(tab) && <Account tab={tab} />}
    </Layout>
  );
}

/* ------------------------------------------------------------------ */
/* Connected accounts: send from my inbox, archive to my drive          */
/* ------------------------------------------------------------------ */
function Connections() {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(null); // { connectionId }
  const toast = useToast();
  const load = () => api('/api/connections').then(setD).catch((e) => toast(e.message, { bad: true }));
  useEffect(() => { load(); }, []);
  if (!d) return <p className="muted">Loading…</p>;

  const ms = d.connections.find((c) => c.provider === 'microsoft');
  const gg = d.connections.find((c) => c.provider === 'google');
  const act = async (fn, msg) => { setBusy(true); try { await fn(); if (msg) toast(msg); await load(); } catch (e) { toast(e.message, { bad: true, ms: 6000 }); } finally { setBusy(false); } };
  const disconnect = (c) => { if (confirm(`Disconnect ${c.account_email}? Documents will fall back to the platform sender and no archive.`)) act(() => api(`/api/connections/${c.id}`, { method: 'DELETE' }), 'Disconnected'); };
  const testEmail = () => act(async () => { const r = await api('/api/org/test-email', { method: 'POST' }); if (!r.ok) throw new Error(r.error); toast(`Test email sent to you from ${r.account} via ${label(r.via)}${r.fallback_from ? ` (your ${label(r.fallback_from)} connection failed, platform sender used)` : ''}`, { ms: 7000 }); });
  const label = (v) => ({ microsoft: 'Microsoft 365', google: 'Google', platform: 'the SignFlow sender' }[v] || v);
  const sharedMail = d.org?.email_mode === 'shared';
  const sharedStorage = d.org?.storage_mode === 'shared';

  const Card = ({ provider, title, icon, conn, hint }) => (
    <div className="card">
      <div className="row spread">
        <h3 style={{ margin: 0 }}>{icon} {title}</h3>
        {conn && <span className="pill completed">Connected</span>}
      </div>
      {!d.providers[provider] && <p className="notice warn" style={{ marginTop: 10 }}>Not available on this server yet. The operator needs to register the platform's {title} app once (see README).</p>}
      {conn ? (
        <>
          <p style={{ margin: '10px 0 4px' }}><strong>{conn.account_name || conn.account_email}</strong> <span className="muted">{conn.account_email}</span></p>
          <p className="muted small" style={{ marginTop: 0 }}>
            {conn.can_mail ? '✓ Can send email' : '– Email not granted'} · {conn.can_storage ? `✓ Can save to ${provider === 'google' ? 'Google Drive' : 'OneDrive'}` : '– Drive not granted'}
            {conn.last_error && <span className="error"> · needs reconnecting: {conn.last_error}</span>}
          </p>
          <div className="row">
            {(!conn.can_mail || !conn.can_storage || conn.last_error) && <a className="btn small" href={`/api/connect/${provider}`}>Reconnect / grant more</a>}
            <button className="ghost small" disabled={busy} onClick={() => disconnect(conn)}>Disconnect</button>
          </div>
        </>
      ) : d.providers[provider] ? (
        <>
          <p className="muted" style={{ margin: '10px 0' }}>{hint}</p>
          <a className="btn" href={`/api/connect/${provider}`}>Connect {title}</a>
          {provider === 'google' && <div className="row" style={{ marginTop: 8 }}><a className="small" href={`/api/connect/google?use=storage`}>Connect Google Drive only</a><span className="muted small">·</span><a className="small" href={`/api/connect/google?use=mail`}>Connect Gmail only</a></div>}
        </>
      ) : null}
    </div>
  );

  return (
    <>
      <div className="card tight" style={{ background: '#eef5ff', borderColor: '#c9dafb' }}>
        <div className="grid-2">
          <div>
            <div className="muted small">Your signing emails are sent from</div>
            <strong>{d.effective.mail.via === 'none' ? 'nowhere yet' : d.effective.mail.account}</strong>
            <span className="muted"> {d.effective.mail.via === 'platform' ? '(SignFlow sender, replies go to you)' : d.effective.mail.via === 'none' ? '' : `via ${d.effective.mail.label}${d.effective.mail.reason === 'shared' ? ' · set by your workspace admin' : ''}`}</span>
            {d.effective.mail.via === 'none' && <div className="error small">Connect an inbox below so signers can receive their links.</div>}
          </div>
          <div>
            <div className="muted small">Completed documents are saved to</div>
            <strong>{d.effective.storage.via === 'none' ? 'SignFlow only' : `${d.effective.storage.label === 'Google' ? 'Google Drive' : 'OneDrive'} · ${d.effective.storage.root_path || 'root'}`}</strong>
            <span className="muted"> {d.effective.storage.via !== 'none' ? `(${d.effective.storage.account}${d.effective.storage.shared ? ', workspace drive set by your admin' : ''})` : ''}</span>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="secondary small" disabled={busy || d.effective.mail.via === 'none'} onClick={testEmail}>Send me a test email</button>
        </div>
      </div>

      <div className="grid-2">
        <Card provider="microsoft" title="Microsoft 365" icon="🟦" conn={ms} hint="Send signing requests from your Outlook inbox (they appear in your Sent Items) and save completed documents to your OneDrive." />
        <Card provider="google" title="Google" icon="🟩" conn={gg} hint="Send from your Gmail and save completed documents to your Google Drive." />
      </div>

      {(ms?.can_mail || gg?.can_mail) && !sharedMail && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Send my emails from</h3>
          <div className="stack">
            {[ms, gg].filter((c) => c?.can_mail).map((c) => (
              <label key={c.id} className="row" style={{ gap: 8 }}><input type="radio" name="mail" checked={(d.choices.mail_connection_id || d.effective.mail.account === c.account_email) && d.effective.mail.account === c.account_email} onChange={() => act(() => api('/api/connections/mail-choice', { method: 'PUT', body: { connection_id: c.id } }), 'Saved')} /> {c.account_email} <span className="muted small">({c.label})</span></label>
            ))}
            {d.effective.mail.via !== 'none' && <label className="row" style={{ gap: 8 }}><input type="radio" name="mail" checked={d.effective.mail.via === 'platform'} onChange={() => act(() => api('/api/connections/mail-choice', { method: 'PUT', body: { connection_id: null } }), 'Saved')} disabled={!d.connections.length} /> The SignFlow sender <span className="muted small">(replies still come to you)</span></label>}
          </div>
        </div>
      )}
      {sharedMail && <p className="notice">Your workspace admin has set everyone to send from a shared inbox ({d.effective.mail.account}). Your own connection is still used for your drive.</p>}

      {(ms?.can_storage || gg?.can_storage) && !sharedStorage && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Save completed documents to</h3>
          <p className="muted" style={{ marginTop: 0 }}>Pick a folder. Inside it, SignFlow creates a sub-folder per SignFlow folder (or "Unfiled") and names each file <code>date_time_signer.pdf</code>.</p>
          <div className="stack">
            {[ms, gg].filter((c) => c?.can_storage).map((c) => (
              <div key={c.id} className="row">
                <label className="row" style={{ gap: 8 }}><input type="radio" name="store" checked={d.choices.archive_connection_id === c.id} onChange={() => setPicker({ connectionId: c.id, provider: c.provider })} /> {c.provider === 'google' ? 'Google Drive' : 'OneDrive'} <span className="muted small">({c.account_email})</span></label>
                {d.choices.archive_connection_id === c.id && <span className="muted small">→ {d.choices.archive_root_path || 'root'} <button className="ghost small" onClick={() => setPicker({ connectionId: c.id, provider: c.provider })}>Change folder</button></span>}
              </div>
            ))}
            <label className="row" style={{ gap: 8 }}><input type="radio" name="store" checked={!d.choices.archive_connection_id} onChange={() => act(() => api('/api/connections/archive-target', { method: 'PUT', body: { connection_id: null } }), 'Saved')} /> Keep documents in SignFlow only</label>
          </div>
        </div>
      )}
      {sharedStorage && <p className="notice">Your workspace admin has set a shared drive for everyone's completed documents ({d.effective.storage.account} / {d.effective.storage.root_path || 'root'}).</p>}

      {picker && <FolderPicker connectionId={picker.connectionId} provider={picker.provider} listUrl={(id, parent) => `/api/connections/${id}/folders${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`}
        onCancel={() => setPicker(null)} onPick={(f) => act(() => api('/api/connections/archive-target', { method: 'PUT', body: { connection_id: picker.connectionId, root_id: f?.id || null, root_path: f?.path || f?.name || '' } }).then(() => setPicker(null)), 'Folder saved')} />}
    </>
  );
}

/** Browse / create folders in a connected drive. onPick(folder|null for root). */
export function FolderPicker({ connectionId, provider, listUrl, onPick, onCancel }) {
  const [stack, setStack] = useState([]); // breadcrumb of {id,name,path}
  const [items, setItems] = useState(null);
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  const parent = stack[stack.length - 1] || null;
  const pathOf = (f) => f.path || [...stack.map((s) => s.name), f.name].join('/');
  const load = () => { setItems(null); setErr(''); api(listUrl(connectionId, parent?.id)).then((r) => setItems(r.folders)).catch((e) => { setErr(e.message); setItems([]); }); };
  useEffect(() => { load(); }, [connectionId, parent?.id]);
  const create = async () => {
    if (!newName.trim()) return;
    try { const f = await api(`/api/connections/${connectionId}/folders`, { method: 'POST', body: { parent: parent?.id || null, name: newName.trim() } }); setNewName(''); setItems((it) => [...(it || []), f]); }
    catch (e) { setErr(e.message); }
  };
  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Choose a folder in {provider === 'google' ? 'Google Drive' : 'OneDrive'}</h3>
        <div className="row" style={{ fontSize: 13, marginBottom: 8, gap: 4 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); setStack([]); }}>{provider === 'google' ? 'My Drive' : 'OneDrive'}</a>
          {stack.map((s, i) => <span key={s.id}> / <a href="#" onClick={(e) => { e.preventDefault(); setStack(stack.slice(0, i + 1)); }}>{s.name}</a></span>)}
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 260, overflowY: 'auto' }}>
          {items === null && <p className="muted" style={{ padding: 12 }}>Loading…</p>}
          {items?.length === 0 && !err && <p className="muted" style={{ padding: 12 }}>No sub-folders here.</p>}
          {items?.map((f) => (
            <div key={f.id} className="row spread" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
              <a href="#" onClick={(e) => { e.preventDefault(); setStack([...stack, { id: f.id, name: f.name, path: pathOf(f) }]); }}>📁 {f.name}</a>
              <button className="secondary small" onClick={() => onPick({ id: f.id, name: f.name, path: pathOf(f) })}>Select</button>
            </div>
          ))}
        </div>
        {err && <p className="error">{err}</p>}
        <div className="row" style={{ marginTop: 10 }}>
          <input placeholder="New folder name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} style={{ flex: 1 }} />
          <button className="secondary small" onClick={create}>Create here</button>
        </div>
        <div className="row spread" style={{ marginTop: 14 }}>
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button onClick={() => onPick(parent ? { id: parent.id, name: parent.name, path: parent.path } : null)}>Use {parent ? `"${parent.name}"` : 'root'}</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Workspace: members, invites, shared vs individual sending/storage    */
/* ------------------------------------------------------------------ */
function Workspace() {
  const [org, setOrg] = useState(null);
  const [invite, setInvite] = useState({ email: '', role: 'member' });
  const [lastLink, setLastLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(null);
  const toast = useToast();
  const load = () => api('/api/org').then(setOrg).catch((e) => toast(e.message, { bad: true }));
  useEffect(() => { load(); }, []);
  if (!org) return <p className="muted">Loading…</p>;
  const act = async (fn, msg) => { setBusy(true); try { const r = await fn(); if (msg) toast(msg); await load(); return r; } catch (e) { toast(e.message, { bad: true, ms: 6000 }); } finally { setBusy(false); } };
  const save = (patch, msg = 'Saved') => act(() => api('/api/org', { method: 'PUT', body: patch }), msg);
  const sendInvite = async (e) => { e.preventDefault(); const r = await act(() => api('/api/org/invites', { method: 'POST', body: invite })); if (r) { setLastLink(r.link); toast(r.emailed ? `Invitation emailed to ${invite.email}` : 'Invitation created — email is not configured, share the link'); setInvite({ email: '', role: 'member' }); } };
  const mailConns = org.connections.filter((c) => c.can_mail);
  const storeConns = org.connections.filter((c) => c.can_storage);

  return (
    <>
      <div className="card">
        <div className="row spread">
          <div><h3 style={{ margin: 0 }}>{org.name}</h3><span className="muted small">{org.members.length} member{org.members.length === 1 ? '' : 's'} · you are {org.my_role}</span></div>
          {org.is_admin && <button className="secondary small" onClick={() => { const n = prompt('Workspace name:', org.name); if (n?.trim()) save({ name: n.trim() }); }}>Rename</button>}
        </div>
      </div>

      {org.is_admin && (
        <div className="grid-2">
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Who sends the emails?</h3>
            <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}><input type="radio" name="em" checked={org.email_mode === 'individual'} onChange={() => save({ email_mode: 'individual' })} /><span><strong>Each member from their own inbox</strong><br /><span className="muted small">Members connect Microsoft 365 or Google under Connected accounts. Anyone who hasn't gets the SignFlow sender.</span></span></label>
            <label className="row" style={{ gap: 8, alignItems: 'flex-start', marginTop: 10 }}><input type="radio" name="em" checked={org.email_mode === 'shared'} disabled={!mailConns.length} onChange={() => { if (mailConns.length === 1) save({ email_mode: 'shared', shared_mail_connection_id: mailConns[0].id }); }} /><span><strong>One shared inbox for the whole workspace</strong><br /><span className="muted small">e.g. contracts@yourcompany.com. Must be connected by a member first.</span></span></label>
            {(org.email_mode === 'shared' || mailConns.length > 1) && mailConns.length > 0 && (
              <select style={{ width: '100%', marginTop: 10 }} value={org.shared_mail_connection_id || ''} onChange={(e) => save({ email_mode: 'shared', shared_mail_connection_id: e.target.value })}>
                <option value="">— choose the shared inbox —</option>
                {mailConns.map((c) => <option key={c.id} value={c.id}>{c.account_email} ({c.label}, connected by {c.owner_name})</option>)}
              </select>
            )}
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Where are completed documents saved?</h3>
            <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}><input type="radio" name="st" checked={org.storage_mode === 'individual'} onChange={() => save({ storage_mode: 'individual' })} /><span><strong>Each member's own drive</strong><br /><span className="muted small">Members pick a folder in their OneDrive or Google Drive.</span></span></label>
            <label className="row" style={{ gap: 8, alignItems: 'flex-start', marginTop: 10 }}><input type="radio" name="st" checked={org.storage_mode === 'shared'} disabled={!storeConns.length} onChange={() => { if (storeConns.length) setPicker({ connectionId: org.shared_storage_connection_id || storeConns[0].id }); }} /><span><strong>One shared drive folder</strong><br /><span className="muted small">All members' documents land there, in a sub-folder per sender.</span></span></label>
            {org.storage_mode === 'shared' && org.shared_storage && <p className="muted small" style={{ marginTop: 8 }}>→ {org.shared_storage.provider === 'google' ? 'Google Drive' : 'OneDrive'} of {org.shared_storage.account_email} / {org.shared_storage_root_path || 'root'} <button className="ghost small" onClick={() => setPicker({ connectionId: org.shared_storage_connection_id })}>Change</button></p>}
            {storeConns.length > 1 && <select style={{ width: '100%', marginTop: 10 }} value={org.shared_storage_connection_id || ''} onChange={(e) => setPicker({ connectionId: e.target.value })}><option value="">— choose whose drive —</option>{storeConns.map((c) => <option key={c.id} value={c.id}>{c.account_email} ({c.label}, {c.owner_name})</option>)}</select>}
          </div>
        </div>
      )}

      {org.is_admin && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Who sees which documents?</h3>
          <label className="row" style={{ gap: 8 }}><input type="radio" name="vis" checked={org.visibility === 'own'} onChange={() => save({ visibility: 'own' })} /> Members see only their own documents (admins see everything)</label>
          <label className="row" style={{ gap: 8, marginTop: 8 }}><input type="radio" name="vis" checked={org.visibility === 'all'} onChange={() => save({ visibility: 'all' })} /> Everyone sees all workspace documents</label>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Members</h3>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th>{org.is_admin && <th></th>}</tr></thead>
          <tbody>
            {org.members.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td><td className="muted">{m.email}</td>
                <td>{org.is_admin && m.role !== 'owner' ? <select value={m.role} style={{ padding: '3px 8px', fontSize: 13 }} onChange={(e) => act(() => api(`/api/org/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated')}><option value="member">member</option><option value="admin">admin</option>{org.is_owner && <option value="owner">owner (transfer)</option>}</select> : <span className="pill draft">{m.role}</span>}</td>
                {org.is_admin && <td>{m.role !== 'owner' && <button className="ghost small" disabled={busy} onClick={() => { if (confirm(`Remove ${m.name} from the workspace? Their documents stay here.`)) act(() => api(`/api/org/members/${m.id}`, { method: 'DELETE' }), 'Member removed'); }}>Remove</button>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {org.is_admin && (
          <>
            <form onSubmit={sendInvite} className="row" style={{ marginTop: 14 }}>
              <input type="email" placeholder="colleague@company.com" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required style={{ flex: 1, minWidth: 200 }} />
              <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}><option value="member">Member</option><option value="admin">Admin</option></select>
              <button disabled={busy}>Invite</button>
            </form>
            {lastLink && <div className="copy-link" style={{ marginTop: 8 }}>{lastLink}<button className="secondary" onClick={() => copyText(lastLink).then(() => toast('Copied'))}>Copy</button></div>}
            {org.invites.length > 0 && (
              <>
                <h4 style={{ marginBottom: 6 }}>Pending invitations</h4>
                {org.invites.map((i) => <div key={i.id} className="row spread" style={{ fontSize: 13, padding: '4px 0' }}><span>{i.email} <span className="muted">· {i.role} · expires {fmtDate(i.expires_at, { time: false })}</span></span><button className="ghost small" onClick={() => act(() => api(`/api/org/invites/${i.id}`, { method: 'DELETE' }), 'Invitation cancelled')}>Cancel</button></div>)}
              </>
            )}
          </>
        )}
      </div>

      {picker && <FolderPicker connectionId={picker.connectionId} provider={org.connections.find((c) => c.id === picker.connectionId)?.provider} listUrl={(id, parent) => `/api/org/connections/${id}/folders${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`}
        onCancel={() => setPicker(null)} onPick={(f) => save({ storage_mode: 'shared', shared_storage_connection_id: picker.connectionId, shared_storage_root_id: f?.id || null, shared_storage_root_path: f?.path || f?.name || '' }, 'Shared folder saved').then(() => setPicker(null))} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Claude & MCP: connect Claude to SignFlow, in-app assistant status    */
/* ------------------------------------------------------------------ */
function ClaudeTab() {
  const [status, setStatus] = useState(null);
  const [grants, setGrants] = useState([]);
  const [newKey, setNewKey] = useState(null);
  const [akey, setAkey] = useState(''); const [wkey, setWkey] = useState(''); const [saving, setSaving] = useState('');
  const toast = useToast();
  const origin = window.location.origin;
  const mcpUrl = `${origin}/mcp`;
  const load = () => { api('/api/assistant/status').then(setStatus).catch(() => setStatus({ enabled: false, tools: [] })); api('/api/oauth/grants').then(setGrants).catch(() => {}); };
  const saveKey = async (scope) => {
    const key = scope === 'workspace' ? wkey : akey; setSaving(scope);
    try { await api(scope === 'workspace' ? '/api/assistant/workspace-key' : '/api/assistant/key', { method: 'PUT', body: { key: key.trim() } }); toast('Key verified and saved'); setAkey(''); setWkey(''); load(); }
    catch (e) { toast(e.message, { bad: true, ms: 7000 }); } finally { setSaving(''); }
  };
  const removeKey = async (scope) => { if (!confirm('Remove this key?')) return; await api(scope === 'workspace' ? '/api/assistant/workspace-key' : '/api/assistant/key', { method: 'DELETE' }); toast('Key removed'); load(); };
  useEffect(() => { load(); }, []);
  const createKey = async () => { try { const k = await api('/api/settings/api-keys', { method: 'POST', body: { name: 'Claude Desktop / Code' } }); setNewKey(k); load(); } catch (e) { toast(e.message, { bad: true }); } };
  const revoke = async (g) => { if (!confirm(`Disconnect ${g.name}?`)) return; await api(`/api/oauth/grants/${g.client_id}`, { method: 'DELETE' }); load(); toast('Disconnected'); };
  const desktopConfig = JSON.stringify({ mcpServers: { signflow: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--header', `Authorization: Bearer ${newKey?.key || 'sf_live_YOUR_KEY'}`] } } }, null, 2);
  return (
    <>
      <div className="card tight" style={{ background: '#eef5ff', borderColor: '#c9dafb' }}>
        <strong>Use SignFlow from Claude, or Claude from inside SignFlow.</strong>
        <div className="muted small" style={{ marginTop: 4 }}>SignFlow has a built-in MCP server. Claude can list your documents, send templates, upload and send PDFs, remind and void — as you, with everything in the audit trail. The in-app assistant (✨ Ask, bottom right) uses the same tools.</div>
      </div>
      <div className="grid-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Claude.ai / Claude for Work</h3>
          <ol style={{ paddingLeft: 20, fontSize: 14, marginTop: 0 }}>
            <li>In claude.ai open <em>Settings → Connectors → Add custom connector</em>.</li>
            <li>Paste this URL:<div className="copy-link" style={{ marginTop: 4 }}>{mcpUrl}<button className="secondary" onClick={() => copyText(mcpUrl).then(() => toast('Copied'))}>Copy</button></div></li>
            <li>Click Connect. You will be sent to SignFlow to log in and approve access, then back to Claude.</li>
          </ol>
          <h4 style={{ marginBottom: 6 }}>Connected apps</h4>
          {grants.length === 0 && <p className="muted small" style={{ marginTop: 0 }}>Nothing connected yet.</p>}
          {grants.map((g) => <div key={g.client_id} className="row spread" style={{ fontSize: 13, padding: '4px 0' }}><span>{g.name} <span className="muted">· last used {g.last_used ? fmtDate(g.last_used) : 'never'}</span></span><button className="ghost small" onClick={() => revoke(g)}>Disconnect</button></div>)}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Claude Desktop / Claude Code</h3>
          <p className="muted small" style={{ marginTop: 0 }}>These accept a token directly. Create an API key, then add the server:</p>
          {newKey ? <div className="notice ok">Key created — copy it now, it is shown once:<div className="copy-link" style={{ marginTop: 6 }}>{newKey.key}<button className="secondary" onClick={() => copyText(newKey.key).then(() => toast('Copied'))}>Copy</button></div></div> : <button className="secondary small" onClick={createKey}>+ Create API key for Claude</button>}
          <p className="small" style={{ marginBottom: 4 }}>Claude Code (terminal):</p>
          <div className="copy-link">{`claude mcp add --transport http signflow ${mcpUrl} --header "Authorization: Bearer ${newKey?.key || 'sf_live_YOUR_KEY'}"`}<button className="secondary" onClick={() => copyText(`claude mcp add --transport http signflow ${mcpUrl} --header "Authorization: Bearer ${newKey?.key || 'sf_live_YOUR_KEY'}"`).then(() => toast('Copied'))}>Copy</button></div>
          <p className="small" style={{ marginBottom: 4, marginTop: 10 }}>Claude Desktop (claude_desktop_config.json):</p>
          <pre className="copy-link" style={{ display: 'block', whiteSpace: 'pre-wrap', margin: 0 }}>{desktopConfig}</pre>
          <p className="muted small">Existing keys are managed under API &amp; webhooks.</p>
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>In-app assistant (✨ Ask)</h3>
        <p className="muted" style={{ marginTop: 0 }}>The assistant runs Claude ({status?.model}) on <strong>your own Anthropic account</strong>, so usage is billed to you, not to SignFlow. Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">console.anthropic.com → API keys</a> (a few cents per request is typical). Prefer not to? Use SignFlow from Claude via the connector above instead — your Claude subscription covers that.</p>
        {status?.enabled && <p className="notice ok">Active using {status.source === 'workspace' ? 'the workspace key' : status.source === 'user' ? 'your key' : 'the shared platform key'} {status.hint || ''}.</p>}
        <div className="grid-2">
          <div>
            <h4 style={{ margin: '0 0 6px' }}>Your key</h4>
            {status?.has_own_key
              ? <div className="row"><code>sk-ant-{status.own_hint}</code><button className="ghost small" onClick={() => removeKey('user')}>Remove</button></div>
              : <div className="row"><input type="password" placeholder="sk-ant-…" value={akey} onChange={(e) => setAkey(e.target.value)} style={{ flex: 1 }} autoComplete="off" /><button className="small" disabled={!akey.trim() || saving === 'user'} onClick={() => saveKey('user')}>{saving === 'user' ? 'Verifying…' : 'Save'}</button></div>}
            <div className="hint">Stored encrypted. Verified with Anthropic before saving. Never shown again.</div>
          </div>
          {status?.is_admin && (
            <div>
              <h4 style={{ margin: '0 0 6px' }}>Workspace key <span className="muted" style={{ fontWeight: 400 }}>(admins)</span></h4>
              {status?.workspace_key
                ? <div className="row"><code>sk-ant-{status.workspace_hint}</code><button className="ghost small" onClick={() => removeKey('workspace')}>Remove</button></div>
                : <div className="row"><input type="password" placeholder="sk-ant-…" value={wkey} onChange={(e) => setWkey(e.target.value)} style={{ flex: 1 }} autoComplete="off" /><button className="small" disabled={!wkey.trim() || saving === 'workspace'} onClick={() => saveKey('workspace')}>{saving === 'workspace' ? 'Verifying…' : 'Save'}</button></div>}
              <div className="hint">One key for every member of the workspace; it takes precedence over personal keys. Set a spend limit on it in the Anthropic console.</div>
            </div>
          )}
          {!status?.is_admin && status?.workspace_key && <div><h4 style={{ margin: '0 0 6px' }}>Workspace key</h4><p className="muted small">Your admin has set a workspace key, so you don't need your own.</p></div>}
        </div>
        {status?.enabled && <p className="muted small" style={{ marginTop: 10 }}>Tools: {status.tools.join(', ')}.</p>}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Account: profile, branding, defaults, API & webhooks                */
/* ------------------------------------------------------------------ */
function Account({ tab }) {
  const [s, setS] = useState(null);
  const [form, setForm] = useState({});
  const [pw, setPw] = useState({ current_password: '', new_password: '' });
  const [newKey, setNewKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const load = () => api('/api/settings').then((d) => {
    setS(d);
    setForm({ name: d.profile.name, company: d.branding.company, brand_color: d.branding.brand_color || '#2f6fed', logo_data: d.branding.logo_data, email_footer: d.branding.email_footer,
      expiry_days: d.defaults.expiry_days, reminder_days: d.defaults.reminder_days, notify_on_view: d.defaults.notify_on_view, webhook_url: d.webhook.url });
  }).catch((e) => toast(e.message, { bad: true }));
  useEffect(() => { load(); }, []);
  const save = async (fields) => { setBusy(true); try { const r = await api('/api/settings', { method: 'PUT', body: fields }); toast('Saved'); if (r.webhook_secret) alert(`New webhook secret (copy it now, it is shown once):\n\n${r.webhook_secret}`); load(); } catch (e) { toast(e.message, { bad: true }); } finally { setBusy(false); } };
  const changePassword = async (e) => { e.preventDefault(); setBusy(true); try { await api('/api/settings/password', { method: 'POST', body: pw }); toast('Password updated'); setPw({ current_password: '', new_password: '' }); load(); } catch (err) { toast(err.message, { bad: true }); } finally { setBusy(false); } };
  const onLogo = (file) => { if (!file) return; if (file.size > 300 * 1024) return toast('Logo must be under 300 KB', { bad: true }); const r = new FileReader(); r.onload = () => setForm({ ...form, logo_data: r.result }); r.readAsDataURL(file); };
  const createKey = async () => { const name = prompt('Name for this API key (e.g. "Zapier", "HR system"):', 'Integration'); if (name === null) return; try { const k = await api('/api/settings/api-keys', { method: 'POST', body: { name } }); setNewKey(k); load(); } catch (e) { toast(e.message, { bad: true }); } };
  const deleteKey = async (k) => { if (!confirm(`Revoke API key "${k.name}"? Anything using it will stop working.`)) return; try { await api(`/api/settings/api-keys/${k.id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, { bad: true }); } };
  const testHook = async () => { setBusy(true); try { const r = await api('/api/settings/webhook/test', { method: 'POST' }); toast(r.ok ? `Webhook responded ${r.status}` : `Webhook failed: ${r.error}`, { bad: !r.ok, ms: 5000 }); } catch (e) { toast(e.message, { bad: true }); } finally { setBusy(false); } };
  if (!s) return <p className="muted">Loading…</p>;
  const origin = window.location.origin;

  if (tab === 'profile') return (
    <div className="grid-2">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Your details</h3>
        <label className="field"><span>Name</span><input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Email</span><input value={s.profile.email} disabled /><div className="hint">Your email is your login and cannot be changed here.</div></label>
        <button disabled={busy} onClick={() => save({ name: form.name })}>Save</button>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>{s.profile.has_password ? 'Change password' : 'Set a password'}</h3>
        {!s.profile.has_password && <p className="notice">You currently sign in with Google, Microsoft or an emailed code. Setting a password adds a second way in.</p>}
        <form onSubmit={changePassword}>
          {s.profile.has_password && <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} required /></label>}
          <label className="field"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} required /></label>
          <button disabled={busy}>{s.profile.has_password ? 'Change password' : 'Set password'}</button>
        </form>
      </div>
    </div>
  );

  if (tab === 'branding') return (
    <div className="grid-2">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Branding</h3>
        <p className="muted" style={{ marginTop: 0 }}>Shown on every email and on the signing page your signers see.</p>
        <label className="field"><span>Company name</span><input value={form.company || ''} placeholder="e.g. Softshala Technologies" onChange={(e) => setForm({ ...form, company: e.target.value })} /></label>
        <label className="field"><span>Brand colour</span><span className="row"><input type="color" value={form.brand_color || '#2f6fed'} style={{ width: 48, padding: 2, height: 38 }} onChange={(e) => setForm({ ...form, brand_color: e.target.value })} /><input value={form.brand_color || ''} style={{ width: 120 }} onChange={(e) => setForm({ ...form, brand_color: e.target.value })} /></span></label>
        <label className="field"><span>Logo</span><input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => onLogo(e.target.files?.[0])} /><div className="hint">PNG or SVG with a transparent background, under 300 KB.</div></label>
        {form.logo_data && <div className="row" style={{ marginBottom: 12 }}><img src={form.logo_data} alt="Logo preview" style={{ maxHeight: 48, maxWidth: 220 }} /><button className="ghost small" onClick={() => setForm({ ...form, logo_data: '' })}>Remove</button></div>}
        <label className="field"><span>Email footer (optional)</span><textarea rows={2} value={form.email_footer || ''} placeholder="e.g. Softshala Technologies Pvt Ltd · Jaipur · CIN …" onChange={(e) => setForm({ ...form, email_footer: e.target.value })} /></label>
        <button disabled={busy} onClick={() => save({ company: form.company, brand_color: form.brand_color, logo_data: form.logo_data, email_footer: form.email_footer })}>Save branding</button>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Preview</h3>
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 20, fontFamily: 'Segoe UI, Arial, sans-serif' }}>
          <div style={{ marginBottom: 14 }}>{form.logo_data ? <img src={form.logo_data} alt="" style={{ maxHeight: 40, maxWidth: 200 }} /> : <strong style={{ color: form.brand_color || '#2f6fed', fontSize: 20 }}>✒ {form.company || 'SignFlow'}</strong>}</div>
          <p style={{ margin: '0 0 8px' }}>Hi Asha,</p>
          <p style={{ margin: '0 0 14px' }}>{s.profile.name}{form.company ? ` (${form.company})` : ''} has asked you to review and sign <strong>Offer Letter</strong>.</p>
          <span style={{ background: form.brand_color || '#2f6fed', color: '#fff', padding: '10px 18px', borderRadius: 8, fontWeight: 600, display: 'inline-block' }}>Review &amp; sign document</span>
          <p className="muted" style={{ marginTop: 14 }}>{form.email_footer || `Sent via SignFlow${form.company ? ` on behalf of ${form.company}` : ''}.`}</p>
        </div>
      </div>
    </div>
  );

  if (tab === 'defaults') return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h3 style={{ marginTop: 0 }}>Sending defaults</h3>
      <p className="muted" style={{ marginTop: 0 }}>Pre-filled for every new document. You can still change them per document.</p>
      <label className="field"><span>Signing deadline (days)</span><input type="number" min={0} max={365} value={form.expiry_days ?? 30} onChange={(e) => setForm({ ...form, expiry_days: e.target.value })} /><div className="hint">0 = no deadline. After the deadline, links stop working and you are notified.</div></label>
      <label className="field"><span>Automatic reminder every (days)</span><input type="number" min={0} max={30} value={form.reminder_days ?? 3} onChange={(e) => setForm({ ...form, reminder_days: e.target.value })} /><div className="hint">0 = no automatic reminders. Reminders go only to the signer whose turn it is, up to 10 times.</div></label>
      <label className="row" style={{ marginBottom: 14, gap: 8 }}><input type="checkbox" checked={!!form.notify_on_view} onChange={(e) => setForm({ ...form, notify_on_view: e.target.checked })} /> Email me when a signer opens a document for the first time</label>
      <button disabled={busy} onClick={() => save({ expiry_days: form.expiry_days, reminder_days: form.reminder_days, notify_on_view: form.notify_on_view })}>Save defaults</button>
    </div>
  );

  return (
    <div className="grid-2">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>API keys</h3>
        <p className="muted" style={{ marginTop: 0 }}>Let other systems create and track envelopes. Send the key as <code>Authorization: Bearer sf_live_…</code> to the same <code>/api/envelopes</code> endpoints this app uses. See the README for the API reference.</p>
        {newKey && <div className="notice ok"><strong>New key “{newKey.name}”</strong> — copy it now, it will not be shown again:<div className="copy-link" style={{ marginTop: 6 }}>{newKey.key}<button className="secondary" onClick={() => copyText(newKey.key).then(() => toast('Copied'))}>Copy</button></div></div>}
        <table>
          <thead><tr><th>Name</th><th>Key</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            {s.api_keys.map((k) => <tr key={k.id}><td>{k.name}</td><td><code>{k.prefix}…</code></td><td className="muted">{k.last_used_at ? fmtDate(k.last_used_at) : 'never'}</td><td><button className="ghost small" onClick={() => deleteKey(k)}>Revoke</button></td></tr>)}
            {s.api_keys.length === 0 && <tr><td colSpan="4" className="muted">No API keys yet.</td></tr>}
          </tbody>
        </table>
        <button className="secondary" style={{ marginTop: 12 }} onClick={createKey}>+ Create API key</button>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Webhook</h3>
        <p className="muted" style={{ marginTop: 0 }}>We POST a JSON event to this URL when an envelope is sent, completed, declined, voided or expires. Each request is signed with HMAC-SHA256 in the <code>X-SignFlow-Signature</code> header.</p>
        <label className="field"><span>Endpoint URL</span><input value={form.webhook_url || ''} placeholder="https://example.com/signflow-webhook" onChange={(e) => setForm({ ...form, webhook_url: e.target.value })} /></label>
        <div className="row" style={{ marginBottom: 12 }}>
          <button disabled={busy} onClick={() => save({ webhook_url: form.webhook_url })}>Save</button>
          <button className="secondary" disabled={busy || !s.webhook.url} onClick={testHook}>Send test event</button>
          <button className="secondary" disabled={busy} onClick={() => save({ regenerate_webhook_secret: true })}>{s.webhook.has_secret ? 'Rotate secret' : 'Generate secret'}</button>
        </div>
        <div className="hint">Secret: {s.webhook.has_secret ? 'configured' : 'none (requests are unsigned)'}. Download URLs look like <code>{origin}/api/envelopes/&lt;id&gt;/download</code> and need an API key.</div>
      </div>
    </div>
  );
}
