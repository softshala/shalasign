// Encryption at rest for sensitive data (PDFs, signatures, ID attachments).
//
// Uses AES-256-GCM. The key comes from, in order:
//   1. SHALASIGN_SECRET env var (SIGNFLOW_SECRET still accepted; recommended for hosting — a secret NOT stored
//      next to the data, so someone who dumps the disk still can't decrypt).
//   2. A generated key file secret.key inside STORAGE_DIR (local default — zero
//      config; travels with your backup so restores work).
//
// Encrypted blobs begin with the magic bytes "SFENC1" so we can tell encrypted
// from plaintext and stay backward compatible with any unencrypted file.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { STORAGE_DIR } from './db.js';

/** Host-provided encryption secret. SHALASIGN_SECRET is the new name; SIGNFLOW_SECRET keeps working for existing deployments. */
export const ENV_SECRET = process.env.SHALASIGN_SECRET || process.env.SIGNFLOW_SECRET || '';

const MAGIC = Buffer.from('SFENC1');
const STR_PREFIX = 'enc1:';

function loadKey() {
  if (ENV_SECRET) {
    // Derive a 32-byte key from the provided secret.
    return crypto.scryptSync(ENV_SECRET, 'signflow-at-rest-v1', 32);
  }
  const keyPath = path.join(STORAGE_DIR, 'secret.key');
  try {
    if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath);
  } catch { /* fall through to generate */ }
  const key = crypto.randomBytes(32);
  try { fs.writeFileSync(keyPath, key, { mode: 0o600 }); } catch { /* read-only fs: key held in memory for this run */ }
  return key;
}

const KEY = loadKey();

export function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ct]); // 6 + 12 + 16 + n
}

export function decryptBuffer(buf) {
  if (buf.length < 34 || !buf.subarray(0, 6).equals(MAGIC)) return buf; // plaintext (back-compat)
  const iv = buf.subarray(6, 18);
  const tag = buf.subarray(18, 34);
  const ct = buf.subarray(34);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// File helpers: store ciphertext on disk, read back plaintext.
export function writeEncrypted(filePath, buf) {
  fs.writeFileSync(filePath, encryptBuffer(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)));
}
export function readDecrypted(filePath) {
  return decryptBuffer(fs.readFileSync(filePath));
}

// String helpers (for the signature image data-URL stored in the DB).
export function encStr(s) {
  if (s == null) return s;
  return STR_PREFIX + encryptBuffer(Buffer.from(String(s), 'utf8')).toString('base64');
}
export function decStr(s) {
  if (s == null) return s;
  if (typeof s !== 'string' || !s.startsWith(STR_PREFIX)) return s; // plaintext (back-compat)
  return decryptBuffer(Buffer.from(s.slice(STR_PREFIX.length), 'base64')).toString('utf8');
}

export const encryptionActive = !!ENV_SECRET;
