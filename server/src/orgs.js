// Organisations / workspaces: members, roles, invitations, and the admin
// choices between shared and individual sending/storage.
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import db, { getOrg, isOrgAdmin, createOrgForUser, tx } from './db.js';
import { requireAuth, currentUser } from './auth.js';
import { appUrl, brandFor, mailRouteFor, sendOrgInvite, sendTestEmail } from './mailer.js';
import { publicConnection, listFolders } from './connections.js';
import { validEmail } from './util.js';

const requireAdmin = (req, res, next) => (isOrgAdmin(req.user) ? next() : res.status(403).json({ error: 'Only workspace admins can do this' }));
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function orgPayload(orgId, user) {
  const org = getOrg(orgId);
  if (!org) return null;
  const members = db.prepare(`SELECT id, name, email, role, created_at FROM users WHERE org_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name`).all(orgId);
  const admin = isOrgAdmin(user);
  const invites = admin ? db.prepare(`SELECT token_hash AS id, email, role, created_at, expires_at FROM org_invites WHERE org_id = ? AND accepted_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC`).all(orgId) : [];
  const connections = admin ? db.prepare(`SELECT c.*, u.name AS owner_name FROM connections c JOIN users u ON u.id = c.user_id WHERE u.org_id = ? ORDER BY u.name, c.provider`).all(orgId).map((c) => ({ ...publicConnection(c), owner_name: c.owner_name })) : [];
  const sharedMail = org.shared_mail_connection_id ? db.prepare(`SELECT account_email, provider FROM connections WHERE id = ?`).get(org.shared_mail_connection_id) : null;
  const sharedStorage = org.shared_storage_connection_id ? db.prepare(`SELECT account_email, provider FROM connections WHERE id = ?`).get(org.shared_storage_connection_id) : null;
  return {
    id: org.id, name: org.name, plan: org.plan, created_at: org.created_at,
    email_mode: org.email_mode, shared_mail_connection_id: org.shared_mail_connection_id, shared_mail: sharedMail,
    storage_mode: org.storage_mode, shared_storage_connection_id: org.shared_storage_connection_id, shared_storage_root_id: org.shared_storage_root_id, shared_storage_root_path: org.shared_storage_root_path, shared_storage: sharedStorage,
    visibility: org.visibility,
    my_role: user.role, is_admin: admin, is_owner: user.role === 'owner',
    members, invites, connections,
  };
}

/** Attach a user to an org via an invite token. Returns the org or throws. */
export function acceptInvite(user, token) {
  const inv = db.prepare(`SELECT * FROM org_invites WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > datetime('now')`).get(hash(token));
  if (!inv) throw Object.assign(new Error('This invitation is invalid or has expired. Ask your admin for a new one.'), { status: 400 });
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw Object.assign(new Error(`This invitation was sent to ${inv.email}. Log in with that email to accept it.`), { status: 403 });
  if (user.org_id === inv.org_id) { db.prepare(`UPDATE org_invites SET accepted_at = datetime('now') WHERE token_hash = ?`).run(inv.token_hash); return getOrg(inv.org_id); }
  tx(() => {
    const oldOrg = getOrg(user.org_id);
    db.prepare(`UPDATE users SET org_id = ?, role = ? WHERE id = ?`).run(inv.org_id, inv.role === 'admin' ? 'admin' : 'member', user.id);
    // Bring the user's own documents, templates, folders and connections along.
    db.prepare(`UPDATE envelopes SET org_id = ? WHERE user_id = ?`).run(inv.org_id, user.id);
    db.prepare(`UPDATE templates SET org_id = ? WHERE user_id = ?`).run(inv.org_id, user.id);
    db.prepare(`UPDATE folders SET org_id = ? WHERE user_id = ?`).run(inv.org_id, user.id);
    db.prepare(`UPDATE connections SET org_id = ? WHERE user_id = ?`).run(inv.org_id, user.id);
    db.prepare(`UPDATE org_invites SET accepted_at = datetime('now') WHERE token_hash = ?`).run(inv.token_hash);
    // Delete the now-empty personal workspace.
    if (oldOrg && oldOrg.owner_user_id === user.id && !db.prepare(`SELECT 1 FROM users WHERE org_id = ?`).get(oldOrg.id)) db.prepare(`DELETE FROM orgs WHERE id = ?`).run(oldOrg.id);
  });
  return getOrg(inv.org_id);
}

