// Envelope lifecycle orchestration shared by the signing ceremony, the sender's
// retry buttons and the scheduler: notifying signers, sealing, completion
// emails, webhooks and the OneDrive archive.
import path from 'path';
import db, { audit, STORAGE_DIR } from './db.js';
import { sealEnvelope, sha256 } from './pdf.js';
import { writeEncrypted } from './crypto.js';
import { appUrl, brandFor, sendSignRequest, sendCompletionEmail } from './mailer.js';
import { queueWebhook } from './webhooks.js';
import { archiveInBackground } from './storage.js';
import { nowSql, safeFilename } from './util.js';

const UPLOADS = path.join(STORAGE_DIR, 'uploads');

export const getEnvelope = (id) => db.prepare(`SELECT * FROM envelopes WHERE id = ?`).get(id);
export const getSigners = (id) => db.prepare(`SELECT * FROM signers WHERE envelope_id = ? ORDER BY order_index`).all(id);

export function isSignerTurn(env, signer) {
  if (!env.sequential) return true;
  const ahead = db.prepare(
    `SELECT COUNT(*) n FROM signers WHERE envelope_id = ? AND order_index < ? AND status != 'signed'`
  ).get(env.id, signer.order_index);
  return ahead.n === 0;
}

/** Public shape of an envelope for webhooks / API consumers. */
export function envelopePayload(id) {
  const env = getEnvelope(id);
  if (!env) return null;
  const signers = getSigners(id).map((s) => ({ id: s.id, name: s.name, email: s.email, order: s.order_index, status: s.status, signed_at: s.signed_at, declined_at: s.declined_at, decline_reason: s.decline_reason }));
  return {
    id: env.id, title: env.title, status: env.status, created_at: env.created_at, sent_at: env.sent_at,
    completed_at: env.completed_at, expires_at: env.expires_at, sha256_original: env.sha256_original, sha256_final: env.sha256_final,
    folder_id: env.folder_id, template_id: env.template_id, signers,
    download_url: env.status === 'completed' ? `${appUrl()}/api/envelopes/${env.id}/download` : null,
    archive_url: env.archive_url || null,
  };
}

/** Email one signer their signing link (initial or reminder). Audits + marks notified_at. */
export async function sendSignRequestTo(env, signer, { isReminder = false } = {}) {
  const brand = brandFor(env.user_id);
  const r = await sendSignRequest({ signer, envelope: env, senderNote: env.message, brand, isReminder, privateMessage: signer.private_message });
  const what = isReminder ? 'Reminder' : 'Signing request';
  audit(env.id, r.sent ? 'email.sent' : 'email.skipped', 'system',
    `${what} ${r.sent ? `emailed to ${signer.email} from ${r.account} (${r.via})${r.fallback_from ? ` after ${r.fallback_from} failed` : ''}` : `not emailed to ${signer.email} (${r.error ? 'error: ' + r.error : 'no email route configured'})`}`);
  db.prepare(`UPDATE signers SET notified_at = datetime('now')${isReminder ? ', reminders_sent = reminders_sent + 1' : ''} WHERE id = ?`).run(signer.id);
  return r;
}

/** Notify every pending signer whose turn it is and who hasn't been notified yet. */
export async function notifyPendingSigners(envId) {
  const env = getEnvelope(envId);
  if (!env || env.status !== 'sent') return;
  for (const s of getSigners(envId)) {
    if (s.status !== 'pending' || s.notified_at) continue;
    if (!isSignerTurn(env, s)) continue;
    await sendSignRequestTo(env, s);
  }
}

/**
 * Seal a fully-signed envelope: stamp fields, add certificate, store both
 * copies, then email everyone, fire the webhook and archive. Throws if sealing
 * itself fails (the error is also stored in envelopes.seal_error so the sender
 * can retry from the UI). Notification failures never throw.
 */
