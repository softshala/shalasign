import { useState } from 'react';
import { api, copyText } from '../api.js';
import { useToast } from './Toast.jsx';

const MASK = '••••••••';

/** Shared building blocks for the first-run wizard and the operator console. */

export function EmailForm({ data, onSaved, compact = false }) {
  const toast = useToast();
  const v = data.values;
  const [form, setForm] = useState({ preset: guessPreset(v.smtp_host), smtp_host: v.smtp_host || '', smtp_port: v.smtp_port || '587', smtp_user: v.smtp_user || '', smtp_pass: v.smtp_pass_set ? MASK : '', from_email: v.from_email || '' });
  const [busy, setBusy] = useState('');
  const preset = data.presets[form.preset] || data.presets.custom;
  const pick = (p) => setForm({ ...form, preset: p, smtp_host: data.presets[p].smtp_host || (p === 'custom' ? form.smtp_host : ''), smtp_port: data.presets[p].smtp_port });
  const save = async (thenTest) => {
    setBusy(thenTest ? 'test' : 'save');
    try {
      await api('/api/platform', { method: 'PUT', body: { smtp_host: form.smtp_host, smtp_port: form.smtp_port, smtp_user: form.smtp_user, smtp_pass: form.smtp_pass, from_email: form.from_email || form.smtp_user } });
      if (thenTest) { const r = await api('/api/platform/test-email', { method: 'POST', body: {} }); if (!r.ok) throw new Error(r.error); toast('Test email sent to you — check your inbox', { ms: 6000 }); }
      else toast('Email settings saved');
      onSaved?.();
    } catch (e) { toast(e.message, { bad: true, ms: 8000 }); }
    finally { setBusy(''); }
  };
  return (
    <div>
      {!compact && <p className="muted" style={{ marginTop: 0 }}>The platform sender delivers login codes, password resets and documents for users who have not connected their own inbox. Any mailbox or transactional service works.</p>}
      <div className="row" style={{ marginBottom: 10 }}>
        {Object.keys(data.presets).map((p) => <button key={p} type="button" className={`folder-chip ${form.preset === p ? 'active' : ''}`} onClick={() => pick(p)}>{{ gmail: 'Gmail', microsoft365: 'Microsoft 365', brevo: 'Brevo (free)', resend: 'Resend', custom: 'Other SMTP' }[p]}</button>)}
      </div>
      {preset.note && <p className="notice" style={{ fontSize: 13 }}>{preset.note}</p>}
      <div className="grid-2" style={{ gap: 10 }}>
        <label className="field"><span>SMTP host</span><input value={form.smtp_host} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} placeholder="smtp.example.com" /></label>
        <label className="field"><span>Port</span><input value={form.smtp_port} onChange={(e) => setForm({ ...form, smtp_port: e.target.value })} placeholder="587" /></label>
        <label className="field"><span>Username</span><input value={form.smtp_user} onChange={(e) => setForm({ ...form, smtp_user: e.target.value })} placeholder="mailbox or login" autoComplete="off" /></label>
        <label className="field"><span>Password / API key</span><input type="password" value={form.smtp_pass} onChange={(e) => setForm({ ...form, smtp_pass: e.target.value })} onFocus={() => form.smtp_pass === MASK && setForm({ ...form, smtp_pass: '' })} autoComplete="new-password" /></label>
      </div>
      <label className="field"><span>From address</span><input value={form.from_email} onChange={(e) => setForm({ ...form, from_email: e.target.value })} placeholder={`${data.values.platform_name || 'SignFlow'} <noreply@yourcompany.com>`} /><div className="hint">Shown as the sender. Most providers require it to be a verified address or domain.</div></label>
      <div className="row">
        <button disabled={!!busy || !form.smtp_host || !form.smtp_user || !form.smtp_pass} onClick={() => save(false)}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button className="secondary" disabled={!!busy || !form.smtp_host || !form.smtp_user || !form.smtp_pass} onClick={() => save(true)}>{busy === 'test' ? 'Sending…' : 'Save & send me a test email'}</button>
        {data.status.email && <span className="pill completed">Configured</span>}
      </div>
    </div>
  );
}
function guessPreset(host) { if (!host) return 'microsoft365'; if (/gmail/.test(host)) return 'gmail'; if (/office365|outlook/.test(host)) return 'microsoft365'; if (/brevo|sendinblue/.test(host)) return 'brevo'; if (/resend/.test(host)) return 'resend'; return 'custom'; }