export function registerOrgRoutes(app) {
  app.get('/api/org', requireAuth, (req, res) => {
    let org = orgPayload(req.user.org_id, req.user);
    if (!org) { createOrgForUser(req.user.id, req.user.name); req.user.role = 'owner'; org = orgPayload('org_' + req.user.id, req.user); }
    res.json(org);
  });

  app.put('/api/org', requireAuth, requireAdmin, (req, res) => {
    const org = getOrg(req.user.org_id);
    const b = req.body || {};
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : org.name;
    const emailMode = ['individual', 'shared'].includes(b.email_mode) ? b.email_mode : org.email_mode;
    const storageMode = ['individual', 'shared'].includes(b.storage_mode) ? b.storage_mode : org.storage_mode;
    const visibility = ['own', 'all'].includes(b.visibility) ? b.visibility : org.visibility;
    const inOrg = (id, cap) => id ? db.prepare(`SELECT c.id FROM connections c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND u.org_id = ? AND c.${cap} = 1`).get(id, org.id) : null;
    let sharedMail = org.shared_mail_connection_id;
    if (b.shared_mail_connection_id !== undefined) {
      if (b.shared_mail_connection_id && !inOrg(b.shared_mail_connection_id, 'can_mail')) return res.status(400).json({ error: 'That inbox is not connected by a member of this workspace' });
      sharedMail = b.shared_mail_connection_id || null;
    }
    let sharedStorage = org.shared_storage_connection_id, rootId = org.shared_storage_root_id, rootPath = org.shared_storage_root_path;
    if (b.shared_storage_connection_id !== undefined) {
      if (b.shared_storage_connection_id && !inOrg(b.shared_storage_connection_id, 'can_storage')) return res.status(400).json({ error: 'That drive is not connected by a member of this workspace' });
      sharedStorage = b.shared_storage_connection_id || null;
      rootId = sharedStorage ? (b.shared_storage_root_id || null) : null;
      rootPath = sharedStorage ? String(b.shared_storage_root_path || '').slice(0, 300) : null;
    }
    if (emailMode === 'shared' && !sharedMail) return res.status(400).json({ error: 'Choose which connected inbox the workspace should send from' });
    if (storageMode === 'shared' && !sharedStorage) return res.status(400).json({ error: 'Choose which connected drive the workspace should archive to' });
    db.prepare(`UPDATE orgs SET name = ?, email_mode = ?, shared_mail_connection_id = ?, storage_mode = ?, shared_storage_connection_id = ?, shared_storage_root_id = ?, shared_storage_root_path = ?, visibility = ? WHERE id = ?`)
      .run(name, emailMode, sharedMail, storageMode, sharedStorage, rootId, rootPath, visibility, org.id);
    res.json(orgPayload(org.id, req.user));
  });

  // ---- invitations ----
  app.post('/api/org/invites', requireAuth, requireAdmin, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = req.body?.role === 'admin' ? 'admin' : 'member';
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    const existing = db.prepare(`SELECT org_id FROM users WHERE email = ?`).get(email);
    if (existing?.org_id === req.user.org_id) return res.status(409).json({ error: 'That person is already a member' });
    const members = db.prepare(`SELECT COUNT(*) n FROM users WHERE org_id = ?`).get(req.user.org_id).n;
    if (members >= 200) return res.status(400).json({ error: 'Workspace member limit reached' });
    const raw = nanoid(40);
    db.prepare(`DELETE FROM org_invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL`).run(req.user.org_id, email);
    db.prepare(`INSERT INTO org_invites (token_hash, org_id, email, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+7 days'))`).run(hash(raw), req.user.org_id, email, role, req.user.id);
    const link = `${appUrl()}/join/${raw}`;
    const org = getOrg(req.user.org_id);
    const r = await sendOrgInvite({ to: email, orgName: org.name, inviterName: req.user.name, link, brand: brandFor(req.user.id) });
    res.json({ ok: true, link, emailed: !!r.sent, via: r.via || null });
  });
  app.delete('/api/org/invites/:id', requireAuth, requireAdmin, (req, res) => {
    db.prepare(`DELETE FROM org_invites WHERE token_hash = ? AND org_id = ?`).run(req.params.id, req.user.org_id);
    res.json({ ok: true });
  });

  // Public: what is this invitation? (for the join page)
  app.get('/api/org/join/:token', (req, res) => {
    const inv = db.prepare(`SELECT i.email, i.role, o.name AS org_name, u.name AS inviter FROM org_invites i JOIN orgs o ON o.id = i.org_id JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > datetime('now')`).get(hash(req.params.token));
    if (!inv) return res.status(404).json({ error: 'This invitation is invalid or has expired.' });
    const existing = db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(inv.email.toLowerCase());
    const me = currentUser(req);
    res.json({ email: inv.email, role: inv.role, org_name: inv.org_name, inviter: inv.inviter, account_exists: !!existing, logged_in_as: me?.email || null });
  });
  app.post('/api/org/join/:token', requireAuth, (req, res) => {
    try { const org = acceptInvite(req.user, req.params.token); res.json({ ok: true, org: { id: org.id, name: org.name } }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  // ---- members ----
  app.patch('/api/org/members/:id', requireAuth, requireAdmin, (req, res) => {
    const m = db.prepare(`SELECT * FROM users WHERE id = ? AND org_id = ?`).get(req.params.id, req.user.org_id);
    if (!m) return res.status(404).json({ error: 'Member not found' });
    const role = req.body?.role;
    if (!['admin', 'member', 'owner'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (m.role === 'owner' || role === 'owner') {
      if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can transfer ownership' });
      if (role === 'owner') { tx(() => { db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(req.user.id); db.prepare(`UPDATE users SET role = 'owner' WHERE id = ?`).run(m.id); db.prepare(`UPDATE orgs SET owner_user_id = ? WHERE id = ?`).run(m.id, req.user.org_id); }); return res.json({ ok: true }); }
    }
    db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, m.id);
    res.json({ ok: true });
  });
  app.delete('/api/org/members/:id', requireAuth, requireAdmin, (req, res) => {
    const m = db.prepare(`SELECT * FROM users WHERE id = ? AND org_id = ?`).get(req.params.id, req.user.org_id);
    if (!m) return res.status(404).json({ error: 'Member not found' });
    if (m.role === 'owner') return res.status(400).json({ error: 'The owner cannot be removed. Transfer ownership first.' });
    if (m.id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
    tx(() => {
      // Their documents stay in the workspace; they get a fresh personal workspace.
      db.prepare(`UPDATE users SET org_id = NULL, role = 'member' WHERE id = ?`).run(m.id);
      db.prepare(`UPDATE orgs SET shared_mail_connection_id = NULL WHERE id = ? AND shared_mail_connection_id IN (SELECT id FROM connections WHERE user_id = ?)`).run(req.user.org_id, m.id);
      db.prepare(`UPDATE orgs SET shared_storage_connection_id = NULL, shared_storage_root_id = NULL, shared_storage_root_path = NULL WHERE id = ? AND shared_storage_connection_id IN (SELECT id FROM connections WHERE user_id = ?)`).run(req.user.org_id, m.id);
      createOrgForUser(m.id, m.name);
      db.prepare(`UPDATE connections SET org_id = ? WHERE user_id = ?`).run('org_' + m.id, m.id);
    });
    res.json({ ok: true });
  });

  // Admin: browse folders of a workspace member's connected drive (for the shared-storage picker).
  app.get('/api/org/connections/:id/folders', requireAuth, requireAdmin, async (req, res) => {
    const c = db.prepare(`SELECT c.* FROM connections c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND u.org_id = ? AND c.can_storage = 1`).get(req.params.id, req.user.org_id);
    if (!c) return res.status(404).json({ error: 'Connection not found' });
    try { res.json({ folders: await listFolders(c, req.query.parent ? String(req.query.parent) : null) }); }
    catch (e) { res.status(e.code === 'RECONNECT' ? 409 : 502).json({ error: e.message }); }
  });

  // Test email from whatever route applies to me.
  app.post('/api/org/test-email', requireAuth, async (req, res) => {
    const route = await mailRouteFor(req.user.id);
    if (!route) return res.status(503).json({ error: 'No email route available: connect an inbox in Settings → Connected accounts, or ask the operator to configure the platform sender.' });
    const r = await sendTestEmail({ to: req.user.email, brand: brandFor(req.user.id) });
    res.json(r.sent ? { ok: true, via: r.via, account: r.account, fallback_from: r.fallback_from || null } : { ok: false, error: r.error || 'not sent' });
  });
}
