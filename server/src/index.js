import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import db, { audit, STORAGE_DIR, tx } from './db.js';
import { sealEnvelope, sha256 } from './pdf.js';
import { mailEnabled, appUrl, sendSignRequest, sendCompletionEmail } from './mailer.js';
import { registerAuthRoutes, requireAuth } from './auth.js';
import { registerSsoRoutes } from './sso.js';
import { registerOtpRoutes } from './otp.js';
import { archiveEnvelope, archiveInBackground, oneDriveEnabled, oneDriveTarget } from './onedrive.js';
import { writeEncrypted, readDecrypted, encStr, encryptionActive } from './crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS = path.join(STORAGE_DIR, 'uploads'); // beside the database, outside the app folder
fs.mkdirSync(UPLOADS, { recursive: true });

const app = express();
app.disable('x-powered-by');

// Security headers (no dependency needed).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (process.env.COOKIE_SECURE) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
app.use(express.json({ limit: '30mb' })); // room for signature + attachment uploads

registerAuthRoutes(app);
registerSsoRoutes(app);   // Google / Microsoft sign-in (when configured)
registerOtpRoutes(app);   // emailed one-time code login (when SMTP configured)

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (_req, file, cb) => cb(null, `${nanoid(12)}.pdf`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype === 'application/pdf' ? cb(null, true) : cb(new Error('Only PDF files are accepted')),
});

// Health / deployment check. Deliberately contains no secrets: it tells you whether
// data will survive a redeploy, which is the #1 hosting mistake.
function storageIsMount() {
  try { return fs.statSync(STORAGE_DIR).dev !== fs.statSync(path.dirname(STORAGE_DIR)).dev; } catch { return false; }
}
app.get('/api/health', (_req, res) => {
  const hosted = !!(process.env.RENDER || process.env.STORAGE_DIR);
  const persistent = !hosted || storageIsMount();
  res.json({
    ok: true,
    uptime_seconds: Math.round(process.uptime()),
    hosted_on_render: !!process.env.RENDER,
    storage_dir_from_env: !!process.env.STORAGE_DIR,
    storage_is_persistent_disk: persistent,
    encryption_key_source: process.env.SIGNFLOW_SECRET ? 'env' : 'file-in-storage-dir',
    warnings: [
      ...(!persistent ? ['Storage is NOT a persistent disk: accounts, documents and sessions are erased on every deploy/restart. Attach a disk and set STORAGE_DIR to its mount path.'] : []),
      ...(process.env.RENDER && !process.env.SIGNFLOW_SECRET ? ['SIGNFLOW_SECRET is not set: the encryption key lives on the data disk, so disk backups can be decrypted by whoever holds them.'] : []),
    ],
  });
});

const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

// ---------- Envelopes ----------

