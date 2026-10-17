// Sender-side envelope routes.
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { nanoid } from 'nanoid';
import db, { audit, STORAGE_DIR, tx, getSettings } from './db.js';
import { requireAuth } from './auth.js';
import { sha256, validatePdf } from './pdf.js';
import { writeEncrypted, readDecrypted } from './crypto.js';
import { appUrl, mailEnabled } from './mailer.js';
import { normalizeFields } from './fields.js';
import { getEnvelope, getSigners, isSignerTurn, notifyPendingSigners, sendSignRequestTo, sealAndNotify, envelopePayload } from './complete.js';
import { queueWebhook } from './webhooks.js';
import { archiveEnvelope, oneDriveEnabled, oneDriveTarget } from './onedrive.js';
import { actorOf, addDays, clampInt, clientIp, nowSql, safeFilename, validEmail } from './util.js';

const UPLOADS = path.join(STORAGE_DIR, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({ destination: UPLOADS, filename: (_req, _file, cb) => cb(null, `${nanoid(12)}.pdf`) }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) ? cb(null, true) : cb(new Error('Only PDF files are accepted')),
});

const ownEnvelope = (req) => db.prepare(`SELECT * FROM envelopes WHERE id = ? AND user_id = ?`).get(req.params.id, req.user.id);
const parseJson = (s, dflt) => { try { return JSON.parse(s ?? ''); } catch { return dflt; } };

function cleanSigners(input, { max = 10 } = {}) {
  const list = (Array.isArray(input) ? input : []).map((s) => ({
    name: String(s?.name || '').trim().slice(0, 80),
    email: String(s?.email || '').trim().toLowerCase().slice(0, 200),
    attachments: (Array.isArray(s?.attachments) ? s.attachments : []).map((a) => String(a).trim().slice(0, 60)).filter(Boolean).slice(0, 10),
    private_message: String(s?.private_message || '').trim().slice(0, 500),
  }));
  if (!list.length) throw new Error('At least one signer is required');
  if (list.length > max) throw new Error(`At most ${max} signers per envelope`);
  list.forEach((s, i) => {
    if (!s.name) throw new Error(`Signer ${i + 1} needs a name`);
    if (!validEmail(s.email)) throw new Error(`Signer ${i + 1} (${s.name}) needs a valid email address`);
  });
  const emails = new Set();
  for (const s of list) { if (emails.has(s.email)) throw new Error(`Duplicate signer email: ${s.email}`); emails.add(s.email); }
  return list;
}

function cleanCc(input) {
  return (Array.isArray(input) ? input : []).slice(0, 20).map((c) => ({
    name: String(c?.name || '').trim().slice(0, 80),
    email: String(c?.email || '').trim().toLowerCase(),
  })).filter((c) => validEmail(c.email));
}

function resolveFolder(req, folderId) {
  if (!folderId) return null;
  const f = db.prepare(`SELECT id FROM folders WHERE id = ? AND user_id = ?`).get(folderId, req.user.id);
  if (!f) throw new Error('Unknown folder');
  return f.id;
}

