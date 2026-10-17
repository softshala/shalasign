import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

export default function Dashboard() {
  const [envelopes, setEnvelopes] = useState([]);
  const [folders, setFolders] = useState([]);
  const [activeFolder, setActiveFolder] = useState('all'); // 'all' | 'none' | folderId
  const [user, setUser] = useState(null);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const nav = useNavigate();

  const load = async () => {
    const me = await fetch('/api/auth/me');
    if (me.status === 401) return nav('/login');
    setUser(await me.json());
    const [e, f] = await Promise.all([fetch('/api/envelopes'), fetch('/api/folders')]);
    if (e.ok) setEnvelopes(await e.json());
    if (f.ok) setFolders(await f.json());
  };
  useEffect(() => { load(); }, []);

  const logout = async () => { await fetch('/api/auth/logout', { method: 'POST' }); nav('/login'); };

  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    const fd = new FormData();
    fd.append('pdf', file);
    fd.append('title', file.name.replace(/\.pdf$/i, ''));
    const res = await fetch('/api/envelopes', { method: 'POST', body: fd });
    if (res.status === 401) return nav('/login?error=' + encodeURIComponent('Your session has ended. Please log in again.'));
    const data = await res.json();
    if (!res.ok) return setError(data.error || 'Upload failed');
    nav(`/prepare/${data.id}`);
  };

  const newFolder = async () => {
    const name = prompt('New folder name:');
    if (!name?.trim()) return;
    await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
    load();
  };

  const shown = envelopes.filter((e) =>
    activeFolder === 'all' ? true : activeFolder === 'none' ? !e.folder_id : e.folder_id === activeFolder
  );

  return (
    <>
      <div className="topbar">
        <span className="logo">✒️ SignFlow</span>
        <span className="muted">Your documents, signed.</span>
        <span style={{ marginLeft: 'auto' }} className="row">
          {user && <span className="muted">{user.name}</span>}
          <button className="secondary" onClick={logout}>Log out</button>
        </span>
      </div>
      <div className="container">
        <div className="card row spread">
          <div>
            <h2 style={{ margin: '0 0 4px' }}>Documents</h2>
            <span className="muted">Upload a PDF to start a new signature request.</span>
          </div>
          <div>
            <input ref={fileRef} type="file" accept="application/pdf" style={{ display: 'none' }} onChange={onUpload} />
            <button onClick={() => fileRef.current.click()}>+ New document</button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}

        <div className="folder-bar">
          <span className={`folder-chip ${activeFolder === 'all' ? 'active' : ''}`} onClick={() => setActiveFolder('all')}>All ({envelopes.length})</span>
          {folders.map((f) => (
            <span key={f.id} className={`folder-chip ${activeFolder === f.id ? 'active' : ''}`} onClick={() => setActiveFolder(f.id)}>📁 {f.name} ({f.count})</span>
          ))}
          <span className={`folder-chip ${activeFolder === 'none' ? 'active' : ''}`} onClick={() => setActiveFolder('none')}>Unfiled</span>
          <span className="folder-chip" onClick={newFolder}>+ New folder</span>
        </div>

        <div className="card">
          <table>
            <thead>
              <tr><th>Document</th><th>Folder</th><th>Status</th><th>Signers</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id}>
                  <td><strong>{e.title}</strong></td>
                  <td className="muted">{e.folder_name || '—'}</td>
                  <td><span className={`pill ${e.status}`}>{e.status}</span></td>
                  <td>{e.signers_total ? `${e.signers_signed}/${e.signers_total} signed` : '—'}</td>
                  <td className="muted">{e.created_at} UTC</td>
                  <td>
                    {e.status === 'draft'
                      ? <Link to={`/prepare/${e.id}`}>Prepare →</Link>
                      : <Link to={`/envelope/${e.id}`}>View →</Link>}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr><td colSpan="6" className="muted" style={{ textAlign: 'center', padding: 30 }}>No documents here yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
