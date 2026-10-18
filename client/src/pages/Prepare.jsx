import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import PdfViewer from '../components/PdfViewer.jsx';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, copyText, fitFont } from '../api.js';
import DataImporter from '../components/DataImporter.jsx';
import { scanTags } from '../lib/tags.js';
import { extractTextLayout } from '../lib/pdftext.js';

const TOOLS = [
  { type: 'signature', label: '✍️ Signature', w: 0.24, h: 0.055 },
  { type: 'initials', label: '🔤 Initials', w: 0.09, h: 0.045 },
  { type: 'date', label: '📅 Date signed', w: 0.14, h: 0.032 },
  { type: 'text', label: '📝 Text', w: 0.2, h: 0.032 },
  { type: 'checkbox', label: '☑️ Checkbox', w: 0.022, h: 0.016 },
];
const COLORS = ['#2f6fed', '#1d9a5b', '#c77700', '#9b59b6'];
const newSigner = () => ({ name: '', email: '', attachments: [], private_message: '', role: '' });
const key = () => Math.random().toString(36).slice(2);

export default function Prepare() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [env, setEnv] = useState(null);
  const [title, setTitle] = useState('');
  const [bulk, setBulk] = useState(false);
  const [signers, setSigners] = useState([newSigner()]);
  const [bulkRows, setBulkRows] = useState([]);          // [{name,email,data}]
  const [bulkColumns, setBulkColumns] = useState([]);    // merge columns from the file
  const [bulkAttachments, setBulkAttachments] = useState([]);
  const [mergeData, setMergeData] = useState({});        // single send: typed merge values
  const [previewIdx, setPreviewIdx] = useState(0);       // which recipient's data to preview
  const [scanning, setScanning] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [aiStatus, setAiStatus] = useState(null);      // /api/assistant/status
  const layoutRef = useRef(null);                       // extracted text layout (lazy)
  const [activeSigner, setActiveSigner] = useState(0);
  const [tool, setTool] = useState('signature');
  const [fields, setFields] = useState([]);
  const [selected, setSelected] = useState(null);
  const [opts, setOpts] = useState({ sequential: true, message: '', folder_id: '', access_code: '', expiry_days: '', reminder_days: '', cc: [] });
  const [folders, setFolders] = useState([]);
  const [defaults, setDefaults] = useState({ expiry_days: 30, reminder_days: 3 });
  const [links, setLinks] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [numPages, setNumPages] = useState(0);
  const loaded = useRef(false);
  const dirty = useRef(false);
  const pageRefs = useRef({});

  // ---- load draft + folders + defaults ----
  useEffect(() => {
    (async () => {
      try {
        const [e, f, s] = await Promise.all([api(`/api/envelopes/${id}`), api('/api/folders'), api('/api/settings')]);
        api('/api/assistant/status').then(setAiStatus).catch(() => setAiStatus({ enabled: false }));
        if (e.status !== 'draft') return nav(`/envelope/${id}`);
        setEnv(e); setFolders(f); setDefaults(s.defaults); setTitle(e.title);
        const d = e.draft;
        if (d) {
          if (Array.isArray(d.signers) && d.signers.length) setSigners(d.signers.map((x) => ({ ...newSigner(), ...x })));
          if (Array.isArray(d.fields)) setFields(d.fields.map((x) => ({ key: key(), ...x })));
          setOpts((o) => ({ ...o, sequential: d.sequential !== false, message: d.message || e.message || '', folder_id: d.folder_id || '', access_code: d.access_code || '',
            expiry_days: d.expiry_days ?? '', reminder_days: d.reminder_days ?? '', cc: d.cc || [] }));
          if (d.bulk) { setBulk(true); setBulkRows(d.bulkRows || []); setBulkColumns(d.bulkColumns || []); setBulkAttachments(d.bulkAttachments || []); }
          if (d.mergeData) setMergeData(d.mergeData);
        } else if (e.message) setOpts((o) => ({ ...o, message: e.message }));
        loaded.current = true;
      } catch (err) { setError(err.message); }
    })();
  }, [id]);

  // ---- autosave (debounced) ----
  const snapshot = useMemo(() => ({ signers, fields: fields.map(({ key: _k, ...f }) => f), ...opts, bulk, bulkRows, bulkColumns, bulkAttachments, mergeData }), [signers, fields, opts, bulk, bulkRows, bulkColumns, bulkAttachments, mergeData]);
  useEffect(() => {
    if (!loaded.current) return;
    dirty.current = true; setSaveState('Saving…');
    const t = setTimeout(async () => {
      try { await api(`/api/envelopes/${id}/draft`, { method: 'PUT', body: { state: snapshot, title } }); dirty.current = false; setSaveState('All changes saved'); }
      catch { setSaveState('Could not save draft'); }
    }, 1200);
    return () => clearTimeout(t);
  }, [snapshot, title]);

  // ---- merge fields ----
  const mergeKeys = useMemo(() => [...new Set(fields.map((f) => f.merge_key).filter(Boolean))], [fields]);
  const requiredKeys = useMemo(() => [...new Set(fields.filter((f) => f.merge_key && f.required !== false).map((f) => f.merge_key))], [fields]);
  const keyLookup = (data, key) => { const col = Object.keys(data || {}).find((c) => c.toLowerCase() === String(key).toLowerCase()); return col ? data[col] : ''; };
  const isAutoKey = (k) => ['name', 'email'].includes(String(k).toLowerCase()); // always provided by the recipient / first signer
  const previewRow = bulkRows[previewIdx];
  const previewData = bulk ? { Name: previewRow?.name || '', Email: previewRow?.email || '', ...(previewRow?.data || {}) } : { Name: signers[0]?.name || '', Email: signers[0]?.email || '', ...mergeData };
  const mergePreview = (f) => (f.merge_key ? (keyLookup(previewData, f.merge_key) || `{{${f.merge_key}}}`) : null);
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const validRows = bulkRows.filter((r) => r.name && EMAIL_RE.test(r.email));
  const bulkProblems = useMemo(() => {
    const out = []; const seen = new Set();
    bulkRows.forEach((r, i) => {
      if (!r.name || !EMAIL_RE.test(r.email)) out.push(`Row ${i + 1}: name or email invalid`);
      else if (seen.has(r.email)) out.push(`Row ${i + 1}: duplicate ${r.email}`);
      seen.add(r.email);
      const miss = requiredKeys.filter((k) => !isAutoKey(k) && !keyLookup(r.data, k)); if (miss.length) out.push(`Row ${i + 1}: missing ${miss.join(', ')}`);
    });
    return out;
  }, [bulkRows, requiredKeys]);
  const getLayout = async () => { if (!layoutRef.current) layoutRef.current = await extractTextLayout(`/api/envelopes/${id}/pdf`); return layoutRef.current; };
  const suggestFields = async () => {
    setSuggesting(true); setError('');
    try {
      const layout = await getLayout();
      const r = await api('/api/ai/suggest-fields', { method: 'POST', body: { envelope_id: id, pages: layout.pages, lines: layout.lines, signers: bulk ? [{ name: 'Recipient', role: 'Recipient' }] : signers.map((s) => ({ name: s.name, role: s.role })) } });
      if (!r.fields.length) { toast('Claude found no obvious places for fields in this document'); return; }
      const near = (a, b) => a.page === b.page && Math.abs(a.x - b.x) < 0.02 && Math.abs(a.y - b.y) < 0.02;
      const fresh = r.fields.filter((f) => !fields.some((g) => near(f, g))).map((f) => ({ key: key(), ...f, signerIndex: bulk ? 0 : Math.min(f.signerIndex, Math.max(0, signers.length - 1)), suggested: true }));
      setFields((fs) => [...fs, ...fresh]);
      toast(`✨ ${fresh.length} field${fresh.length === 1 ? '' : 's'} suggested — review, drag to adjust, or remove with ×`, { ms: 6000 });
    } catch (e) { if (e.status === 402) setError('AI suggestions need your Anthropic API key — add it in Settings → Claude & MCP.'); else setError(e.message); }
    finally { setSuggesting(false); }
  };
  const acceptSuggestions = () => setFields((fs) => fs.map(({ suggested: _s, reason: _r, ...f }) => f));
  const dropSuggestions = () => setFields((fs) => fs.filter((f) => !f.suggested));
  const suggestedCount = fields.filter((f) => f.suggested).length;
  const detectTags = async () => {
    setScanning(true); setError('');
    try {
      const r = await scanTags(`/api/envelopes/${id}/pdf`);
      if (!r.fields.length) { toast('No {{tags}} found in this document'); return; }
      const near = (a, b) => a.page === b.page && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
      const fresh = r.fields.filter((f) => !fields.some((g) => near(f, g))).map((f) => ({ key: key(), ...f, signerIndex: bulk ? 0 : Math.min(f.signerIndex, Math.max(0, signers.length - 1)) }));
      setFields((fs) => [...fs, ...fresh]);
      if (!bulk) { const sigCount = Math.max(...r.fields.map((f) => f.signerIndex + 1), 1); if (sigCount > signers.length) setSigners((ss) => [...ss, ...Array.from({ length: sigCount - ss.length }, newSigner)]); }
      toast(`${fresh.length} field${fresh.length === 1 ? '' : 's'} placed from tags${r.keys.length ? ` · merge keys: ${r.keys.join(', ')}` : ''}`, { ms: 5000 });
    } catch (e) { setError('Could not scan the document for tags: ' + e.message); }
    finally { setScanning(false); }
  };

  // ---- field placement / drag / resize ----
  const placeField = (page, { x, y }) => {
    const t = TOOLS.find((t) => t.type === tool);
    const f = { key: key(), type: t.type, page, x: Math.max(0, Math.min(1 - t.w, x - t.w / 2)), y: Math.max(0, Math.min(1 - t.h, y - t.h / 2)), w: t.w, h: t.h, signerIndex: bulk ? 0 : activeSigner, label: '', required: true };
    setFields((fs) => [...fs, f]); setSelected(f.key);
  };
  const updateField = (k, patch) => setFields((fs) => fs.map((f) => (f.key === k ? { ...f, ...patch } : f)));
  const removeField = (k) => { setFields((fs) => fs.filter((f) => f.key !== k)); if (selected === k) setSelected(null); };
  const duplicateField = (k) => { const f = fields.find((x) => x.key === k); if (!f) return; const nf = { ...f, key: key(), x: Math.min(1 - f.w, f.x + 0.02), y: Math.min(1 - f.h, f.y + 0.02) }; setFields((fs) => [...fs, nf]); setSelected(nf.key); };

  const startDrag = (e, k, size, mode) => {
    e.stopPropagation(); e.preventDefault();
    const f = fields.find((x) => x.key === k); if (!f) return;
    setSelected(k);
    const start = { x: e.clientX, y: e.clientY, fx: f.x, fy: f.y, fw: f.w, fh: f.h };
    const target = e.currentTarget; target.setPointerCapture?.(e.pointerId);
    const onMove = (ev) => {
      const dx = (ev.clientX - start.x) / size.width, dy = (ev.clientY - start.y) / size.height;
      if (mode === 'resize') updateField(k, { w: Math.max(0.015, Math.min(1 - start.fx, start.fw + dx)), h: Math.max(0.01, Math.min(1 - start.fy, start.fh + dy)) });
      else updateField(k, { x: Math.min(1 - start.fw, Math.max(0, start.fx + dx)), y: Math.min(1 - start.fh, Math.max(0, start.fy + dy)) });
    };
    const onUp = () => { target.removeEventListener('pointermove', onMove); target.removeEventListener('pointerup', onUp); target.removeEventListener('pointercancel', onUp); };
    target.addEventListener('pointermove', onMove); target.addEventListener('pointerup', onUp); target.addEventListener('pointercancel', onUp);
  };
  useEffect(() => {
    const onKey = (e) => { if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) removeField(selected); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [selected, fields]);

  // ---- signers ----
  const setSigner = (i, patch) => setSigners((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addSigner = () => { if (signers.length < 10) setSigners([...signers, newSigner()]); };
  const removeSigner = (i) => {
    if (signers.length <= 1) return;
    setSigners(signers.filter((_, j) => j !== i));
    setFields(fields.filter((f) => f.signerIndex !== i).map((f) => (f.signerIndex > i ? { ...f, signerIndex: f.signerIndex - 1 } : f)));
    setActiveSigner(0);
  };
  const moveSigner = (i, dir) => {
    const j = i + dir; if (j < 0 || j >= signers.length) return;
    const ss = [...signers]; [ss[i], ss[j]] = [ss[j], ss[i]]; setSigners(ss);
    setFields(fields.map((f) => (f.signerIndex === i ? { ...f, signerIndex: j } : f.signerIndex === j ? { ...f, signerIndex: i } : f)));
  };
  const fieldCount = (i) => fields.filter((f) => f.signerIndex === i).length;

  // ---- send ----
  const send = async () => {
    setError('');
    if (!fields.some((f) => f.type === 'signature')) return setError('Place at least one signature field on the document.');
    let document_text = '';
    if (aiStatus?.enabled) { try { document_text = (await getLayout()).fullText.slice(0, 20000); } catch { /* scanned PDF or extraction failure: no briefing */ } }
    const common = { document_text, fields: fields.map(({ key: _k, suggested: _s, reason: _r, ...f }) => f), folder_id: opts.folder_id || null, access_code: opts.access_code || null, expiry_days: opts.expiry_days === '' ? undefined : opts.expiry_days, reminder_days: opts.reminder_days === '' ? undefined : opts.reminder_days };
    setBusy(true);
    try {
      if (bulk) {
        if (!bulkRows.length) return setError('Upload an Excel/CSV file or paste recipients first.');
        if (bulkProblems.length) return setError(`Fix the recipient data first: ${bulkProblems.slice(0, 6).join(' · ')}${bulkProblems.length > 6 ? ` · and ${bulkProblems.length - 6} more` : ''}`);
        const d = await api(`/api/envelopes/${id}/bulk-send`, { method: 'POST', body: { ...common, recipients: bulkRows.map((r) => ({ name: r.name, email: r.email, data: r.data })), attachments: bulkAttachments, message: opts.message } });
        setLinks({ emailed: d.emailed, via: d.email_via, account: d.email_account, list: d.links, bulk: true, count: d.count });
      } else {
        const missing = signers.findIndex((s) => !s.name.trim() || !s.email.trim());
        if (missing >= 0) return setError(`Signer ${missing + 1} needs a name and an email.`);
        const missKeys = requiredKeys.filter((k) => !isAutoKey(k) && !keyLookup(mergeData, k));
        if (missKeys.length) return setError(`Fill in the merge data for: ${missKeys.join(', ')}`);
        const d = await api(`/api/envelopes/${id}/send`, { method: 'POST', body: { ...common, signers, sequential: opts.sequential, cc: opts.cc, title, message: opts.message, merge: mergeData } });
        setLinks({ emailed: d.emailed, via: d.email_via, account: d.email_account, list: d.links });
      }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const saveTemplate = async () => {
    const name = prompt('Template name:', title);
    if (!name?.trim()) return;
    try {
      await api('/api/templates', { method: 'POST', body: { envelope_id: id, name: name.trim(), roles: signers.map((s, i) => ({ name: s.role || s.name || `Signer ${i + 1}`, attachments: s.attachments })), fields: fields.map(({ key: _k, ...f }) => f), options: { sequential: opts.sequential, message: opts.message, access_code: opts.access_code, expiry_days: opts.expiry_days || 0, reminder_days: opts.reminder_days || 0, cc: opts.cc } } });
      toast('Template saved');
    } catch (e) { toast(e.message, { bad: true }); }
  };

  // ---- result screen ----
  if (links) {
    return (
      <Layout>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>{links.bulk ? `Sent to ${links.count} recipient${links.count === 1 ? '' : 's'} 🎉` : 'Envelope sent 🎉'}</h2>
          <p className="muted">
            {links.emailed
              ? (opts.sequential && !links.bulk && links.list.length > 1 ? 'The first signer has been emailed. Each next signer is emailed when their turn comes. Links are listed here as a backup:' : 'Each recipient has been emailed their own signing link. The links are also listed here as a backup:')
              : 'No email route is set up yet, so share these links directly (each one is private to that signer). To send automatically, connect your inbox in Settings → Connected accounts.'}
          </p>
          {links.emailed && links.account && <p className="muted small">Emails were sent from <strong>{links.account}</strong>{links.via === 'platform' ? ' (the ShalaSign sender; replies come to you)' : links.via === 'microsoft' ? ' via your Microsoft 365 inbox' : links.via === 'google' ? ' via your Gmail' : ''}.</p>}
          {links.list.slice(0, 50).map((l) => (
            <div key={l.signing_url} style={{ marginBottom: 12 }}>
              <strong>{l.name}</strong> <span className="muted">({l.email})</span>
              <div className="copy-link">{l.signing_url}<button className="secondary" onClick={() => copyText(l.signing_url).then(() => toast('Link copied'))}>Copy</button></div>
            </div>
          ))}
          {links.list.length > 50 && <p className="muted">…and {links.list.length - 50} more. Open each document from the dashboard for its link.</p>}
          <div className="row" style={{ marginTop: 8 }}>
            <Link to={links.bulk ? '/' : `/envelope/${id}`} className="btn">{links.bulk ? 'Back to documents →' : 'Track envelope →'}</Link>
            <Link to="/" className="btn secondary">Send another</Link>
          </div>
        </div>
      </Layout>
    );
  }

  const selectedField = fields.find((f) => f.key === selected);
  const effExpiry = opts.expiry_days === '' ? defaults.expiry_days : Number(opts.expiry_days);
  const effReminder = opts.reminder_days === '' ? defaults.reminder_days : Number(opts.reminder_days);

  return (
    <Layout wide subtitle="Prepare — add signers, then click the page to place fields">
      <div className="row spread" style={{ marginBottom: 10 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Document title" style={{ fontSize: 18, fontWeight: 600, border: '1px solid transparent', background: 'transparent', padding: '4px 8px', flex: 1, minWidth: 200 }} onFocus={(e) => (e.target.style.borderColor = 'var(--border)')} onBlur={(e) => (e.target.style.borderColor = 'transparent')} />
        <span className="save-state">{saveState}{numPages ? ` · ${numPages} page${numPages > 1 ? 's' : ''}` : ''}</span>
      </div>
      <div className="editor-layout">
        <div className="sidebar">
          <div className="card tight">
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button className={!bulk ? 'active' : ''} onClick={() => { setBulk(false); setActiveSigner(0); }}>One / few signers</button>
              <button className={bulk ? 'active' : ''} onClick={() => { setBulk(true); setActiveSigner(0); setFields(fields.map((f) => ({ ...f, signerIndex: 0 }))); }}>Bulk send</button>
            </div>
          </div>

          {bulk ? (
            <div className="card">
              <h4 style={{ marginTop: 0 }}>1 · Recipients & data</h4>
              <p className="muted" style={{ marginTop: 0 }}>Each person gets their own private copy. Extra columns fill your <strong>merge fields</strong> (e.g. <code>{'{{Company}}'}</code>) per recipient.</p>
              <DataImporter rows={bulkRows} columns={bulkColumns} requiredKeys={requiredKeys.filter((k) => !isAutoKey(k))} onChange={({ rows, columns }) => { setBulkRows(rows); setBulkColumns(columns); setPreviewIdx(0); }} />
              {bulkRows.length > 1 && (
                <label className="field" style={{ marginTop: 10 }}><span>Preview document as</span>
                  <select value={previewIdx} onChange={(e) => setPreviewIdx(+e.target.value)}>{bulkRows.slice(0, 200).map((r, i) => <option key={i} value={i}>{r.name || r.email || `Row ${i + 1}`}</option>)}</select>
                </label>
              )}
              <AttachmentPicker labels={bulkAttachments} onChange={setBulkAttachments} />
            </div>
          ) : (
            <div className="card">
              <h4 style={{ marginTop: 0 }}>1 · Signers</h4>
              {signers.map((s, i) => (
                <div key={i} className={`signer-block s${i % 4}`}>
                  <div className="row spread" style={{ marginBottom: 6 }}>
                    <strong style={{ fontSize: 13, color: COLORS[i % 4] }}>{opts.sequential && signers.length > 1 ? `${i + 1}. ` : ''}{s.role || `Signer ${i + 1}`} <span className="muted">· {fieldCount(i)} field{fieldCount(i) === 1 ? '' : 's'}</span></strong>
                    <span className="row" style={{ gap: 2 }}>
                      {signers.length > 1 && opts.sequential && <><button className="ghost small" title="Move up" disabled={i === 0} onClick={() => moveSigner(i, -1)}>↑</button><button className="ghost small" title="Move down" disabled={i === signers.length - 1} onClick={() => moveSigner(i, 1)}>↓</button></>}
                      {signers.length > 1 && <button className="ghost small" title="Remove signer" onClick={() => removeSigner(i)}>×</button>}
                    </span>
                  </div>
                  <input placeholder={`Signer ${i + 1} name`} value={s.name} onChange={(e) => setSigner(i, { name: e.target.value })} />
                  <input type="email" placeholder="email@example.com" value={s.email} onChange={(e) => setSigner(i, { email: e.target.value })} />
                  <details>
                    <summary className="muted small" style={{ cursor: 'pointer' }}>Private note, role & required documents</summary>
                    <input placeholder="Role (for templates), e.g. Candidate" value={s.role || ''} onChange={(e) => setSigner(i, { role: e.target.value })} style={{ marginTop: 6 }} />
                    <input placeholder="Private message to this signer (optional)" value={s.private_message || ''} onChange={(e) => setSigner(i, { private_message: e.target.value })} />
                    <AttachmentPicker labels={s.attachments || []} onChange={(labels) => setSigner(i, { attachments: labels })} />
                  </details>
                </div>
              ))}
              <div className="row">
                {signers.length < 10 && <button className="secondary small" onClick={addSigner}>+ Add signer</button>}
              </div>
              {signers.length > 1 && (
                <label className="row" style={{ marginTop: 10, fontSize: 13, gap: 8 }}>
                  <input type="checkbox" checked={opts.sequential} onChange={(e) => setOpts({ ...opts, sequential: e.target.checked })} /> Sign in order (each signer is emailed when it is their turn)
                </label>
              )}
            </div>
          )}

          <div className="card palette">
            <h4 style={{ marginTop: 0 }}>2 · Fields</h4>
            {!bulk && signers.length > 1 && (
              <>
                <div className="muted" style={{ marginBottom: 6 }}>Placing for:</div>
                <select style={{ width: '100%', marginBottom: 12 }} value={activeSigner} onChange={(e) => setActiveSigner(+e.target.value)}>
                  {signers.map((s, i) => <option key={i} value={i}>{s.name || s.role || `Signer ${i + 1}`}</option>)}
                </select>
              </>
            )}
            {bulk && <p className="muted" style={{ marginTop: 0 }}>Fields you place apply to every recipient.</p>}
            {TOOLS.map((t) => (
              <button key={t.type} className={tool === t.type ? 'active' : ''} onClick={() => setTool(t.type)}>{t.label}</button>
            ))}
            <button className="secondary" style={{ background: '#eef5ff', color: '#1e3a8a' }} disabled={suggesting} onClick={suggestFields} title={aiStatus?.enabled ? 'Claude reads the document and proposes where signature, date and text fields go' : 'Needs your Anthropic API key (Settings → Claude & MCP)'}>{suggesting ? '✨ Reading the document…' : '✨ Suggest fields with AI'}</button>
            {suggestedCount > 0 && (
              <div className="notice" style={{ margin: '0 0 8px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ flex: 1 }}>{suggestedCount} suggested field{suggestedCount === 1 ? '' : 's'} (dashed blue). Hover one to see why.</span>
                <button className="small" onClick={acceptSuggestions}>Keep all</button><button className="secondary small" onClick={dropSuggestions}>Remove all</button>
              </div>
            )}
            <button className="secondary" style={{ background: '#fff4e0', color: '#7a4a00' }} disabled={scanning} onClick={detectTags} title="Finds {{sig:1}}, {{date:1}}, {{Company}}… typed in the document and places fields over them">{scanning ? 'Scanning…' : '🔍 Detect {{tags}} in document'}</button>
            <p className="muted">Click the document to place the selected field. Drag to move, pull the corner to resize, press Delete to remove. Type <code>{'{{Company}}'}</code> in your document and click <em>Detect tags</em> to place merge fields automatically.</p>
            {mergeKeys.length > 0 && !bulk && (
              <div className="att-req" style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Merge data</div>
                {mergeKeys.map((k) => (
                  <label key={k} className="small" style={{ display: 'block', marginBottom: 6 }}>{'{{' + k + '}}'}{requiredKeys.includes(k) && !isAutoKey(k) ? ' *' : ''}
                    <input style={{ width: '100%', marginTop: 2 }} placeholder={isAutoKey(k) ? `Defaults to signer 1's ${k.toLowerCase()}` : `Value for ${k}`} value={keyLookup(mergeData, k)} onChange={(e) => setMergeData({ ...mergeData, [k]: e.target.value })} />
                  </label>
                ))}
                <div className="hint">These values are stamped into the document and recorded in the audit trail. Switch to <em>Bulk send</em> to fill them from a spreadsheet.</div>
              </div>
            )}
            {mergeKeys.length > 0 && bulk && <p className="muted small">Merge fields: {mergeKeys.map((k) => <code key={k} style={{ marginRight: 6, color: isAutoKey(k) || bulkColumns.some((c) => c.toLowerCase() === k.toLowerCase()) ? 'var(--ok)' : 'var(--bad)' }}>{'{{' + k + '}}'}</code>)} — green = column found in your data ({'{{Name}}'} and {'{{Email}}'} come from the recipient).</p>}
            {selectedField && (
              <div className="att-req">
                <div className="row spread"><strong style={{ fontSize: 13 }}>Selected: {selectedField.type}</strong><span className="muted small">page {selectedField.page + 1}</span></div>
                {(selectedField.type === 'text' || selectedField.type === 'checkbox') && (
                  <input placeholder={selectedField.type === 'text' ? 'Label, e.g. Employee ID' : 'Label, e.g. I agree'} value={selectedField.label || ''} onChange={(e) => updateField(selected, { label: e.target.value })} style={{ width: '100%', marginTop: 6 }} />
                )}
                {selectedField.type === 'text' && (
                  <>
                    <label className="small" style={{ display: 'block', marginTop: 6 }}>Fill from data
                      <select style={{ width: '100%', marginTop: 2 }} value={selectedField.merge_key ? '__key' : ''} onChange={(e) => { if (e.target.value === '') updateField(selected, { merge_key: undefined, cover: false }); else if (e.target.value === '__new') { const k = prompt('Merge key / column name, e.g. Company'); if (k?.trim()) updateField(selected, { merge_key: k.trim().replace(/[{}]/g, ''), label: selectedField.label || k.trim(), cover: true }); } else updateField(selected, { merge_key: e.target.value, label: selectedField.label || e.target.value, cover: true }); }}>
                        <option value="">— signer types it —</option>
                        {selectedField.merge_key && <option value="__key">{'{{' + selectedField.merge_key + '}}'}</option>}
                        {bulkColumns.filter((c) => c !== selectedField.merge_key).map((c) => <option key={c} value={c}>{'{{' + c + '}}'} (from file)</option>)}
                        {mergeKeys.filter((k) => k !== selectedField.merge_key && !bulkColumns.includes(k)).map((k) => <option key={k} value={k}>{'{{' + k + '}}'}</option>)}
                        <option value="__new">+ new merge key…</option>
                      </select>
                    </label>
                    {selectedField.merge_key ? (
                      <label className="row small" style={{ marginTop: 6, gap: 6 }}><input type="checkbox" checked={!!selectedField.cover} onChange={(e) => updateField(selected, { cover: e.target.checked })} /> Hide the text underneath (white-out the {'{{tag}}'})</label>
                    ) : (
                      <input placeholder="Pre-filled value (optional)" value={selectedField.prefill || ''} onChange={(e) => updateField(selected, { prefill: e.target.value })} style={{ width: '100%', marginTop: 6 }} />
                    )}
                    <label className="row small" style={{ marginTop: 6, gap: 6 }}><input type="checkbox" checked={selectedField.required !== false} onChange={(e) => updateField(selected, { required: e.target.checked })} /> Required</label>
                  </>
                )}
                {!bulk && signers.length > 1 && (
                  <select value={selectedField.signerIndex} onChange={(e) => updateField(selected, { signerIndex: +e.target.value })} style={{ width: '100%', marginTop: 6 }}>
                    {signers.map((s, i) => <option key={i} value={i}>Assign to {s.name || s.role || `Signer ${i + 1}`}</option>)}
                  </select>
                )}
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="secondary small" onClick={() => duplicateField(selected)}>Duplicate</button>
                  <button className="danger small" onClick={() => removeField(selected)}>Delete</button>
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <h4 style={{ marginTop: 0 }}>3 · Options & send</h4>
            <label className="field"><span>Message to signers (optional)</span>
              <textarea rows={2} placeholder="Shown in the email and on the signing page" value={opts.message} onChange={(e) => setOpts({ ...opts, message: e.target.value })} />
            </label>
            <label className="field"><span>Folder</span>
              <select value={opts.folder_id} onChange={(e) => setOpts({ ...opts, folder_id: e.target.value })}>
                <option value="">— No folder —</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
            <div className="grid-2" style={{ gap: 10 }}>
              <label className="field"><span>Deadline (days)</span><input type="number" min={0} max={365} placeholder={String(defaults.expiry_days)} value={opts.expiry_days} onChange={(e) => setOpts({ ...opts, expiry_days: e.target.value })} /></label>
              <label className="field"><span>Remind every (days)</span><input type="number" min={0} max={30} placeholder={String(defaults.reminder_days)} value={opts.reminder_days} onChange={(e) => setOpts({ ...opts, reminder_days: e.target.value })} /></label>
            </div>
            <div className="hint" style={{ marginTop: -8, marginBottom: 10 }}>{effExpiry ? `Links expire ${effExpiry} day${effExpiry === 1 ? '' : 's'} after sending` : 'No deadline'}{effReminder ? ` · automatic reminders every ${effReminder} day${effReminder === 1 ? '' : 's'}` : ' · no automatic reminders'}.</div>
            <a href="#" className="small" onClick={(e) => { e.preventDefault(); setShowAdvanced(!showAdvanced); }}>{showAdvanced ? 'Hide' : 'More options'}: access code, CC</a>
            {showAdvanced && (
              <div style={{ marginTop: 10 }}>
                <label className="field"><span>Access code (optional)</span>
                  <input placeholder="e.g. a PIN you share separately" value={opts.access_code} onChange={(e) => setOpts({ ...opts, access_code: e.target.value })} />
                  <div className="hint">Signers must enter this code before they can open the document.</div>
                </label>
                {!bulk && <CcPicker cc={opts.cc} onChange={(cc) => setOpts({ ...opts, cc })} />}
              </div>
            )}
            {error && <p className="error">{error}</p>}
            <button style={{ width: '100%', marginTop: 10 }} onClick={send} disabled={busy}>{busy ? 'Sending…' : bulk ? `Send to ${validRows.length} recipient${validRows.length === 1 ? '' : 's'} →` : 'Send for signature →'}</button>
            <button className="secondary small" style={{ width: '100%', marginTop: 8 }} onClick={saveTemplate}>Save as template</button>
          </div>
        </div>

        <div className="editor-main">
          <PdfViewer
            url={`/api/envelopes/${id}/pdf`}
            onPageClick={placeField}
            onReady={setNumPages}
            pageRefs={pageRefs}
            renderOverlay={(pageIndex, size) => fields.filter((f) => f.page === pageIndex).map((f) => (
              <div
                key={f.key}
                className={`field-box s${f.signerIndex % 4} ${selected === f.key ? 'selected' : ''} ${f.merge_key ? 'merge' : ''} ${f.suggested ? 'suggested' : ''}`}
                style={{ left: f.x * size.width, top: f.y * size.height, width: f.w * size.width, height: f.h * size.height, ...(f.merge_key ? { background: f.cover ? '#fff' : 'rgba(255,244,224,0.9)', borderStyle: 'dashed', borderColor: '#c77700', color: '#1b2430', fontSize: fitFont(mergePreview(f), f.w * size.width, f.h * size.height), whiteSpace: 'nowrap', justifyContent: 'flex-start', paddingLeft: 3 } : {}) }}
                onPointerDown={(e) => startDrag(e, f.key, size, 'move')}
                onClick={(e) => { e.stopPropagation(); setSelected(f.key); }}
                title={`${f.type} · ${signers[f.signerIndex]?.name || signers[f.signerIndex]?.role || `Signer ${f.signerIndex + 1}`}${f.reason ? ` · ✨ ${f.reason}` : ''}`}
              >
                {f.merge_key ? mergePreview(f) : (<>
                  {f.label && f.type !== 'signature' ? <span className="lbl">{f.label}</span> : null}
                  {f.type}{!bulk && signers.length > 1 ? ` · ${(signers[f.signerIndex]?.name || `S${f.signerIndex + 1}`).split(' ')[0]}` : ''}
                </>)}
                <button className="del" aria-label="Remove field" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); removeField(f.key); }}>×</button>
                <span className="resize" onPointerDown={(e) => startDrag(e, f.key, size, 'resize')} />
              </div>
            ))}
          />
        </div>
      </div>
    </Layout>
  );
}

// Lets the sender require documents (Aadhaar, PAN, or custom) from one signer.
function AttachmentPicker({ labels, onChange }) {
  const [custom, setCustom] = useState('');
  const add = (label) => { const l = label.trim(); if (l && !labels.includes(l)) onChange([...labels, l]); };
  const remove = (label) => onChange(labels.filter((x) => x !== label));
  return (
    <div className="att-req">
      <div className="muted" style={{ marginBottom: 6 }}>Require documents from this signer (optional)</div>
      {labels.map((l) => <span key={l} className="att-chip">{l}<button onClick={() => remove(l)} aria-label={`Remove ${l}`}>×</button></span>)}
      <div className="row" style={{ marginTop: 6 }}>
        <button className="secondary small" onClick={() => add('Aadhaar card')}>+ Aadhaar</button>
        <button className="secondary small" onClick={() => add('PAN card')}>+ PAN</button>
        <button className="secondary small" onClick={() => add('Photo ID')}>+ Photo ID</button>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input style={{ flex: 1, fontSize: 12, padding: '5px 8px' }} placeholder="Custom document…" value={custom} onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(custom); setCustom(''); } }} />
        <button className="secondary small" onClick={() => { add(custom); setCustom(''); }}>Add</button>
      </div>
    </div>
  );
}

function CcPicker({ cc, onChange }) {
  const [email, setEmail] = useState('');
  const add = () => { const e = email.trim().toLowerCase(); if (!e || !e.includes('@') || cc.some((c) => c.email === e)) return; onChange([...cc, { name: e.split('@')[0], email: e }]); setEmail(''); };
  return (
    <div className="field">
      <span>CC — receives the completed document (optional)</span>
      {cc.map((c) => <span key={c.email} className="att-chip">{c.email}<button onClick={() => onChange(cc.filter((x) => x.email !== c.email))} aria-label="Remove">×</button></span>)}
      <div className="row" style={{ marginTop: 4 }}>
        <input type="email" style={{ flex: 1 }} placeholder="hr@company.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button className="secondary small" onClick={add}>Add</button>
      </div>
    </div>
  );
}
