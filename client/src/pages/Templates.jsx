import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, fmtDate } from '../api.js';

export default function Templates() {
  const [templates, setTemplates] = useState(null);
  const [busy, setBusy] = useState('');
  const nav = useNavigate();
  const toast = useToast();

  const load = () => api('/api/templates').then(setTemplates).catch((e) => toast(e.message, { bad: true }));
  useEffect(() => { load(); }, []);

  const use = async (t) => {
    const title = prompt('Document title for this new envelope:', t.name);
    if (title === null) return;
    setBusy(t.id);
    try { const d = await api(`/api/templates/${t.id}/use`, { method: 'POST', body: { title: title.trim() || t.name } }); nav(`/prepare/${d.id}`); }
    catch (e) { toast(e.message, { bad: true }); setBusy(''); }
  };
  const rename = async (t) => {
    const name = prompt('Template name:', t.name);
    if (!name?.trim() || name.trim() === t.name) return;
    try { await api(`/api/templates/${t.id}`, { method: 'PATCH', body: { name: name.trim() } }); load(); } catch (e) { toast(e.message, { bad: true }); }
  };
  const remove = async (t) => {
    if (!confirm(`Delete template "${t.name}"? Documents already sent from it are not affected.`)) return;
    try { await api(`/api/templates/${t.id}`, { method: 'DELETE' }); toast('Template deleted'); load(); } catch (e) { toast(e.message, { bad: true }); }
  };

  return (
    <Layout subtitle="Reusable documents">
      <div className="card row spread">
        <div>
          <h2 style={{ margin: '0 0 4px' }}>Templates</h2>
          <span className="muted">Save a prepared document once, then send it again in seconds. To create one, open any draft and click <strong>Save as template</strong>.</span>
        </div>
        <button className="secondary" onClick={() => nav('/')}>+ New document</button>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Template</th><th>Signer roles</th><th>Fields</th><th className="hide-mobile">Defaults</th><th className="hide-mobile">Used</th><th></th></tr></thead>
            <tbody>
              {(templates || []).map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong><div className="muted small">Created {fmtDate(t.created_at, { time: false })}</div></td>
                  <td>{t.roles.map((r) => r.name).join(', ')}</td>
                  <td>{t.fields.length}</td>
                  <td className="muted hide-mobile">
                    {t.options.expiry_days ? `Expires in ${t.options.expiry_days}d` : 'No deadline'}{t.options.reminder_days ? ` · remind every ${t.options.reminder_days}d` : ''}{t.options.access_code ? ' · access code' : ''}
                  </td>
                  <td className="muted hide-mobile">{t.use_count}×</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="small" disabled={busy === t.id} onClick={() => use(t)}>{busy === t.id ? 'Creating…' : 'Use template'}</button>
                    <button className="ghost small" onClick={() => rename(t)}>Rename</button>
                    <button className="ghost small" onClick={() => remove(t)}>Delete</button>
                  </td>
                </tr>
              ))}
              {templates && templates.length === 0 && (
                <tr><td colSpan="6"><div className="empty"><div style={{ fontSize: 34 }}>📋</div><h3>No templates yet</h3><p>Prepare a document, then click “Save as template” in the options panel.</p></div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
