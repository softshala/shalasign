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
db.exec('PRAGMA foreign_keys = OFF'); // we manage integrity in code; keeps migrations simple
console.log(`SignFlow data folder: ${STORAGE_DIR}`);

// Run several statements as one all-or-nothing unit.
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

CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,                     -- sha256(email:code); the code itself is never stored
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email);

-- "Forgot password" links (single use, 1 hour).
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

-- Per-user preferences: branding, defaults, webhook. One row per user.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  company TEXT DEFAULT '',
  brand_color TEXT DEFAULT '',
  logo_data TEXT DEFAULT '',                   -- data URL (PNG/JPG, small)
  email_footer TEXT DEFAULT '',
  default_expiry_days INTEGER DEFAULT 30,
  default_reminder_days INTEGER DEFAULT 3,
  webhook_url TEXT DEFAULT '',
  webhook_secret TEXT DEFAULT '',
  notify_on_view INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- API keys for integrations ("Authorization: Bearer sf_live_...").
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,                        -- first 12 chars, for display
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS onedrive_shares (
  drive_id TEXT NOT NULL,
  path TEXT NOT NULL,
  email TEXT NOT NULL,
  shared_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (drive_id, path, email)
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reusable templates: a PDF + signer roles + field layout.
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  pdf_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  roles_json TEXT NOT NULL DEFAULT '[]',       -- [{name:"Candidate", attachments:[...]}]
  fields_json TEXT NOT NULL DEFAULT '[]',      -- [{type,page,x,y,w,h,label,signerIndex,required}]
  options_json TEXT NOT NULL DEFAULT '{}',     -- {sequential, message, access_code, expiry_days, reminder_days, cc}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  use_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS envelopes (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  folder_id TEXT,
  access_code TEXT,
  title TEXT NOT NULL,
  message TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',        -- draft | sent | completed | voided | declined | expired
  original_pdf TEXT NOT NULL,
  final_pdf TEXT,
  signer_pdf TEXT,
  sha256_original TEXT NOT NULL,
  sha256_final TEXT,
  sequential INTEGER NOT NULL DEFAULT 1,       -- 1 = signers sign in order
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  completed_at TEXT,
  expires_at TEXT,                             -- signing deadline (sent envelopes)
  reminder_days INTEGER DEFAULT 0,             -- 0 = no automatic reminders
  last_reminder_at TEXT,
  cc_json TEXT DEFAULT '[]',                   -- [{name,email}] receive the completed copy
  draft_json TEXT,                             -- autosaved Prepare state (signers/fields/options)
  template_id TEXT,
  seal_error TEXT,                             -- set when sealing failed; cleared on retry
  archive_url TEXT,
  archived_at TEXT,
  page_count INTEGER
);

CREATE TABLE IF NOT EXISTS signers (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | signed | declined
  signature_image TEXT,                        -- data URL of drawn/typed signature (encrypted)
  consent_at TEXT,
  signed_at TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  ip TEXT,
  user_agent TEXT,
  private_message TEXT DEFAULT '',
  viewed_at TEXT,
  notified_at TEXT,
  reminders_sent INTEGER NOT NULL DEFAULT 0
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
  required INTEGER NOT NULL DEFAULT 1,
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
CREATE INDEX IF NOT EXISTS idx_audit_env ON audit_events(envelope_id);
CREATE INDEX IF NOT EXISTS idx_env_user ON envelopes(user_id, status);
CREATE INDEX IF NOT EXISTS idx_signers_env ON signers(envelope_id);

-- Organisations / workspaces. Every user belongs to exactly one org.
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  email_mode TEXT NOT NULL DEFAULT 'individual',      -- individual: each member sends from their own connected inbox (or platform)
                                                      -- shared: everyone sends from one connected inbox chosen by an admin
  shared_mail_connection_id TEXT,
  storage_mode TEXT NOT NULL DEFAULT 'individual',    -- individual | shared
  shared_storage_connection_id TEXT,
  shared_storage_root_id TEXT,
  shared_storage_root_path TEXT,
  visibility TEXT NOT NULL DEFAULT 'own',             -- own: members see their own envelopes; all: everyone sees the org's envelopes
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS org_invites (
  token_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);

-- OAuth connections to the user's own Microsoft 365 / Google account.
-- Tokens are encrypted at rest (crypto.encStr).
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT,
  provider TEXT NOT NULL,                             -- microsoft | google
  account_email TEXT NOT NULL,
  account_name TEXT DEFAULT '',
  external_id TEXT,                                   -- Microsoft oid / Google sub
  tenant_id TEXT,                                     -- Microsoft tenant (tid)
  scopes TEXT NOT NULL DEFAULT '',                    -- space separated, as granted
  refresh_token TEXT,                                 -- encrypted
  access_token TEXT,                                  -- encrypted cache
  access_expires_at TEXT,
  can_mail INTEGER NOT NULL DEFAULT 0,
  can_storage INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, provider)
);

