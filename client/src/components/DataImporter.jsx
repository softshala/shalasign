import { useMemo, useRef, useState } from 'react';

/**
 * Recipient data for bulk send: upload Excel/CSV or paste rows, map the Name and
 * Email columns, see validation per row. Emits onChange({ rows, columns }) where
 * rows = [{ name, email, data: {col: value} }] and columns = the extra (merge) columns.
 *
 * props: rows, columns, requiredKeys (merge keys used by fields), onChange
 */
export default function DataImporter({ rows, columns, requiredKeys = [], onChange }) {
  const [raw, setRaw] = useState(null);          // { headers: [], records: [][] , source }
  const [map, setMap] = useState({ name: '', email: '' });
  const [paste, setPaste] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const guess = (headers, wanted) => headers.find((h) => wanted.some((w) => h.toLowerCase().replace(/[^a-z]/g, '') === w)) || headers.find((h) => wanted.some((w) => h.toLowerCase().includes(w))) || '';

  const ingest = (headers, records, source) => {
    headers = headers.map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
    const name = guess(headers, ['name', 'fullname', 'signer', 'recipient', 'employee']);
    const email = guess(headers, ['email', 'emailaddress', 'mail']);
    setRaw({ headers, records, source }); setMap({ name, email }); setErr('');
    emit(headers, records, { name, email });
  };

  const emit = (headers, records, m) => {
    if (!m.name || !m.email) { onChange({ rows: [], columns: headers.filter((h) => h !== m.name && h !== m.email) }); return; }
    const ni = headers.indexOf(m.name), ei = headers.indexOf(m.email);
    const extra = headers.filter((h) => h !== m.name && h !== m.email);
    const out = records.filter((r) => r.some((c) => String(c ?? '').trim() !== '')).map((r) => ({
      name: String(r[ni] ?? '').trim(), email: String(r[ei] ?? '').trim().toLowerCase(),
      data: Object.fromEntries(extra.map((h) => [h, String(r[headers.indexOf(h)] ?? '').trim()])),
    }));
    onChange({ rows: out, columns: extra });
  };

  const onFile = async (file) => {
    if (!file) return;
    setBusy(true); setErr('');
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('File is too large (max 5 MB).');
      const isCsv = /\.(csv|txt|tsv)$/i.test(file.name) || /text\/(csv|plain|tab)/.test(file.type);
      if (isCsv) {
        const text = (await file.text()).replace(/^﻿/, '');
        const recs = parseCsv(text);
        if (recs.length < 2) throw new Error('The file needs a header row plus at least one data row.');
        ingest(recs[0], recs.slice(1), file.name);
      } else if (/\.(xlsx|xlsm|xls|ods)$/i.test(file.name) || /spreadsheet|excel/.test(file.type)) {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const recs = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
        const nonEmpty = recs.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
        if (nonEmpty.length < 2) throw new Error('The first sheet needs a header row plus at least one data row.');
        ingest(nonEmpty[0], nonEmpty.slice(1), `${file.name} · sheet "${wb.SheetNames[0]}"`);
      } else throw new Error('Please upload an Excel (.xlsx) or CSV file.');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const usePaste = () => {
    const recs = parseCsv(paste.trim());
    if (!recs.length) return;
    // Pasted lines without a header: treat as Name, Email[, extra…]
    const looksLikeHeader = recs[0].some((c) => /name|email/i.test(c)) && !recs[0].some((c) => c.includes('@'));
    if (looksLikeHeader) ingest(recs[0], recs.slice(1), 'pasted');
    else {
      const width = Math.max(...recs.map((r) => r.length));
      const headers = ['Name', 'Email', ...Array.from({ length: Math.max(0, width - 2) }, (_, i) => `Column ${i + 3}`)];
      // Allow "email only" or "email, name" orderings per row.
      const fixed = recs.map((r) => (r.length === 1 && r[0].includes('@') ? [r[0].split('@')[0], r[0]] : r[0]?.includes('@') && !r[1]?.includes('@') ? [r[1] || r[0].split('@')[0], r[0], ...r.slice(2)] : r));
      ingest(headers, fixed, 'pasted');
    }
  };

  const remap = (m) => { setMap(m); if (raw) emit(raw.headers, raw.records, m); };

  // ---- validation ----
  const issues = useMemo(() => {
    const seen = new Set(); const out = [];
    rows.forEach((r, i) => {
      const probs = [];
      if (!r.name) probs.push('no name');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) probs.push('invalid email');
      else if (seen.has(r.email)) probs.push('duplicate email');
      seen.add(r.email);
      for (const k of requiredKeys) {
        const col = Object.keys(r.data).find((c) => c.toLowerCase() === k.toLowerCase());
        if (!col) probs.push(`no column "${k}"`); else if (!r.data[col]) probs.push(`${k} empty`);
      }
      if (probs.length) out.push({ row: i + 1, probs });
    });
    return out;
  }, [rows, requiredKeys]);
  const missingColumns = requiredKeys.filter((k) => !columns.some((c) => c.toLowerCase() === k.toLowerCase()));

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm,.ods,.csv,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />
        <button className="secondary small" disabled={busy} onClick={() => fileRef.current.click()}>{busy ? 'Reading…' : '📄 Upload Excel / CSV'}</button>
        <span className="muted small">Header row with <strong>Name</strong>, <strong>Email</strong> and one column per merge field.</span>
      </div>
      {!raw && (
        <>
          <textarea style={{ width: '100%', minHeight: 90, fontFamily: 'Menlo, Consolas, monospace', fontSize: 12 }} placeholder={'…or paste rows:\nAsha Verma, asha@example.com, Acme Pvt Ltd\nRohit Jain, rohit@example.com, Globex'} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="row spread" style={{ marginTop: 4 }}><span className="muted small">Name, Email, then extra columns in the order of your merge fields.</span><button className="secondary small" onClick={usePaste} disabled={!paste.trim()}>Use pasted rows</button></div>
        </>
      )}
      {err && <p className="error">{err}</p>}

      {raw && (
        <>
          <div className="row spread" style={{ marginTop: 4 }}>
            <span className="muted small">Source: {raw.source} · {raw.records.length} row{raw.records.length === 1 ? '' : 's'}</span>
            <button className="ghost small" onClick={() => { setRaw(null); setPaste(''); onChange({ rows: [], columns: [] }); }}>Clear</button>
          </div>
          <div className="row" style={{ marginTop: 6, gap: 8 }}>
            <label className="small">Name column <select value={map.name} onChange={(e) => remap({ ...map, name: e.target.value })}><option value="">—</option>{raw.headers.map((h) => <option key={h} value={h}>{h}</option>)}</select></label>
            <label className="small">Email column <select value={map.email} onChange={(e) => remap({ ...map, email: e.target.value })}><option value="">—</option>{raw.headers.map((h) => <option key={h} value={h}>{h}</option>)}</select></label>
          </div>
          {(!map.name || !map.email) && <p className="error small">Choose which columns hold the recipient's name and email.</p>}
          {columns.length > 0 && <p className="muted small" style={{ margin: '6px 0' }}>Merge columns available: {columns.map((c) => <code key={c} style={{ marginRight: 6 }}>{`{{${c}}}`}</code>)}</p>}
          {missingColumns.length > 0 && <p className="error small">Your fields use {missingColumns.map((k) => `{{${k}}}`).join(', ')} but the file has no such column.</p>}
          {rows.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginTop: 6 }}>
              <table style={{ fontSize: 12 }}>
                <thead><tr><th>#</th><th>Name</th><th>Email</th>{columns.slice(0, 6).map((c) => <th key={c}>{c}</th>)}{columns.length > 6 && <th>…</th>}<th></th></tr></thead>
                <tbody>
                  {rows.slice(0, 200).map((r, i) => {
                    const iss = issues.find((x) => x.row === i + 1);
                    return (
                      <tr key={i} style={iss ? { background: '#fff4f4' } : undefined}>
                        <td className="muted">{i + 1}</td><td>{r.name || <span className="error">—</span>}</td><td>{r.email || <span className="error">—</span>}</td>
                        {columns.slice(0, 6).map((c) => <td key={c}>{r.data[c] || <span className="muted">—</span>}</td>)}{columns.length > 6 && <td className="muted">…</td>}
                        <td>{iss ? <span className="error small">{iss.probs.join(', ')}</span> : <span style={{ color: 'var(--ok)' }}>✓</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.length > 200 && <p className="muted small" style={{ padding: 8 }}>Showing the first 200 of {rows.length} rows.</p>}
            </div>
          )}
          <p className={`small ${issues.length ? 'error' : 'muted'}`} style={{ marginTop: 6 }}>
            {issues.length ? `${issues.length} row${issues.length === 1 ? ' has' : 's have'} problems — fix the file or they will block sending.` : rows.length ? `All ${rows.length} rows look good.` : ''}
          </p>
        </>
      )}
    </div>
  );
}

/** Minimal RFC-4180-ish CSV parser (handles quotes, commas/tabs/semicolons, CRLF). */
export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const delim = (text.split('\n')[0] || '').includes('\t') ? '\t' : (text.split('\n')[0] || '').split(';').length > (text.split('\n')[0] || '').split(',').length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}