export function ProvidersForm({ data, onSaved }) {
  const toast = useToast();
  const v = data.values;
  const [g, setG] = useState({ id: v.google_client_id || '', secret: v.google_client_secret_set ? MASK : '' });
  const [m, setM] = useState({ id: v.ms_client_id || '', secret: v.ms_client_secret_set ? MASK : '', tenant: v.ms_tenant || 'common' });
  const [busy, setBusy] = useState('');
  const save = async (which) => {
    setBusy(which);
    try {
      if (which === 'google') await api('/api/platform', { method: 'PUT', body: { google_client_id: g.id, google_client_secret: g.secret } });
      else { await api('/api/platform', { method: 'PUT', body: { ms_client_id: m.id, ms_client_secret: m.secret, ms_tenant: m.tenant } }); const r = await api('/api/platform/test-provider/microsoft', { method: 'POST' }); toast(r.ok ? `Saved. ${r.note}` : `Saved, but: ${r.error}`, { bad: !r.ok, ms: 9000 }); }
      if (which === 'google') toast('Google saved. Try "Continue with Google" on the login page to verify.');
      onSaved?.();
    } catch (e) { toast(e.message, { bad: true, ms: 8000 }); }
    finally { setBusy(''); }
  };
  const Uris = ({ list }) => <div className="stack" style={{ gap: 4, margin: '6px 0 10px' }}>{list.map((u) => <div key={u} className="copy-link">{u}<button className="secondary" onClick={() => copyText(u).then(() => toast('Copied'))}>Copy</button></div>)}</div>;
  return (
    <div className="grid-2">
      <div>
        <h4 style={{ margin: '0 0 4px' }}>🟦 Microsoft {data.status.microsoft && <span className="pill completed">Configured</span>}</h4>
        <p className="muted small" style={{ marginTop: 0 }}>Enables "Continue with Microsoft" and lets users connect Outlook + OneDrive. In <a href="https://entra.microsoft.com" target="_blank" rel="noopener noreferrer">entra.microsoft.com</a> → App registrations → New registration: account types <em>Any organizational directory and personal accounts</em>, platform Web, these redirect URIs:</p>
        <Uris list={data.redirect_uris.microsoft} />
        <label className="field"><span>Application (client) ID</span><input value={m.id} onChange={(e) => setM({ ...m, id: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" /></label>
        <label className="field"><span>Client secret (Value)</span><input type="password" value={m.secret} onChange={(e) => setM({ ...m, secret: e.target.value })} onFocus={() => m.secret === MASK && setM({ ...m, secret: '' })} autoComplete="new-password" /></label>
        <label className="field"><span>Tenant</span><input value={m.tenant} onChange={(e) => setM({ ...m, tenant: e.target.value })} placeholder="common" /><div className="hint"><code>common</code> = any Microsoft account (public product). Your Directory (tenant) ID = your company only.</div></label>
        <button disabled={busy === 'microsoft' || !m.id || !m.secret} onClick={() => save('microsoft')}>{busy === 'microsoft' ? 'Verifying…' : 'Save & verify'}</button>
      </div>
      <div>
        <h4 style={{ margin: '0 0 4px' }}>🟩 Google {data.status.google && <span className="pill completed">Configured</span>}</h4>
        <p className="muted small" style={{ marginTop: 0 }}>Enables "Continue with Google" and Gmail + Google Drive connections. In <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud console</a> → Credentials → OAuth client ID (Web). Enable the Gmail and Drive APIs. Redirect URIs:</p>
        <Uris list={data.redirect_uris.google} />
        <label className="field"><span>Client ID</span><input value={g.id} onChange={(e) => setG({ ...g, id: e.target.value })} placeholder="….apps.googleusercontent.com" /></label>
        <label className="field"><span>Client secret</span><input type="password" value={g.secret} onChange={(e) => setG({ ...g, secret: e.target.value })} onFocus={() => g.secret === MASK && setG({ ...g, secret: '' })} autoComplete="new-password" /></label>
        <button disabled={busy === 'google' || !g.id || !g.secret} onClick={() => save('google')}>{busy === 'google' ? 'Saving…' : 'Save'}</button>
        <div className="hint" style={{ marginTop: 8 }}>Gmail sending is a Google "restricted" scope: public release needs Google's verification. Until then Google users' mail goes through the platform sender.</div>
      </div>
    </div>
  );
}

export function GeneralForm({ data, onSaved }) {
  const toast = useToast();
  const v = data.values;
  const [form, setForm] = useState({ platform_name: v.platform_name || '', public_url: v.public_url || '', trust_proxy: v.trust_proxy || 'auto', archive_timezone: v.archive_timezone || 'Asia/Kolkata' });
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await api('/api/platform', { method: 'PUT', body: form }); toast('Saved'); onSaved?.(); } catch (e) { toast(e.message, { bad: true }); } finally { setBusy(false); } };
  return (
    <div>
      <label className="field"><span>Platform name</span><input value={form.platform_name} onChange={(e) => setForm({ ...form, platform_name: e.target.value })} placeholder="SignFlow" /><div className="hint">Shown in emails and on the login page.</div></label>
      <label className="field"><span>Public URL</span><input value={form.public_url} onChange={(e) => setForm({ ...form, public_url: e.target.value })} placeholder={data.status.public_url} /><div className="hint">Detected automatically as <code>{data.status.public_url}</code> ({data.status.url_source}). Set it only if that is wrong, e.g. behind a custom domain. Used in emails and OAuth redirects.</div></label>
      <div className="grid-2" style={{ gap: 10 }}>
        <label className="field"><span>Reverse proxy</span><select value={form.trust_proxy} onChange={(e) => setForm({ ...form, trust_proxy: e.target.value })}><option value="auto">Auto-detect (recommended)</option><option value="on">Always behind a proxy</option><option value="off">Never</option></select><div className="hint">Affects how client IPs in the audit trail and HTTPS are detected.</div></label>
        <label className="field"><span>Time zone for archive file names</span><input value={form.archive_timezone} onChange={(e) => setForm({ ...form, archive_timezone: e.target.value })} placeholder="Asia/Kolkata" /></label>
      </div>
      <button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
    </div>
  );
}

export function AccessForm({ data, onSaved }) {
  const toast = useToast();
  const v = data.values;
  const [form, setForm] = useState({ signup_mode: v.signup_mode || 'open', sso_allowed_domains: v.sso_allowed_domains || '' });
  const [opEmail, setOpEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await api('/api/platform', { method: 'PUT', body: form }); toast('Saved'); onSaved?.(); } catch (e) { toast(e.message, { bad: true }); } finally { setBusy(false); } };
  const addOp = async () => { try { await api('/api/platform/operators', { method: 'POST', body: { email: opEmail } }); setOpEmail(''); toast('Operator added'); onSaved?.(); } catch (e) { toast(e.message, { bad: true }); } };
  const removeOp = async (o) => { if (!confirm(`Remove ${o.email} as operator?`)) return; try { await api(`/api/platform/operators/${o.id}`, { method: 'DELETE' }); onSaved?.(); } catch (e) { toast(e.message, { bad: true }); } };
  return (
    <div className="grid-2">
      <div>
        <h4 style={{ margin: '0 0 6px' }}>Who can sign up</h4>
        <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}><input type="radio" checked={form.signup_mode === 'open'} onChange={() => setForm({ ...form, signup_mode: 'open' })} /><span><strong>Anyone</strong> <span className="muted small">(public product)</span></span></label>
        <label className="row" style={{ gap: 8, alignItems: 'flex-start', marginTop: 8 }}><input type="radio" checked={form.signup_mode === 'invite_only'} onChange={() => setForm({ ...form, signup_mode: 'invite_only' })} /><span><strong>Invitation only</strong> <span className="muted small">(workspace admins invite people)</span></span></label>
        <label className="field" style={{ marginTop: 12 }}><span>Allowed email domains (optional)</span><input value={form.sso_allowed_domains} onChange={(e) => setForm({ ...form, sso_allowed_domains: e.target.value })} placeholder="softshala.com, partner.in" /><div className="hint">Comma-separated. Leave empty for any domain.</div></label>
        <button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      <div>
        <h4 style={{ margin: '0 0 6px' }}>Platform operators</h4>
        <p className="muted small" style={{ marginTop: 0 }}>Operators see this console. Everyone else only sees their workspace.</p>
        {data.operators.map((o) => <div key={o.id} className="row spread" style={{ fontSize: 13, padding: '4px 0' }}><span>{o.name} <span className="muted">{o.email}</span></span>{data.operators.length > 1 && <button className="ghost small" onClick={() => removeOp(o)}>Remove</button>}</div>)}
        <div className="row" style={{ marginTop: 8 }}><input type="email" placeholder="existing user's email" value={opEmail} onChange={(e) => setOpEmail(e.target.value)} style={{ flex: 1 }} /><button className="secondary small" onClick={addOp} disabled={!opEmail}>Add</button></div>
      </div>
    </div>
  );
}

