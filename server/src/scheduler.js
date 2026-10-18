// Background jobs, in-process (no extra service needed):
//   - automatic reminders to signers whose turn it is
//   - expiring envelopes past their deadline
//   - retrying failed webhook deliveries
//   - housekeeping (expired login codes / sessions / reset links)
import db, { audit } from './db.js';
import { brandFor, sendExpiredNotice } from './mailer.js';
import { queueWebhook, processWebhookQueue } from './webhooks.js';
import { getEnvelope, getSigners, isSignerTurn, sendSignRequestTo, envelopePayload } from './complete.js';
import { sqlToDate } from './util.js';

const MAX_REMINDERS_PER_SIGNER = 10;
let lastHourly = 0;

export function startScheduler() {
  const tick = async () => {
    try { await processWebhookQueue(); } catch (e) { console.error('[scheduler] webhooks:', e.message); }
    if (Date.now() - lastHourly > 15 * 60_000) {
      lastHourly = Date.now();
      try { await expireEnvelopes(); } catch (e) { console.error('[scheduler] expiry:', e.message); }
      try { await sendReminders(); } catch (e) { console.error('[scheduler] reminders:', e.message); }
      try { housekeeping(); } catch (e) { console.error('[scheduler] housekeeping:', e.message); }
    }
  };
  setTimeout(tick, 5_000);
  const t = setInterval(tick, 60_000);
  t.unref?.();
  return { runNow: tick };
}

export async function expireEnvelopes() {
  const due = db.prepare(
    `SELECT id FROM envelopes WHERE status = 'sent' AND expires_at IS NOT NULL AND expires_at <= datetime('now')`
  ).all();
  for (const { id } of due) {
    db.prepare(`UPDATE envelopes SET status = 'expired' WHERE id = ? AND status = 'sent'`).run(id);
    const env = getEnvelope(id);
    const pending = getSigners(id).filter((s) => s.status === 'pending').map((s) => `${s.name} <${s.email}>`);
    audit(id, 'envelope.expired', 'system', `Signing deadline ${env.expires_at} UTC passed. Pending: ${pending.join(', ') || 'none'}`);
    const brand = brandFor(env.user_id);
    if (brand.senderEmail) {
      const r = await sendExpiredNotice({ to: brand.senderEmail, envelope: env, brand, pending });
      audit(id, r.sent ? 'email.sent' : 'email.skipped', 'system', `Expiry notice ${r.sent ? 'sent to' : 'not sent to'} ${brand.senderEmail}`);
    }
    queueWebhook(env.user_id, 'envelope.expired', envelopePayload(id));
  }
  return due.length;
}

export async function sendReminders() {
  const envs = db.prepare(
    `SELECT * FROM envelopes WHERE status = 'sent' AND reminder_days > 0 AND (expires_at IS NULL OR expires_at > datetime('now'))`
  ).all();
  let sent = 0;
  const now = Date.now();
  for (const env of envs) {
    for (const s of getSigners(env.id)) {
      if (s.status !== 'pending' || !isSignerTurn(env, s)) continue;
      if (s.reminders_sent >= MAX_REMINDERS_PER_SIGNER) continue;
      const baseline = sqlToDate(s.notified_at || env.sent_at || env.created_at);
      if (!baseline) continue;
      if (now - baseline.getTime() < env.reminder_days * 864e5) continue;
      await sendSignRequestTo(env, s, { isReminder: true });
      audit(env.id, 'reminder.sent', 'system', `Automatic reminder #${s.reminders_sent + 1} to ${s.email}`);
      sent += 1;
    }
    if (sent) db.prepare(`UPDATE envelopes SET last_reminder_at = datetime('now') WHERE id = ?`).run(env.id);
  }
  return sent;
}

function housekeeping() {
  db.prepare(`DELETE FROM login_codes WHERE expires_at < datetime('now', '-1 day')`).run();
  db.prepare(`DELETE FROM password_resets WHERE expires_at < datetime('now', '-1 day')`).run();
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  db.prepare(`DELETE FROM webhook_deliveries WHERE created_at < datetime('now', '-30 days')`).run();
  db.prepare(`DELETE FROM oauth_codes WHERE expires_at < datetime('now', '-1 day')`).run();
  db.prepare(`DELETE FROM oauth_tokens WHERE refresh_expires_at < datetime('now', '-7 days') OR (revoked = 1 AND created_at < datetime('now', '-7 days'))`).run();
}
