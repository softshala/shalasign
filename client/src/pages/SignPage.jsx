import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import PdfViewer from '../components/PdfViewer.jsx';
import SignatureModal from '../components/SignatureModal.jsx';
import { api, fmtDate, daysLeft, fitFont } from '../api.js';

export default function SignPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [signature, setSignature] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [consent, setConsent] = useState(false);
  const [values, setValues] = useState({});
  const [uploads, setUploads] = useState({});
  const [fits, setFits] = useState({});          // fieldId -> {x,y,w,h} signature placement inside the field (fractions)
  const [sigDims, setSigDims] = useState(null);  // natural size of the adopted signature image
  const sigDrag = useRef(null);
  useEffect(() => {
    if (!signature) { setSigDims(null); return; }
    const img = new Image(); img.onload = () => setSigDims({ w: img.naturalWidth, h: img.naturalHeight }); img.src = signature;
    setFits({}); // a new signature starts centred again
  }, [signature]);
  // Default placement = the image fitted inside the box and centred (same as the server's default), so it can be dragged.
  const defaultFit = (fw, fh) => {
    if (!sigDims || !fw || !fh) return { x: 0, y: 0, w: 1, h: 1 };
    const scale = Math.min(fw / sigDims.w, fh / sigDims.h);
    const w = Math.min(1, (sigDims.w * scale) / fw), h = Math.min(1, (sigDims.h * scale) / fh);
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  };
  const [done, setDone] = useState(null);
  const [code, setCode] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const pageRefs = useRef({});
  const fieldRefs = useRef({});

  const authHeaders = code ? { 'x-access-code': code } : {};
  const fetchData = (useCode) => api(`/api/sign/${token}`, { headers: useCode ? { 'x-access-code': useCode } : {} });

  useEffect(() => { fetchData().then((d) => { setData(d); const pre = {}; (d.fields || []).forEach((f) => { if (f.type === 'text' && f.value) pre[f.id] = f.value; }); setValues(pre); }).catch((e) => setError(e.message)); }, [token]);

  // Apply brand colour to the page.
  useEffect(() => {
    if (data?.brand?.color) document.documentElement.style.setProperty('--brand', data.brand.color);
    return () => document.documentElement.style.removeProperty('--brand');
  }, [data?.brand?.color]);

  const unlock = async (e) => {
    e?.preventDefault(); setCodeError('');
    try { const d = await fetchData(codeInput.trim()); if (d.locked) return setCodeError('Wrong access code — try again.'); setCode(codeInput.trim()); setData(d); }
    catch (err) { setCodeError(err.message); }
  };

  const sigFields = useMemo(() => (data?.fields || []).filter((f) => f.type === 'signature' || f.type === 'initials'), [data]);
  const inputFields = useMemo(() => (data?.fields || []).filter((f) => f.type === 'text' && !f.readonly), [data]);
  const reqAttachments = data?.attachments || [];
  const missingText = inputFields.filter((f) => f.required && !(values[f.id] ?? '').trim());
  const allAttached = reqAttachments.every((a) => a.uploaded || uploads[a.id]);
  const needsSig = sigFields.length > 0;
  const ready = consent && (!needsSig || signature) && missingText.length === 0 && allAttached;
  const totalSteps = (needsSig ? 1 : 0) + inputFields.filter((f) => f.required).length + reqAttachments.length + 1;
  const doneSteps = (needsSig && signature ? 1 : 0) + (inputFields.filter((f) => f.required).length - missingText.length) + reqAttachments.filter((a) => a.uploaded || uploads[a.id]).length + (consent ? 1 : 0);

  const nextIncomplete = () => {
    const f = (data?.fields || []).find((f) => (f.type === 'signature' || f.type === 'initials') ? !signature : f.type === 'text' ? (f.required && !(values[f.id] ?? '').trim()) : false);
    if (!f) { document.getElementById('finish-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    const el = fieldRefs.current[f.id] || pageRefs.current[f.page];
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (f.type === 'text') setTimeout(() => fieldRefs.current[f.id]?.focus?.(), 400);
  };

  const onFile = (attId, file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return alert('File is too large (max 10 MB).');
    if (!/^(image\/(png|jpeg)|application\/pdf)$/.test(file.type)) return alert('Please upload a PDF, PNG or JPG.');
    const reader = new FileReader();
    reader.onload = () => setUploads((u) => ({ ...u, [attId]: { data: reader.result, filename: file.name } }));
    reader.readAsDataURL(file);
  };

  const submit = async () => {
    setError(''); setBusy(true);
    try {
      const d = await api(`/api/sign/${token}`, { method: 'POST', headers: authHeaders, body: { consent, signature_image: signature, values, signature_fit: fits, attachments: Object.entries(uploads).map(([id, u]) => ({ id, data: u.data, filename: u.filename })) } });
      setDone(d); window.scrollTo({ top: 0 });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const decline = async () => {
    setBusy(true);
    try { await api(`/api/sign/${token}/decline`, { method: 'POST', headers: authHeaders, body: { reason: declineReason } }); setDone({ declined: true }); setDeclining(false); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const brand = data?.brand || {};
  const Brand = () => brand.logo_url ? <img src={brand.logo_url} alt={brand.company || 'Logo'} style={{ maxHeight: 30, maxWidth: 140 }} /> : <span className="logo">✒️ {brand.company || 'SignFlow'}</span>;

  if (error && !data) return <Centered><h2>⚠️ {error}</h2><p className="muted">If you think this is a mistake, contact the person who sent you the document.</p></Centered>;
  if (!data) return <Centered><p className="muted">Loading…</p></Centered>;

  if (data.locked) {
    return (
      <Centered>
        <h2>🔒 Protected document</h2>
        <p className="muted">{data.envelope?.title}</p>
        <form onSubmit={unlock}>
          <p>Enter the access code the sender shared with you.</p>
          <input style={{ width: '100%', marginBottom: 10, textAlign: 'center', letterSpacing: 2 }} placeholder="Access code" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} autoFocus />
          {codeError && <p className="error">{codeError}</p>}
          <button style={{ width: '100%' }}>Unlock</button>
        </form>
      </Centered>
    );
  }

  const downloadBtn = <a className="btn" href={`/api/sign/${token}/download${code ? `?code=${encodeURIComponent(code)}` : ''}`} onClick={async (e) => { if (!code) return; e.preventDefault(); const r = await fetch(`/api/sign/${token}/download`, { headers: authHeaders }); const b = await r.blob(); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = `${data.envelope.title}-signed.pdf`; a.click(); URL.revokeObjectURL(u); }}>⬇ Download signed document</a>;

  if (done) {
    if (done.declined) return <Centered><h2>Declined</h2><p>You declined to sign <strong>{data.envelope.title}</strong>. The sender has been notified.</p></Centered>;
    return (
      <Centered>
        <h2>✅ Thank you, {data.signer.name}!</h2>
        <p>Your signature has been recorded.</p>
        {done.envelope_status === 'completed'
          ? (done.sealed === false
            ? <p className="muted">{done.message}</p>
            : <><p>All parties have signed. The document is sealed with a certificate of completion and a copy has been emailed to you.</p>{downloadBtn}</>)
          : <p className="muted">Waiting on {done.remaining_signers} more signer{done.remaining_signers === 1 ? '' : 's'}. You will receive the final document by email once everyone has signed.</p>}
      </Centered>
    );
  }

  const st = data.envelope.status;
  if (st === 'completed') return <Centered><h2>✅ Completed</h2><p><strong>{data.envelope.title}</strong> has been signed by all parties.</p>{data.can_download && downloadBtn}</Centered>;
  if (st === 'declined') return <Centered><h2>Declined</h2><p>This document was declined{data.signer.status === 'declined' ? ' by you' : ' by another signer'} and is no longer open for signing.</p></Centered>;
  if (st === 'expired') return <Centered><h2>⌛ Expired</h2><p>The signing deadline for <strong>{data.envelope.title}</strong> has passed. Ask the sender to send it again.</p></Centered>;
  if (data.signer.status === 'signed') return <Centered><h2>You have already signed this document.</h2><p className="muted">Signed {fmtDate(data.signer.signed_at)}. You will receive the final copy by email when everyone has signed.</p></Centered>;
  if (!data.your_turn) {
    return (
      <Centered>
        <h2>⏳ Not your turn yet</h2>
        <p className="muted">This document is signed in order. You will get an email when it is your turn.</p>
        <SignerList signers={data.signers} me={data.signer.order_index} />
      </Centered>
    );
  }

  const left = daysLeft(data.envelope.expires_at);

  return (
    <div className="sign-page">
      <div className="sign-top">
        <div className="inner">
          <Brand />
          <span className="muted" style={{ flex: 1, minWidth: 160 }}><strong style={{ color: 'var(--ink)' }}>{data.envelope.title}</strong> · signing as {data.signer.name}</span>
          <span className="muted small hide-mobile">{doneSteps}/{totalSteps} steps done</span>
          <div className="progress hide-mobile" style={{ width: 120, margin: 0 }}><div style={{ width: `${(doneSteps / totalSteps) * 100}%` }} /></div>
        </div>
      </div>
      <div className="container wide">
        {left != null && left <= 3 && <div className="notice warn">⏰ Please sign by {fmtDate(data.envelope.expires_at)}{left <= 0 ? ' — the deadline is today.' : ` (${left} day${left === 1 ? '' : 's'} left).`}</div>}
        {data.summary && <Briefing s={data.summary} />}
        {(data.envelope.message || data.signer.private_message) && (
          <div className="card tight">
            {data.envelope.message && <div><span className="muted small">Message from {brand.sender_name || 'the sender'}:</span> <em>{data.envelope.message}</em></div>}
            {data.signer.private_message && <div style={{ marginTop: data.envelope.message ? 6 : 0 }}><span className="muted small">Note for you:</span> <em>{data.signer.private_message}</em></div>}
          </div>
        )}
        <div className="editor-layout">
          <div className="editor-main">
            <PdfViewer
              url={`/api/sign/${token}/pdf`} headers={authHeaders} pageRefs={pageRefs}
              renderOverlay={(pageIndex, size) => data.fields.filter((f) => f.page === pageIndex).map((f) => {
                const style = { left: f.x * size.width, top: f.y * size.height, width: f.w * size.width, height: f.h * size.height };
                if (f.type === 'signature' || f.type === 'initials') {
                  const fit = fits[f.id] || defaultFit(f.w * size.width, f.h * size.height);
                  const startFit = (e, mode) => {
                    if (!signature) return;
                    e.stopPropagation(); e.preventDefault();
                    const box = e.currentTarget.closest('.field-box').getBoundingClientRect();
                    const target = e.currentTarget; target.setPointerCapture?.(e.pointerId);
                    sigDrag.current = { moved: false, sx: e.clientX, sy: e.clientY, fit: { ...fit }, box, mode };
                    const onMove = (ev) => {
                      const d = sigDrag.current; if (!d) return;
                      const dx = (ev.clientX - d.sx) / d.box.width, dy = (ev.clientY - d.sy) / d.box.height;
                      if (Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) > 3) d.moved = true;
                      if (d.mode === 'resize') { const w = Math.max(0.2, Math.min(1 - d.fit.x, d.fit.w + dx)); const h = Math.max(0.2, Math.min(1 - d.fit.y, d.fit.h + dy)); setFits((s) => ({ ...s, [f.id]: { ...d.fit, w, h } })); }
                      else { const x = Math.max(0, Math.min(1 - d.fit.w, d.fit.x + dx)); const y = Math.max(0, Math.min(1 - d.fit.h, d.fit.y + dy)); setFits((s) => ({ ...s, [f.id]: { ...d.fit, x, y } })); }
                    };
                    const onUp = () => { target.removeEventListener('pointermove', onMove); target.removeEventListener('pointerup', onUp); const moved = sigDrag.current?.moved; sigDrag.current = null; if (!moved && mode === 'move') setShowModal(true); };
                    target.addEventListener('pointermove', onMove); target.addEventListener('pointerup', onUp);
                  };
                  return (
                    <div key={f.id} ref={(el) => (fieldRefs.current[f.id] = el)} className={`field-box sig ${signature ? 'done' : 'todo'}`} style={{ ...style, overflow: 'visible', ...(f.cover ? { background: '#fff' } : {}) }} onClick={() => { if (!signature) setShowModal(true); }} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setShowModal(true)} title={signature ? 'Drag to move, pull the corner to resize, tap to change' : ''}>
                      {signature ? (
                        <div style={{ position: 'absolute', left: `${fit.x * 100}%`, top: `${fit.y * 100}%`, width: `${fit.w * 100}%`, height: `${fit.h * 100}%`, cursor: 'move', touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', outline: fits[f.id] ? '1px dashed var(--ok)' : 'none' }} onPointerDown={(e) => startFit(e, 'move')}>
                          <img src={signature} alt="signature" style={{ maxWidth: '100%', maxHeight: '100%', pointerEvents: 'none' }} draggable={false} />
                          <span className="resize" style={{ background: 'var(--ok)', cursor: 'nwse-resize' }} onPointerDown={(e) => startFit(e, 'resize')} />
                        </div>
                      ) : `Tap to ${f.type === 'initials' ? 'initial' : 'sign'}`}
                    </div>
                  );
                }
                if (f.type === 'date') return <div key={f.id} className="field-box done" style={{ ...style, whiteSpace: 'nowrap', overflow: 'hidden', fontSize: fitFont(new Date().toLocaleDateString(), f.w * size.width, f.h * size.height), ...(f.cover ? { background: '#fff' } : {}) }}>{new Date().toLocaleDateString()}</div>;
                if (f.type === 'checkbox') {
                  return (
                    <div key={f.id} className={`field-box ${values[f.id] === 'true' ? 'done' : 'todo'}`} style={{ ...style, fontSize: Math.max(10, f.h * size.height * 0.8) }} role="checkbox" aria-checked={values[f.id] === 'true'} tabIndex={0}
                      onClick={() => setValues({ ...values, [f.id]: values[f.id] === 'true' ? 'false' : 'true' })} onKeyDown={(e) => e.key === ' ' && setValues({ ...values, [f.id]: values[f.id] === 'true' ? 'false' : 'true' })} title={f.label || 'Checkbox'}>
                      {values[f.id] === 'true' ? '✓' : ''}
                    </div>
                  );
                }
                if (f.readonly) {
                  return <div key={f.id} className="field-box done" style={{ ...style, background: '#fff', border: '1px solid transparent', color: 'var(--ink)', justifyContent: 'flex-start', paddingLeft: 3, whiteSpace: 'nowrap', overflow: 'hidden', fontSize: fitFont(f.value, f.w * size.width, f.h * size.height) }} title="Filled in by the sender">{f.value}</div>;
                }
                return (
                  <input key={f.id} ref={(el) => (fieldRefs.current[f.id] = el)} className="field-box text-input" style={{ ...style, fontSize: Math.max(10, f.h * size.height * 0.55), borderColor: f.required && !(values[f.id] ?? '').trim() ? undefined : 'var(--ok)' }}
                    placeholder={`${f.label || 'Text'}${f.required ? ' *' : ''}`} value={values[f.id] || ''} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} aria-label={f.label || 'Text field'} />
                );
              })}
            />
          </div>
          <div className="sidebar">
            <div className="card" id="finish-panel">
              <h4 style={{ marginTop: 0 }}>Finish signing</h4>
              <div className="progress"><div style={{ width: `${(doneSteps / totalSteps) * 100}%` }} /></div>
              {needsSig && (
                <>
                  <button style={{ width: '100%', marginBottom: 10 }} className={signature ? 'secondary' : ''} onClick={() => setShowModal(true)}>{signature ? 'Change signature' : '✍️ Add your signature'}</button>
                  {signature && <img src={signature} alt="your signature" className="sig-preview" style={{ marginBottom: 6, display: 'block' }} />}
                  {signature && <p className="muted small" style={{ marginTop: 0 }}>On the document you can drag your signature within its box and pull the corner to resize it.</p>}
                </>
              )}
              {missingText.length > 0 && <p className="muted small">{missingText.length} required field{missingText.length === 1 ? '' : 's'} left to fill on the document.</p>}
              {reqAttachments.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div className="muted" style={{ marginBottom: 6 }}>Required documents</div>
                  {reqAttachments.map((a) => (
                    <div key={a.id} className="att-req" style={{ marginTop: 6 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{a.label}</div>
                      {uploads[a.id] ? <div className="att-done">✓ {uploads[a.id].filename} <button className="secondary small" style={{ marginLeft: 6 }} onClick={() => setUploads((u) => { const n = { ...u }; delete n[a.id]; return n; })}>change</button></div>
                        : a.uploaded ? <div className="att-done">✓ already uploaded</div>
                        : <input type="file" accept="image/png,image/jpeg,application/pdf" style={{ fontSize: 12, width: '100%' }} onChange={(e) => onFile(a.id, e.target.files?.[0])} />}
                    </div>
                  ))}
                </div>
              )}
              <label style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'flex-start', marginBottom: 12 }}>
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 2 }} />
                <span>I agree to use electronic records and signatures, and I intend this to be my legally binding signature.</span>
              </label>
              {error && <p className="error">{error}</p>}
              <button style={{ width: '100%' }} disabled={!ready || busy} onClick={submit}>{busy ? 'Submitting…' : 'Finish & sign'}</button>
              {data.can_decline && !declining && <button className="ghost small" style={{ width: '100%', marginTop: 8, color: 'var(--muted)' }} onClick={() => setDeclining(true)}>Decline to sign</button>}
              {declining && (
                <div className="att-req" style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Decline this document?</div>
                  <textarea rows={2} style={{ width: '100%', marginTop: 6 }} placeholder="Reason (optional, shared with the sender)" value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="danger small" disabled={busy} onClick={decline}>Decline</button>
                    <button className="secondary small" onClick={() => setDeclining(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
            {data.signers?.length > 1 && <div className="card tight"><SignerList signers={data.signers} me={data.signer.order_index} sequential={data.envelope.sequential} /></div>}
            <p className="muted small" style={{ textAlign: 'center' }}>Secured by SignFlow · every step is recorded in a tamper-evident audit trail.</p>
          </div>
        </div>
      </div>
      <div className="sign-bottom">
        <div className="inner">
          <button className="secondary" onClick={nextIncomplete}>{ready ? 'Review' : 'Next step →'}</button>
          <button disabled={!ready || busy} onClick={submit}>{busy ? 'Submitting…' : 'Finish & sign'}</button>
        </div>
      </div>
      {showModal && <SignatureModal signerName={data.signer.name} onDone={(dataUrl) => { setSignature(dataUrl); setShowModal(false); }} onCancel={() => setShowModal(false)} />}
    </div>
  );
}

function Briefing({ s }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="card tight" style={{ borderColor: '#c9dafb', background: '#f7faff' }}>
      <div className="row spread" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <strong>✨ What am I signing?</strong>
        <span className="muted small">{open ? 'Hide' : 'Show'}</span>
      </div>
      {open && (
        <div style={{ fontSize: 14, marginTop: 8 }}>
          <p style={{ margin: '0 0 8px' }}>{s.summary}</p>
          {s.key_points?.length > 0 && <><div className="muted small" style={{ marginBottom: 2 }}>Key terms</div><ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>{s.key_points.map((k, i) => <li key={i}>{k}</li>)}</ul></>}
          {s.obligations?.length > 0 && <><div className="muted small" style={{ marginBottom: 2 }}>You are agreeing to</div><ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>{s.obligations.map((k, i) => <li key={i}>{k}</li>)}</ul></>}
          {s.caution && <p className="notice warn" style={{ margin: '0 0 8px' }}>⚠️ {s.caution}</p>}
          <p className="muted small" style={{ margin: 0 }}>Generated by AI from the document text to help you read it. It is not legal advice and the signed document is what counts — please read it.</p>
        </div>
      )}
    </div>
  );
}

function SignerList({ signers, me, sequential }) {
  return (
    <ul className="timeline" style={{ textAlign: 'left' }}>
      {signers.map((s) => (
        <li key={s.order}><span className={`dot ${s.status}`} /><span>{sequential ? `${s.order + 1}. ` : ''}{s.name}{s.order === me ? ' (you)' : ''}</span><span className={`pill ${s.status}`} style={{ marginLeft: 'auto' }}>{s.status}</span></li>
      ))}
    </ul>
  );
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ textAlign: 'center', maxWidth: 480, width: '100%' }}>{children}</div>
    </div>
  );
}
