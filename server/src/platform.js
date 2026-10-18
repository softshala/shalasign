// Platform-level configuration, editable from the browser by the operator
// (the first account, or anyone listed in OPERATOR_EMAILS). Values are stored
// in SQLite — secrets encrypted — and override environment variables, which
// remain as a fallback for Docker-style deployments.
import db from './db.js';
import { encStr, decStr } from './crypto.js';
import { requireAuth } from './auth.js';
import { esc, validEmail } from './util.js';

// key -> { env, secret }
const KEYS = {
  platform_name: { env: null }, public_url: { env: 'APP_URL' }, trust_proxy: { env: 'TRUST_PROXY' }, setup_done: { env: null }, detected_url: { env: null },
  smtp_host: { env: 'SMTP_HOST' }, smtp_port: { env: 'SMTP_PORT' }, smtp_user: { env: 'SMTP_USER' }, smtp_pass: { env: 'SMTP_PASS', secret: true }, from_email: { env: 'FROM_EMAIL' },
  google_client_id: { env: 'GOOGLE_CLIENT_ID' }, google_client_secret: { env: 'GOOGLE_CLIENT_SECRET', secret: true },
  ms_client_id: { env: 'MS_CLIENT_ID' }, ms_client_secret: { env: 'MS_CLIENT_SECRET', secret: true }, ms_tenant: { env: 'MS_TENANT' },
  sso_allowed_domains: { env: 'SSO_ALLOWED_DOMAINS' }, signup_mode: { env: null },
  assistant_shared_key: { env: 'ANTHROPIC_API_KEY', secret: true }, assistant_shared: { env: 'ASSISTANT_SHARED_KEY' }, assistant_model: { env: 'ASSISTANT_MODEL' },
  archive_timezone: { env: 'ONEDRIVE_TIMEZONE' },
};
const DEFAULTS = { platform_name: 'SignFlow', trust_proxy: 'auto', signup_mode: 'open', ms_tenant: 'common', assistant_model: 'claude-opus-5-5', archive_timezone: 'Asia/Kolkata', smtp_port: '465' };

let cache = null;
function load() {
  if (cache) return cache;
  const rows = db.prepare(`SELECT key, value, encrypted FROM platform_settings`).all();
  const fromDb = Object.fromEntries(rows.map((r) => [r.key, r.encrypted ? decStr(r.value) : r.value]));
  cache = {};
  for (const [k, meta] of Object.entries(KEYS)) {
    const v = fromDb[k] !== undefined && fromDb[k] !== null && fromDb[k] !== '' ? fromDb[k] : meta.env && process.env[meta.env] ? process.env[meta.env] : DEFAULTS[k] ?? '';
    cache[k] = v;
  }
  cache._sources = Object.fromEntries(Object.entries(KEYS).map(([k, meta]) => [k, fromDb[k] ? 'ui' : meta.env && process.env[meta.env] ? 'env' : 'default']));
  return cache;
}
export const platform = () => load();
export const setting = (k) => load()[k];

export function savePlatform(patch) {
  const up = db.prepare(`INSERT INTO platform_settings (key, value, encrypted, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = datetime('now')`);
  const del = db.prepare(`DELETE FROM platform_settings WHERE key = ?`);
  for (const [k, raw] of Object.entries(patch)) {
    if (!KEYS[k]) continue;
    const v = raw === null || raw === undefined ? '' : String(raw).trim();
    if (v === '') { del.run(k); continue; }
    up.run(k, KEYS[k].secret ? encStr(v) : v, KEYS[k].secret ? 1 : 0);
  }
  cache = null;
}

