// Tiny fetch wrapper: JSON in/out, friendly errors, and a redirect to /login
// when the session has ended (instead of a dead "Please log in" message).
export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

export function sessionExpired() {
  window.location.assign('/login?error=' + encodeURIComponent('Your session has ended. Please log in again.'));
}

export async function api(path, { method = 'GET', body, headers = {}, formData, raw = false, allow401 = false } = {}) {
  const opts = { method, headers: { ...headers } };
  if (formData) opts.body = formData;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); }
  catch { throw new ApiError('Network error — check your connection and try again.', 0); }
  if (res.status === 401 && !allow401 && !path.startsWith('/api/sign/') && !path.startsWith('/api/auth/')) { sessionExpired(); throw new ApiError('Session ended', 401); }
  if (raw) return res;
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

export const fmtDate = (sql, { time = true } = {}) => {
  if (!sql) return '—';
  const d = new Date(String(sql).includes('T') ? sql : String(sql).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(sql);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}) });
};

export const timeAgo = (sql) => {
  if (!sql) return '';
  const d = new Date(String(sql).includes('T') ? sql : String(sql).replace(' ', 'T') + 'Z');
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(sql, { time: false });
};

export const daysLeft = (sql) => {
  if (!sql) return null;
  const d = new Date(String(sql).replace(' ', 'T') + 'Z');
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
};

/** Font size (px) so `text` fits on one line in a box of w×h px; mirrors the server's shrink-to-fit stamping. */
export function fitFont(text, w, h, { max = 14, min = 7 } = {}) {
  const byH = h * 0.62;
  const byW = text ? (w - 6) / (String(text).length * 0.55) : byH;
  return Math.max(min, Math.min(max, byH, byW));
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); return true; } catch { return false; } finally { ta.remove(); }
  }
}
