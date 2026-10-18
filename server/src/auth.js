import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import db, { createOrgForUser, getOrg } from './db.js';
import { appUrl, mailEnabled, sendPasswordReset } from './mailer.js';
import { clientIp, makeLimiter, validEmail } from './util.js';

const SESSION_DAYS = 30;
const COOKIE = 'sf_session';

// Accounts created through Google/Microsoft/OTP have no password. We store this
// sentinel (bcrypt can never match it) rather than relaxing the NOT NULL column.
export const NO_PASSWORD = '!';

// Optional allow-list of email domains for accounts created via SSO / OTP,
// e.g. SSO_ALLOWED_DOMAINS=softshala.com,partner.in  (password signup is unaffected).
const ALLOWED_DOMAINS = (process.env.SSO_ALLOWED_DOMAINS || '')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

export function domainAllowed(email) {
  if (!ALLOWED_DOMAINS.length) return true;
  const domain = email.split('@')[1] || '';
  return ALLOWED_DOMAINS.includes(domain);
}

/** Find a user by email, or create a password-less one (used by SSO and OTP). */
export function findOrCreateUser(email, name) {
  const key = email.toLowerCase().trim();
  const existing = db.prepare(`SELECT * FROM users WHERE email = ?`).get(key);
  if (existing) return existing;
  if (!domainAllowed(key)) {
    const err = new Error('Accounts for this email domain are not allowed. Ask your administrator.');
    err.status = 403;
    throw err;
  }
  const id = nanoid(10);
  const displayName = (name || key.split('@')[0]).trim().slice(0, 80);
  db.prepare(`INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)`).run(id, displayName, key, NO_PASSWORD);
  createOrgForUser(id, displayName);
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

// Brute-force protection: per-email lockout after repeated failures AND a
// per-IP ceiling so one address can't lock everyone out or spray passwords.
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map(); // email -> { count, until }
const ipLimiter = makeLimiter(60, 15 * 60 * 1000);

function throttleState(email) {
  const f = fails.get(email);
  if (f && f.until && f.until > Date.now()) return f;
  return null;
}
function recordFail(email) {
  const f = fails.get(email) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  fails.set(email, f);
  if (fails.size > 10000) fails.clear();
}
function clearFails(email) { fails.delete(email); }

const publicUser = (u) => {
  const org = getOrg(u.org_id);
  return { id: u.id, name: u.name, email: u.email, has_password: u.password_hash !== NO_PASSWORD, role: u.role || 'member', org: org ? { id: org.id, name: org.name, email_mode: org.email_mode, storage_mode: org.storage_mode, visibility: org.visibility } : null };
};

export function registerAuthRoutes(app) {
  // Shared per-IP limiter for all auth endpoints.
  app.use('/api/auth', (req, res, next) => {
    if (req.method === 'GET') return next();
    if (!ipLimiter(clientIp(req))) return res.status(429).json({ error: 'Too many requests from this network. Try again in a few minutes.' });
    next();
  });

  app.post('/api/auth/signup', async (req, res) => {
    const { name, email, password, invite } = req.body || {};
    if (!name?.trim() || !email?.trim() || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
    const key = email.toLowerCase().trim();
    const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(key);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists — try logging in' });
    const id = nanoid(10);
    db.prepare(`INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)`)
      .run(id, name.trim().slice(0, 80), key, bcrypt.hashSync(password, 10));
    createOrgForUser(id, name.trim());
    let joined = null;
    if (invite) {
      try { const { acceptInvite } = await import('./orgs.js'); joined = acceptInvite(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id), String(invite)); }
      catch (e) { console.warn('[signup] invite not applied:', e.message); }
    }
    startSession(res, id);
    res.json({ ...publicUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id)), joined_org: joined ? joined.name : null });
  });

  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const key = (email || '').toLowerCase().trim();
    const locked = throttleState(key);
    if (locked) {
      const mins = Math.ceil((locked.until - Date.now()) / 60000);
      return res.status(429).json({ error: `Too many attempts. Try again in ${mins} minute(s).` });
    }
    const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(key);
    if (user && user.password_hash === NO_PASSWORD) {
      return res.status(401).json({ error: 'This account signs in with Google, Microsoft or an emailed code — it has no password. Use "Forgot password" to set one.' });
    }
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      recordFail(key);
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    clearFails(key);
    startSession(res, user.id);
    res.json(publicUser(user));
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies?.[COOKIE];
    if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  // Tells the login page which sign-in methods are configured on this server.
  app.get('/api/auth/providers', (_req, res) => {
    res.json({
      password: true,
      google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      microsoft: !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET),
      otp: mailEnabled() || !!process.env.OTP_DEV_LOG,
      password_reset: mailEnabled() || !!process.env.OTP_DEV_LOG,
    });
  });

  app.get('/api/auth/me', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    res.json(publicUser(user));
  });

  // ---- Forgot / reset password (also lets SSO users set a password) ----
  app.post('/api/auth/forgot', async (req, res) => {
    const key = String(req.body?.email || '').toLowerCase().trim();
    if (!validEmail(key)) return res.status(400).json({ error: 'Please enter a valid email address' });
    if (!mailEnabled() && !process.env.OTP_DEV_LOG) return res.status(503).json({ error: 'Password reset emails are not configured on this server. Ask your administrator.' });
    const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(key);
    // Always answer OK so the endpoint doesn't reveal which emails exist.
    if (user) {
      const raw = nanoid(40);
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(user.id);
      db.prepare(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))`).run(hash, user.id);
      const link = `${appUrl()}/reset/${raw}`;
      if (mailEnabled()) await sendPasswordReset({ to: user.email, name: user.name, link });
      else console.log(`[OTP_DEV_LOG] password reset link for ${user.email}: ${link}`);
    }
    res.json({ ok: true });
  });

  app.post('/api/auth/reset', (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const row = db.prepare(`SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')`).get(hash);
    if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(bcrypt.hashSync(password, 10), row.user_id);
    db.prepare(`UPDATE password_resets SET used = 1 WHERE token_hash = ?`).run(hash);
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(row.user_id); // log out everywhere
    startSession(res, row.user_id);
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.user_id);
    res.json(publicUser(user));
  });
}

export function startSession(res, userId) {
  const token = nanoid(40);
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, userId, expires.toISOString().replace('T', ' ').slice(0, 19));
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!process.env.COOKIE_SECURE,
    maxAge: SESSION_DAYS * 864e5,
  });
}

// Set by oauth.js at startup (avoids a circular import).
let _oauthLookup = null;
export const setOAuthLookup = (fn) => { _oauthLookup = fn; };

export function currentUser(req) {
  // 1) API key: Authorization: Bearer sf_live_xxx
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer sf_at_')) {
    const row = _oauthLookup?.(auth.slice(7).trim());
    if (row) { req.authVia = 'oauth'; return row; }
    return null;
  }
  if (auth.startsWith('Bearer sf_')) {
    const hash = crypto.createHash('sha256').update(auth.slice(7).trim()).digest('hex');
    const row = db.prepare(`SELECT u.*, k.id AS api_key_id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?`).get(hash);
    if (row) {
      db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(row.api_key_id);
      req.authVia = 'api_key';
      return row;
    }
    return null;
  }
  // 2) Session cookie
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  return db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token) || null;
}

/** Middleware: require a logged-in user (session or API key); attaches req.user. */
export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in' });
  req.user = user;
  next();
}