/** Write signers/fields/attachments for an envelope, returning signer rows. */
function insertSigners(envId, signers, fields) {
  const insSigner = db.prepare(`INSERT INTO signers (id, envelope_id, name, email, order_index, token, private_message) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insField = db.prepare(`INSERT INTO fields (id, envelope_id, signer_id, type, page, x, y, w, h, label, required, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insAtt = db.prepare(`INSERT INTO attachments (id, envelope_id, signer_id, label) VALUES (?, ?, ?, ?)`);
  const out = [];
  signers.forEach((s, i) => {
    const sid = nanoid(10);
    const token = nanoid(32);
    insSigner.run(sid, envId, s.name, s.email, i, token, s.private_message || '');
    for (const f of fields.filter((f) => f.signerIndex === i)) {
      insField.run(nanoid(10), envId, sid, f.type, f.page, f.x, f.y, f.w, f.h, f.label, f.required, f.value);
    }
    for (const label of s.attachments || []) insAtt.run(nanoid(10), envId, sid, label);
    out.push({ id: sid, name: s.name, email: s.email, token });
  });
  return out;
}

export function registerEnvelopeRoutes(app) {
  // ---------- Create ----------
  app.post('/api/envelopes', requireAuth, (req, res, next) => {
    upload.single('pdf')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message === 'File too large' ? 'PDF must be under 25 MB' : err.message });
      next();
    });
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'A PDF file is required (field name: pdf)' });
    const bytes = fs.readFileSync(req.file.path);
    let info;
    try { info = await validatePdf(bytes); }
    catch (e) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } return res.status(400).json({ error: e.message }); }
    const id = nanoid(12);
    const hash = sha256(bytes);
    writeEncrypted(req.file.path, bytes);
    const title = String(req.body.title || req.file.originalname.replace(/\.pdf$/i, '')).trim().slice(0, 200) || 'Document';
    db.prepare(`INSERT INTO envelopes (id, user_id, title, message, original_pdf, sha256_original, page_count) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, title, String(req.body.message || '').slice(0, 2000), req.file.path, hash, info.pages);
    audit(id, 'envelope.created', actorOf(req.user), `Uploaded "${req.file.originalname}" (${bytes.length} bytes, ${info.pages} page(s), sha256 ${hash.slice(0, 16)}…)`, clientIp(req));
    res.json({ id, sha256: hash, pages: info.pages, title });
  });

  // ---------- List / stats ----------
  app.get('/api/envelopes', requireAuth, (req, res) => {
    const { q = '', status = '', folder = 'all', sort = 'created_desc' } = req.query;
    const limit = clampInt(req.query.limit, 1, 200, 50);
    const offset = clampInt(req.query.offset, 0, 1e9, 0);
    const where = ['e.user_id = ?'];
    const params = [req.user.id];
    if (status && status !== 'all') {
      if (status === 'active') { where.push(`e.status = 'sent'`); }
      else { where.push('e.status = ?'); params.push(String(status)); }
    }
    if (folder === 'none') where.push('e.folder_id IS NULL');
    else if (folder && folder !== 'all') { where.push('e.folder_id = ?'); params.push(String(folder)); }
    if (q.trim()) {
      where.push(`(e.title LIKE ? OR e.id = ? OR EXISTS (SELECT 1 FROM signers s WHERE s.envelope_id = e.id AND (s.name LIKE ? OR s.email LIKE ?)))`);
      const like = `%${q.trim()}%`;
      params.push(like, q.trim(), like, like);
    }
    const order = { created_desc: 'e.created_at DESC', created_asc: 'e.created_at ASC', title: 'e.title COLLATE NOCASE ASC', status: 'e.status ASC, e.created_at DESC', completed_desc: 'e.completed_at DESC' }[sort] || 'e.created_at DESC';
    const total = db.prepare(`SELECT COUNT(*) n FROM envelopes e WHERE ${where.join(' AND ')}`).get(...params).n;
    const rows = db.prepare(`
      SELECT e.id, e.title, e.status, e.folder_id, e.created_at, e.sent_at, e.completed_at, e.expires_at, e.seal_error, e.archive_url, e.template_id, e.page_count,
             f.name AS folder_name,
             (SELECT COUNT(*) FROM signers s WHERE s.envelope_id = e.id) AS signers_total,
             (SELECT COUNT(*) FROM signers s WHERE s.envelope_id = e.id AND s.status = 'signed') AS signers_signed,
             (SELECT GROUP_CONCAT(s.name, ', ') FROM signers s WHERE s.envelope_id = e.id) AS signer_names,
             (SELECT s.name FROM signers s WHERE s.envelope_id = e.id AND s.status = 'pending' ORDER BY s.order_index LIMIT 1) AS waiting_on
      FROM envelopes e LEFT JOIN folders f ON f.id = e.folder_id
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ items: rows, total, limit, offset });
  });

  app.get('/api/envelopes/stats', requireAuth, (req, res) => {
    const by = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) n FROM envelopes WHERE user_id = ? GROUP BY status`).all(req.user.id).map((r) => [r.status, r.n]));
    const month = db.prepare(`SELECT COUNT(*) n FROM envelopes WHERE user_id = ? AND status = 'completed' AND completed_at >= datetime('now', '-30 days')`).get(req.user.id).n;
    const avg = db.prepare(`SELECT AVG((julianday(completed_at) - julianday(COALESCE(sent_at, created_at))) * 24) h FROM envelopes WHERE user_id = ? AND status = 'completed' AND completed_at IS NOT NULL`).get(req.user.id).h;
    const expiringSoon = db.prepare(`SELECT COUNT(*) n FROM envelopes WHERE user_id = ? AND status = 'sent' AND expires_at IS NOT NULL AND expires_at <= datetime('now', '+3 days')`).get(req.user.id).n;
    const templates = db.prepare(`SELECT COUNT(*) n FROM templates WHERE user_id = ?`).get(req.user.id).n;
    res.json({
      draft: by.draft || 0, sent: by.sent || 0, completed: by.completed || 0, voided: by.voided || 0, declined: by.declined || 0, expired: by.expired || 0,
      completed_30d: month, avg_hours_to_complete: avg == null ? null : Math.round(avg * 10) / 10, expiring_soon: expiringSoon, templates,
      total: Object.values(by).reduce((a, b) => a + b, 0),
    });
  });

  // ---------- Folders ----------
  app.get('/api/folders', requireAuth, (req, res) => {
    const folders = db.prepare(`SELECT id, name, created_at FROM folders WHERE user_id = ? ORDER BY name`).all(req.user.id);
    const counts = db.prepare(`SELECT folder_id, COUNT(*) n FROM envelopes WHERE user_id = ? AND folder_id IS NOT NULL GROUP BY folder_id`).all(req.user.id);
    const byFolder = Object.fromEntries(counts.map((c) => [c.folder_id, c.n]));
    res.json(folders.map((f) => ({ ...f, count: byFolder[f.id] || 0 })));
  });
  app.post('/api/folders', requireAuth, (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Folder name is required' });
    const id = nanoid(10);
    db.prepare(`INSERT INTO folders (id, user_id, name) VALUES (?, ?, ?)`).run(id, req.user.id, name);
    res.json({ id, name });
  });
  app.patch('/api/folders/:id', requireAuth, (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Folder name is required' });
    db.prepare(`UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`).run(name, req.params.id, req.user.id);
    res.json({ ok: true });
  });
  app.delete('/api/folders/:id', requireAuth, (req, res) => {
    db.prepare(`UPDATE envelopes SET folder_id = NULL WHERE folder_id = ? AND user_id = ?`).run(req.params.id, req.user.id);
    db.prepare(`DELETE FROM folders WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
    res.json({ ok: true });
  });
  app.post('/api/envelopes/:id/folder', requireAuth, (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    let folderId;
    try { folderId = resolveFolder(req, req.body?.folder_id); } catch (e) { return res.status(400).json({ error: e.message }); }
    db.prepare(`UPDATE envelopes SET folder_id = ? WHERE id = ?`).run(folderId, env.id);
    res.json({ ok: true });
  });

  // ---------- Detail ----------
  app.get('/api/envelopes/:id', requireAuth, (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    const signers = db.prepare(`SELECT id, name, email, order_index, status, token, consent_at, signed_at, declined_at, decline_reason, viewed_at, notified_at, reminders_sent, private_message, ip FROM signers WHERE envelope_id = ? ORDER BY order_index`).all(env.id);
    const fields = db.prepare(`SELECT id, signer_id, type, page, x, y, w, h, label, required, value FROM fields WHERE envelope_id = ?`).all(env.id);
    const events = db.prepare(`SELECT type, actor, detail, ip, created_at FROM audit_events WHERE envelope_id = ? ORDER BY id`).all(env.id);
    const attachments = db.prepare(`SELECT id, signer_id, label, original_name, mime, uploaded_at FROM attachments WHERE envelope_id = ?`).all(env.id)
      .map((a) => ({ ...a, uploaded: !!a.uploaded_at }));
    const folder = env.folder_id ? db.prepare(`SELECT name FROM folders WHERE id = ?`).get(env.folder_id) : null;
    const canSeal = signers.length > 0 && signers.every((s) => s.status === 'signed') && (!env.final_pdf || !!env.seal_error);
    res.json({
      ...env, original_pdf: undefined, final_pdf: undefined, signer_pdf: undefined,
      folder_name: folder?.name || null,
      cc: parseJson(env.cc_json, []),
      draft: env.status === 'draft' ? parseJson(env.draft_json, null) : undefined,
      draft_json: undefined,
      signers: signers.map((s) => ({ ...s, signing_url: `${appUrl()}/sign/${s.token}`, your_turn: env.status === 'sent' && s.status === 'pending' && isSignerTurn(env, s) })),
      fields, events, attachments,
      can_seal: canSeal,
      archive_enabled: oneDriveEnabled(), archive_target: oneDriveEnabled() ? oneDriveTarget() : null,
      mail_enabled: mailEnabled(),
    });
  });

  app.get('/api/envelopes/:id/pdf', requireAuth, (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    res.contentType('application/pdf').send(readDecrypted(env.original_pdf));
  });

  app.get('/api/envelopes/:id/original', requireAuth, (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    res.set('Content-Disposition', `attachment; filename="${safeFilename(env.title)}-original.pdf"`);
    res.contentType('application/pdf').send(readDecrypted(env.original_pdf));
  });

  app.get('/api/envelopes/:id/download', requireAuth, (req, res) => {
    const env = ownEnvelope(req);
    if (!env?.final_pdf) return res.status(404).json({ error: 'No completed document' });
    const which = req.query.copy === 'signer' && env.signer_pdf ? env.signer_pdf : env.final_pdf;
    res.set('Content-Disposition', `attachment; filename="${safeFilename(env.title)}-signed.pdf"`);
    res.contentType('application/pdf').send(readDecrypted(which));
  });

  app.get('/api/envelopes/:id/attachments/:aid', requireAuth, (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    const a = db.prepare(`SELECT * FROM attachments WHERE id = ? AND envelope_id = ?`).get(req.params.aid, env.id);
    if (!a?.stored_path || !fs.existsSync(a.stored_path)) return res.status(404).json({ error: 'Attachment not uploaded' });
    res.set('Content-Disposition', `attachment; filename="${safeFilename(a.original_name || a.label)}"`);
    res.contentType(a.mime || 'application/octet-stream').send(readDecrypted(a.stored_path));
  });

  // ---------- Draft autosave / edit ----------
  app.put('/api/envelopes/:id/draft', requireAuth, (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    if (env.status !== 'draft') return res.status(409).json({ error: `Envelope is ${env.status}` });
    const state = req.body?.state;
    const json = JSON.stringify(state ?? {});
    if (json.length > 400_000) return res.status(413).json({ error: 'Draft too large' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 200) : null;
    db.prepare(`UPDATE envelopes SET draft_json = ?${title ? ', title = ?' : ''} WHERE id = ?`).run(...(title ? [json, title, env.id] : [json, env.id]));
    res.json({ ok: true, saved_at: nowSql() });
  });

  app.patch('/api/envelopes/:id', requireAuth, (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 200) : null;
    if (title) db.prepare(`UPDATE envelopes SET title = ? WHERE id = ?`).run(title, env.id);
    res.json({ ok: true });
  });

  app.delete('/api/envelopes/:id', requireAuth, (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    if (env.status === 'completed') return res.status(409).json({ error: 'Completed documents are kept as evidence and cannot be deleted' });
    if (env.status === 'sent') return res.status(409).json({ error: 'Void the envelope first, then delete it' });
    tx(() => {
      for (const a of db.prepare(`SELECT stored_path FROM attachments WHERE envelope_id = ?`).all(env.id)) { try { if (a.stored_path) fs.unlinkSync(a.stored_path); } catch { /* ignore */ } }
      db.prepare(`DELETE FROM attachments WHERE envelope_id = ?`).run(env.id);
      db.prepare(`DELETE FROM fields WHERE envelope_id = ?`).run(env.id);
      db.prepare(`DELETE FROM signers WHERE envelope_id = ?`).run(env.id);
      db.prepare(`DELETE FROM audit_events WHERE envelope_id = ?`).run(env.id);
      db.prepare(`DELETE FROM envelopes WHERE id = ?`).run(env.id);
    });
    for (const p of [env.original_pdf, env.final_pdf, env.signer_pdf]) { try { if (p) fs.unlinkSync(p); } catch { /* ignore */ } }
    res.json({ ok: true });
  });

  // ---------- Send ----------
  app.post('/api/envelopes/:id/send', requireAuth, async (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    if (env.status !== 'draft') return res.status(409).json({ error: `Envelope is already ${env.status}` });
    const settings = getSettings(req.user.id);
    const b = req.body || {};
    let signers, fields, folderId;
    try {
      signers = cleanSigners(b.signers);
      fields = normalizeFields(b.fields, signers.length, { requireSignature: true, requirePerSigner: true });
      folderId = resolveFolder(req, b.folder_id);
    } catch (e) { return res.status(400).json({ error: e.message }); }
    const sequential = b.sequential !== false;
    const code = b.access_code ? String(b.access_code).trim().slice(0, 40) : null;
    const expiryDays = b.expiry_days === undefined || b.expiry_days === null || b.expiry_days === '' ? settings.default_expiry_days : clampInt(b.expiry_days, 0, 365, 0);
    const reminderDays = b.reminder_days === undefined || b.reminder_days === null || b.reminder_days === '' ? settings.default_reminder_days : clampInt(b.reminder_days, 0, 30, 0);
    const cc = cleanCc(b.cc);
    const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 200) : env.title;
    const message = typeof b.message === 'string' ? b.message.trim().slice(0, 2000) : env.message;

    const created = tx(() => {
      db.prepare(`UPDATE envelopes SET title = ?, message = ?, folder_id = ?, access_code = ?, sequential = ?, status = 'sent', sent_at = datetime('now'),
                  expires_at = ?, reminder_days = ?, cc_json = ?, draft_json = NULL WHERE id = ?`)
        .run(title, message, folderId, code, sequential ? 1 : 0, expiryDays > 0 ? addDays(expiryDays) : null, reminderDays, JSON.stringify(cc), env.id);
      return insertSigners(env.id, signers, fields);
    });
    audit(env.id, 'envelope.sent', actorOf(req.user), `Sent to ${signers.map((s) => `${s.name} <${s.email}>`).join(', ')}${sequential && signers.length > 1 ? ' (in order)' : ''}${expiryDays ? ` · expires in ${expiryDays} day(s)` : ''}${reminderDays ? ` · reminders every ${reminderDays} day(s)` : ''}${cc.length ? ` · CC ${cc.map((c) => c.email).join(', ')}` : ''}`, clientIp(req));

    await notifyPendingSigners(env.id);
    queueWebhook(req.user.id, 'envelope.sent', envelopePayload(env.id));
    res.json({ status: 'sent', emailed: mailEnabled(), links: created.map((s) => ({ name: s.name, email: s.email, signing_url: `${appUrl()}/sign/${s.token}` })) });
  });

  // Bulk send: one draft + one field layout -> a separate envelope per recipient.
  app.post('/api/envelopes/:id/bulk-send', requireAuth, async (req, res) => {
    const draft = ownEnvelope(req);
    if (!draft) return res.status(404).json({ error: 'Not found' });
    if (draft.status !== 'draft') return res.status(409).json({ error: `Envelope is ${draft.status}` });
    const settings = getSettings(req.user.id);
    const b = req.body || {};
    const recipients = (Array.isArray(b.recipients) ? b.recipients : []).map((r) => ({ name: String(r?.name || '').trim().slice(0, 80), email: String(r?.email || '').trim().toLowerCase() })).filter((r) => r.name && validEmail(r.email));
    if (!recipients.length) return res.status(400).json({ error: 'Add at least one recipient (name + email)' });
    if (recipients.length > 500) return res.status(400).json({ error: 'Bulk send is limited to 500 recipients at a time' });
    let fields, folderId;
    try {
      fields = normalizeFields(b.fields, 1, { requireSignature: true });
      folderId = resolveFolder(req, b.folder_id);
    } catch (e) { return res.status(400).json({ error: e.message }); }
    const code = b.access_code ? String(b.access_code).trim().slice(0, 40) : null;
    const attachments = (Array.isArray(b.attachments) ? b.attachments : []).map((a) => String(a).trim().slice(0, 60)).filter(Boolean);
    const expiryDays = b.expiry_days === undefined || b.expiry_days === null || b.expiry_days === '' ? settings.default_expiry_days : clampInt(b.expiry_days, 0, 365, 0);
    const reminderDays = b.reminder_days === undefined || b.reminder_days === null || b.reminder_days === '' ? settings.default_reminder_days : clampInt(b.reminder_days, 0, 30, 0);
    const srcBytes = readDecrypted(draft.original_pdf);

    const results = [];
    const envIds = [];
    for (const r of recipients) {
      const eid = nanoid(12);
      const pdfPath = path.join(UPLOADS, `${eid}.pdf`);
      writeEncrypted(pdfPath, srcBytes);
      tx(() => {
        db.prepare(`INSERT INTO envelopes (id, user_id, folder_id, access_code, title, message, status, original_pdf, sha256_original, sequential, sent_at, expires_at, reminder_days, page_count)
                    VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?, 1, datetime('now'), ?, ?, ?)`)
          .run(eid, req.user.id, folderId, code, `${draft.title} — ${r.name}`, draft.message || '', pdfPath, draft.sha256_original, expiryDays > 0 ? addDays(expiryDays) : null, reminderDays, draft.page_count);
        const [s] = insertSigners(eid, [{ name: r.name, email: r.email, attachments, private_message: '' }], fields.map((f) => ({ ...f, signerIndex: 0 })));
        results.push({ name: r.name, email: r.email, signing_url: `${appUrl()}/sign/${s.token}` });
      });
      audit(eid, 'envelope.created', actorOf(req.user), `Bulk send copy for ${r.name} <${r.email}>`, clientIp(req));
      audit(eid, 'envelope.sent', actorOf(req.user), `Bulk send to ${r.name} <${r.email}>`, clientIp(req));
      envIds.push(eid);
    }
    // The draft template is consumed by the bulk send.
    tx(() => {
      db.prepare(`DELETE FROM audit_events WHERE envelope_id = ?`).run(draft.id);
      db.prepare(`DELETE FROM envelopes WHERE id = ?`).run(draft.id);
    });
    try { fs.unlinkSync(draft.original_pdf); } catch { /* ignore */ }

    // Emails go out in the background so 500 recipients don't block the request.
    (async () => { for (const id of envIds) { try { await notifyPendingSigners(id); } catch (e) { console.error('[bulk] notify failed', id, e.message); } } })();
    res.json({ status: 'sent', count: results.length, emailed: mailEnabled(), links: results });
  });

  // ---------- Lifecycle actions ----------
  app.post('/api/envelopes/:id/void', requireAuth, (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    if (env.status === 'completed') return res.status(409).json({ error: 'Completed envelopes cannot be voided' });
    if (env.status !== 'sent') return res.status(409).json({ error: `Envelope is ${env.status}` });
    db.prepare(`UPDATE envelopes SET status = 'voided' WHERE id = ?`).run(env.id);
    audit(env.id, 'envelope.voided', actorOf(req.user), String(req.body?.reason || '').slice(0, 300), clientIp(req));
    queueWebhook(req.user.id, 'envelope.voided', envelopePayload(env.id));
    res.json({ status: 'voided' });
  });

  // Send a reminder now to every pending signer whose turn it is.
  app.post('/api/envelopes/:id/remind', requireAuth, async (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    if (env.status !== 'sent') return res.status(409).json({ error: `Envelope is ${env.status}` });
    const targets = getSigners(env.id).filter((s) => s.status === 'pending' && isSignerTurn(env, s));
    if (!targets.length) return res.status(409).json({ error: 'Nobody is waiting to sign right now' });
    for (const s of targets) {
      await sendSignRequestTo(env, s, { isReminder: true });
      audit(env.id, 'reminder.sent', actorOf(req.user), `Manual reminder to ${s.email}`, clientIp(req));
    }
    db.prepare(`UPDATE envelopes SET last_reminder_at = datetime('now') WHERE id = ?`).run(env.id);
    res.json({ ok: true, reminded: targets.map((s) => s.email), emailed: mailEnabled() });
  });

  // Resend one signer's link (unchanged token).
  app.post('/api/envelopes/:id/signers/:sid/resend', requireAuth, async (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    const s = db.prepare(`SELECT * FROM signers WHERE id = ? AND envelope_id = ?`).get(req.params.sid, env.id);
    if (!s) return res.status(404).json({ error: 'Signer not found' });
    if (env.status !== 'sent' || s.status !== 'pending') return res.status(409).json({ error: 'This signer is not waiting to sign' });
    if (!isSignerTurn(env, s)) return res.status(409).json({ error: `It is not ${s.name}'s turn yet (signing is in order)` });
    await sendSignRequestTo(env, s, { isReminder: true });
    audit(env.id, 'reminder.sent', actorOf(req.user), `Link re-sent to ${s.email}`, clientIp(req));
    res.json({ ok: true, emailed: mailEnabled(), signing_url: `${appUrl()}/sign/${s.token}` });
  });

  // Correct a pending signer's name/email. A new link is issued and the old one stops working.
  app.patch('/api/envelopes/:id/signers/:sid', requireAuth, async (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    const s = db.prepare(`SELECT * FROM signers WHERE id = ? AND envelope_id = ?`).get(req.params.sid, env.id);
    if (!s) return res.status(404).json({ error: 'Signer not found' });
    if (env.status !== 'sent' || s.status !== 'pending') return res.status(409).json({ error: 'Only pending signers on a sent envelope can be changed' });
    const name = String(req.body?.name || s.name).trim().slice(0, 80);
    const email = String(req.body?.email || s.email).trim().toLowerCase();
    if (!name || !validEmail(email)) return res.status(400).json({ error: 'A name and a valid email are required' });
    const dup = db.prepare(`SELECT 1 FROM signers WHERE envelope_id = ? AND email = ? AND id != ?`).get(env.id, email, s.id);
    if (dup) return res.status(400).json({ error: 'Another signer already uses that email' });
    const token = nanoid(32);
    db.prepare(`UPDATE signers SET name = ?, email = ?, token = ?, notified_at = NULL, reminders_sent = 0 WHERE id = ?`).run(name, email, token, s.id);
    audit(env.id, 'signer.changed', actorOf(req.user), `Signer updated: ${s.name} <${s.email}> → ${name} <${email}>. Old link revoked.`, clientIp(req));
    const fresh = db.prepare(`SELECT * FROM signers WHERE id = ?`).get(s.id);
    if (isSignerTurn(env, fresh)) await sendSignRequestTo(env, fresh);
    res.json({ ok: true, signing_url: `${appUrl()}/sign/${token}`, emailed: mailEnabled() });
  });

  // Retry sealing after a failure (or seal an envelope whose signers are all done).
  app.post('/api/envelopes/:id/seal', requireAuth, async (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    const signers = getSigners(env.id);
    if (!signers.length || signers.some((s) => s.status !== 'signed')) return res.status(409).json({ error: 'Not all signers have signed yet' });
    if (env.final_pdf && !env.seal_error) return res.status(409).json({ error: 'Already sealed' });
    try {
      const r = await sealAndNotify(env.id);
      audit(env.id, 'seal.retried', actorOf(req.user), 'Sealing retried successfully', clientIp(req));
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ error: `Sealing failed again: ${e.message}` });
    }
  });

  app.post('/api/envelopes/:id/archive', requireAuth, async (req, res) => {
    const env = ownEnvelope(req);
    if (!env) return res.status(404).json({ error: 'Not found' });
    if (!oneDriveEnabled()) return res.status(503).json({ error: 'OneDrive archiving is not configured on this server' });
    if (env.status !== 'completed') return res.status(409).json({ error: 'Only completed envelopes can be archived' });
    try {
      const r = await archiveEnvelope(env.id);
      res.json({ ok: true, url: r.url, path: r.path });
    } catch (err) {
      audit(env.id, 'archive.failed', actorOf(req.user), `OneDrive archive failed: ${err.message.slice(0, 220)}`, clientIp(req));
      res.status(502).json({ error: `OneDrive upload failed: ${err.message}` });
    }
  });
}
