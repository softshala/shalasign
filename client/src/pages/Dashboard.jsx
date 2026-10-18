import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout.jsx';
import { useToast } from '../components/Toast.jsx';
import { api, fmtDate, timeAgo, daysLeft, copyText } from '../api.js';

const STATUS_LABEL = { draft: 'Draft', sent: 'Awaiting signature', completed: 'Completed', voided: 'Voided', declined: 'Declined', expired: 'Expired' };

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [list, setList] = useState({ items: [], total: 0 });
  const [folders, setFolders] = useState([]);
  const [filters, setFilters] = useState({ q: '', status: 'all', folder: 'all', sort: 'created_desc' });
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const nav = useNavigate();
  const toast = useToast();
  const LIMIT = 25;

  const load = async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ ...filters, limit: LIMIT, offset: page * LIMIT });
      const [s, l, f] = await Promise.all([api('/api/envelopes/stats'), api(`/api/envelopes?${qs}`), api('/api/folders')]);
      setStats(s); setList(l); setFolders(f);
    } catch (e) { toast(e.message, { bad: true }); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [filters, page]);
  useEffect(() => { setPage(0); }, [filters.q, filters.status, filters.folder]);
  // Refresh quietly while documents are out for signature.
  useEffect(() => {
    if (!stats?.sent) return;
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [stats?.sent, filters, page]);

  const uploadFile = async (file) => {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return toast('Please choose a PDF file', { bad: true });
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('pdf', file);
      fd.append('title', file.name.replace(/\.pdf$/i, ''));
      const d = await api('/api/envelopes', { method: 'POST', formData: fd });
      nav(`/prepare/${d.id}`);
    } catch (e) { toast(e.message, { bad: true }); }
    finally { setUploading(false); }
  };

  const newFolder = async () => {
    const name = prompt('New folder name:');
    if (!name?.trim()) return;
    try { await api('/api/folders', { method: 'POST', body: { name: name.trim() } }); load(); } catch (e) { toast(e.message, { bad: true }); }
  };
  const renameFolder = async (f) => {
    const name = prompt('Rename folder:', f.name);
    if (!name?.trim() || name.trim() === f.name) return;
    try { await api(`/api/folders/${f.id}`, { method: 'PATCH', body: { name: name.trim() } }); load(); } catch (e) { toast(e.message, { bad: true }); }
  };
  const deleteFolder = async (f) => {
    if (!confirm(`Delete folder "${f.name}"? Documents inside are kept and become unfiled.`)) return;
    try { await api(`/api/folders/${f.id}`, { method: 'DELETE' }); setFilters({ ...filters, folder: 'all' }); } catch (e) { toast(e.message, { bad: true }); }
  };
  const deleteEnvelope = async (e, env) => {
    e.stopPropagation();
    if (!confirm(`Delete "${env.title}"? This cannot be undone.`)) return;
    try { await api(`/api/envelopes/${env.id}`, { method: 'DELETE' }); toast('Deleted'); load(); } catch (err) { toast(err.message, { bad: true }); }
  };
  const copyLink = async (e, env) => {
    e.stopPropagation();
    await copyText(`${window.location.origin}/envelope/${env.id}`);
    toast('Link copied');
  };

  const setStatus = (s) => setFilters({ ...filters, status: filters.status === s ? 'all' : s });
  const pages = Math.max(1, Math.ceil(list.total / LIMIT));

  return (
    <Layout subtitle="Your documents, signed.">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); uploadFile(e.dataTransfer.files?.[0]); }}
      >
        <div className="card row spread" style={{ borderColor: dragOver ? 'var(--brand)' : undefined, borderStyle: dragOver ? 'dashed' : undefined }}>
          <div>
            <h2 style={{ margin: '0 0 4px' }}>Documents</h2>
            <span className="muted">{dragOver ? 'Drop the PDF to start' : 'Upload a PDF or drop it here to start a new signature request.'}</span>
          </div>
          <div className="row">
            <Link to="/templates" className="btn secondary">Use a template</Link>
            <input ref={fileRef} type="file" accept="application/pdf,.pdf" style={{ display: 'none' }} onChange={(e) => uploadFile(e.target.files?.[0])} />
            <button onClick={() => fileRef.current.click()} disabled={uploading}>{uploading ? 'Uploading…' : '+ New document'}</button>
          </div>
        </div>

        {stats && (
          <div className="stats">
            <Stat n={stats.sent} label="Awaiting signature" active={filters.status === 'sent'} onClick={() => setStatus('sent')} />
            <Stat n={stats.completed} label="Completed" active={filters.status === 'completed'} onClick={() => setStatus('completed')} />
            <Stat n={stats.draft} label="Drafts" active={filters.status === 'draft'} onClick={() => setStatus('draft')} />
            <Stat n={stats.expiring_soon} label="Expiring in 3 days" warn={stats.expiring_soon > 0} active={false} onClick={() => setFilters({ ...filters, status: 'sent', sort: 'created_asc' })} />
            <Stat n={stats.completed_30d} label="Completed · 30 days" active={false} onClick={() => setStatus('completed')} />
            <Stat n={stats.avg_hours_to_complete == null ? '—' : stats.avg_hours_to_complete < 48 ? `${stats.avg_hours_to_complete}h` : `${Math.round(stats.avg_hours_to_complete / 24)}d`} label="Avg. time to sign" active={false} onClick={() => {}} />
          </div>
        )}

        <div className="toolbar">
          <input type="search" placeholder="Search by title, signer name or email…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} aria-label="Search documents" />
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="Status filter">
            <option value="all">All statuses</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value })} aria-label="Sort">
            <option value="created_desc">Newest first</option>
            <option value="created_asc">Oldest first</option>
            <option value="title">Title A–Z</option>
            <option value="status">By status</option>
          </select>
        </div>

        <div className="folder-bar">
          <button className={`folder-chip ${filters.folder === 'all' ? 'active' : ''}`} onClick={() => setFilters({ ...filters, folder: 'all' })}>All</button>
          {folders.map((f) => (
            <button key={f.id} className={`folder-chip ${filters.folder === f.id ? 'active' : ''}`} onClick={() => setFilters({ ...filters, folder: f.id })}
              onDoubleClick={() => renameFolder(f)} title="Double-click to rename">📁 {f.name} ({f.count})</button>
          ))}
          <button className={`folder-chip ${filters.folder === 'none' ? 'active' : ''}`} onClick={() => setFilters({ ...filters, folder: 'none' })}>Unfiled</button>
          <button className="folder-chip" onClick={newFolder}>+ New folder</button>
          {filters.folder !== 'all' && filters.folder !== 'none' && (
            <button className="ghost small" onClick={() => deleteFolder(folders.find((f) => f.id === filters.folder))}>Delete folder</button>
          )}
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Document</th>{list.shows_workspace && <th className="hide-mobile">Sent by</th>}<th>Signers</th><th>Status</th><th className="hide-mobile">Folder</th><th>Updated</th><th></th></tr>
              </thead>
              <tbody>
                {list.items.map((e) => {
                  const left = e.status === 'sent' ? daysLeft(e.expires_at) : null;
                  const href = e.status === 'draft' ? `/prepare/${e.id}` : `/envelope/${e.id}`;
                  return (
                    <tr key={e.id} className="clickable" onClick={() => nav(href)}>
                      <td>
                        <strong>{e.title}</strong>
                        <div className="muted small">{e.page_count ? `${e.page_count} page${e.page_count > 1 ? 's' : ''}` : ''}{e.template_id ? ' · from template' : ''}{e.archive_url ? ' · ☁️ archived' : ''}</div>
                      </td>
                      {list.shows_workspace && <td className="muted hide-mobile">{e.mine ? 'You' : e.owner_name}</td>}
                      <td>
                        {e.signers_total ? (<>
                          <div>{e.signers_signed}/{e.signers_total} signed</div>
                          <div className="muted small">{e.status === 'sent' && e.waiting_on ? `Waiting on ${e.waiting_on}` : e.signer_names}</div>
                        </>) : <span className="muted">—</span>}
                      </td>
                      <td>
                        <span className={`pill ${e.status}`}>{STATUS_LABEL[e.status] || e.status}</span>
                        {e.seal_error && <div className="error small" style={{ margin: '4px 0 0' }}>Sealing failed — open to retry</div>}
                        {left != null && left <= 3 && <div className={`small ${left <= 0 ? 'error' : ''}`} style={{ color: left > 0 ? 'var(--warn)' : undefined, margin: '4px 0 0' }}>{left <= 0 ? 'Deadline passed' : `Due in ${left} day${left === 1 ? '' : 's'}`}</div>}
                      </td>
                      <td className="muted hide-mobile">{e.folder_name || '—'}</td>
                      <td className="muted" title={fmtDate(e.completed_at || e.sent_at || e.created_at)}>{timeAgo(e.completed_at || e.sent_at || e.created_at)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <Link to={href} onClick={(ev) => ev.stopPropagation()}>{e.status === 'draft' ? 'Prepare →' : 'View →'}</Link>
                        {e.status !== 'draft' && <button className="ghost small" title="Copy link to this page" onClick={(ev) => copyLink(ev, e)}>⧉</button>}
                        {['draft', 'voided', 'declined', 'expired'].includes(e.status) && <button className="ghost small" title="Delete" onClick={(ev) => deleteEnvelope(ev, e)}>🗑</button>}
                      </td>
                    </tr>
                  );
                })}
                {!loading && list.items.length === 0 && (
                  <tr><td colSpan={list.shows_workspace ? 7 : 6}>
                    <div className="empty">
                      <div style={{ fontSize: 34 }}>📄</div>
                      <h3>{filters.q || filters.status !== 'all' || filters.folder !== 'all' ? 'No documents match' : 'No documents yet'}</h3>
                      <p>{filters.q || filters.status !== 'all' || filters.folder !== 'all' ? 'Try clearing the search or filters.' : 'Upload a PDF to send your first signature request.'}</p>
                    </div>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {list.total > LIMIT && (
            <div className="row spread" style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
              <span className="muted">{list.total} documents</span>
              <span className="row">
                <button className="secondary small" disabled={page === 0} onClick={() => setPage(page - 1)}>← Prev</button>
                <span className="muted">Page {page + 1} of {pages}</span>
                <button className="secondary small" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next →</button>
              </span>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

function Stat({ n, label, onClick, active, warn }) {
  return (
    <div className={`stat ${active ? 'active' : ''}`} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="n" style={{ color: warn ? 'var(--warn)' : undefined }}>{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}
