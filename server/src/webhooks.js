// Outgoing webhooks: POST a signed JSON payload to the sender's configured URL
// when an envelope completes / is declined / expires / is voided. Deliveries
// are queued in SQLite and retried with back-off by the scheduler.
import crypto from 'crypto';
import db, { getSettings } from './db.js';
import { nowSql } from './util.js';

const BACKOFF_MIN = [1, 5, 30, 120, 720]; // minutes between attempts (5 attempts total)

export function queueWebhook(userId, event, payload) {
  if (!userId) return;
  const s = getSettings(userId);
  if (!s.webhook_url || !/^https?:\/\//i.test(s.webhook_url)) return;
  const body = JSON.stringify({ event, created_at: new Date().toISOString(), data: payload });
  db.prepare(
    `INSERT INTO webhook_deliveries (user_id, envelope_id, event, url, payload, next_attempt_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(userId, payload?.id || null, event, s.webhook_url, body);
  // Try right away (fire and forget); the scheduler picks up anything that fails.
  processWebhookQueue().catch(() => {});
}

let running = false;
export async function processWebhookQueue() {
  if (running) return;
  running = true;
  try {
    const due = db.prepare(
      `SELECT * FROM webhook_deliveries WHERE delivered_at IS NULL AND attempts < ? AND next_attempt_at <= datetime('now') ORDER BY id LIMIT 20`
    ).all(BACKOFF_MIN.length);
    for (const d of due) await deliver(d);
  } finally {
    running = false;
  }
}

async function deliver(d) {
  const s = getSettings(d.user_id);
  const secret = s.webhook_secret || '';
  const sig = secret ? crypto.createHmac('sha256', secret).update(d.payload).digest('hex') : '';
  let status = null, error = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const r = await fetch(d.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SignFlow-Webhook/1.0',
        'X-SignFlow-Event': d.event,
        'X-SignFlow-Delivery': String(d.id),
        ...(sig ? { 'X-SignFlow-Signature': `sha256=${sig}` } : {}),
      },
      body: d.payload,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    status = r.status;
    if (!r.ok) error = `HTTP ${r.status}`;
  } catch (e) {
    error = e.name === 'AbortError' ? 'timeout after 10s' : e.message;
  }
  const attempts = d.attempts + 1;
  if (!error) {
    db.prepare(`UPDATE webhook_deliveries SET attempts = ?, last_status = ?, last_error = NULL, delivered_at = datetime('now') WHERE id = ?`).run(attempts, status, d.id);
  } else {
    const wait = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1] || 720;
    const next = nowSql(new Date(Date.now() + wait * 60_000));
    db.prepare(`UPDATE webhook_deliveries SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`).run(attempts, status, error.slice(0, 200), next, d.id);
  }
}

/** Send a test event to the user's webhook URL right now; returns {ok, status, error}. */
export async function testWebhook(userId) {
  const s = getSettings(userId);
  if (!s.webhook_url) return { ok: false, error: 'No webhook URL configured' };
  const body = JSON.stringify({ event: 'ping', created_at: new Date().toISOString(), data: { message: 'SignFlow webhook test' } });
  const sig = s.webhook_secret ? crypto.createHmac('sha256', s.webhook_secret).update(body).digest('hex') : '';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const r = await fetch(s.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SignFlow-Event': 'ping', ...(sig ? { 'X-SignFlow-Signature': `sha256=${sig}` } : {}) },
      body, signal: ctrl.signal,
    });
    clearTimeout(t);
    return { ok: r.ok, status: r.status, error: r.ok ? null : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout after 10s' : e.message };
  }
}
