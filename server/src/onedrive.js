// OneDrive / SharePoint archive via Microsoft Graph.
//
// When an envelope completes, the sealed PDF (sender's copy, with certificate
// and audit trail) is copied into a OneDrive or SharePoint document library:
//
//   {ONEDRIVE_FOLDER}/{SignFlow folder name or "Unfiled"}/{title} [{envelope id}] signed.pdf
//
// Authentication is app-only (client-credentials) using the same Entra app
// registration as Microsoft sign-in (MS_TENANT / MS_CLIENT_ID / MS_CLIENT_SECRET),
// so no user needs to be logged in when a signer finishes at 2 a.m.
//
// Destination — set ONE of:
//   ONEDRIVE_USER=archive@softshala.com                   -> that user's OneDrive
//   ONEDRIVE_SITE=softshala.sharepoint.com/sites/Contracts -> that site's default library
// Optional:
//   ONEDRIVE_FOLDER=SignFlow                              (root folder; default "SignFlow")
//
// Required Graph APPLICATION permission on the app registration (+ admin consent):
//   Files.ReadWrite.All  (for ONEDRIVE_USER)   or   Sites.ReadWrite.All  (for ONEDRIVE_SITE)
import db, { audit } from './db.js';
import { readDecrypted } from './crypto.js';

const cfg = {
  tenant: process.env.MS_TENANT,
  clientId: process.env.MS_CLIENT_ID,
  secret: process.env.MS_CLIENT_SECRET,
  user: process.env.ONEDRIVE_USER,
  site: process.env.ONEDRIVE_SITE,
  folder: (process.env.ONEDRIVE_FOLDER || 'SignFlow').replace(/^\/+|\/+$/g, '') || 'SignFlow',
};
// Overridable for tests only.
const GRAPH = (process.env.GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
const LOGIN = (process.env.MS_LOGIN_BASE_URL || 'https://login.microsoftonline.com').replace(/\/$/, '');

const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;   // Graph: simple PUT up to 4 MB
const CHUNK = 10 * 1024 * 1024;              // upload-session chunk (multiple of 320 KiB)

export const oneDriveEnabled = () => !!(cfg.tenant && cfg.clientId && cfg.secret && (cfg.user || cfg.site));
export const oneDriveTarget = () => (cfg.site ? `SharePoint ${cfg.site}` : `OneDrive of ${cfg.user}`) + ` / ${cfg.folder}`;

// ---- Graph plumbing ----
let tokenCache = { value: null, exp: 0 };
async function accessToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp - 60_000) return tokenCache.value;
  const r = await fetch(`${LOGIN}/${cfg.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.secret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Microsoft token request failed: ${j.error_description || j.error || r.status}`);
  tokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}

async function graph(path, { method = 'GET', body, contentType = 'application/json' } = {}) {
  const r = await fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': contentType } : {}) },
    body,
  });
  const text = await r.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return {}; } })() : {};
  if (!r.ok) {
    const err = new Error(`Graph ${method} ${path} → ${r.status} ${json.error?.code || ''} ${json.error?.message || text.slice(0, 200)}`.trim());
    err.status = r.status;
    err.code = json.error?.code;
    throw err;
  }
  return json;
}

let driveId = null;
async function resolveDriveId() {
  if (driveId) return driveId;
  if (cfg.site) {
    const [host, ...rest] = cfg.site.replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/');
    const site = await graph(`/sites/${host}:/${rest.join('/')}`);
    driveId = (await graph(`/sites/${site.id}/drive`)).id;
  } else {
    driveId = (await graph(`/users/${encodeURIComponent(cfg.user)}/drive`)).id;
  }
  return driveId;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function ensureFolders(relPath) {
  const id = await resolveDriveId();
  const parts = relPath.split('/').slice(0, -1); // folders only
  for (let i = 0; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    const url = parent ? `/drives/${id}/root:/${encPath(parent)}:/children` : `/drives/${id}/root/children`;
    try {
      await graph(url, { method: 'POST', body: JSON.stringify({ name: parts[i], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) });
    } catch (e) {
      if (e.code !== 'nameAlreadyExists' && e.status !== 409) throw e;
    }
  }
}

async function uploadFile(relPath, bytes) {
  const id = await resolveDriveId();
  const base = `/drives/${id}/root:/${encPath(relPath)}`;
  if (bytes.length <= SIMPLE_UPLOAD_MAX) {
    return graph(`${base}:/content`, { method: 'PUT', body: bytes, contentType: 'application/pdf' });
  }
  const session = await graph(`${base}:/createUploadSession`, {
    method: 'POST',
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  });
  let item = null;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    const r = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` },
      body: bytes.subarray(start, end),
    });
    if (!r.ok) throw new Error(`Upload chunk ${start}-${end - 1} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    item = await r.json().catch(() => null);
  }
  return item;
}

// OneDrive forbids " * : < > ? / \ | and trailing dots/spaces in names.
const safeName = (s) => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'Document';

/**
 * Copy the sealed PDF of a completed envelope to OneDrive/SharePoint.
 * Records archive_url on the envelope and an audit event. Throws on failure.
 */
export async function archiveEnvelope(envelopeId) {
  if (!oneDriveEnabled()) return { skipped: true };
  const env = db.prepare(
    `SELECT e.*, f.name AS folder_name FROM envelopes e LEFT JOIN folders f ON f.id = e.folder_id WHERE e.id = ?`
  ).get(envelopeId);
  if (!env) throw new Error('Envelope not found');
  if (env.status !== 'completed' || !env.final_pdf) throw new Error('Only completed envelopes can be archived');

  const bytes = readDecrypted(env.final_pdf);
  const relPath = `${cfg.folder}/${safeName(env.folder_name || 'Unfiled')}/${safeName(env.title)} [${env.id}] signed.pdf`;

  let item;
  try {
    item = await uploadFile(relPath, bytes);
  } catch (e) {
    if (e.status !== 404 && e.code !== 'itemNotFound') throw e;
    await ensureFolders(relPath); // parent folders did not exist yet
    item = await uploadFile(relPath, bytes);
  }

  const url = item?.webUrl || null;
  db.prepare(`UPDATE envelopes SET archive_url = ?, archived_at = datetime('now') WHERE id = ?`).run(url, envelopeId);
  audit(envelopeId, 'archive.onedrive', 'system', `Copied sealed PDF to ${oneDriveTarget()}: ${relPath}`);
  return { url, path: relPath };
}

/** Fire-and-forget wrapper used right after sealing; never throws. */
export function archiveInBackground(envelopeId) {
  if (!oneDriveEnabled()) return;
  archiveEnvelope(envelopeId).catch((err) => {
    console.error(`[onedrive] archive of ${envelopeId} failed:`, err.message);
    audit(envelopeId, 'archive.failed', 'system', `OneDrive archive failed: ${err.message.slice(0, 220)} — retry from the envelope page`);
  });
}
