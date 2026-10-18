import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/Toast.jsx';
import { EmailForm, ProvidersForm, GeneralForm } from '../components/PlatformForms.jsx';

/** /setup — first-run wizard for the platform operator. Every step can be skipped and revisited in /admin. */
export default function Setup() {
  const nav = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [step, setStep] = useState(0);
  const load = () => api('/api/platform').then(setData).catch((e) => { if (e.status === 403) nav('/'); else toast(e.message, { bad: true }); });
  useEffect(() => { load(); }, []);
  if (!data) return <div className="empty"><p className="muted">Loading…</p></div>;

  const steps = [
    { title: 'Welcome', body: (
      <>
        <p>You are the <strong>platform operator</strong>. This takes a few minutes and everything can be changed later under <strong>Admin</strong>. Nothing here requires touching the server.</p>
        <ul style={{ fontSize: 14, lineHeight: 1.7 }}>
          <li><strong>Name & address</strong> — what people see in emails; the public URL is already detected.</li>
          <li><strong>Email</strong> — a sender for login codes and for users who have not connected their own inbox.</li>
          <li><strong>Sign-in with Microsoft / Google</strong> — optional, also powers "connect your inbox and drive".</li>
        </ul>
        <p className="muted small">Your own documents and settings live in your workspace like any other user's.</p>
      </>
    ) },
    { title: 'Name & address', body: <GeneralForm data={data} onSaved={load} /> },
    { title: 'Email', body: <EmailForm data={data} onSaved={load} /> },
    { title: 'Sign-in providers', body: <ProvidersForm data={data} onSaved={load} /> },
    { title: 'Done', body: (
      <>
        <p>Setup summary:</p>
        <dl className="kv">
          <dt>Platform</dt><dd>{data.status.platform_name} · {data.status.public_url}</dd>
          <dt>Email</dt><dd>{data.status.email ? <span className="pill completed">Configured</span> : <span className="pill draft">Not yet — users can still connect their own inbox</span>}</dd>
          <dt>Microsoft</dt><dd>{data.status.microsoft ? <span className="pill completed">Configured</span> : <span className="pill draft">Skipped</span>}</dd>
          <dt>Google</dt><dd>{data.status.google ? <span className="pill completed">Configured</span> : <span className="pill draft">Skipped</span>}</dd>
        </dl>
        <p className="muted small">Next for you as a user: connect your own inbox and drive in Settings → Connected accounts, then send your first document.</p>
      </>
    ) },
  ];
  const finish = async () => { try { await api('/api/platform', { method: 'PUT', body: { setup_done: true } }); nav('/'); } catch (e) { toast(e.message, { bad: true }); } };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div className="topbar"><span className="logo">✒️ {data.status.platform_name || 'ShalaSign'}</span><span className="muted">First-run setup</span><span className="right"><button className="ghost small" onClick={finish}>Skip setup for now</button></span></div>
      <div className="container" style={{ maxWidth: 820 }}>
        <div className="row" style={{ gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {steps.map((s, i) => <button key={s.title} className={`folder-chip ${i === step ? 'active' : ''}`} onClick={() => setStep(i)}>{i + 1}. {s.title}</button>)}
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>{steps[step].title}</h2>
          {steps[step].body}
          <div className="row spread" style={{ marginTop: 18 }}>
            <button className="secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>← Back</button>
            {step < steps.length - 1 ? <button onClick={() => setStep(step + 1)}>{step === 0 ? "Let's go →" : 'Next →'}</button> : <button onClick={finish}>Finish & open dashboard</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
