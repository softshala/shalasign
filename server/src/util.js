// Small shared helpers.

/** "YYYY-MM-DD HH:MM:SS" in UTC, the format SQLite's datetime('now') uses. */
export const nowSql = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);

/** Parse a SQL-style UTC timestamp (or ISO string) back to a Date. */
export const sqlToDate = (s) => {
  if (!s) return null;
  const str = String(s);
  return new Date(str.includes('T') ? str : str.replace(' ', 'T') + 'Z');
};

export const addDays = (days, from = new Date()) => nowSql(new Date(from.getTime() + days * 864e5));

/** Client IP. With app.set('trust proxy') Express resolves X-Forwarded-For safely. */
export const clientIp = (req) => (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');

/** Escape text for inclusion in HTML (emails). */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const safeFilename = (s) => (String(s || 'document').replace(/[^\w. -]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'document');

export const actorOf = (user) => (user ? `${user.name} <${user.email}>` : 'system');

export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());

export const clampInt = (v, min, max, dflt) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

/** Tiny fixed-window rate limiter: limiter(max, windowMs) -> (key) => allowed */
export function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now - h.start > windowMs) { h = { start: now, n: 0 }; hits.set(key, h); }
    h.n += 1;
    if (hits.size > 20000) hits.clear();
    return h.n <= max;
  };
}
