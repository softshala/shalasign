import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div style={{ minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ textAlign: 'center', maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>Page not found</h2>
        <p className="muted">The link may be wrong, or the page has moved.</p>
        <Link to="/" className="btn">Go to documents</Link>
      </div>
    </div>
  );
}
