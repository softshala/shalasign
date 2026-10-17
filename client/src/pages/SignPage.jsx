import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import PdfViewer from '../components/PdfViewer.jsx';
import SignatureModal from '../components/SignatureModal.jsx';

export default function SignPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [signature, setSignature] = useState(null); // data URL
  const [showModal, setShowModal] = useState(false);
  const [consent, setConsent] = useState(false);
  const [values, setValues] = useState({});   // fieldId -> text/checkbox value
  const [uploads, setUploads] = useState({}); // attachmentId -> { data, filename }
  const [done, setDone] = useState(null);
  const [code, setCode] = useState('');       // access code the signer enters
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');

  const authHeaders = code ? { 'x-access-code': code } : {};

  const fetchData = (useCode) => {
    const headers = useCode ? { 'x-access-code': useCode } : {};
    return fetch(`/api/sign/${token}`, { headers })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });
  };

  useEffect(() => {
    fetchData().then(setData).catch((e) => setError(e.message));
  }, [token]);

  const unlock = async () => {
    setCodeError('');
    try {
      const d = await fetchData(codeInput.trim());
      if (d.locked) { setCodeError('Wrong access code — try again.'); return; }
      setCode(codeInput.trim());
      setData(d);
    } catch (e) { setCodeError(e.message); }
  };

  const submit = async () => {
    setError('');
    const res = await fetch(`/api/sign/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        consent, signature_image: signature, values,
        attachments: Object.entries(uploads).map(([id, u]) => ({ id, data: u.data, filename: u.filename })),
      }),
    });
    const d = await res.json();
    if (!res.ok) return setError(d.error || 'Signing failed');
    setDone(d);
  };

  if (error && !data) return <Centered><h2>⚠️ {error}</h2></Centered>;
  if (!data) return <Centered><p className="muted">Loading…</p></Centered>;

  // Access-code gate: the sender protected this document with a code.
  if (data.locked) {
    return (
      <Centered>
        <h2>🔒 Protected document</h2>
        <p className="muted">{data.envelope?.title}</p>
        <p>Enter the access code the sender shared with you.</p>
        <input style={{ width: '100%', marginBottom: 10, textAlign: 'center', letterSpacing: 2 }} placeholder="Access code"
          value={codeInput} onChange={(e) => setCodeInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && unlock()} />
        {codeError && <p className="error">{codeError}</p>}
        <button style={{ width: '100%' }} onClick={unlock}>Unlock</button>
      </Centered>
    );
  }

  if (done) {
    return (
      <Centered>
        <h2>✅ Thank you, {data.signer.name}!</h2>
        <p>Your signature has been recorded.</p>
        {done.envelope_status === 'completed'
          ? <p>All parties have signed — the document is now sealed with a certificate of completion.</p>
          : <p className="muted">Waiting on {done.remaining_signers} more signer(s).</p>}
      </Centered>
    );
  }

  if (data.signer.status === 'signed') return <Centered><h2>You have already signed this document.</h2></Centered>;
  if (!data.your_turn) return <Centered><h2>⏳ Not your turn yet</h2><p className="muted">Signers before you haven't finished. Try again later.</p></Centered>;

  const sigFields = data.fields.filter((f) => f.type === 'signature' || f.type === 'initials');
  const inputFields = data.fields.filter((f) => f.type === 'text' || f.type === 'checkbox');
  const allInputsFilled = inputFields.every((f) => f.type === 'checkbox' || (values[f.id] ?? '').trim() !== '');
  const reqAttachments = data.attachments || [];
  const allAttached = reqAttachments.every((a) => a.uploaded || uploads[a.id]);
  const ready = consent && signature && (sigFields.length === 0 || signature) && allInputsFilled && allAttached;

  const onFile = (attId, file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return alert('File is too large (max 10 MB).');
    const reader = new FileReader();
    reader.onload = () => setUploads((u) => ({ ...u, [attId]: { data: reader.result, filename: file.name } }));
    reader.readAsDataURL(file);
  };

  return (
    <>
      <div className="topbar">
        <span className="logo">✒️ SignFlow</span>
        <span className="muted">{data.envelope.title} — signing as {data.signer.name}</span>
      </div>
      <div className="container" style={{ maxWidth: 1250 }}>
        {data.envelope.message && <div className="card"><em>{data.envelope.message}</em></div>}
        <div className="editor-layout">
          <div className="editor-main">
            <PdfViewer
              url={`/api/sign/${token}/pdf`}
              headers={authHeaders}
              renderOverlay={(pageIndex, size) => data.fields.filter((f) => f.page === pageIndex).map((f) => {
                const style = { left: f.x * size.width, top: f.y * size.height, width: f.w * size.width, height: f.h * size.height };
                if (f.type === 'signature' || f.type === 'initials') {
                  return (
                    <div key={f.id} className={`field-box ${signature ? 'done' : 'todo'}`} style={style} onClick={() => setShowModal(true)}>
                      {signature ? <img src={signature} alt="signature" /> : `Click to ${f.type === 'initials' ? 'initial' : 'sign'}`}
                    </div>
                  );
                }
                if (f.type === 'date') {
                  return <div key={f.id} className="field-box done" style={style}>{new Date().toISOString().slice(0, 10)}</div>;
                }
                if (f.type === 'checkbox') {
                  return (
                    <div key={f.id} className="field-box todo" style={style}
                      onClick={() => setValues({ ...values, [f.id]: values[f.id] === 'true' ? 'false' : 'true' })}>
                      {values[f.id] === 'true' ? '✓' : ''}
                    </div>
                  );
                }
                return (
                  <input key={f.id} className="field-box" style={{ ...style, position: 'absolute', fontSize: Math.max(10, f.h * size.height * 0.55) }}
                    placeholder={f.label || 'Text'} value={values[f.id] || ''}
                    onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} />
                );
              })}
            />
          </div>
          <div className="sidebar">
            <div className="card">
              <h4 style={{ marginTop: 0 }}>Finish signing</h4>
              <button style={{ width: '100%', marginBottom: 12 }} className={signature ? 'secondary' : ''} onClick={() => setShowModal(true)}>
                {signature ? 'Change signature' : '✍️ Add your signature'}
              </button>
              {signature && <img src={signature} alt="your signature" style={{ maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 12 }} />}
              {reqAttachments.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div className="muted" style={{ marginBottom: 6 }}>Required documents</div>
                  {reqAttachments.map((a) => (
                    <div key={a.id} className="att-req" style={{ marginTop: 6 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{a.label}</div>
                      {uploads[a.id] ? (
                        <div className="att-done">✓ {uploads[a.id].filename} <button className="secondary" style={{ padding: '2px 8px', fontSize: 11, marginLeft: 6 }} onClick={() => setUploads((u) => { const n = { ...u }; delete n[a.id]; return n; })}>change</button></div>
                      ) : a.uploaded ? (
                        <div className="att-done">✓ already uploaded</div>
                      ) : (
                        <input type="file" accept="image/png,image/jpeg,application/pdf" style={{ fontSize: 12 }} onChange={(e) => onFile(a.id, e.target.files?.[0])} />
                      )}
                    </div>
                  ))}
                </div>
              )}
              <label style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'flex-start', marginBottom: 12 }}>
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>I agree to use electronic records and signatures, and I intend this to be my legally binding signature.</span>
              </label>
              {error && <p className="error">{error}</p>}
              <button style={{ width: '100%' }} disabled={!ready} onClick={submit}>Finish & sign</button>
            </div>
          </div>
        </div>
      </div>
      {showModal && (
        <SignatureModal
          signerName={data.signer.name}
          onDone={(dataUrl) => { setSignature(dataUrl); setShowModal(false); }}
          onCancel={() => setShowModal(false)}
        />
      )}
    </>
  );
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ textAlign: 'center', maxWidth: 480 }}>{children}</div>
    </div>
  );
}
