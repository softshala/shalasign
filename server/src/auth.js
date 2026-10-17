import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import db from './db.js';

const SESSION_DAYS = 30;
const COOKIE = 'sf_session';

// Simple in-memory brute-force protection: after too many failed logins for an
// email, lock that email for a cooldown window.
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map(); // email -> { count, until }

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
}
function clearFails(email) { fails.delete(email); }

export function registerAuthRoutes(app) {
  app.post('/api/auth/signup', (req, res) => {
    const { name, email, password } = req.body || {};
    if (!name?.trim() || !email?.trim() || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
    const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'An account with this email already exists — try logging in' });
    const id = nanoid(10);
    db.prepare(`INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)`)
      .run(id, name.trim(), email.toLowerCase().trim(), bcrypt.hashSync(password, 10));
    startSession(res, id);
    res.json({ id, name: name.trim(), email: email.toLowerCase().trim() });
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
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      recordFail(key);
      return res.status(401).json({ error: 'Wrong email or password' });
    }
    clearFails(key);
    startSession(res, user.id);
    res.json({ id: user.id, name: user.name, email: user.email });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies?.[COOKIE];
    if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    res.json({ id: user.id, name: user.name, email: user.email });
  });
}

function startSession(res, userId) {
  const token = nanoid(40);
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .run(token, userId, expires.toISOString());
  // Clean up expired sessions opportunistically.
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!process.env.COOKIE_SECURE, // set COOKIE_SECURE=1 once the app runs on https
    maxAge: SESSION_DAYS * 864e5,
  });
}

export function currentUser(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  return db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token) || null;
}

/** Middleware: require a logged-in user; attaches req.user. */
export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in' });
  req.user = user;
  next();
}
