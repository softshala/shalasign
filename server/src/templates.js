// Reusable templates: a PDF + signer roles + field layout + default options.
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import db, { audit, STORAGE_DIR, isOrgAdmin } from './db.js';
import { findEnvelope, canEdit } from './scope.js';
import { requireAuth } from './auth.js';
import { readDecrypted, writeEncrypted } from './crypto.js';
import { normalizeFields } from './fields.js';
import { actorOf, clientIp } from './util.js';

const UPLOADS = path.join(STORAGE_DIR, 'uploads');

const rowToTemplate = (t) => ({
  id: t.id, name: t.name, created_at: t.created_at, use_count: t.use_count, sha256: t.sha256,
  roles: JSON.parse(t.roles_json || '[]'), fields: JSON.parse(t.fields_json || '[]'), options: JSON.parse(t.options_json || '{}'),
});

export function registerTemplateRoutes(app) {
  app.get('/api/templates', requireAuth, (req, res) => {
    const rows = db.prepare(`SELECT t.*, u.name AS owner_name FROM templates t LEFT JOIN users u ON u.id = t.user_id WHERE t.org_id = ? ORDER BY t.created_at DESC`).all(req.user.org_id);
    res.json(rows.map((t) => ({ ...rowToTemplate(t), owner_name: t.owner_name, mine: t.user_id === req.user.id })));
  });

  app.get('/api/templates/:id', requireAuth, (req, res) => {
    const t = db.prepare(`SELECT * FROM templates WHERE id = ? AND org_id = ?`).get(req.params.id, req.user.org_id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    res.json(rowToTemplate(t));
  });

  app.get('/api/templates/:id/pdf', requireAuth, (req, res) => {
    const t = db.prepare(`SELECT * FROM templates WHERE id = ? AND org_id = ?`).get(req.params.id, req.user.org_id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    res.contentType('application/pdf').send(readDecrypted(t.pdf_path));
  });

  // Save the current Prepare state of a draft envelope as a template.
  app.post('/api/templates', requireAuth, (req, res) => {
    const { envelope_id, name, roles = [], fields = [], options = {} } = req.body || {};
    const env = findEnvelope(req.user, envelope_id);
    if (!env || !canEdit(req.user, env)) return res.status(404).json({ error: 'Envelope not found' });
    const tname = String(name || env.title).trim().slice(0, 100);
    if (!tname) return res.status(400).json({ error: 'Template name is required' });
    const cleanRoles = (Array.isArray(roles) ? roles : []).slice(0, 10).map((r, i) => ({
      name: String(r?.name || `Signer ${i + 1}`).trim().slice(0, 60) || `Signer ${i + 1}`,
      attachments: (Array.isArray(r?.attachments) ? r.attachments : []).map((a) => String(a).trim().slice(0, 60)).filter(Boolean),
    }));
    if (!cleanRoles.length) cleanRoles.push({ name: 'Signer 1', attachments: [] });
    let cleanFields;
    try { cleanFields = normalizeFields(fields, cleanRoles.length, { requireSignature: false }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const cleanOptions = {
      sequential: options.sequential !== false,
      message: String(options.message || '').slice(0, 2000),
      access_code: String(options.access_code || '').slice(0, 40),
      expiry_days: Math.max(0, Math.min(365, parseInt(options.expiry_days, 10) || 0)),
      reminder_days: Math.max(0, Math.min(30, parseInt(options.reminder_days, 10) || 0)),
      cc: (Array.isArray(options.cc) ? options.cc : []).slice(0, 20),
    };
    const id = nanoid(12);
    const pdfPath = path.join(UPLOADS, `tpl-${id}.pdf`);
    writeEncrypted(pdfPath, readDecrypted(env.original_pdf));
    db.prepare(`INSERT INTO templates (id, user_id, org_id, name, pdf_path, sha256, roles_json, fields_json, options_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, req.user.org_id, tname, pdfPath, env.sha256_original, JSON.stringify(cleanRoles), JSON.stringify(cleanFields), JSON.stringify(cleanOptions));
    res.json({ id, name: tname });
  });

  app.patch('/api/templates/:id', requireAuth, (req, res) => {
    const t = db.prepare(`SELECT * FROM templates WHERE id = ? AND org_id = ?`).get(req.params.id, req.user.org_id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.user_id !== req.user.id && !isOrgAdmin(req.user)) return res.status(403).json({ error: 'Only the creator or an admin can change this template' });
    const name = String(req.body?.name || '').trim().slice(0, 100);
    if (name) db.prepare(`UPDATE templates SET name = ? WHERE id = ?`).run(name, t.id);
    res.json({ ok: true });
  });

  app.delete('/api/templates/:id', requireAuth, (req, res) => {
    const t = db.prepare(`SELECT * FROM templates WHERE id = ? AND org_id = ?`).get(req.params.id, req.user.org_id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (t.user_id !== req.user.id && !isOrgAdmin(req.user)) return res.status(403).json({ error: 'Only the creator or an admin can delete this template' });
    db.prepare(`DELETE FROM templates WHERE id = ?`).run(t.id);
    try { fs.unlinkSync(t.pdf_path); } catch { /* already gone */ }
    res.json({ ok: true });
  });

  // Create a new draft envelope from a template. The Prepare page opens it with
  // the roles, fields and options pre-filled (stored in draft_json).
  app.post('/api/templates/:id/use', requireAuth, (req, res) => {
    const t = db.prepare(`SELECT * FROM templates WHERE id = ? AND org_id = ?`).get(req.params.id, req.user.org_id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const tpl = rowToTemplate(t);
    const id = nanoid(12);
    const pdfPath = path.join(UPLOADS, `${id}.pdf`);
    writeEncrypted(pdfPath, readDecrypted(t.pdf_path));
    const title = String(req.body?.title || tpl.name).trim().slice(0, 200) || tpl.name;
    const draft = {
      signers: tpl.roles.map((r) => ({ name: '', email: '', role: r.name, attachments: r.attachments || [], private_message: '' })),
      fields: tpl.fields,
      sequential: tpl.options.sequential !== false,
      message: tpl.options.message || '',
      access_code: tpl.options.access_code || '',
      expiry_days: tpl.options.expiry_days ?? null,
      reminder_days: tpl.options.reminder_days ?? null,
      cc: tpl.options.cc || [],
      folder_id: req.body?.folder_id || null,
    };
    const extSys = String(req.body?.external_system || '').trim().toLowerCase().slice(0, 40) || null;
    db.prepare(`INSERT INTO envelopes (id, user_id, org_id, title, message, original_pdf, sha256_original, template_id, draft_json, external_system, external_id, external_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, req.user.org_id, title, draft.message, pdfPath, t.sha256, t.id, JSON.stringify(draft), extSys, extSys ? String(req.body?.external_id || '').slice(0, 120) || null : null, extSys && /^https?:\/\//.test(String(req.body?.external_url || '')) ? String(req.body.external_url).slice(0, 500) : null);
    db.prepare(`UPDATE templates SET use_count = use_count + 1 WHERE id = ?`).run(t.id);
    audit(id, 'envelope.created', actorOf(req.user), `Created from template "${t.name}"`, clientIp(req));
    res.json({ id, title });
  });
}