// Create a draft envelope from an uploaded PDF
app.post('/api/envelopes', requireAuth, upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A PDF file is required (field name: pdf)' });
  const id = nanoid(12);
  const bytes = fs.readFileSync(req.file.path);
  const hash = sha256(bytes);
  writeEncrypted(req.file.path, bytes); // encrypt the stored PDF at rest
  db.prepare(
    `INSERT INTO envelopes (id, user_id, title, message, original_pdf, sha256_original) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.id, req.body.title || req.file.originalname, req.body.message || '', req.file.path, hash);
  audit(id, 'envelope.created', `${req.user.name} <${req.user.email}>`, `Uploaded "${req.file.originalname}" (${bytes.length} bytes, sha256 ${hash.slice(0, 16)}…)`, clientIp(req));
  res.json({ id, sha256: hash });
});

// Fetch an envelope only if it belongs to the logged-in user.
function ownEnvelope(req) {
  return db.prepare(`SELECT * FROM envelopes WHERE id = ? AND user_id = ?`).get(req.params.id, req.user.id);
}

app.get('/api/envelopes', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT id, title, status, folder_id, created_at, completed_at FROM envelopes WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id);
  const counts = db.prepare(`SELECT envelope_id, COUNT(*) total, SUM(status='signed') signed FROM signers GROUP BY envelope_id`).all();
  const byEnv = Object.fromEntries(counts.map((c) => [c.envelope_id, c]));
  const folders = db.prepare(`SELECT id, name FROM folders WHERE user_id = ?`).all(req.user.id);
  const folderName = Object.fromEntries(folders.map((f) => [f.id, f.name]));
  res.json(rows.map((r) => ({ ...r, folder_name: folderName[r.folder_id] || null, signers_total: byEnv[r.id]?.total || 0, signers_signed: byEnv[r.id]?.signed || 0 })));
});

// ---------- Folders ----------
app.get('/api/folders', requireAuth, (req, res) => {
  const folders = db.prepare(`SELECT id, name, created_at FROM folders WHERE user_id = ? ORDER BY name`).all(req.user.id);
  const counts = db.prepare(`SELECT folder_id, COUNT(*) n FROM envelopes WHERE user_id = ? AND folder_id IS NOT NULL GROUP BY folder_id`).all(req.user.id);
  const byFolder = Object.fromEntries(counts.map((c) => [c.folder_id, c.n]));
  res.json(folders.map((f) => ({ ...f, count: byFolder[f.id] || 0 })));
});

app.post('/api/folders', requireAuth, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  const id = nanoid(10);
  db.prepare(`INSERT INTO folders (id, user_id, name) VALUES (?, ?, ?)`).run(id, req.user.id, name);
  res.json({ id, name });
});

// Move an envelope into (or out of) a folder.
app.post('/api/envelopes/:id/folder', requireAuth, (req, res) => {
  const env = ownEnvelope(req);
  if (!env) return res.status(404).json({ error: 'Not found' });
  const folderId = req.body?.folder_id || null;
  if (folderId) {
    const f = db.prepare(`SELECT id FROM folders WHERE id = ? AND user_id = ?`).get(folderId, req.user.id);
    if (!f) return res.status(400).json({ error: 'Unknown folder' });
  }
  db.prepare(`UPDATE envelopes SET folder_id = ? WHERE id = ?`).run(folderId, env.id);
  res.json({ ok: true });
});

app.get('/api/envelopes/:id', requireAuth, (req, res) => {
  const env = ownEnvelope(req);
  if (!env) return res.status(404).json({ error: 'Not found' });
  const signers = db.prepare(`SELECT id, name, email, order_index, status, token, consent_at, signed_at FROM signers WHERE envelope_id = ? ORDER BY order_index`).all(env.id);
  const fields = db.prepare(`SELECT * FROM fields WHERE envelope_id = ?`).all(env.id);
  const events = db.prepare(`SELECT type, actor, detail, ip, created_at FROM audit_events WHERE envelope_id = ? ORDER BY id`).all(env.id);
  res.json({ ...env, original_pdf: undefined, final_pdf: undefined, signer_pdf: undefined, signers, fields, events,
    archive_enabled: oneDriveEnabled(), archive_target: oneDriveEnabled() ? oneDriveTarget() : null });
});

// Serve the original PDF (for the sender's field-placement editor)
app.get('/api/envelopes/:id/pdf', requireAuth, (req, res) => {
  const env = ownEnvelope(req);
  if (!env) return res.status(404).json({ error: 'Not found' });
  res.contentType('application/pdf').send(readDecrypted(env.original_pdf));
});

// Attach signers + fields and send
app.post('/api/envelopes/:id/send', requireAuth, async (req, res) => {
  const env = ownEnvelope(req);
  if (!env) return res.status(404).json({ error: 'Not found' });
  if (env.status !== 'draft') return res.status(409).json({ error: `Envelope is ${env.status}` });

  const { signers = [], fields = [], sequential = true, folder_id = null, access_code = null } = req.body;
  if (!signers.length) return res.status(400).json({ error: 'At least one signer is required' });
  if (!fields.some((f) => f.type === 'signature')) return res.status(400).json({ error: 'At least one signature field is required' });

  // Optional folder + signer access code.
  let folder = null;
  if (folder_id) {
    folder = db.prepare(`SELECT id FROM folders WHERE id = ? AND user_id = ?`).get(folder_id, req.user.id);
    if (!folder) return res.status(400).json({ error: 'Unknown folder' });
  }
  const code = access_code ? String(access_code).trim() : null;
  db.prepare(`UPDATE envelopes SET folder_id = ?, access_code = ? WHERE id = ?`).run(folder ? folder.id : null, code || null, env.id);

  const insSigner = db.prepare(`INSERT INTO signers (id, envelope_id, name, email, order_index, token) VALUES (?, ?, ?, ?, ?, ?)`);
  const insField = db.prepare(`INSERT INTO fields (id, envelope_id, signer_id, type, page, x, y, w, h, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insAtt = db.prepare(`INSERT INTO attachments (id, envelope_id, signer_id, label) VALUES (?, ?, ?, ?)`);

  const links = tx(() => {
    const out = [];
    signers.forEach((s, i) => {
      const sid = nanoid(10);
      const token = nanoid(32); // capability URL — knowing it grants signing access
      insSigner.run(sid, env.id, s.name, s.email, i, token);
      out.push({ name: s.name, email: s.email, signing_url: `/sign/${token}` });
      for (const f of fields.filter((f) => f.signerIndex === i)) {
        insField.run(nanoid(10), env.id, sid, f.type, f.page, f.x, f.y, f.w, f.h, f.label || '');
      }
      // Required attachments the sender set for this signer (e.g. Aadhaar, PAN).
      for (const label of (s.attachments || [])) {
        if (String(label).trim()) insAtt.run(nanoid(10), env.id, sid, String(label).trim());
      }
    });
    db.prepare(`UPDATE envelopes SET status = 'sent', sequential = ? WHERE id = ?`).run(sequential ? 1 : 0, env.id);
    return out;
  });

  audit(env.id, 'envelope.sent', `${req.user.name} <${req.user.email}>`, `Sent to ${signers.map((s) => `${s.name} <${s.email}>`).join(', ')}`, clientIp(req));

  // Email signing links. Sequential routing: only the first signer is
  // notified now; the next one is emailed when their turn comes.
  const dbSigners = db.prepare(`SELECT * FROM signers WHERE envelope_id = ? ORDER BY order_index`).all(env.id);
  const toNotify = sequential ? dbSigners.slice(0, 1) : dbSigners;
  for (const s of toNotify) {
    const r = await sendSignRequest({ signer: s, envelope: env, senderNote: env.message });
    audit(env.id, r.sent ? 'email.sent' : 'email.skipped', 'system',
      `Signing request ${r.sent ? 'emailed to' : 'not emailed (SMTP ' + (r.error ? 'error: ' + r.error : 'not configured') + ') for'} ${s.email}`);
  }

  res.json({ status: 'sent', emailed: mailEnabled(), links: links.map((l) => ({ ...l, signing_url: `${appUrl()}${l.signing_url}` })) });
});

// Bulk send: take the draft document + one field layout and create a separate
// envelope for each recipient, each sent individually (like Zoho's Bulk send).
app.post('/api/envelopes/:id/bulk-send', requireAuth, async (req, res) => {
  const draft = ownEnvelope(req);
  if (!draft) return res.status(404).json({ error: 'Not found' });
  if (draft.status !== 'draft') return res.status(409).json({ error: `Envelope is ${draft.status}` });

  const { recipients = [], fields = [], folder_id = null, access_code = null, attachments = [] } = req.body;
  const clean = recipients.filter((r) => r.name?.trim() && r.email?.trim());
  if (clean.length < 1) return res.status(400).json({ error: 'Add at least one recipient (name + email)' });
  if (clean.length > 500) return res.status(400).json({ error: 'Bulk send is limited to 500 recipients at a time' });
  if (!fields.some((f) => f.type === 'signature')) return res.status(400).json({ error: 'Place at least one signature field' });

  let folderId = null;
  if (folder_id) {
    const f = db.prepare(`SELECT id FROM folders WHERE id = ? AND user_id = ?`).get(folder_id, req.user.id);
    if (!f) return res.status(400).json({ error: 'Unknown folder' });
    folderId = f.id;
  }
  const code = access_code ? String(access_code).trim() : null;
  const srcBytes = readDecrypted(draft.original_pdf);

  const results = [];
  for (const r of clean) {
    const eid = nanoid(12);
    const pdfPath = path.join(UPLOADS, `${eid}.pdf`);
    writeEncrypted(pdfPath, srcBytes); // each envelope gets its own encrypted copy
    db.prepare(
      `INSERT INTO envelopes (id, user_id, folder_id, access_code, title, message, status, original_pdf, sha256_original, sequential) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?, 1)`
    ).run(eid, req.user.id, folderId, code, `${draft.title} — ${r.name}`, draft.message || '', pdfPath, draft.sha256_original);

    const sid = nanoid(10);
    const token = nanoid(32);
    db.prepare(`INSERT INTO signers (id, envelope_id, name, email, order_index, token) VALUES (?, ?, ?, ?, 0, ?)`).run(sid, eid, r.name.trim(), r.email.trim(), token);
    for (const f of fields) {
      db.prepare(`INSERT INTO fields (id, envelope_id, signer_id, type, page, x, y, w, h, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(nanoid(10), eid, sid, f.type, f.page, f.x, f.y, f.w, f.h, f.label || '');
    }
    for (const label of attachments) {
      if (String(label).trim()) db.prepare(`INSERT INTO attachments (id, envelope_id, signer_id, label) VALUES (?, ?, ?, ?)`).run(nanoid(10), eid, sid, String(label).trim());
    }
    audit(eid, 'envelope.created', `${req.user.name} <${req.user.email}>`, `Bulk send copy for ${r.name} <${r.email}>`, clientIp(req));
    audit(eid, 'envelope.sent', `${req.user.name} <${req.user.email}>`, `Bulk send to ${r.name} <${r.email}>`, clientIp(req));

    const dbSigner = db.prepare(`SELECT * FROM signers WHERE id = ?`).get(sid);
    const envRow = db.prepare(`SELECT * FROM envelopes WHERE id = ?`).get(eid);
    const mr = await sendSignRequest({ signer: dbSigner, envelope: envRow, senderNote: draft.message });
    audit(eid, mr.sent ? 'email.sent' : 'email.skipped', 'system', `Bulk signing request ${mr.sent ? 'emailed to' : 'not emailed for'} ${r.email}`);
    results.push({ name: r.name, email: r.email, signing_url: `${appUrl()}/sign/${token}` });
  }

  // The draft template is consumed by the bulk send — remove it and its rows.
  tx(() => {
    db.prepare(`DELETE FROM audit_events WHERE envelope_id = ?`).run(draft.id);
    db.prepare(`DELETE FROM attachments WHERE envelope_id = ?`).run(draft.id);
    db.prepare(`DELETE FROM fields WHERE envelope_id = ?`).run(draft.id);
    db.prepare(`DELETE FROM signers WHERE envelope_id = ?`).run(draft.id);
    db.prepare(`DELETE FROM envelopes WHERE id = ?`).run(draft.id);
  });
  res.json({ status: 'sent', count: results.length, emailed: mailEnabled(), links: results });
});

app.post('/api/envelopes/:id/void', requireAuth, (req, res) => {
  const env = ownEnvelope(req);
  if (!env) return res.status(404).json({ error: 'Not found' });
  if (env.status === 'completed') return res.status(409).json({ error: 'Completed envelopes cannot be voided' });
  db.prepare(`UPDATE envelopes SET status = 'voided' WHERE id = ?`).run(env.id);
  audit(env.id, 'envelope.voided', `${req.user.name} <${req.user.email}>`, req.body?.reason || '', clientIp(req));
  res.json({ status: 'voided' });
});

// Copy (or re-copy) the sealed PDF to OneDrive/SharePoint on demand.
app.post('/api/envelopes/:id/archive', requireAuth, async (req, res) => {
  const env = ownEnvelope(req);
  if (!env) return res.status(404).json({ error: 'Not found' });
  if (!oneDriveEnabled()) return res.status(503).json({ error: 'OneDrive archiving is not configured on this server' });
  if (env.status !== 'completed') return res.status(409).json({ error: 'Only completed envelopes can be archived' });
  try {
    const r = await archiveEnvelope(env.id);
    res.json({ ok: true, url: r.url, path: r.path });
  } catch (err) {
    audit(env.id, 'archive.failed', `${req.user.name} <${req.user.email}>`, `OneDrive archive failed: ${err.message.slice(0, 220)}`, clientIp(req));
    res.status(502).json({ error: `OneDrive upload failed: ${err.message}` });
  }
});

app.get('/api/envelopes/:id/download', requireAuth, (req, res) => {
  const env = ownEnvelope(req);
  if (!env?.final_pdf) return res.status(404).json({ error: 'No completed document' });
  res.set('Content-Disposition', `attachment; filename="${env.title.replace(/[^\w. -]/g, '_')}-signed.pdf"`);
  res.contentType('application/pdf').send(readDecrypted(env.final_pdf));
});

// ---------- Signing ceremony ----------

function signerByToken(token) {
  return db.prepare(`SELECT * FROM signers WHERE token = ?`).get(token);
}

function isSignerTurn(env, signer) {
  if (!env.sequential) return true;
  const ahead = db.prepare(
    `SELECT COUNT(*) n FROM signers WHERE envelope_id = ? AND order_index < ? AND status != 'signed'`
  ).get(env.id, signer.order_index);
  return ahead.n === 0;
}

// Access code: compare the code sent in the x-access-code header.
function codeOk(env, req) {
  if (!env.access_code) return true;
  return String(req.headers['x-access-code'] || '') === env.access_code;
}

// Throttle access-code guessing per signing link.
const codeFails = new Map(); // token -> { count, until }
function codeLocked(token) {
  const f = codeFails.get(token);
  return f && f.until > Date.now();
}
function recordCodeFail(token) {
  const f = codeFails.get(token) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 8) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  codeFails.set(token, f);
}

app.get('/api/sign/:token', (req, res) => {
  const signer = signerByToken(req.params.token);
  if (!signer) return res.status(404).json({ error: 'Invalid or expired signing link' });
  const env = db.prepare(`SELECT * FROM envelopes WHERE id = ?`).get(signer.envelope_id);
  if (env.status === 'voided') return res.status(410).json({ error: 'This envelope was voided by the sender' });
  // Locked by an access code the sender set — signer must enter it first.
  if (env.access_code) {
    if (codeLocked(req.params.token)) return res.status(429).json({ error: 'Too many wrong codes. Try again in 15 minutes.' });
    if (!codeOk(env, req)) {
      if (req.headers['x-access-code']) recordCodeFail(req.params.token);
      return res.json({ locked: true, envelope: { title: env.title } });
    }
  }
  const fields = db.prepare(`SELECT id, type, page, x, y, w, h, label, value FROM fields WHERE signer_id = ?`).all(signer.id);
  const attachments = db.prepare(`SELECT id, label, original_name, stored_path FROM attachments WHERE signer_id = ?`).all(signer.id)
    .map((a) => ({ id: a.id, label: a.label, uploaded: !!a.stored_path, original_name: a.original_name }));
  audit(env.id, 'envelope.viewed', `${signer.name} <${signer.email}>`, '', clientIp(req));
  res.json({
    envelope: { id: env.id, title: env.title, message: env.message, status: env.status },
    signer: { name: signer.name, email: signer.email, status: signer.status },
    your_turn: isSignerTurn(env, signer),
    fields,
    attachments,
  });
});

app.get('/api/sign/:token/pdf', (req, res) => {
  const signer = signerByToken(req.params.token);
  if (!signer) return res.status(404).json({ error: 'Invalid link' });
  const env = db.prepare(`SELECT original_pdf, access_code FROM envelopes WHERE id = ?`).get(signer.envelope_id);
  if (!codeOk(env, req)) return res.status(401).json({ error: 'Access code required' });
  res.contentType('application/pdf').send(readDecrypted(env.original_pdf));
});

app.post('/api/sign/:token', async (req, res) => {
  const signer = signerByToken(req.params.token);
  if (!signer) return res.status(404).json({ error: 'Invalid or expired signing link' });
  const env = db.prepare(`SELECT * FROM envelopes WHERE id = ?`).get(signer.envelope_id);

  if (env.status !== 'sent') return res.status(409).json({ error: `Envelope is ${env.status}` });
  if (!codeOk(env, req)) return res.status(401).json({ error: 'Wrong access code' });
  if (signer.status === 'signed') return res.status(409).json({ error: 'You have already signed' });
  if (!isSignerTurn(env, signer)) return res.status(409).json({ error: 'It is not your turn to sign yet' });

  const { consent, signature_image, values = {}, attachments: uploads = [] } = req.body;
  if (!consent) return res.status(400).json({ error: 'You must consent to sign electronically' });
  if (!signature_image?.startsWith('data:image/')) return res.status(400).json({ error: 'A signature image is required' });

  // Required attachments must all be provided (or already uploaded).
  const required = db.prepare(`SELECT * FROM attachments WHERE signer_id = ?`).all(signer.id);
  const uploadById = Object.fromEntries((uploads || []).map((u) => [u.id, u]));
  for (const r of required) {
    const already = r.stored_path;
    const incoming = uploadById[r.id];
    if (!already && !(incoming && typeof incoming.data === 'string' && incoming.data.startsWith('data:'))) {
      return res.status(400).json({ error: `Please attach the required document: ${r.label}` });
    }
  }

  const ip = clientIp(req);
  const ua = (req.headers['user-agent'] || '').toString();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Save uploaded attachment files to disk.
  const extFor = (mime) => (mime.includes('pdf') ? '.pdf' : mime.includes('png') ? '.png' : (mime.includes('jpeg') || mime.includes('jpg')) ? '.jpg' : '.bin');
  for (const r of required) {
    const incoming = uploadById[r.id];
    if (!incoming || !incoming.data?.startsWith('data:')) continue;
    const mime = incoming.data.slice(5, incoming.data.indexOf(';')).toLowerCase();
    const base64 = incoming.data.split(',')[1] || '';
    const buf = Buffer.from(base64, 'base64');
    const p = path.join(UPLOADS, `att-${nanoid(10)}${extFor(mime)}`);
    writeEncrypted(p, buf); // encrypt the ID document at rest
    db.prepare(`UPDATE attachments SET stored_path=?, original_name=?, mime=?, uploaded_at=? WHERE id=?`)
      .run(p, (incoming.filename || 'attachment').slice(0, 120), mime, now, r.id);
  }

  const myFields = db.prepare(`SELECT * FROM fields WHERE signer_id = ?`).all(signer.id);
  const setValue = db.prepare(`UPDATE fields SET value = ? WHERE id = ?`);

  tx(() => {
    for (const f of myFields) {
      if (f.type === 'date') setValue.run(now.slice(0, 10), f.id);
      else if (f.type === 'signature' || f.type === 'initials') setValue.run('signed', f.id);
      else setValue.run(String(values[f.id] ?? ''), f.id);
    }
    db.prepare(
      `UPDATE signers SET status='signed', signature_image=?, consent_at=?, signed_at=?, ip=?, user_agent=? WHERE id=?`
    ).run(encStr(signature_image), now, now, ip, ua, signer.id); // signature encrypted at rest
  });
  if (required.length) audit(env.id, 'signer.attached', `${signer.name} <${signer.email}>`, `Uploaded ${required.length} required document(s): ${required.map((r) => r.label).join(', ')}`, ip);

  audit(env.id, 'signer.consented', `${signer.name} <${signer.email}>`, 'Agreed to use electronic records and signatures', ip);
  audit(env.id, 'signer.signed', `${signer.name} <${signer.email}>`, `Completed ${myFields.length} field(s)`, ip);

  const remaining = db.prepare(`SELECT COUNT(*) n FROM signers WHERE envelope_id = ? AND status != 'signed'`).get(env.id).n;
  if (remaining > 0) {
    // Sequential routing: it's now the next signer's turn — email them.
    if (env.sequential) {
      const next = db.prepare(
        `SELECT * FROM signers WHERE envelope_id = ? AND status != 'signed' ORDER BY order_index LIMIT 1`
      ).get(env.id);
      if (next) {
        const r = await sendSignRequest({ signer: next, envelope: env, senderNote: env.message });
        audit(env.id, r.sent ? 'email.sent' : 'email.skipped', 'system',
          `Next-signer notification ${r.sent ? 'emailed to' : 'not emailed for'} ${next.email}`);
      }
    }
    return res.json({ status: 'signed', envelope_status: 'sent', remaining_signers: remaining });
  }

  // Everyone has signed — seal the document
  try {
    const completedAt = now;
    db.prepare(`UPDATE envelopes SET completed_at = ? WHERE id = ?`).run(completedAt, env.id);
    audit(env.id, 'envelope.completed', 'system', 'All signers completed; sealing document');

    const fullEnv = db.prepare(`SELECT * FROM envelopes WHERE id = ?`).get(env.id);
    const signers = db.prepare(`SELECT * FROM signers WHERE envelope_id = ? ORDER BY order_index`).all(env.id);
    const fields = db.prepare(`SELECT * FROM fields WHERE envelope_id = ?`).all(env.id);
    const events = db.prepare(`SELECT * FROM audit_events WHERE envelope_id = ? ORDER BY id`).all(env.id);
    const attachments = db.prepare(`SELECT * FROM attachments WHERE envelope_id = ?`).all(env.id);

    // Sender's copy — full audit trail + attachments (encrypted at rest).
    const finalBytes = await sealEnvelope({ envelope: fullEnv, signers, fields, events, attachments, includeAuditTrail: true });
    const finalPath = path.join(UPLOADS, `${env.id}-final.pdf`);
    writeEncrypted(finalPath, finalBytes);
    const finalHash = sha256(finalBytes);

    // Signers' copy — certificate WITHOUT the audit trail (signers + details only).
    const signerBytes = await sealEnvelope({ envelope: fullEnv, signers, fields, events, attachments, includeAuditTrail: false });
    const signerPath = path.join(UPLOADS, `${env.id}-signer.pdf`);
    writeEncrypted(signerPath, signerBytes);

    db.prepare(`UPDATE envelopes SET status='completed', final_pdf=?, signer_pdf=?, sha256_final=? WHERE id=?`).run(finalPath, signerPath, finalHash, env.id);
    audit(env.id, 'document.sealed', 'system', `Final document sha256 ${finalHash}`);
    archiveInBackground(env.id); // copy to OneDrive/SharePoint if configured (does not block the signer)

    // Email the signers' copy (no audit trail) to every signer. The email
    // attachment is the decrypted PDF content (not the on-disk ciphertext).
    const sealedEnv = db.prepare(`SELECT * FROM envelopes WHERE id = ?`).get(env.id);
    for (const s of signers) {
      const r = await sendCompletionEmail({ to: s.email, name: s.name, envelope: sealedEnv, pdfContent: signerBytes });
      audit(env.id, r.sent ? 'email.sent' : 'email.skipped', 'system',
        `Completion email ${r.sent ? 'sent to' : 'not sent to'} ${s.email}`);
    }

    res.json({ status: 'signed', envelope_status: 'completed', final_sha256: finalHash });
  } catch (err) {
    console.error('Sealing failed:', err);
    res.status(500).json({ error: 'Signature recorded but sealing failed: ' + err.message });
  }
});

// ---------- Static frontend (production build) ----------
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`SignFlow server on http://localhost:${PORT}`);
  if ((process.env.RENDER || process.env.STORAGE_DIR) && !storageIsMount()) {
    console.warn('\n!!! WARNING: STORAGE_DIR is not on a persistent disk. All accounts, documents and sessions');
    console.warn(`!!! will be ERASED on the next deploy or restart. Storage dir: ${STORAGE_DIR}`);
    console.warn('!!! Fix: attach a disk to the service and set STORAGE_DIR to its mount path (see render.yaml).\n');
  }
  if (process.env.RENDER && !process.env.SIGNFLOW_SECRET) {
    console.warn('!!! WARNING: SIGNFLOW_SECRET is not set; the encryption key is stored next to the data.');
  }
});