export async function sealAndNotify(envelopeId) {
  const env = getEnvelope(envelopeId);
  if (!env) throw new Error('Envelope not found');
  const signers = getSigners(envelopeId);
  if (!signers.length || signers.some((s) => s.status !== 'signed')) throw new Error('Not all signers have signed yet');

  const completedAt = env.completed_at || nowSql();
  if (!env.completed_at) {
    db.prepare(`UPDATE envelopes SET completed_at = ? WHERE id = ?`).run(completedAt, envelopeId);
    audit(envelopeId, 'envelope.completed', 'system', 'All signers completed; sealing document');
  }

  const brand = brandFor(env.user_id);
  let finalBytes, signerBytes, finalHash;
  try {
    const fullEnv = getEnvelope(envelopeId);
    const fields = db.prepare(`SELECT * FROM fields WHERE envelope_id = ?`).all(envelopeId);
    const events = db.prepare(`SELECT * FROM audit_events WHERE envelope_id = ? ORDER BY id`).all(envelopeId);
    const attachments = db.prepare(`SELECT * FROM attachments WHERE envelope_id = ?`).all(envelopeId);

    finalBytes = await sealEnvelope({ envelope: fullEnv, signers, fields, events, attachments, includeAuditTrail: true, brand });
    signerBytes = await sealEnvelope({ envelope: fullEnv, signers, fields, events, attachments, includeAuditTrail: false, brand });
    finalHash = sha256(finalBytes);

    const finalPath = path.join(UPLOADS, `${envelopeId}-final.pdf`);
    const signerPath = path.join(UPLOADS, `${envelopeId}-signer.pdf`);
    writeEncrypted(finalPath, finalBytes);
    writeEncrypted(signerPath, signerBytes);
    db.prepare(`UPDATE envelopes SET status='completed', final_pdf=?, signer_pdf=?, sha256_final=?, seal_error=NULL WHERE id=?`)
      .run(finalPath, signerPath, finalHash, envelopeId);
    audit(envelopeId, 'document.sealed', 'system', `Final document sha256 ${finalHash}`);
  } catch (err) {
    console.error(`Sealing ${envelopeId} failed:`, err);
    db.prepare(`UPDATE envelopes SET seal_error = ? WHERE id = ?`).run(String(err.message).slice(0, 300), envelopeId);
    audit(envelopeId, 'seal.failed', 'system', `Sealing failed: ${String(err.message).slice(0, 200)} — retry from the envelope page`);
    throw err;
  }

  // ---- notifications (best effort) ----
  const sealedEnv = getEnvelope(envelopeId);
  const fname = `${safeFilename(sealedEnv.title)}-signed.pdf`;
  for (const s of signers) {
    const r = await sendCompletionEmail({ to: s.email, name: s.name, envelope: sealedEnv, pdfContent: signerBytes, filename: fname, brand, audience: 'signer', downloadUrl: `${appUrl()}/sign/${s.token}/download` });
    audit(envelopeId, r.sent ? 'email.sent' : 'email.skipped', 'system', `Completion email ${r.sent ? `sent to ${s.email} from ${r.account} (${r.via})` : `not sent to ${s.email}${r.error ? ': ' + r.error : ''}`}`);
  }
  let cc = [];
  try { cc = JSON.parse(sealedEnv.cc_json || '[]'); } catch { /* ignore */ }
  for (const c of cc) {
    if (!c?.email) continue;
    const r = await sendCompletionEmail({ to: c.email, name: c.name || '', envelope: sealedEnv, pdfContent: signerBytes, filename: fname, brand, audience: 'cc' });
    audit(envelopeId, r.sent ? 'email.sent' : 'email.skipped', 'system', `CC copy ${r.sent ? 'sent to' : 'not sent to'} ${c.email}`);
  }
  if (brand.senderEmail) {
    const r = await sendCompletionEmail({ to: brand.senderEmail, name: brand.senderName, envelope: sealedEnv, pdfContent: finalBytes, filename: fname, brand, audience: 'sender', downloadUrl: `${appUrl()}/envelope/${envelopeId}` });
    audit(envelopeId, r.sent ? 'email.sent' : 'email.skipped', 'system', `Sender copy ${r.sent ? 'sent to' : 'not sent to'} ${brand.senderEmail}`);
  }

  queueWebhook(sealedEnv.user_id, 'envelope.completed', envelopePayload(envelopeId));
  archiveInBackground(envelopeId);
  return { sha256_final: finalHash };
}