export function AssistantPlatformForm({ data, onSaved }) {
  const toast = useToast();
  const v = data.values;
  const [form, setForm] = useState({ assistant_shared: !!v.assistant_shared, assistant_shared_key: v.assistant_shared_key_set ? MASK : '', assistant_model: v.assistant_model || 'claude-opus-5-5' });
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await api('/api/platform', { method: 'PUT', body: form }); toast('Saved'); onSaved?.(); } catch (e) { toast(e.message, { bad: true }); } finally { setBusy(false); } };
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>By default every user (or workspace) brings their own Anthropic key, so you never pay for their usage. Tick the box only if you want to offer the assistant on your account, for example as part of a paid plan.</p>
      <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={form.assistant_shared} onChange={(e) => setForm({ ...form, assistant_shared: e.target.checked })} /> Pay for all users with a shared platform key</label>
      {form.assistant_shared && <label className="field" style={{ marginTop: 10 }}><span>Platform Anthropic API key</span><input type="password" value={form.assistant_shared_key} onChange={(e) => setForm({ ...form, assistant_shared_key: e.target.value })} onFocus={() => form.assistant_shared_key === MASK && setForm({ ...form, assistant_shared_key: '' })} placeholder="sk-ant-…" autoComplete="new-password" /><div className="hint">Set a monthly spend limit on this key in the Anthropic console.</div></label>}
      <label className="field" style={{ marginTop: 10 }}><span>Model</span><input value={form.assistant_model} onChange={(e) => setForm({ ...form, assistant_model: e.target.value })} /></label>
      <button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
    </div>
  );
}
