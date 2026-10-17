// Passwordless login with a one-time code sent by email.
//
//   POST /api/auth/otp/request { email }          -> emails a 6-digit code
//   POST /api/auth/otp/verify  { email, code, name? } -> logs in (creates the account if new)
//
// Codes live 10 minutes, allow 5 wrong attempts, can be re-requested once per
// minute and at most 6 times per hour per email. Only a SHA-256 of the code is
// stored. Requires SMTP; set OTP_DEV_LOG=1 to print codes to the console
// instead while developing locally.
import crypto from 'crypto';
import db from './db.js';
import { mailEnabled, sendLoginCode } from './mailer.js';
import { startSession, findOrCreateUser, domainAllowed } from './auth.js';

const TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const MAX_PER_HOUR = 6;
const MAX_PER_IP_PER_HOUR = 30;

export const otpEnabled = () => mailEnabled() || !!process.env.OTP_DEV_LOG;

const hashCode = (email, code) => crypto.createHash('sha256').update(`${email}:${code}`).digest('hex');
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

// Per-IP request throttle (in memory; resets on restart, which is fine here).
const ipHits = new Map(); // ip -> [timestamps]
function ipAllowed(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600e3);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) ipHits.clear(); // crude memory cap
  return hits.length <= MAX_PER_IP_PER_HOUR;
}

export function registerOtpRoutes(app) {
  app.post('/api/auth/otp/request', async (req, res) => {
    if (!otpEnabled()) return res.status(503).json({ error: 'Email code login is not configured on this server (SMTP settings missing).' });
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
    if (!ipAllowed(clientIp(req))) return res.status(429).json({ error: 'Too many requests. Try again later.' });

    const existingUser = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
    if (!existingUser && !domainAllowed(email)) {
      return res.status(403).json({ error: 'Accounts for this email domain are not allowed. Ask your administrator.' });
    }

    db.prepare(`DELETE FROM login_codes WHERE expires_at < datetime('now')`).run();
    const recent = db.prepare(
      `SELECT COUNT(*) n, MAX(created_at) last FROM login_codes WHERE email = ? AND created_at > datetime('now', '-1 hour')`
    ).get(email);
    if (recent.n >= MAX_PER_HOUR) return res.status(429).json({ error: 'Too many codes requested for this email. Try again in an hour.' });
    if (recent.last && Date.now() - Date.parse(recent.last.replace(' ', 'T') + 'Z') < RESEND_SECONDS * 1000) {
      return res.status(429).json({ error: `Please wait ${RESEND_SECONDS} seconds before requesting another code.` });
    }

    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    db.prepare(`DELETE FROM login_codes WHERE email = ? AND used = 0`).run(email);
    db.prepare(`INSERT INTO login_codes (email, code_hash, expires_at) VALUES (?, ?, datetime('now', '+${TTL_MIN} minutes'))`)
      .run(email, hashCode(email, code));

    if (mailEnabled()) {
      const r = await sendLoginCode({ to: email, code, minutes: TTL_MIN });
      if (!r.sent) return res.status(502).json({ error: 'Could not send the email. Check the server\'s SMTP settings.' });
    } else {
      console.log(`[OTP_DEV_LOG] login code for ${email}: ${code}`);
    }
    res.json({ ok: true, new_account: !existingUser, expires_in_minutes: TTL_MIN });
  });

  app.post('/api/auth/otp/verify', (req, res) => {
    if (!otpEnabled()) return res.status(503).json({ error: 'Email code login is not configured on this server.' });
    const email = String(req.body?.email || '').toLowerCase().trim();
    const code = String(req.body?.code || '').replace(/\D/g, '');
    if (!validEmail(email) || code.length !== 6) return res.status(400).json({ error: 'Enter your email and the 6-digit code' });

    const row = db.prepare(
      `SELECT * FROM login_codes WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1`
    ).get(email);
    if (!row || Date.parse(row.expires_at.replace(' ', 'T') + 'Z') < Date.now()) {
      return res.status(400).json({ error: 'That code has expired. Request a new one.' });
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      db.prepare(`DELETE FROM login_codes WHERE id = ?`).run(row.id);
      return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.' });
    }

    const expected = Buffer.from(row.code_hash, 'hex');
    const given = Buffer.from(hashCode(email, code), 'hex');
    if (!crypto.timingSafeEqual(expected, given)) {
      db.prepare(`UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?`).run(row.id);
      const left = MAX_ATTEMPTS - row.attempts - 1;
      return res.status(401).json({ error: left > 0 ? `Wrong code. ${left} attempt(s) left.` : 'Wrong code. Request a new one.' });
    }

    db.prepare(`UPDATE login_codes SET used = 1 WHERE id = ?`).run(row.id);
    try {
      const user = findOrCreateUser(email, String(req.body?.name || '').trim());
      startSession(res, user.id);
      res.json({ id: user.id, name: user.name, email: user.email });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}
