// "Connect your account": one-click OAuth to the user's own Microsoft 365 or
// Google account, with DELEGATED scopes a normal user can consent to — no
// admin portal, no server configuration per customer. The platform app
// credentials (MS_CLIENT_ID/SECRET, GOOGLE_CLIENT_ID/SECRET) are set once by
// the operator; that's the only server-side setup, exactly like Zoho/Adobe.
//
//   Microsoft: Mail.Send (send as the user), Files.ReadWrite (their OneDrive)
//   Google:    gmail.send, drive.file (only files ShalaSign creates)
//
// Tokens are encrypted at rest and refreshed automatically.
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import db, { getOrg, getSettings, isOrgAdmin } from './db.js';
import { requireAuth } from './auth.js';
import { appUrl } from './mailer.js';
import { encStr, decStr } from './crypto.js';
import { nowSql, sqlToDate } from './util.js';

import { googleConfig, microsoftConfig } from './platform.js';

const COOKIE = 'sf_connect';
const LOGIN = (process.env.MS_LOGIN_BASE_URL || 'https://login.microsoftonline.com').replace(/\/$/, '');
export const GRAPH = (process.env.GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
export const GOOGLE_API = (process.env.GOOGLE_API_BASE_URL || 'https://www.googleapis.com').replace(/\/$/, '');
const GOOGLE_TOKEN = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';

const STATIC = {
  microsoft: { label: 'Microsoft 365', base: ['openid', 'profile', 'email', 'offline_access', 'User.Read'], mail: ['Mail.Send'], storage: ['Files.ReadWrite'], hasScope: (scopes, s) => scopes.some((x) => x.toLowerCase() === s.toLowerCase() || x.toLowerCase().endsWith('/' + s.toLowerCase())) },
  google: { label: 'Google', base: ['openid', 'email', 'profile'], mail: ['https://www.googleapis.com/auth/gmail.send'], storage: ['https://www.googleapis.com/auth/drive.file'], hasScope: (scopes, s) => scopes.includes(s) },
};
// Credentials come from the operator console (or env) and may change at runtime.
const PROVIDERS = new Proxy({}, { get(_t, name) {
  if (name === 'microsoft') { const c = microsoftConfig(); return c ? { ...STATIC.microsoft, clientId: c.clientId, clientSecret: c.clientSecret, authUrl: `${LOGIN}/${c.tenant}/oauth2/v2.0/authorize`, tokenUrl: (t) => `${LOGIN}/${t || c.tenant}/oauth2/v2.0/token` } : { ...STATIC.microsoft, clientId: null, clientSecret: null, authUrl: '', tokenUrl: (t) => `${LOGIN}/${t || 'common'}/oauth2/v2.0/token` }; }
  if (name === 'google') { const c = googleConfig(); return { ...STATIC.google, clientId: c?.clientId || null, clientSecret: c?.clientSecret || null, authUrl: GOOGLE_AUTH, tokenUrl: () => GOOGLE_TOKEN }; }
  return undefined;
} });
export const connectEnabled = (p) => !!(PROVIDERS[p]?.clientId && PROVIDERS[p]?.clientSecret);
const b64url = (b) => Buffer.from(b).toString('base64url');
const redirectUri = (p) => `${appUrl()}/api/connect/${p}/callback`;
const cookieOpts = (req) => ({ httpOnly: true, sameSite: 'lax', secure: !!process.env.COOKIE_SECURE || !!req?.secure, maxAge: 10 * 60 * 1000, path: '/api/connect' });
const decodeJwt = (jwt) => { try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; } };

export const getConnection = (id) => (id ? db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id) : null);
export const publicConnection = (c) => c && ({ id: c.id, provider: c.provider, label: PROVIDERS[c.provider]?.label || c.provider, account_email: c.account_email, account_name: c.account_name, can_mail: !!c.can_mail, can_storage: !!c.can_storage, last_error: c.last_error, created_at: c.created_at, user_id: c.user_id });

function capabilities(provider, scopes) {
  const p = PROVIDERS[provider];
  return {
    can_mail: p.mail.every((s) => p.hasScope(scopes, s)) ? 1 : 0,
    can_storage: p.storage.every((s) => p.hasScope(scopes, s)) ? 1 : 0,
  };
}

