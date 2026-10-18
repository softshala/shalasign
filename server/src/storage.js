// Archive of sealed PDFs into the user's (or the organisation's) connected
// drive — OneDrive via Microsoft Graph or Google Drive — using the folder they
// picked in Settings. Falls back to the operator-level ONEDRIVE_* app-only
// configuration (onedrive.js) when nothing is connected.
import db, { audit } from './db.js';
import { readDecrypted } from './crypto.js';
import { resolveStorageTarget, apiFetch, accessTokenFor, GRAPH, GOOGLE_API } from './connections.js';
import { archiveEnvelope as legacyArchive, oneDriveEnabled as legacyEnabled, oneDriveTarget as legacyTarget } from './onedrive.js';

import { setting } from './platform.js';
const TZ_FALLBACK = 'Asia/Kolkata';
const SIMPLE_MAX = 4 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;

const safeName = (s) => String(s || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'Document';
function stamp(utcStr) {
  const d = utcStr ? new Date(utcStr.replace(' ', 'T') + 'Z') : new Date();
  const TZ = setting('archive_timezone') || TZ_FALLBACK;
  let fmt; try { fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}-${p.minute}-${p.second}` };
}

/** Human description of where a user's documents will go (for the UI). */
export function storageTargetFor(userId) {
  const t = resolveStorageTarget(userId);
  if (t) return { enabled: true, via: t.conn.provider, account: t.conn.account_email, root: t.rootPath || (t.conn.provider === 'google' ? 'My Drive' : 'OneDrive root'), shared: t.shared };
  if (legacyEnabled()) return { enabled: true, via: 'onedrive-app', account: null, root: legacyTarget(), shared: true };
  return { enabled: false };
}

// ---- Microsoft (delegated) ----
async function msUpload(conn, rootId, relPath, bytes) {
  const enc = relPath.split('/').map(encodeURIComponent).join('/');
  const base = rootId ? `${GRAPH}/me/drive/items/${encodeURIComponent(rootId)}:/${enc}` : `${GRAPH}/me/drive/root:/${enc}`;
  if (bytes.length <= SIMPLE_MAX) return apiFetch(conn, `${base}:/content`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/pdf' } });
  const session = await apiFetch(conn, `${base}:/createUploadSession`, { method: 'POST', body: { item: { '@microsoft.graph.conflictBehavior': 'replace' } } });
  let item = null;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    const r = await fetch(session.uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` }, body: bytes.subarray(start, end) });
    if (!r.ok) throw new Error(`OneDrive upload chunk failed: ${r.status} ${(await r.text()).slice(0, 160)}`);
    item = await r.json().catch(() => null);
  }
  return item;
}

// ---- Google Drive ----
async function gFolderChain(conn, rootId, folders) {
  let parent = rootId || 'root';
  for (const name of folders) {
    const q = `'${parent}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const j = await apiFetch(conn, `${GOOGLE_API}/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
    if (j.files?.length) parent = j.files[0].id;
    else parent = (await apiFetch(conn, `${GOOGLE_API}/drive/v3/files?fields=id`, { method: 'POST', body: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] } })).id;
  }
  return parent;
}
async function gUpload(conn, rootId, relPath, bytes) {
  const parts = relPath.split('/'); const fileName = parts.pop();
  const parent = await gFolderChain(conn, rootId, parts);
  // Resumable upload: metadata first, then the bytes in one PUT.
  const init = await apiFetch(conn, `${GOOGLE_API}/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink`, { method: 'POST', body: { name: fileName, parents: [parent], mimeType: 'application/pdf' }, raw: true });
  if (!init.ok) throw new Error(`Google Drive upload init failed: ${init.status} ${(await init.text()).slice(0, 160)}`);
  const loc = init.headers.get('location');
  const put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', Authorization: `Bearer ${await accessTokenFor(conn)}` }, body: bytes });
  if (!put.ok) throw new Error(`Google Drive upload failed: ${put.status} ${(await put.text()).slice(0, 160)}`);
  return put.json().catch(() => null);
}

/** Copy the sealed PDF of a completed envelope to the resolved drive. Throws on failure. */
export async function archiveEnvelope(envelopeId) {
  const env = db.prepare(`SELECT e.*, f.name AS folder_name, u.name AS owner_name, u.email AS owner_email FROM envelopes e LEFT JOIN folders f ON f.id = e.folder_id LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?`).get(envelopeId);
  if (!env) throw new Error('Envelope not found');
  if (env.status !== 'completed' || !env.final_pdf) throw new Error('Only completed envelopes can be archived');
  const target = resolveStorageTarget(env.user_id);
  if (!target) {
    if (legacyEnabled()) return legacyArchive(envelopeId);
    return { skipped: true };
  }
  const signers = db.prepare(`SELECT name FROM signers WHERE envelope_id = ? ORDER BY order_index`).all(envelopeId).map((r) => r.name);
  const { date, time } = stamp(env.completed_at);
  const segments = [
    ...(target.shared ? [safeName(env.owner_name || env.owner_email)] : []),  // shared org drive: one folder per sender
    safeName(env.folder_name || 'Unfiled'),
    `${date}_${time}_${safeName(signers[0] || env.id)}`,
  ];
  const relPath = segments.join('/') + '.pdf';
  const bytes = readDecrypted(env.final_pdf);
  const item = target.conn.provider === 'microsoft' ? await msUpload(target.conn, target.rootId, relPath, bytes) : await gUpload(target.conn, target.rootId, relPath, bytes);
  const url = item?.webUrl || item?.webViewLink || null;
  const where = `${target.conn.provider === 'microsoft' ? 'OneDrive' : 'Google Drive'} of ${target.conn.account_email}${target.rootPath ? ` / ${target.rootPath}` : ''}`;
  db.prepare(`UPDATE envelopes SET archive_url = ?, archived_at = datetime('now') WHERE id = ?`).run(url, envelopeId);
  audit(envelopeId, 'archive.stored', 'system', `Copied sealed PDF to ${where}: ${relPath}`);
  return { url, path: relPath, where };
}

export function archiveInBackground(envelopeId) {
  archiveEnvelope(envelopeId).catch((err) => {
    console.error(`[archive] ${envelopeId} failed:`, err.message);
    audit(envelopeId, 'archive.failed', 'system', `Archive failed: ${String(err.message).slice(0, 220)} — retry from the envelope page`);
  });
}

export function archiveEnabledFor(userId) {
  return !!resolveStorageTarget(userId) || legacyEnabled();
}
export function archiveTargetLabel(userId) {
  const t = storageTargetFor(userId);
  if (!t.enabled) return null;
  if (t.via === 'onedrive-app') return t.root;
  return `${t.via === 'microsoft' ? 'OneDrive' : 'Google Drive'} (${t.account}) / ${t.root}`;
}
