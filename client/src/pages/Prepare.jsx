import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import PdfViewer from '../components/PdfViewer.jsx';

const TOOLS = [
  { type: 'signature', label: '✍️ Signature', w: 0.24, h: 0.055 },
  { type: 'initials', label: '🔤 Initials', w: 0.09, h: 0.045 },
  { type: 'date', label: '📅 Date signed', w: 0.14, h: 0.032 },
  { type: 'text', label: '📝 Text', w: 0.2, h: 0.032 },
  { type: 'checkbox', label: '☑️ Checkbox', w: 0.022, h: 0.016 },
];

export default function Prepare() {
  const { id } = useParams();
  const [bulk, setBulk] = useState(false);
  const [signers, setSigners] = useState([{ name: '', email: '', attachments: [] }]);
  const [bulkRecipients, setBulkRecipients] = useState('');
  const [bulkAttachments, setBulkAttachments] = useState([]);
  const [activeSigner, setActiveSigner] = useState(0);
  const [tool, setTool] = useState('signature');
  const [fields, setFields] = useState([]);
  const [sequential, setSequential] = useState(true);
  const [folders, setFolders] = useState([]);
  const [folderId, setFolderId] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [links, setLinks] = useState(null);
  const [error, setError] = useState('');
  const drag = useRef(null);
  const nav = useNavigate();

  useEffect(() => {
    fetch('/api/auth/me').then((r) => { if (r.status === 401) nav('/login'); });
    fetch('/api/folders').then((r) => r.ok && r.json().then(setFolders));
  }, []);

  // Parse "Name, email@x.com" lines (comma or tab separated) for bulk send.
  const parsedRecipients = bulkRecipients.split('\n').map((line) => {
    const parts = line.split(/[,\t]/).map((p) => p.trim());
    if (parts.length >= 2 && parts[0] && parts[1]) return { name: parts[0], email: parts[1] };
    if (parts.length === 1 && parts[0].includes('@')) return { name: parts[0].split('@')[0], email: parts[0] };
    return null;
  }).filter(Boolean);

  const placeField = (page, { x, y }) => {
    const t = TOOLS.find((t) => t.type === tool);
    setFields((f) => [...f, {
      key: Math.random().toString(36).slice(2),
      type: t.type, page,
      x: Math.max(0, x - t.w / 2), y: Math.max(0, y - t.h / 2),
      w: t.w, h: t.h, signerIndex: activeSigner,
    }]);
  };

  const startDrag = (e, key, pageSize) => {
    e.stopPropagation();
    const field = fields.find((f) => f.key === key);
    drag.current = { key, startX: e.clientX, startY: e.clientY, ox: field.x, oy: field.y, pageSize };
    const onMove = (ev) => {
      const d = drag.current;
      setFields((fs) => fs.map((f) => f.key === d.key ? {
        ...f,
        x: Math.min(1 - f.w, Math.max(0, d.ox + (ev.clientX - d.startX) / d.pageSize.width)),
        y: Math.min(1 - f.h, Math.max(0, d.oy + (ev.clientY - d.startY) / d.pageSize.height)),
      } : f));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const send = async () => {
    setError('');
    if (!fields.some((f) => f.type === 'signature')) return setError('Place at least one signature field.');

    if (bulk) {
      if (!parsedRecipients.length) return setError('Add at least one recipient (Name, email per line).');
      const res = await fetch(`/api/envelopes/${id}/bulk-send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: parsedRecipients, fields, folder_id: folderId || null, access_code: accessCode || null, attachments: bulkAttachments }),
      });
      const data = await res.json();
      if (!res.ok) return setError(data.error || 'Bulk send failed');
      return setLinks({ emailed: data.emailed, list: data.links, bulk: true, count: data.count });
    }

    const clean = signers.filter((s) => s.name.trim() && s.email.trim());
    if (!clean.length) return setError('Add at least one signer (name + email).');
    const res = await fetch(`/api/envelopes/${id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signers: clean, fields, sequential, folder_id: folderId || null, access_code: accessCode || null }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error || 'Send failed');
    setLinks({ emailed: data.emailed, list: data.links });
  };

  if (links) {
    return (
      <>
        <div className="topbar"><Link className="logo" to="/">✒️ SignFlow</Link></div>
        <div className="container">
          <div className="card">
            <h2>{links.bulk ? `Sent to ${links.count} recipient(s) 🎉` : 'Envelope sent 🎉'}</h2>
            <p className="muted">
              {links.emailed
                ? 'Each recipient has been emailed their own signing link. The links are also listed here as a backup:'
                : 'Email is not configured on the server (see .env.example), so share these links directly:'}
            </p>
            {links.list.map((l) => (
              <div key={l.signing_url} style={{ marginBottom: 12 }}>
                <strong>{l.name}</strong> <span className="muted">({l.email})</span>
                <div className="copy-link">{l.signing_url}</div>
              </div>
            ))}
            <Link to={links.bulk ? '/' : `/envelope/${id}`} className="btn">{links.bulk ? 'Back to documents →' : 'Track envelope →'}</Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <Link className="logo" to="/">✒️ SignFlow</Link>
        <span className="muted">Prepare document — add signers, then click the page to place fields</span>
      </div>
      <div className="container" style={{ maxWidth: 1250 }}>
        <div className="editor-layout">
          <div className="sidebar">
            <div className="card">
              <div className="tabs" style={{ marginBottom: 0 }}>
                <button className={!bulk ? 'active' : ''} onClick={() => { setBulk(false); setActiveSigner(0); }}>One / few signers</button>
                <button className={bulk ? 'active' : ''} onClick={() => { setBulk(true); setActiveSigner(0); setFields(fields.filter((f) => f.signerIndex === 0)); }}>Bulk send</button>
              </div>
            </div>

            {bulk ? (
              <div className="card">
                <h4 style={{ marginTop: 0 }}>1 · Recipients</h4>
                <p className="muted" style={{ marginTop: 0 }}>One per line as <strong>Name, email</strong>. Each person gets their own private copy to sign.</p>
                <textarea style={{ width: '100%', minHeight: 120, fontFamily: 'monospace', fontSize: 12 }}
                  placeholder={'Asha Verma, asha@example.com\nRohit Jain, rohit@example.com'}
                  value={bulkRecipients} onChange={(e) => setBulkRecipients(e.target.value)} />
                <div className="muted" style={{ marginTop: 6 }}>{parsedRecipients.length} valid recipient(s)</div>
                <AttachmentPicker labels={bulkAttachments} onChange={setBulkAttachments} />
              </div>
            ) : (
            <div className="card">
              <h4 style={{ marginTop: 0 }}>1 · Signers</h4>
              {signers.map((s, i) => (
                <div key={i} style={{ marginBottom: 12, paddingLeft: 8, borderLeft: `4px solid ${['#2f6fed','#1d9a5b','#c77700','#9b59b6'][i % 4]}` }}>
                  <input style={{ width: '100%', marginBottom: 6 }} placeholder={`Signer ${i + 1} name`} value={s.name}
                    onChange={(e) => setSigners(signers.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                  <input style={{ width: '100%' }} placeholder="email@example.com" value={s.email}
                    onChange={(e) => setSigners(signers.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} />
                  <AttachmentPicker
                    labels={s.attachments || []}
                    onChange={(labels) => setSigners(signers.map((x, j) => j === i ? { ...x, attachments: labels } : x))}
                  />
                </div>
              ))}
              <div className="row">
                {signers.length < 4 && <button className="secondary" onClick={() => setSigners([...signers, { name: '', email: '', attachments: [] }])}>+ Add signer</button>}
                {signers.length > 1 && <button className="secondary" onClick={() => { setSigners(signers.slice(0, -1)); setFields(fields.filter((f) => f.signerIndex < signers.length - 1)); setActiveSigner(0); }}>− Remove</button>}
              </div>
              {signers.length > 1 && (
                <label className="muted" style={{ display: 'block', marginTop: 10 }}>
                  <input type="checkbox" checked={sequential} onChange={(e) => setSequential(e.target.checked)} /> Sign in order
                </label>
              )}
            </div>
            )}
            <div className="card palette">
              <h4 style={{ marginTop: 0 }}>2 · Fields</h4>
              {!bulk && (
                <>
                  <div className="muted" style={{ marginBottom: 8 }}>Placing for:</div>
                  <select style={{ width: '100%', marginBottom: 12 }} value={activeSigner} onChange={(e) => setActiveSigner(+e.target.value)}>
                    {signers.map((s, i) => <option key={i} value={i}>{s.name || `Signer ${i + 1}`}</option>)}
                  </select>
                </>
              )}
              {bulk && <p className="muted" style={{ marginTop: 0 }}>Fields you place apply to every recipient.</p>}
              {TOOLS.map((t) => (
                <button key={t.type} className={tool === t.type ? 'active' : ''} onClick={() => setTool(t.type)}>{t.label}</button>
              ))}
              <p className="muted">Click anywhere on the document to place the selected field. Drag to reposition.</p>
            </div>
            <div className="card">
              <h4 style={{ marginTop: 0 }}>3 · Options & send</h4>
              <label className="field"><span>Folder (optional)</span>
                <select style={{ width: '100%' }} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                  <option value="">— No folder —</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Access code (optional)</span>
                <input style={{ width: '100%' }} placeholder="e.g. a PIN you share separately" value={accessCode}
                  onChange={(e) => setAccessCode(e.target.value)} />
              </label>
              <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>If set, signers must enter this code before they can open the document.</p>
              {error && <p className="error">{error}</p>}
              <button style={{ width: '100%' }} onClick={send}>{bulk ? `Send to ${parsedRecipients.length} recipient(s) →` : 'Send for signature →'}</button>
            </div>
          </div>
          <div className="editor-main">
            <PdfViewer
              url={`/api/envelopes/${id}/pdf`}
              onPageClick={placeField}
              renderOverlay={(pageIndex, size) => fields.filter((f) => f.page === pageIndex).map((f) => (
                <div
                  key={f.key}
                  className={`field-box s${f.signerIndex % 4}`}
                  style={{ left: f.x * size.width, top: f.y * size.height, width: f.w * size.width, height: f.h * size.height }}
                  onMouseDown={(e) => startDrag(e, f.key, size)}
                  onClick={(e) => e.stopPropagation()}
                >
                  {f.type}
                  <button className="del" onClick={(e) => { e.stopPropagation(); setFields(fields.filter((x) => x.key !== f.key)); }}>×</button>
                </div>
              ))}
            />
          </div>
        </div>
      </div>
    </>
  );
}

// Lets the sender require documents (Aadhaar, PAN, or custom) from one signer.
function AttachmentPicker({ labels, onChange }) {
  const [custom, setCustom] = useState('');
  const add = (label) => { const l = label.trim(); if (l && !labels.includes(l)) onChange([...labels, l]); };
  const remove = (label) => onChange(labels.filter((x) => x !== label));
  return (
    <div className="att-req">
      <div className="muted" style={{ marginBottom: 6 }}>Require documents (optional)</div>
      {labels.map((l) => (
        <span key={l} className="att-chip" style={{ marginRight: 4, marginBottom: 4 }}>{l}<button onClick={() => remove(l)}>×</button></span>
      ))}
      <div className="row" style={{ marginTop: 6 }}>
        <button className="secondary" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => add('Aadhaar card')}>+ Aadhaar</button>
        <button className="secondary" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => add('PAN card')}>+ PAN</button>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input style={{ flex: 1, fontSize: 12, padding: '5px 8px' }} placeholder="Custom document…" value={custom} onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { add(custom); setCustom(''); } }} />
        <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => { add(custom); setCustom(''); }}>Add</button>
      </div>
    </div>
  );
}
