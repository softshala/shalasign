import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, fmtDate } from '../api.js';
import { EmailForm, ProvidersForm, GeneralForm, AccessForm, AssistantPlatformForm } from '../components/PlatformForms.jsx';

const TABS = [['status', 'Setup status'], ['email', 'Email'], ['providers', 'Sign-in & connectors'], ['access', 'Access & operators'], ['assistant', 'Assistant'], ['general', 'General']];

/** /admin — operator console. Replaces every environment variable that used to be needed. */
export default function Admin() {
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'status';
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const load = () => { api('/api/platform').then(setData).catch((e) => { if (e.status === 403) nav('/'); else toast(e.message, { bad: true }); }); api('/api/health').then(setHealth).catch(() => {}); };
  useEffect(() => { load(); }, []);
  if (!data) return <Layout><p className="muted">Loading…</p></Layout>;
  const s = data.status;
  const Row = ({ ok, warn, label, detail, fix }) => (
    <div className="row spread" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span><span style={{ marginRight: 8 }}>{ok ? '✅' : warn ? '⚠️' : '❌'}</span><strong>{label}</strong> <span className="muted">{detail}</span></span>
      {!ok && fix && <button className="secondary small" onClick={() => setParams({ tab: fix })}>Fix</button>}
    </div>
  );
  return (
    <Layout subtitle="Operator console">
      <div className="row spread"><h2 style={{ margin: '0 0 12px' }}>Admin</h2><span className="muted small">Visible only to platform operators</span></div>
      <div className="tabs">{TABS.map(([k, v]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setParams({ tab: k })}>{v}</button>)}</div>

      {tab === 'status' && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Is this installation ready?</h3>
          <Row ok={health ? health.storage_is_persistent_disk : true} label="Persistent storage" detail={health ? (health.storage_is_persistent_disk ? 'documents survive restarts' : 'NOT persistent — attach a disk on the host and set STORAGE_DIR') : ''} />
          <Row ok={health?.encryption_key_source === 'env'} warn label="Encryption key" detail={health?.encryption_key_source === 'env' ? 'held in the host\'s secret store' : 'stored next to the data (set SHALASIGN_SECRET on the host for stronger protection)'} />
          <Row ok={s.url_source !== 'localhost'} label="Public URL" detail={`${s.public_url} (${s.url_source})`} fix="general" />
          <Row ok={s.email} label="Platform email" detail={s.email ? 'configured' : 'not configured — login codes and resets are off; users must connect their own inbox'} fix="email" />
          <Row ok={s.microsoft} warn label="Microsoft sign-in & connections" detail={s.microsoft ? `configured (tenant ${s.ms_tenant})` : 'not configured'} fix="providers" />
          <Row ok={s.google} warn label="Google sign-in & connections" detail={s.google ? 'configured' : 'not configured'} fix="providers" />
          <Row ok label="Sign-up" detail={s.signup_mode === 'open' ? 'open to anyone' : 'invitation only'} />
          <Row ok label="MCP server" detail={`${s.public_url}/mcp — ready; users connect from Settings → Claude & MCP`} />
          <Row ok label="Assistant billing" detail={s.assistant_shared ? 'shared platform key (you pay)' : 'each user / workspace brings their own key'} />
          <p className="muted small" style={{ marginTop: 10 }}>Values set here override environment variables. Env vars remain a fallback for container deployments.</p>
          {health && <details style={{ marginTop: 8 }}><summary className="muted small">Raw health</summary><pre className="copy-link" style={{ display: 'block', whiteSpace: 'pre-wrap' }}>{JSON.stringify(health, null, 2)}</pre></details>}
        </div>
      )}
      {tab === 'email' && <div className="card"><h3 style={{ marginTop: 0 }}>Platform email sender</h3><EmailForm data={data} onSaved={load} /></div>}
      {tab === 'providers' && <div className="card"><h3 style={{ marginTop: 0 }}>Sign-in providers & account connections</h3><p className="muted" style={{ marginTop: 0 }}>One app registration per provider, created once by you. Users then simply click "Continue with…" or "Connect".</p><ProvidersForm data={data} onSaved={load} /></div>}
      {tab === 'access' && <div className="card"><h3 style={{ marginTop: 0 }}>Access & operators</h3><AccessForm data={data} onSaved={load} /></div>}
      {tab === 'assistant' && <div className="card"><h3 style={{ marginTop: 0 }}>In-app assistant billing</h3><AssistantPlatformForm data={data} onSaved={load} /></div>}
      {tab === 'general' && <div className="card"><h3 style={{ marginTop: 0 }}>General</h3><GeneralForm data={data} onSaved={load} /></div>}
    </Layout>
  );
}
