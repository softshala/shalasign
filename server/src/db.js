// Uses Node's built-in SQLite (node:sqlite) — no native compilation, so the
// app installs with zero build tools on any machine.
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// WHERE YOUR DATA LIVES — this is deliberately OUTSIDE the app folder so that
// replacing/updating the app never touches your accounts, documents or history.
//   1. STORAGE_DIR env var (hosting sets this to a persistent disk), else
//   2. ~/SignFlowData in the user's home folder (survives app updates), else
//   3. the app's own data/ folder (last-resort fallback).
function resolveStorageDir() {
  if (process.env.STORAGE_DIR) return process.env.STORAGE_DIR;
  try {
    const home = path.join(os.homedir(), 'SignFlowData');
    fs.mkdirSync(home, { recursive: true });
    return home;
  } catch {
    return path.join(__dirname, '..', 'data');
  }
}
export const STORAGE_DIR = resolveStorageDir();
fs.mkdirSync(STORAGE_DIR, { recursive: true });
const db = new DatabaseSync(path.join(STORAGE_DIR, 'signflow.db'));
db.exec('PRAGMA journal_mode = WAL');
console.log(`SignFlow data folder: ${STORAGE_DIR}`);

// Run several statements as one all-or-nothing unit (replaces better-sqlite3's
// db.transaction). Usage: tx(() => { ...writes... });
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  folder_id TEXT,
  access_code TEXT,
  title TEXT NOT NULL,
  message TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',        -- draft | sent | completed | voided
  original_pdf TEXT NOT NULL,
  final_pdf TEXT,
  sha256_original TEXT NOT NULL,
  sha256_final TEXT,
  sequential INTEGER NOT NULL DEFAULT 1,       -- 1 = signers sign in order
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS signers (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | signed | declined
  signature_image TEXT,                        -- data URL of drawn/typed signature
  consent_at TEXT,
  signed_at TEXT,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  signer_id TEXT NOT NULL REFERENCES signers(id),
  type TEXT NOT NULL,                          -- signature | initials | date | text | checkbox
  page INTEGER NOT NULL DEFAULT 0,             -- 0-based page index
  x REAL NOT NULL, y REAL NOT NULL,            -- normalized [0,1], top-left origin
  w REAL NOT NULL, h REAL NOT NULL,
  label TEXT DEFAULT '',
  value TEXT                                   -- filled at signing time
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL,
  signer_id TEXT NOT NULL,
  label TEXT NOT NULL,              -- e.g. "Aadhaar card", "PAN card"
  stored_path TEXT,                 -- filled when the signer uploads
  original_name TEXT,
  mime TEXT,
  uploaded_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  detail TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Upgrade older databases that predate newer columns.
try { db.exec(`ALTER TABLE envelopes ADD COLUMN user_id TEXT REFERENCES users(id)`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE envelopes ADD COLUMN signer_pdf TEXT`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE envelopes ADD COLUMN folder_id TEXT`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE envelopes ADD COLUMN access_code TEXT`); } catch { /* exists */ }

export default db;

export function audit(envelopeId, type, actor, detail, ip = '') {
  db.prepare(
    `INSERT INTO audit_events (envelope_id, type, actor, detail, ip) VALUES (?, ?, ?, ?, ?)`
  ).run(envelopeId, type, actor, detail, ip);
}
