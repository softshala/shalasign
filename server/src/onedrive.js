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
//   ONEDRIVE_USER=archive@softshala.com                   -> ONE central OneDrive. Each sender gets
//                                                            their own sub-folder, which is shared
//                                                            (read-only) with that sender, so every
//                                                            user sees only their own documents.
//   ONEDRIVE_USER=@sender                                 -> each sender's OWN OneDrive (sender must
//                                                            be a user in your Microsoft 365 tenant)
//   ONEDRIVE_SITE=softshala.sharepoint.com/sites/Contracts -> a SharePoint site library (per-sender
//                                                            sub-folders, shared the same way)
// Optional:
//   ONEDRIVE_FOLDER=SignFlow                              root folder (default "SignFlow")
//   ONEDRIVE_PER_SENDER=0                                 one shared tree instead of per-sender folders
//   ONEDRIVE_SHARE_WITH_SENDER=0                          don't share each sender's folder with them
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
  perSender: process.env.ONEDRIVE_PER_SENDER !== '0',
  shareWithSender: process.env.ONEDRIVE_SHARE_WITH_SENDER !== '0',
};
const SENDER_DRIVE = cfg.user === '@sender'; // archive into each sender's own OneDrive
// Overridable for tests only.
const GRAPH = (process.env.GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
const LOGIN = (process.env.MS_LOGIN_BASE_URL || 'https://login.microsoftonline.com').replace(/\/$/, '');

const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;   // Graph: simple PUT up to 4 MB
const CHUNK = 10 * 1024 * 1024;              // upload-session chunk (multiple of 320 KiB)

export const oneDriveEnabled = () => !!(cfg.tenant && cfg.clientId && cfg.secret && (cfg.user || cfg.site));
export const oneDriveTarget = () => (cfg.site ? `SharePoint ${cfg.site}` : SENDER_DRIVE ? 'your own OneDrive' : `OneDrive of ${cfg.user}`) + ` / ${cfg.folder}`;

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

const driveIds = new Map(); // owner email (or '*' for the central drive) -> drive id
async function resolveDriveId(ownerEmail) {
  const key = SENDER_DRIVE ? ownerEmail : '*';
  if (driveIds.has(key)) return driveIds.get(key);
  let id;
  if (cfg.site) {
    const [host, ...rest] = cfg.site.replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/');
    const site = await graph(`/sites/${host}:/${rest.join('/')}`);
    id = (await graph(`/sites/${site.id}/drive`)).id;
  } else {
    const upn = SENDER_DRIVE ? ownerEmail : cfg.user;
    try {
      id = (await graph(`/users/${encodeURIComponent(upn)}/drive`)).id;
    } catch (e) {
      if (SENDER_DRIVE && (e.status === 404 || e.code === 'Request_ResourceNotFound')) {
        throw new Error(`${upn} is not a Microsoft 365 user in this tenant, so there is no OneDrive to archive into`);
      }
      throw e;
    }
  }
  driveIds.set(key, id);
  return id;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function ensureFolders(id, relPath) {
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

async function uploadFile(id, relPath, bytes) {
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

// Share a sender's folder with them (read-only, org sign-in required) exactly once.
async function shareFolderWithSender(driveId, folderPath, email) {
  const already = db.prepare(`SELECT 1 FROM onedrive_shares WHERE drive_id = ? AND path = ? AND email = ?`).get(driveId, folderPath, email);
  if (already) return false;
  const item = await graph(`/drives/${driveId}/root:/${encPath(folderPath)}`);
  await graph(`/drives/${driveId}/items/${item.id}/invite`, {
    method: 'POST',
    body: JSON.stringify({
      recipients: [{ email }],
      roles: ['read'],
      requireSignIn: true,
      sendInvitation: false,
      message: 'Your signed documents from SignFlow',
    }),
  });
  db.prepare(`INSERT OR IGNORE INTO onedrive_shares (drive_id, path, email) VALUES (?, ?, ?)`).run(driveId, folderPath, email);
  return true;
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
    `SELECT e.*, f.name AS folder_name, u.email AS owner_email, u.name AS owner_name
       FROM envelopes e
       LEFT JOIN folders f ON f.id = e.folder_id
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.id = ?`
  ).get(envelopeId);
  if (!env) throw new Error('Envelope not found');
  if (env.status !== 'completed' || !env.final_pdf) throw new Error('Only completed envelopes can be archived');
  const owner = (env.owner_email || '').toLowerCase();
  if (SENDER_DRIVE && !owner) throw new Error('Envelope has no owner to archive for');

  const bytes = readDecrypted(env.final_pdf);
  // Central drive: SignFlow/<sender email>/<folder>/file  — each sender gets their own tree.
  // Sender's own drive: SignFlow/<folder>/file.
  const senderFolder = cfg.perSender && !SENDER_DRIVE && owner ? `${cfg.folder}/${safeName(owner)}` : null;
  const relPath = `${senderFolder || cfg.folder}/${safeName(env.folder_name || 'Unfiled')}/${safeName(env.title)} [${env.id}] signed.pdf`;

  const driveId = await resolveDriveId(owner);
  let item;
  try {
    item = await uploadFile(driveId, relPath, bytes);
  } catch (e) {
    if (e.status !== 404 && e.code !== 'itemNotFound') throw e;
    await ensureFolders(driveId, relPath); // parent folders did not exist yet
    item = await uploadFile(driveId, relPath, bytes);
  }

  const url = item?.webUrl || null;
  db.prepare(`UPDATE envelopes SET archive_url = ?, archived_at = datetime('now') WHERE id = ?`).run(url, envelopeId);
  audit(envelopeId, 'archive.onedrive', 'system', `Copied sealed PDF to ${oneDriveTarget()}: ${relPath}`);

  // Give the sender read access to their folder in the central drive (once).
  if (senderFolder && cfg.shareWithSender) {
    try {
      if (await shareFolderWithSender(driveId, senderFolder, owner)) {
        audit(envelopeId, 'archive.shared', 'system', `Shared OneDrive folder ${senderFolder} with ${owner} (read-only)`);
      }
    } catch (e) {
      // Not fatal: the file is archived; the sender just can't open the link until an admin shares the folder.
      console.error(`[onedrive] sharing ${senderFolder} with ${owner} failed:`, e.message);
      audit(envelopeId, 'archive.share_failed', 'system', `Could not share ${senderFolder} with ${owner}: ${e.message.slice(0, 180)}`);
    }
  }
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
