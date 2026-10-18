// Signer-facing routes (no account; the capability token in the URL is the key).
import path from 'path';
import { nanoid } from 'nanoid';
import db, { audit, STORAGE_DIR, tx, getSettings } from './db.js';
import { writeEncrypted, readDecrypted, encStr } from './crypto.js';
import { brandFor, mailEnabled, sendDeclineNotice, sendViewedNotice } from './mailer.js';
import { getEnvelope, isSignerTurn, notifyPendingSigners, sealAndNotify, envelopePayload } from './complete.js';
import { queueWebhook } from './webhooks.js';
import { clientIp, nowSql, safeFilename } from './util.js';

const UPLOADS = path.join(STORAGE_DIR, 'uploads');
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);

const signerByToken = (token) => db.prepare(`SELECT * FROM signers WHERE token = ?`).get(token);

function codeOk(env, req) {
  if (!env.access_code) return true;
  return String(req.headers['x-access-code'] || '') === env.access_code;
}
// Throttle access-code guessing per signing link.
const codeFails = new Map();
const codeLocked = (token) => { const f = codeFails.get(token); return f && f.until > Date.now(); };
function recordCodeFail(token) {
  const f = codeFails.get(token) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 8) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  codeFails.set(token, f);
  if (codeFails.size > 10000) codeFails.clear();
}

const publicBrand = (userId) => {
  const b = brandFor(userId);
  return { company: b.company, color: b.color, logo_url: b.logoUrl, sender_name: b.senderName };
};

/** Shared guard: resolve signer + envelope, enforce void/access code. */
function load(req, res, { requireCode = true } = {}) {
  const signer = signerByToken(req.params.token);
  if (!signer) { res.status(404).json({ error: 'Invalid or expired signing link' }); return null; }
  const env = getEnvelope(signer.envelope_id);
  if (!env) { res.status(404).json({ error: 'Invalid signing link' }); return null; }
  if (env.status === 'voided') { res.status(410).json({ error: 'This document was cancelled by the sender.' }); return null; }
  if (requireCode && env.access_code) {
    if (codeLocked(req.params.token)) { res.status(429).json({ error: 'Too many wrong codes. Try again in 15 minutes.' }); return null; }
    if (!codeOk(env, req)) {
      if (req.headers['x-access-code']) recordCodeFail(req.params.token);
      res.status(401).json({ locked: true, error: 'Access code required', envelope: { title: env.title }, brand: publicBrand(env.user_id) });
      return null;
    }
  }
  return { signer, env };
}

