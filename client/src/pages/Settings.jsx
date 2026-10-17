import { useEffect, useState } from 'react';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, fmtDate, copyText } from '../api.js';

export default function Settings() {
  const [s, setS] = useState(null);
  const [tab, setTab] = useState('profile');
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

  const save = async (fields) => {
    setBusy(true);
    try { const r = await api('/api/settings', { method: 'PUT', body: fields }); toast('Saved'); if (r.webhook_secret) alert(`New webhook secret (copy it now, it is shown once):\n\n${r.webhook_secret}`); load(); }
    catch (e) { toast(e.message, { bad: true }); }
    finally { setBusy(false); }
  };
  const changePassword = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await api('/api/settings/password', { method: 'POST', body: pw }); toast('Password updated'); setPw({ current_password: '', new_password: '' }); load(); }
    catch (err) { toast(err.message, { bad: true }); }
    finally { setBusy(false); }
  };
  const onLogo = (file) => {
    if (!file) return;
    if (file.size > 300 * 1024) return toast('Logo must be under 300 KB', { bad: true });
    const r = new FileReader(); r.onload = () => setForm({ ...form, logo_data: r.result }); r.readAsDataURL(file);
  };
  const createKey = async () => {
    const name = prompt('Name for this API key (e.g. "Zapier", "HR system"):', 'Integration');
    if (name === null) return;
    try { const k = await api('/api/settings/api-keys', { method: 'POST', body: { name } }); setNewKey(k); load(); } catch (e) { toast(e.message, { bad: true }); }
  };
  const deleteKey = async (k) => {
    if (!confirm(`Revoke API key "${k.name}"? Anything using it will stop working.`)) return;
    try { await api(`/api/settings/api-keys/${k.id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, { bad: true }); }
  };
  const testHook = async () => {
    setBusy(true);
    try { const r = await api('/api/settings/webhook/test', { method: 'POST' }); toast(r.ok ? `Webhook responded ${r.status}` : `Webhook failed: ${r.error}`, { bad: !r.ok, ms: 5000 }); }
    catch (e) { toast(e.message, { bad: true }); }
    finally { setBusy(false); }
  };

  if (!s) return <Layout><p className="muted">Loading…</p></Layout>;
  const origin = window.location.origin;

  return (
    <Layout subtitle="Account & integrations">
      <h2 style={{ margin: '0 0 12px' }}>Settings</h2>
      <div className="tabs">
        {[['profile', 'Profile'], ['branding', 'Branding'], ['defaults', 'Sending defaults'], ['integrations', 'API & webhooks']].map(([k, v]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{v}</button>
        ))}
      </div>

      {tab === 'profile' && (
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
      )}

      {tab === 'branding' && (
        <div className="grid-2">
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Branding</h3>
            <p className="muted" style={{ marginTop: 0 }}>Shown on every email and on the signing page your signers see.</p>
            <label className="field"><span>Company name</span><input value={form.company || ''} placeholder="e.g. Softshala Technologies" onChange={(e) => setForm({ ...form, company: e.target.value })} /></label>
            <label className="field"><span>Brand colour</span>
              <span className="row"><input type="color" value={form.brand_color || '#2f6fed'} style={{ width: 48, padding: 2, height: 38 }} onChange={(e) => setForm({ ...form, brand_color: e.target.value })} /><input value={form.brand_color || ''} style={{ width: 120 }} onChange={(e) => setForm({ ...form, brand_color: e.target.value })} /></span>
            </label>
            <label className="field"><span>Logo</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => onLogo(e.target.files?.[0])} />
              <div className="hint">PNG or SVG with a transparent background, under 300 KB.</div>
            </label>
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
      )}

      {tab === 'defaults' && (
        <div className="card" style={{ maxWidth: 560 }}>
          <h3 style={{ marginTop: 0 }}>Sending defaults</h3>
          <p className="muted" style={{ marginTop: 0 }}>Pre-filled for every new document. You can still change them per document.</p>
          <label className="field"><span>Signing deadline (days)</span><input type="number" min={0} max={365} value={form.expiry_days ?? 30} onChange={(e) => setForm({ ...form, expiry_days: e.target.value })} /><div className="hint">0 = no deadline. After the deadline, links stop working and you are notified.</div></label>
          <label className="field"><span>Automatic reminder every (days)</span><input type="number" min={0} max={30} value={form.reminder_days ?? 3} onChange={(e) => setForm({ ...form, reminder_days: e.target.value })} /><div className="hint">0 = no automatic reminders. Reminders go only to the signer whose turn it is, up to 10 times.</div></label>
          <label className="row" style={{ marginBottom: 14, gap: 8 }}><input type="checkbox" checked={!!form.notify_on_view} onChange={(e) => setForm({ ...form, notify_on_view: e.target.checked })} /> Email me when a signer opens a document for the first time</label>
          <button disabled={busy} onClick={() => save({ expiry_days: form.expiry_days, reminder_days: form.reminder_days, notify_on_view: form.notify_on_view })}>Save defaults</button>
        </div>
      )}

      {tab === 'integrations' && (
        <div className="grid-2">
          <div className="card">
            <h3 style={{ marginTop: 0 }}>API keys</h3>
            <p className="muted" style={{ marginTop: 0 }}>Let other systems create and track envelopes. Send the key as <code>Authorization: Bearer sf_live_…</code> to the same <code>/api/envelopes</code> endpoints this app uses. See the README for the API reference.</p>
            {newKey && (
              <div className="notice ok">
                <strong>New key “{newKey.name}”</strong> — copy it now, it will not be shown again:
                <div className="copy-link" style={{ marginTop: 6 }}>{newKey.key}<button className="secondary" onClick={() => copyText(newKey.key).then(() => toast('Copied'))}>Copy</button></div>
              </div>
            )}
            <table>
              <thead><tr><th>Name</th><th>Key</th><th>Last used</th><th></th></tr></thead>
              <tbody>
                {s.api_keys.map((k) => (
                  <tr key={k.id}><td>{k.name}</td><td><code>{k.prefix}…</code></td><td className="muted">{k.last_used_at ? fmtDate(k.last_used_at) : 'never'}</td><td><button className="ghost small" onClick={() => deleteKey(k)}>Revoke</button></td></tr>
                ))}
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
            <div className="hint">Secret: {s.webhook.has_secret ? 'configured' : 'none (requests are unsigned)'}. Your envelope download URLs look like <code>{origin}/api/envelopes/&lt;id&gt;/download</code> and need an API key.</div>
          </div>
        </div>
      )}
    </Layout>
  );
}
