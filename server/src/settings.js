// Account settings: profile, password, branding, defaults, webhook, API keys.
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import db, { getSettings } from './db.js';
import { requireAuth, NO_PASSWORD } from './auth.js';
import { testWebhook } from './webhooks.js';

const MAX_LOGO_BYTES = 300 * 1024;

export function registerSettingsRoutes(app) {
  app.get('/api/settings', requireAuth, (req, res) => {
    const s = getSettings(req.user.id);
    const keys = db.prepare(`SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id);
    res.json({
      profile: { name: req.user.name, email: req.user.email, has_password: req.user.password_hash !== NO_PASSWORD },
      branding: { company: s.company, brand_color: s.brand_color, logo_data: s.logo_data, email_footer: s.email_footer },
      defaults: { expiry_days: s.default_expiry_days, reminder_days: s.default_reminder_days, notify_on_view: !!s.notify_on_view },
      webhook: { url: s.webhook_url, has_secret: !!s.webhook_secret },
      api_keys: keys,
    });
  });

  app.put('/api/settings', requireAuth, (req, res) => {
    const b = req.body || {};
    const cur = getSettings(req.user.id);
    // profile
    if (typeof b.name === 'string' && b.name.trim()) {
      db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(b.name.trim().slice(0, 80), req.user.id);
    }
    // branding
    const company = typeof b.company === 'string' ? b.company.trim().slice(0, 80) : cur.company;
    const color = typeof b.brand_color === 'string' ? (/^#[0-9a-f]{6}$/i.test(b.brand_color) ? b.brand_color : '') : cur.brand_color;
    let logo = cur.logo_data;
    if (typeof b.logo_data === 'string') {
      if (b.logo_data === '') logo = '';
      else {
        if (!/^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,/.test(b.logo_data)) return res.status(400).json({ error: 'Logo must be a PNG, JPG, WebP or SVG image' });
        if (b.logo_data.length > MAX_LOGO_BYTES * 1.37) return res.status(400).json({ error: 'Logo must be under 300 KB' });
        logo = b.logo_data;
      }
    }
    const footer = typeof b.email_footer === 'string' ? b.email_footer.trim().slice(0, 300) : cur.email_footer;
    // defaults
    const expiry = b.expiry_days !== undefined ? Math.max(0, Math.min(365, parseInt(b.expiry_days, 10) || 0)) : cur.default_expiry_days;
    const remind = b.reminder_days !== undefined ? Math.max(0, Math.min(30, parseInt(b.reminder_days, 10) || 0)) : cur.default_reminder_days;
    const notifyView = b.notify_on_view !== undefined ? (b.notify_on_view ? 1 : 0) : cur.notify_on_view;
    // webhook
    let url = cur.webhook_url, secret = cur.webhook_secret;
    if (typeof b.webhook_url === 'string') {
      url = b.webhook_url.trim();
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return res.status(400).json({ error: 'Webhook URL must start with http:// or https://' });
    }
    if (typeof b.webhook_secret === 'string') secret = b.webhook_secret.trim().slice(0, 128);
    if (b.regenerate_webhook_secret) secret = crypto.randomBytes(24).toString('hex');

    db.prepare(`
      INSERT INTO user_settings (user_id, company, brand_color, logo_data, email_footer, default_expiry_days, default_reminder_days, webhook_url, webhook_secret, notify_on_view, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET company=excluded.company, brand_color=excluded.brand_color, logo_data=excluded.logo_data,
        email_footer=excluded.email_footer, default_expiry_days=excluded.default_expiry_days, default_reminder_days=excluded.default_reminder_days,
        webhook_url=excluded.webhook_url, webhook_secret=excluded.webhook_secret, notify_on_view=excluded.notify_on_view, updated_at=datetime('now')
    `).run(req.user.id, company, color, logo, footer, expiry, remind, url, secret, notifyView);
    res.json({ ok: true, webhook_secret: b.regenerate_webhook_secret ? secret : undefined });
  });

  app.post('/api/settings/password', requireAuth, (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const hasPassword = req.user.password_hash !== NO_PASSWORD;
    if (hasPassword && !bcrypt.compareSync(current_password || '', req.user.password_hash)) {
      return res.status(401).json({ error: 'Current password is wrong' });
    }
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(bcrypt.hashSync(new_password, 10), req.user.id);
    res.json({ ok: true });
  });

  app.post('/api/settings/webhook/test', requireAuth, async (req, res) => {
    res.json(await testWebhook(req.user.id));
  });

  // ---- API keys ----
  app.post('/api/settings/api-keys', requireAuth, (req, res) => {
    if (req.authVia === 'api_key') return res.status(403).json({ error: 'API keys cannot create other API keys' });
    const name = String(req.body?.name || 'Integration').trim().slice(0, 60) || 'Integration';
    const count = db.prepare(`SELECT COUNT(*) n FROM api_keys WHERE user_id = ?`).get(req.user.id).n;
    if (count >= 10) return res.status(400).json({ error: 'Maximum of 10 API keys' });
    const raw = `sf_live_${crypto.randomBytes(24).toString('base64url')}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const id = nanoid(10);
    db.prepare(`INSERT INTO api_keys (id, user_id, name, key_hash, prefix) VALUES (?, ?, ?, ?, ?)`).run(id, req.user.id, name, hash, raw.slice(0, 12));
    res.json({ id, name, key: raw, prefix: raw.slice(0, 12) }); // the full key is shown ONCE
  });

  app.delete('/api/settings/api-keys/:id', requireAuth, (req, res) => {
    if (req.authVia === 'api_key') return res.status(403).json({ error: 'API keys cannot delete API keys' });
    db.prepare(`DELETE FROM api_keys WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  // Public logo for emails (no auth: emails can't send cookies).
  app.get('/api/public/logo/:userId', (req, res) => {
    const s = getSettings(req.params.userId);
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(s.logo_data || '');
    if (!m) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=3600');
    res.contentType(m[1]).send(Buffer.from(m[2], 'base64'));
  });
}
