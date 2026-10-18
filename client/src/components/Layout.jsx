import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import Assistant from './Assistant.jsx';

/** Top bar + auth guard for sender pages. Renders children once the user is known. */
export default function Layout({ children, wide = false, subtitle }) {
  const [user, setUser] = useState(null);
  const nav = useNavigate();
  useEffect(() => {
    api('/api/auth/me', { allow401: true }).then(async (u) => {
      setUser(u);
      // Operators on a fresh install go through the first-run wizard once.
      if (u.is_operator && window.location.pathname === '/') {
        try { const p = await api('/api/platform/public'); if (p.needs_setup) nav('/setup'); } catch { /* ignore */ }
      }
    }).catch(() => nav('/login'));
  }, []);
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }); nav('/login'); };
  return (
    <>
      <div className="topbar">
        <Link className="logo" to="/">✒️ SignFlow</Link>
        <nav className="nav hide-mobile">
          <NavLink to="/" end>Documents</NavLink>
          <NavLink to="/templates">Templates</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          {user?.is_operator && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        {subtitle && <span className="muted hide-mobile">{subtitle}</span>}
        <span className="right">
          {user && <span className="muted hide-mobile" title={user.org?.name}>{user.name}{user.org ? ` · ${user.org.name}` : ''}</span>}
          <Link to="/settings" className="btn ghost small" title="Settings" aria-label="Settings">⚙︎</Link>
          <button className="secondary small" onClick={logout}>Log out</button>
        </span>
      </div>
      <div className={`container ${wide ? 'wide' : ''}`}>{user ? children : null}</div>
      {user && <Assistant />}
    </>
  );
}