// ---------- tokens ----------
/** Valid access token for a connection, refreshing if needed. Throws a friendly error if the user must reconnect. */
export async function accessTokenFor(conn) {
  const exp = sqlToDate(conn.access_expires_at);
  if (conn.access_token && exp && exp.getTime() - Date.now() > 60_000) return decStr(conn.access_token);
  const p = PROVIDERS[conn.provider];
  const refresh = decStr(conn.refresh_token);
  if (!refresh) throw reconnectError(conn, 'no refresh token');
  const r = await fetch(p.tokenUrl(conn.tenant_id), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: p.clientId, client_secret: p.clientSecret, ...(conn.provider === 'microsoft' ? { scope: [...p.base, ...(conn.can_mail ? p.mail : []), ...(conn.can_storage ? p.storage : [])].join(' ') } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    db.prepare(`UPDATE connections SET last_error = ?, updated_at = datetime('now') WHERE id = ?`).run(`${j.error || r.status}: ${(j.error_description || '').slice(0, 160)}`, conn.id);
    throw reconnectError(conn, j.error_description || j.error || `HTTP ${r.status}`);
  }
  const expiresAt = nowSql(new Date(Date.now() + (j.expires_in || 3600) * 1000));
  db.prepare(`UPDATE connections SET access_token = ?, access_expires_at = ?, refresh_token = COALESCE(?, refresh_token), last_error = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(encStr(j.access_token), expiresAt, j.refresh_token ? encStr(j.refresh_token) : null, conn.id);
  return j.access_token;
}
function reconnectError(conn, detail) {
  const e = new Error(`Your ${PROVIDERS[conn.provider]?.label || conn.provider} connection (${conn.account_email}) needs to be reconnected in Settings → Connected accounts (${detail}).`);
  e.code = 'RECONNECT';
  return e;
}

/** Authenticated fetch against Graph / Google APIs for a connection. Returns parsed JSON (or {} for empty). */
export async function apiFetch(conn, url, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const token = await accessTokenFor(conn);
  const isJsonBody = body && typeof body === 'object' && !(body instanceof Uint8Array);
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(isJsonBody ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: isJsonBody ? JSON.stringify(body) : body });
  if (raw) return r;
  const text = await r.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return {}; } })() : {};
  if (!r.ok) {
    const err = new Error(`${PROVIDERS[conn.provider]?.label} API ${method} ${url.replace(GRAPH, '').replace(GOOGLE_API, '')} → ${r.status} ${json.error?.code || json.error?.status || ''} ${json.error?.message || text.slice(0, 160)}`.trim());
    err.status = r.status; err.code = json.error?.code; err.body = json;
    throw err;
  }
  return json;
}

// ---------- resolution: which connection sends mail / stores files for a user ----------
export function resolveMailConnection(userId) {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  if (!user) return null;
  const org = getOrg(user.org_id);
  if (org?.email_mode === 'shared' && org.shared_mail_connection_id) {
    const c = getConnection(org.shared_mail_connection_id);
    if (c?.can_mail) return { conn: c, reason: 'shared' };
  }
  const s = getSettings(userId);
  if (s.mail_connection_id) { const c = getConnection(s.mail_connection_id); if (c?.can_mail && c.user_id === userId) return { conn: c, reason: 'chosen' }; }
  const any = db.prepare(`SELECT * FROM connections WHERE user_id = ? AND can_mail = 1 ORDER BY created_at LIMIT 1`).get(userId);
  return any ? { conn: any, reason: 'default' } : null;
}
export function resolveStorageTarget(userId) {
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  if (!user) return null;
  const org = getOrg(user.org_id);
  if (org?.storage_mode === 'shared' && org.shared_storage_connection_id) {
    const c = getConnection(org.shared_storage_connection_id);
    if (c?.can_storage) return { conn: c, rootId: org.shared_storage_root_id, rootPath: org.shared_storage_root_path || '', shared: true };
  }
  const s = getSettings(userId);
  if (s.archive_connection_id) { const c = getConnection(s.archive_connection_id); if (c?.can_storage && c.user_id === userId) return { conn: c, rootId: s.archive_root_id, rootPath: s.archive_root_path || '', shared: false }; }
  return null;
}

// ---------- folder browsing (for the picker) ----------
export async function listFolders(conn, parent) {
  if (conn.provider === 'microsoft') {
    const url = parent ? `${GRAPH}/me/drive/items/${encodeURIComponent(parent)}/children?$select=id,name,folder,parentReference&$top=200` : `${GRAPH}/me/drive/root/children?$select=id,name,folder,parentReference&$top=200`;
    const j = await apiFetch(conn, url);
    return (j.value || []).filter((i) => i.folder).map((i) => ({ id: i.id, name: i.name, path: ((i.parentReference?.path || '').replace(/^\/drive\/root:?/, '') + '/' + i.name).replace(/^\/+/, '') }));
  }
  const q = `'${parent || 'root'}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const j = await apiFetch(conn, `${GOOGLE_API}/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=200&orderBy=name`);
  return (j.files || []).map((f) => ({ id: f.id, name: f.name }));
}
export async function createFolder(conn, parent, name) {
  if (conn.provider === 'microsoft') {
    const url = parent ? `${GRAPH}/me/drive/items/${encodeURIComponent(parent)}/children` : `${GRAPH}/me/drive/root/children`;
    const j = await apiFetch(conn, url, { method: 'POST', body: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' } });
    return { id: j.id, name: j.name, path: ((j.parentReference?.path || '').replace(/^\/drive\/root:?/, '') + '/' + j.name).replace(/^\/+/, '') };
  }
  const j = await apiFetch(conn, `${GOOGLE_API}/drive/v3/files?fields=id,name`, { method: 'POST', body: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent || 'root'] } });
  return { id: j.id, name: j.name };
}

// ---------- routes ----------
export function registerConnectionRoutes(app) {
  // What's connected, what's possible, and what will actually be used.
  app.get('/api/connections', requireAuth, (req, res) => {
    const mine = db.prepare(`SELECT * FROM connections WHERE user_id = ? ORDER BY created_at`).all(req.user.id).map(publicConnection);
    const org = getOrg(req.user.org_id);
    const s = getSettings(req.user.id);
    const mail = resolveMailConnection(req.user.id);
    const storage = resolveStorageTarget(req.user.id);
    const platformMail = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    res.json({
      providers: { microsoft: connectEnabled('microsoft'), google: connectEnabled('google') },
      connections: mine,
      choices: { mail_connection_id: s.mail_connection_id, archive_connection_id: s.archive_connection_id, archive_root_id: s.archive_root_id, archive_root_path: s.archive_root_path },
      effective: {
        mail: mail ? { via: mail.conn.provider, account: mail.conn.account_email, reason: mail.reason, label: PROVIDERS[mail.conn.provider].label } : platformMail ? { via: 'platform', account: process.env.FROM_EMAIL || process.env.SMTP_USER, reason: 'platform' } : { via: 'none' },
        storage: storage ? { via: storage.conn.provider, account: storage.conn.account_email, root_path: storage.rootPath || (storage.conn.provider === 'google' ? 'My Drive' : ''), shared: storage.shared, label: PROVIDERS[storage.conn.provider].label } : { via: 'none' },
      },
      org: org ? { email_mode: org.email_mode, storage_mode: org.storage_mode, is_admin: isOrgAdmin(req.user) } : null,
    });
  });

  // Step 1: start consent. ?use=mail,storage (default both).
  app.get('/api/connect/:provider', requireAuth, (req, res) => {
    const name = req.params.provider; const p = PROVIDERS[name];
    if (!p || !connectEnabled(name)) return res.status(404).json({ error: `${name} connections are not available on this server` });
    const use = String(req.query.use || 'mail,storage').split(',').map((s) => s.trim()).filter((s) => ['mail', 'storage'].includes(s));
    const existing = db.prepare(`SELECT scopes FROM connections WHERE user_id = ? AND provider = ?`).get(req.user.id, name);
    const prior = existing ? existing.scopes.split(' ').filter(Boolean) : [];
    const scopes = [...new Set([...p.base, ...(use.includes('mail') ? p.mail : []), ...(use.includes('storage') ? p.storage : []), ...prior])];
    const state = b64url(crypto.randomBytes(24)); const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    res.cookie(COOKIE, b64url(JSON.stringify({ state, verifier, provider: name, userId: req.user.id, back: String(req.query.back || '/settings?tab=connections') })), cookieOpts(req));
    const params = new URLSearchParams({
      client_id: p.clientId, redirect_uri: redirectUri(name), response_type: 'code', scope: scopes.join(' '), state,
      code_challenge: challenge, code_challenge_method: 'S256',
      ...(name === 'google' ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', login_hint: req.user.email } : { prompt: 'select_account', login_hint: req.user.email }),
    });
    res.redirect(`${p.authUrl}?${params}`);
  });

  // Step 2: callback — exchange, identify the account, store encrypted tokens.
  app.get('/api/connect/:provider/callback', async (req, res) => {
    const name = req.params.provider; const p = PROVIDERS[name];
    let saved = null;
    try { saved = JSON.parse(Buffer.from(req.cookies?.[COOKIE] || '', 'base64url').toString('utf8')); } catch { /* missing */ }
    const back = saved?.back && saved.back.startsWith('/') ? saved.back : '/settings?tab=connections';
    const fail = (msg) => { res.clearCookie(COOKIE, { path: '/api/connect' }); res.redirect(`${appUrl()}${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(msg)}`); };
    if (!p || !connectEnabled(name)) return fail(`${name} connections are not available`);
    if (!saved || saved.provider !== name || !req.query.state || saved.state !== req.query.state) return fail('The connection attempt expired or was tampered with. Please try again.');
    if (req.query.error) return fail(String(req.query.error_description || req.query.error));
    if (!req.query.code) return fail('No authorization code was returned.');
    try {
      const tr = await fetch(p.tokenUrl(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri(name), client_id: p.clientId, client_secret: p.clientSecret, code_verifier: saved.verifier }) });
      const tokens = await tr.json().catch(() => ({}));
      if (!tr.ok || !tokens.access_token) { console.error(`[connect:${name}]`, tokens); return fail(`${p.label} rejected the connection (${tokens.error || tr.status}).`); }
      const claims = tokens.id_token ? decodeJwt(tokens.id_token) : {};
      let email, displayName, externalId, tenantId = null;
      if (name === 'microsoft') {
        const me = await (await fetch(`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).json().catch(() => ({}));
        email = (me.mail || me.userPrincipalName || claims.preferred_username || claims.email || '').toLowerCase();
        displayName = me.displayName || claims.name || ''; externalId = me.id || claims.oid; tenantId = claims.tid || null;
      } else {
        const me = await (await fetch(process.env.GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } })).json().catch(() => ({}));
        email = (me.email || claims.email || '').toLowerCase(); displayName = me.name || claims.name || ''; externalId = me.sub || claims.sub;
      }
      if (!email) return fail(`${p.label} did not share which account was connected.`);
      const granted = String(tokens.scope || '').split(/\s+/).filter(Boolean);
      const existing = db.prepare(`SELECT * FROM connections WHERE user_id = ? AND provider = ?`).get(saved.userId, name);
      const scopes = [...new Set([...(existing ? existing.scopes.split(' ').filter(Boolean) : []), ...granted])];
      const caps = capabilities(name, scopes);
      const expiresAt = nowSql(new Date(Date.now() + (tokens.expires_in || 3600) * 1000));
      const user = db.prepare(`SELECT org_id FROM users WHERE id = ?`).get(saved.userId);
      if (existing) {
        db.prepare(`UPDATE connections SET account_email = ?, account_name = ?, external_id = ?, tenant_id = COALESCE(?, tenant_id), scopes = ?, refresh_token = COALESCE(?, refresh_token), access_token = ?, access_expires_at = ?, can_mail = ?, can_storage = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ?`)
          .run(email, displayName, externalId, tenantId, scopes.join(' '), tokens.refresh_token ? encStr(tokens.refresh_token) : null, encStr(tokens.access_token), expiresAt, caps.can_mail, caps.can_storage, existing.id);
      } else {
        db.prepare(`INSERT INTO connections (id, user_id, org_id, provider, account_email, account_name, external_id, tenant_id, scopes, refresh_token, access_token, access_expires_at, can_mail, can_storage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(nanoid(12), saved.userId, user?.org_id || null, name, email, displayName, externalId, tenantId, scopes.join(' '), tokens.refresh_token ? encStr(tokens.refresh_token) : null, encStr(tokens.access_token), expiresAt, caps.can_mail, caps.can_storage);
      }
      res.clearCookie(COOKIE, { path: '/api/connect' });
      res.redirect(`${appUrl()}${back}${back.includes('?') ? '&' : '?'}connected=${name}`);
    } catch (err) {
      console.error(`[connect:${name}]`, err);
      fail(`Connecting ${p.label} failed. Please try again.`);
    }
  });

  app.delete('/api/connections/:id', requireAuth, async (req, res) => {
    const c = db.prepare(`SELECT * FROM connections WHERE id = ? AND user_id = ?`).get(req.params.id, req.user.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (c.provider === 'google') { try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decStr(c.refresh_token) || decStr(c.access_token) || '')}`, { method: 'POST' }); } catch { /* best effort */ } }
    db.prepare(`DELETE FROM connections WHERE id = ?`).run(c.id);
    db.prepare(`UPDATE user_settings SET mail_connection_id = NULL WHERE mail_connection_id = ?`).run(c.id);
    db.prepare(`UPDATE user_settings SET archive_connection_id = NULL, archive_root_id = NULL, archive_root_path = NULL WHERE archive_connection_id = ?`).run(c.id);
    db.prepare(`UPDATE orgs SET shared_mail_connection_id = NULL WHERE shared_mail_connection_id = ?`).run(c.id);
    db.prepare(`UPDATE orgs SET shared_storage_connection_id = NULL, shared_storage_root_id = NULL, shared_storage_root_path = NULL WHERE shared_storage_connection_id = ?`).run(c.id);
    res.json({ ok: true });
  });

  // Choose which connected inbox sends my emails (null = platform sender).
  app.put('/api/connections/mail-choice', requireAuth, (req, res) => {
    const id = req.body?.connection_id || null;
    if (id) { const c = db.prepare(`SELECT * FROM connections WHERE id = ? AND user_id = ? AND can_mail = 1`).get(id, req.user.id); if (!c) return res.status(400).json({ error: 'That connection cannot send mail' }); }
    upsertSettings(req.user.id, { mail_connection_id: id });
    res.json({ ok: true });
  });

  // Choose where my completed documents are archived.
  app.put('/api/connections/archive-target', requireAuth, (req, res) => {
    const { connection_id = null, root_id = null, root_path = null } = req.body || {};
    if (connection_id) { const c = db.prepare(`SELECT * FROM connections WHERE id = ? AND user_id = ? AND can_storage = 1`).get(connection_id, req.user.id); if (!c) return res.status(400).json({ error: 'That connection cannot store files' }); }
    upsertSettings(req.user.id, { archive_connection_id: connection_id, archive_root_id: connection_id ? root_id : null, archive_root_path: connection_id ? String(root_path || '').slice(0, 300) : null });
    res.json({ ok: true });
  });

  // Folder picker.
  app.get('/api/connections/:id/folders', requireAuth, async (req, res) => {
    const c = db.prepare(`SELECT * FROM connections WHERE id = ? AND (user_id = ? OR org_id = ?)`).get(req.params.id, req.user.id, req.user.org_id);
    if (!c?.can_storage) return res.status(404).json({ error: 'Connection not found or cannot access files' });
    if (c.user_id !== req.user.id && !isOrgAdmin(req.user)) return res.status(403).json({ error: 'Only admins can browse another member\'s drive' });
    try { res.json({ folders: await listFolders(c, req.query.parent ? String(req.query.parent) : null) }); }
    catch (e) { res.status(e.code === 'RECONNECT' ? 409 : 502).json({ error: e.message }); }
  });
  app.post('/api/connections/:id/folders', requireAuth, async (req, res) => {
    const c = db.prepare(`SELECT * FROM connections WHERE id = ? AND (user_id = ? OR org_id = ?)`).get(req.params.id, req.user.id, req.user.org_id);
    if (!c?.can_storage) return res.status(404).json({ error: 'Connection not found or cannot access files' });
    if (c.user_id !== req.user.id && !isOrgAdmin(req.user)) return res.status(403).json({ error: 'Only admins can create folders in another member\'s drive' });
    const name = String(req.body?.name || '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100);
    if (!name) return res.status(400).json({ error: 'Folder name is required' });
    try { res.json(await createFolder(c, req.body?.parent ? String(req.body.parent) : null, name)); }
    catch (e) { res.status(e.code === 'RECONNECT' ? 409 : 502).json({ error: e.message }); }
  });
}

function upsertSettings(userId, patch) {
  db.prepare(`INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`).run(userId);
  const keys = Object.keys(patch);
  db.prepare(`UPDATE user_settings SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE user_id = ?`).run(...keys.map((k) => patch[k]), userId);
}