export function registerSigningRoutes(app) {
  app.get('/api/sign/:token', async (req, res) => {
    const signer = signerByToken(req.params.token);
    if (!signer) return res.status(404).json({ error: 'Invalid or expired signing link' });
    const env = getEnvelope(signer.envelope_id);
    if (env.status === 'voided') return res.status(410).json({ error: 'This document was cancelled by the sender.' });
    if (env.access_code) {
      if (codeLocked(req.params.token)) return res.status(429).json({ error: 'Too many wrong codes. Try again in 15 minutes.' });
      if (!codeOk(env, req)) {
        if (req.headers['x-access-code']) recordCodeFail(req.params.token);
        return res.json({ locked: true, envelope: { title: env.title }, brand: publicBrand(env.user_id) });
      }
    }
    const fields = db.prepare(`SELECT id, type, page, x, y, w, h, label, required, value, merge_key, cover FROM fields WHERE signer_id = ?`).all(signer.id)
      .map((f) => ({ ...f, readonly: !!f.merge_key, cover: !!f.cover, merge_key: undefined }));
    const attachments = db.prepare(`SELECT id, label, original_name, stored_path FROM attachments WHERE signer_id = ?`).all(signer.id)
      .map((a) => ({ id: a.id, label: a.label, uploaded: !!a.stored_path, original_name: a.original_name }));
    const others = db.prepare(`SELECT name, order_index, status FROM signers WHERE envelope_id = ? ORDER BY order_index`).all(env.id);

    if (!signer.viewed_at) {
      db.prepare(`UPDATE signers SET viewed_at = datetime('now') WHERE id = ?`).run(signer.id);
      audit(env.id, 'envelope.viewed', `${signer.name} <${signer.email}>`, 'Opened the signing page for the first time', clientIp(req));
      const settings = getSettings(env.user_id);
      if (settings.notify_on_view) {
        const brand = brandFor(env.user_id);
        if (brand.senderEmail) sendViewedNotice({ to: brand.senderEmail, envelope: env, signerName: signer.name, brand }).catch(() => {});
      }
    } else {
      audit(env.id, 'envelope.viewed', `${signer.name} <${signer.email}>`, '', clientIp(req));
    }

    res.json({
      envelope: { id: env.id, title: env.title, message: env.message, status: env.status, expires_at: env.expires_at, page_count: env.page_count, sequential: !!env.sequential },
      summary: (() => { try { return env.summary_json ? JSON.parse(env.summary_json) : null; } catch { return null; } })(),
      signer: { name: signer.name, email: signer.email, status: signer.status, order_index: signer.order_index, private_message: signer.private_message || '', signed_at: signer.signed_at, decline_reason: signer.decline_reason },
      your_turn: env.status === 'sent' && signer.status === 'pending' && isSignerTurn(env, signer),
      can_download: env.status === 'completed' && !!env.signer_pdf,
      can_decline: env.status === 'sent' && signer.status === 'pending',
      fields, attachments,
      signers: others.map((o) => ({ name: o.name, order: o.order_index, status: o.status })),
      brand: publicBrand(env.user_id),
    });
  });

  app.get('/api/sign/:token/pdf', (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    res.contentType('application/pdf').send(readDecrypted(ctx.env.original_pdf));
  });

  // Signer's copy of the completed document (certificate without audit trail).
  app.get('/api/sign/:token/download', (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const { env, signer } = ctx;
    if (env.status !== 'completed' || !env.signer_pdf) return res.status(404).json({ error: 'The document is not completed yet' });
    audit(env.id, 'document.downloaded', `${signer.name} <${signer.email}>`, 'Downloaded signed copy', clientIp(req));
    res.set('Content-Disposition', `attachment; filename="${safeFilename(env.title)}-signed.pdf"`);
    res.contentType('application/pdf').send(readDecrypted(env.signer_pdf));
  });

  app.post('/api/sign/:token/decline', async (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const { env, signer } = ctx;
    if (env.status !== 'sent') return res.status(409).json({ error: `This document is ${env.status}` });
    if (signer.status !== 'pending') return res.status(409).json({ error: 'You have already responded to this document' });
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    const ip = clientIp(req);
    tx(() => {
      db.prepare(`UPDATE signers SET status = 'declined', declined_at = datetime('now'), decline_reason = ?, ip = ?, user_agent = ? WHERE id = ?`)
        .run(reason, ip, String(req.headers['user-agent'] || '').slice(0, 300), signer.id);
      db.prepare(`UPDATE envelopes SET status = 'declined' WHERE id = ?`).run(env.id);
    });
    audit(env.id, 'signer.declined', `${signer.name} <${signer.email}>`, reason ? `Declined: "${reason}"` : 'Declined to sign', ip);
    const brand = brandFor(env.user_id);
    if (brand.senderEmail) {
      const r = await sendDeclineNotice({ to: brand.senderEmail, envelope: env, signerName: signer.name, reason, brand });
      audit(env.id, r.sent ? 'email.sent' : 'email.skipped', 'system', `Decline notice ${r.sent ? 'sent to' : 'not sent to'} ${brand.senderEmail}`);
    }
    queueWebhook(env.user_id, 'envelope.declined', envelopePayload(env.id));
    res.json({ status: 'declined' });
  });

  app.post('/api/sign/:token', async (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const { env, signer } = ctx;
    if (env.status !== 'sent') return res.status(409).json({ error: `This document is ${env.status} and can no longer be signed` });
    if (signer.status === 'signed') return res.status(409).json({ error: 'You have already signed' });
    if (signer.status === 'declined') return res.status(409).json({ error: 'You declined this document' });
    if (!isSignerTurn(env, signer)) return res.status(409).json({ error: 'It is not your turn to sign yet' });
    if (env.expires_at && env.expires_at <= nowSql()) return res.status(409).json({ error: 'The signing deadline for this document has passed' });

    const { consent, signature_image, values = {}, attachments: uploads = [], typed_name, signature_fit = {} } = req.body || {};
    if (!consent) return res.status(400).json({ error: 'You must agree to sign electronically' });
    const myFields = db.prepare(`SELECT * FROM fields WHERE signer_id = ?`).all(signer.id);
    const needsSig = myFields.some((f) => f.type === 'signature' || f.type === 'initials');
    if (needsSig) {
      if (typeof signature_image !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(signature_image)) return res.status(400).json({ error: 'A signature image is required' });
      if (signature_image.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Signature image is too large' });
    }
    // Required text fields must be filled (merge-bound fields keep the sender's value).
    for (const f of myFields) {
      if (f.type === 'text' && f.merge_key) continue;
      if (f.type === 'text' && f.required && !String(values[f.id] ?? f.value ?? '').trim()) {
        return res.status(400).json({ error: `Please fill in the required field "${f.label || 'Text'}"` });
      }
    }
    // Required attachments: present (already or now), right type, right size.
    const required = db.prepare(`SELECT * FROM attachments WHERE signer_id = ?`).all(signer.id);
    const uploadById = Object.fromEntries((Array.isArray(uploads) ? uploads : []).map((u) => [u?.id, u]));
    const parsed = {};
    for (const r of required) {
      const incoming = uploadById[r.id];
      if (r.stored_path && !incoming) continue;
      if (!incoming || typeof incoming.data !== 'string') return res.status(400).json({ error: `Please attach the required document: ${r.label}` });
      const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(incoming.data);
      if (!m) return res.status(400).json({ error: `The file for "${r.label}" is not valid` });
      const mime = m[1].toLowerCase();
      if (!ATTACHMENT_MIMES.has(mime)) return res.status(400).json({ error: `"${r.label}" must be a PDF, PNG or JPG` });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_ATTACHMENT_BYTES) return res.status(400).json({ error: `"${r.label}" is larger than 10 MB` });
      parsed[r.id] = { mime, buf, filename: String(incoming.filename || 'attachment').slice(0, 120) };
    }

    const ip = clientIp(req);
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const now = nowSql();
    const extFor = (mime) => (mime.includes('pdf') ? '.pdf' : mime.includes('png') ? '.png' : '.jpg');
    for (const [aid, p] of Object.entries(parsed)) {
      const fp = path.join(UPLOADS, `att-${nanoid(10)}${extFor(p.mime)}`);
      writeEncrypted(fp, p.buf);
      db.prepare(`UPDATE attachments SET stored_path=?, original_name=?, mime=?, uploaded_at=? WHERE id=?`).run(fp, p.filename, p.mime, now, aid);
    }

    const setValue = db.prepare(`UPDATE fields SET value = ? WHERE id = ?`);
    const setMeta = db.prepare(`UPDATE fields SET value = ?, meta = ? WHERE id = ?`);
    // Signature placement inside the field, chosen by the signer: {x,y,w,h} as fractions of the field.
    const fitFor = (f) => {
      const v = signature_fit && typeof signature_fit === 'object' ? signature_fit[f.id] : null;
      if (!v) return null;
      const n = (x, lo, hi) => (Number.isFinite(+x) ? Math.min(hi, Math.max(lo, +x)) : null);
      const w = n(v.w, 0.15, 1), h = n(v.h, 0.15, 1);
      if (w === null || h === null) return null;
      const x = n(v.x, 0, 1 - w), y = n(v.y, 0, 1 - h);
      if (x === null || y === null) return null;
      return JSON.stringify({ fit: { x, y, w, h } });
    };
    tx(() => {
      for (const f of myFields) {
        if (f.type === 'date') setValue.run(now.slice(0, 10), f.id);
        else if (f.type === 'signature' || f.type === 'initials') setMeta.run('signed', fitFor(f), f.id);
        else if (f.type === 'checkbox') setValue.run(values[f.id] === 'true' || values[f.id] === true ? 'true' : 'false', f.id);
        else if (f.merge_key) continue; // sender's merge value stays as-is
        else setValue.run(String(values[f.id] ?? f.value ?? '').slice(0, 500), f.id);
      }
      db.prepare(`UPDATE signers SET status='signed', signature_image=?, consent_at=?, signed_at=?, ip=?, user_agent=? WHERE id=?`)
        .run(needsSig ? encStr(signature_image) : null, now, now, ip, ua, signer.id);
    });
    if (Object.keys(parsed).length) audit(env.id, 'signer.attached', `${signer.name} <${signer.email}>`, `Uploaded ${Object.keys(parsed).length} required document(s): ${required.filter((r) => parsed[r.id]).map((r) => r.label).join(', ')}`, ip);
    audit(env.id, 'signer.consented', `${signer.name} <${signer.email}>`, `Agreed to use electronic records and signatures${typed_name ? ` (typed name: ${String(typed_name).slice(0, 80)})` : ''}`, ip);
    audit(env.id, 'signer.signed', `${signer.name} <${signer.email}>`, `Completed ${myFields.length} field(s)`, ip);

    const remaining = db.prepare(`SELECT COUNT(*) n FROM signers WHERE envelope_id = ? AND status != 'signed'`).get(env.id).n;
    if (remaining > 0) {
      await notifyPendingSigners(env.id); // sequential: next signer's turn
      return res.json({ status: 'signed', envelope_status: 'sent', remaining_signers: remaining });
    }
    try {
      const r = await sealAndNotify(env.id);
      res.json({ status: 'signed', envelope_status: 'completed', final_sha256: r.sha256_final, can_download: true });
    } catch (err) {
      // The signature IS recorded; the sender can retry sealing from their side.
      res.json({ status: 'signed', envelope_status: 'completed', sealed: false, message: 'Your signature was recorded. The final document is being prepared and will be emailed to you.' });
    }
  });
}