/** Public base URL: explicit override → env → the origin seen on real requests → localhost. */
export function publicUrl() {
  const p = load();
  return (p.public_url || p.detected_url || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
}

/** Learn the public origin from incoming requests (ignores localhost/private hosts). */
export function rememberOrigin(req) {
  try {
    const host = req.get('host'); if (!host) return;
    if (/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(host) || /^0\.0\.0\.0/.test(host)) return;
    const origin = `${req.protocol}://${host}`;
    const p = load();
    if (p.public_url) return; // explicit override wins
    if (p.detected_url === origin) return;
    if (p.detected_url && p.detected_url.startsWith('https://') && origin.startsWith('http://')) return; // never downgrade
    savePlatform({ detected_url: origin });
  } catch { /* ignore */ }
}

export const isOperator = (user) => !!user?.is_operator || (process.env.OPERATOR_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean).includes((user?.email || '').toLowerCase());

export function smtpConfig() {
  const p = load();
  if (!(p.smtp_host && p.smtp_user && p.smtp_pass)) return null;
  return { host: p.smtp_host, port: Number(p.smtp_port || 465), user: p.smtp_user, pass: p.smtp_pass, from: p.from_email || p.smtp_user };
}
export const googleConfig = () => { const p = load(); return p.google_client_id && p.google_client_secret ? { clientId: p.google_client_id, clientSecret: p.google_client_secret } : null; };
export const microsoftConfig = () => { const p = load(); return p.ms_client_id && p.ms_client_secret ? { clientId: p.ms_client_id, clientSecret: p.ms_client_secret, tenant: p.ms_tenant || 'common' } : null; };
export const allowedDomains = () => String(load().sso_allowed_domains || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
export const sharedAssistantKey = () => { const p = load(); return p.assistant_shared === '1' && p.assistant_shared_key ? p.assistant_shared_key : null; };

/** Overall setup state (for the wizard, the operator console and /api/health). */
export function setupStatus() {
  const p = load();
  const operator = db.prepare(`SELECT COUNT(*) n FROM users WHERE is_operator = 1`).get().n;
  return {
    platform_name: p.platform_name, public_url: publicUrl(), url_source: p._sources.public_url === 'ui' ? 'override' : p._sources.public_url === 'env' ? 'env' : p.detected_url ? 'detected' : 'localhost',
    email: !!smtpConfig(), google: !!googleConfig(), microsoft: !!microsoftConfig(), ms_tenant: p.ms_tenant,
    signup_mode: p.signup_mode, allowed_domains: allowedDomains(), assistant_shared: !!sharedAssistantKey(),
    operator_exists: operator > 0, setup_done: p.setup_done === '1', trust_proxy: p.trust_proxy,
    sources: p._sources,
  };
}

const PRESETS = {
  gmail: { smtp_host: 'smtp.gmail.com', smtp_port: '465', note: 'Use an App Password (Google account → Security → 2-Step Verification → App passwords).' },
  microsoft365: { smtp_host: 'smtp.office365.com', smtp_port: '587', note: 'The mailbox needs "Authenticated SMTP" enabled by a Microsoft 365 admin.' },
  brevo: { smtp_host: 'smtp-relay.brevo.com', smtp_port: '587', note: 'Free 300 emails/day. User = your Brevo login, password = an SMTP key.' },
  resend: { smtp_host: 'smtp.resend.com', smtp_port: '465', note: 'User is literally "resend", password = your Resend API key. Verify your sending domain first.' },
  custom: { smtp_host: '', smtp_port: '587', note: '' },
};

export function registerPlatformRoutes(app) {
  const requireOperator = (req, res, next) => (isOperator(req.user) ? next() : res.status(403).json({ error: 'Only the platform operator can do this' }));

  // Public: enough for the login/setup pages to decide what to show.
  app.get('/api/platform/public', (_req, res) => {
    const s = setupStatus();
    res.json({ platform_name: s.platform_name, needs_setup: !s.setup_done, operator_exists: s.operator_exists, signup_mode: s.signup_mode, email: s.email, google: s.google, microsoft: s.microsoft });
  });

  app.get('/api/platform', requireAuth, requireOperator, (req, res) => {
    const p = load(); const s = setupStatus();
    const redirect = (prov) => [`${publicUrl()}/api/auth/sso/${prov}/callback`, `${publicUrl()}/api/connect/${prov}/callback`];
    res.json({
      status: s, presets: PRESETS,
      values: {
        platform_name: p.platform_name, public_url: p.public_url, trust_proxy: p.trust_proxy, signup_mode: p.signup_mode, sso_allowed_domains: p.sso_allowed_domains, archive_timezone: p.archive_timezone,
        smtp_host: p.smtp_host, smtp_port: p.smtp_port, smtp_user: p.smtp_user, smtp_pass_set: !!p.smtp_pass, from_email: p.from_email,
        google_client_id: p.google_client_id, google_client_secret_set: !!p.google_client_secret,
        ms_client_id: p.ms_client_id, ms_client_secret_set: !!p.ms_client_secret, ms_tenant: p.ms_tenant,
        assistant_shared: p.assistant_shared === '1', assistant_shared_key_set: !!p.assistant_shared_key, assistant_model: p.assistant_model,
      },
      redirect_uris: { google: redirect('google'), microsoft: redirect('microsoft') },
      operators: db.prepare(`SELECT id, name, email FROM users WHERE is_operator = 1 ORDER BY created_at`).all(),
    });
  });

  app.put('/api/platform', requireAuth, requireOperator, (req, res) => {
    const b = req.body || {};
    const patch = {};
    const str = (k, max = 300) => { if (b[k] !== undefined) patch[k] = String(b[k] ?? '').slice(0, max); };
    ['platform_name', 'smtp_host', 'smtp_user', 'from_email', 'google_client_id', 'ms_client_id', 'sso_allowed_domains', 'archive_timezone', 'assistant_model'].forEach((k) => str(k));
    ['smtp_pass', 'google_client_secret', 'ms_client_secret', 'assistant_shared_key'].forEach((k) => { if (b[k] !== undefined && b[k] !== '••••••••') str(k, 500); });
    if (b.smtp_port !== undefined) patch.smtp_port = String(parseInt(b.smtp_port, 10) || 465);
    if (b.ms_tenant !== undefined) patch.ms_tenant = String(b.ms_tenant || 'common').trim().slice(0, 80);
    if (b.public_url !== undefined) { const u = String(b.public_url || '').trim().replace(/\/$/, ''); if (u && !/^https?:\/\/[^\s/]+$/.test(u)) return res.status(400).json({ error: 'Public URL must look like https://sign.example.com' }); patch.public_url = u; }
    if (b.trust_proxy !== undefined) patch.trust_proxy = ['auto', 'on', 'off'].includes(b.trust_proxy) ? b.trust_proxy : 'auto';
    if (b.signup_mode !== undefined) patch.signup_mode = ['open', 'invite_only'].includes(b.signup_mode) ? b.signup_mode : 'open';
    if (b.assistant_shared !== undefined) patch.assistant_shared = b.assistant_shared ? '1' : '';
    if (b.setup_done !== undefined) patch.setup_done = b.setup_done ? '1' : '';
    if (patch.from_email && !/^(.+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(patch.from_email)) return res.status(400).json({ error: 'From address must be an email, optionally as "Name <email>"' });
    savePlatform(patch);
    res.json({ ok: true, status: setupStatus() });
  });

  // Send a test email through the platform sender to the operator.
  app.post('/api/platform/test-email', requireAuth, requireOperator, async (req, res) => {
    const { sendPlatformTest } = await import('./mailer.js');
    const r = await sendPlatformTest({ to: String(req.body?.to || req.user.email), name: req.user.name });
    res.json(r.sent ? { ok: true } : { ok: false, error: r.error || 'Platform sender is not configured' });
  });

  // Verify Microsoft app credentials (client-credentials token request). Google has no credential-only check.
  app.post('/api/platform/test-provider/:provider', requireAuth, requireOperator, async (req, res) => {
    if (req.params.provider !== 'microsoft') return res.status(400).json({ error: 'Only Microsoft credentials can be verified without a browser sign-in. For Google, use "Continue with Google" on the login page.' });
    const c = microsoftConfig(); if (!c) return res.status(400).json({ error: 'Enter the Microsoft client ID and secret first' });
    const tenant = c.tenant === 'common' || c.tenant === 'consumers' ? 'organizations' : c.tenant;
    try {
      const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret, scope: 'https://graph.microsoft.com/.default' }) });
      const j = await r.json().catch(() => ({}));
      if (j.access_token) return res.json({ ok: true, note: 'Client ID and secret accepted by Microsoft.' });
      // AADSTS700016 = app not found in that tenant (fine for multi-tenant 'organizations'); 7000215 = invalid secret
      if (/AADSTS7000215/.test(j.error_description || '')) return res.json({ ok: false, error: 'Microsoft says the client secret is invalid. Copy the secret VALUE (not the ID) from Certificates & secrets.' });
      if (/AADSTS700016/.test(j.error_description || '')) return res.json({ ok: false, error: `Microsoft cannot find this application in tenant "${tenant}". Check the client ID, or set the tenant to your Directory (tenant) ID.` });
      if (/AADSTS500011|invalid_scope/.test(j.error_description || '')) return res.json({ ok: true, note: 'Credentials accepted (no app-only Graph permission, which is fine for sign-in and connections).' });
      res.json({ ok: false, error: (j.error_description || j.error || `HTTP ${r.status}`).split('\n')[0].slice(0, 220) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Operators management
  app.post('/api/platform/operators', requireAuth, requireOperator, (req, res) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
    const u = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
    if (!u) return res.status(404).json({ error: 'No account with that email yet. Ask them to sign up first.' });
    db.prepare(`UPDATE users SET is_operator = 1 WHERE id = ?`).run(u.id);
    res.json({ ok: true });
  });
  app.delete('/api/platform/operators/:id', requireAuth, requireOperator, (req, res) => {
    const n = db.prepare(`SELECT COUNT(*) n FROM users WHERE is_operator = 1`).get().n;
    if (n <= 1) return res.status(400).json({ error: 'There must be at least one operator' });
    db.prepare(`UPDATE users SET is_operator = 0 WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });
}

export const escName = () => esc(setting('platform_name') || 'SignFlow');
