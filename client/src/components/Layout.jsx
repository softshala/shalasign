import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

/** Top bar + auth guard for sender pages. Renders children once the user is known. */
export default function Layout({ children, wide = false, subtitle }) {
  const [user, setUser] = useState(null);
  const nav = useNavigate();
  useEffect(() => {
    api('/api/auth/me', { allow401: true }).then(setUser).catch(() => nav('/login'));
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
        </nav>
        {subtitle && <span className="muted hide-mobile">{subtitle}</span>}
        <span className="right">
          {user && <span className="muted hide-mobile">{user.name}</span>}
          <Link to="/settings" className="btn ghost small" title="Settings" aria-label="Settings">⚙︎</Link>
          <button className="secondary small" onClick={logout}>Log out</button>
        </span>
      </div>
      <div className={`container ${wide ? 'wide' : ''}`}>{user ? children : null}</div>
    </>
  );
}