-- OAuth 2.1 server for MCP clients (claude.ai connectors etc.).
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  secret_hash TEXT,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,                        -- JSON array
  logo_uri TEXT DEFAULT '',
  client_uri TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'signflow',
  resource TEXT DEFAULT '',
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'signflow',
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outgoing webhook deliveries (for retries + visibility).
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  envelope_id TEXT,
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  delivered_at TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Upgrade older databases that predate newer columns (ALTER is a no-op if present).
const addColumn = (table, def) => { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`); } catch { /* exists */ } };
for (const def of [
  'user_id TEXT REFERENCES users(id)', 'signer_pdf TEXT', 'folder_id TEXT', 'access_code TEXT',
  'archive_url TEXT', 'archived_at TEXT', 'sent_at TEXT', 'expires_at TEXT', 'reminder_days INTEGER DEFAULT 0',
  'last_reminder_at TEXT', "cc_json TEXT DEFAULT '[]'", 'draft_json TEXT', 'template_id TEXT', 'seal_error TEXT', 'page_count INTEGER',
]) addColumn('envelopes', def);
for (const def of ['declined_at TEXT', 'decline_reason TEXT', "private_message TEXT DEFAULT ''", 'viewed_at TEXT', 'notified_at TEXT', 'reminders_sent INTEGER NOT NULL DEFAULT 0']) addColumn('signers', def);
addColumn('fields', 'required INTEGER NOT NULL DEFAULT 1');
addColumn('fields', 'merge_key TEXT');                    // bound to a data column / typed merge value
addColumn('fields', 'cover INTEGER NOT NULL DEFAULT 0');  // white-out the original {{tag}} text under the field
addColumn('fields', 'meta TEXT');                         // JSON: e.g. signature fit {x,y,w,h} inside the field
addColumn('envelopes', 'merge_json TEXT');                // the merge values used for this envelope (audit/record)
addColumn('users', 'org_id TEXT');
addColumn('users', "role TEXT NOT NULL DEFAULT 'member'");          // owner | admin | member (within the org)
addColumn('envelopes', 'org_id TEXT');
addColumn('templates', 'org_id TEXT');
addColumn('folders', 'org_id TEXT');
for (const def of ['mail_connection_id TEXT', 'archive_connection_id TEXT', 'archive_root_id TEXT', 'archive_root_path TEXT']) addColumn('user_settings', def);
db.exec('CREATE INDEX IF NOT EXISTS idx_env_org ON envelopes(org_id)');

// Every existing user gets a personal workspace once (migration for pre-org databases).
{
  const orphans = db.prepare(`SELECT id, name FROM users WHERE org_id IS NULL`).all();
  const insOrg = db.prepare(`INSERT INTO orgs (id, name, owner_user_id) VALUES (?, ?, ?)`);
  const setUser = db.prepare(`UPDATE users SET org_id = ?, role = 'owner' WHERE id = ?`);
  for (const u of orphans) {
    const orgId = 'org_' + u.id;
    insOrg.run(orgId, `${u.name}'s workspace`, u.id);
    setUser.run(orgId, u.id);
    db.prepare(`UPDATE envelopes SET org_id = ? WHERE user_id = ? AND org_id IS NULL`).run(orgId, u.id);
    db.prepare(`UPDATE templates SET org_id = ? WHERE user_id = ? AND org_id IS NULL`).run(orgId, u.id);
    db.prepare(`UPDATE folders SET org_id = ? WHERE user_id = ? AND org_id IS NULL`).run(orgId, u.id);
  }
}

export default db;

export function audit(envelopeId, type, actor, detail, ip = '') {
  db.prepare(
    `INSERT INTO audit_events (envelope_id, type, actor, detail, ip) VALUES (?, ?, ?, ?, ?)`
  ).run(envelopeId, type, actor, detail ?? '', ip ?? '');
}

/** Settings row for a user, with defaults applied. */
export function getSettings(userId) {
  const row = db.prepare(`SELECT * FROM user_settings WHERE user_id = ?`).get(userId);
  return {
    company: '', brand_color: '', logo_data: '', email_footer: '',
    default_expiry_days: 30, default_reminder_days: 3, webhook_url: '', webhook_secret: '', notify_on_view: 0,
    mail_connection_id: null, archive_connection_id: null, archive_root_id: null, archive_root_path: null,
    ...(row || {}),
  };
}

export const getOrg = (orgId) => (orgId ? db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(orgId) : null);
export const getUser = (userId) => db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
export const isOrgAdmin = (user) => user?.role === 'owner' || user?.role === 'admin';

/** Create a personal workspace for a brand-new user. */
export function createOrgForUser(userId, userName) {
  const orgId = 'org_' + userId;
  db.prepare(`INSERT INTO orgs (id, name, owner_user_id) VALUES (?, ?, ?)`).run(orgId, `${userName}'s workspace`, userId);
  db.prepare(`UPDATE users SET org_id = ?, role = 'owner' WHERE id = ?`).run(orgId, userId);
  return orgId;
}
