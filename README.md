# SignFlow — a self-hosted e-signature platform

Upload a PDF, place signature fields, send signing links, capture drawn, typed
or uploaded signatures with consent, and seal the completed document with
stamped signatures, a Certificate of Completion and a full audit trail. Built
to match the core of Adobe Acrobat Sign and Zoho Sign while keeping every
document on infrastructure you control. See [docs/COMPARISON.md](docs/COMPARISON.md)
for a feature-by-feature comparison and roadmap.

## Features

**Sending** — drag-and-drop field editor (signature, initials, date, text,
checkbox; required/optional, labels, pre-filled values; resize and move),
up to 10 signers with sequential or parallel routing, private message per
signer, CC recipients, required attachments per signer (Aadhaar, PAN, custom),
access codes, folders, **templates**, **bulk send** (up to 500 recipients, CSV
import), **draft autosave**, signing **deadlines** and **automatic reminders**.

**Signing** — no account needed; works on phones (touch drawing, sticky action
bar, "next step" guidance); draw, type or upload a signature and remember it on
the device; decline with a reason; download the signed copy; branded with the
sender's logo and colour.

**Tracking** — dashboard with stats, search, status/folder filters; per-signer
status (notified, opened, signed, declined); remind now, resend link, change a
signer's email, void, retry sealing; audit trail with IP and device.

**Evidence** — stamped PDF + Certificate of Completion, SHA-256 of original and
final, append-only audit log, AES-256 encryption at rest for every PDF,
signature image and uploaded ID. Completed documents cannot be deleted.

**Accounts & workspaces** — email + password, Google and Microsoft sign-in,
emailed one-time code login, password reset, login throttling. Workspaces with
owner/admin/member roles, invitations, shared folders and templates, and an
admin choice between individual and shared sending/storage.

**Connected accounts** — one-click "Connect Microsoft 365 / Google": signing
emails go out from the user's own inbox and completed documents land in the
OneDrive or Google Drive folder they picked. No per-customer server setup.

**Integrations** — REST API with API keys, HMAC-signed webhooks with retries.

## Stack

- **Backend**: Node.js 22.5+ + Express, SQLite (built-in `node:sqlite`, no native build), pdf-lib, multer, nodemailer
- **Frontend**: React 18 + Vite, pdfjs-dist (in-browser PDF rendering), react-router

## Quick start

**Requires Node.js 22.5 or newer** (the database uses Node's built-in SQLite module). Check with `node --version`. Hosting picks this up from `.node-version`.

```bash
# 1. Backend
cd server
npm install
npm start            # → http://localhost:4000

# 2. Frontend (dev mode, separate terminal)
cd client
npm install
npm run dev          # → http://localhost:5173 (proxies /api to :4000)
```

**Production-style run**: `cd client && npm run build`, then just run the server —
it serves the built frontend itself at http://localhost:4000. On Mac/Windows,
double-click `start-mac.command` / `START-WINDOWS.bat`.

Open `/api/health` on any deployment to check that storage is persistent,
email is configured and the encryption key comes from the environment.

## Configuration

Copy `server/.env.example` to `server/.env`. Everything is optional; the login
page and the app only show what is configured.

| Area | Variables |
|---|---|
| Public URL (used in emails and SSO redirects) | `APP_URL` |
| Email (signing links, reminders, completion copies) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL` |
| Storage & encryption | `STORAGE_DIR` (persistent disk), `SIGNFLOW_SECRET` (AES key; otherwise a `secret.key` file is generated) |
| HTTPS deployments | `COOKIE_SECURE=1`; behind a proxy `TRUST_PROXY=1` (automatic on Render) |
| Google sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Microsoft sign-in | `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT` |
| Who may create accounts via SSO / code | `SSO_ALLOWED_DOMAINS=softshala.com` |
| OneDrive / SharePoint archive | `ONEDRIVE_USER` or `ONEDRIVE_SITE`, `ONEDRIVE_FOLDER`, `ONEDRIVE_PATH`, `ONEDRIVE_TIMEZONE`, `ONEDRIVE_SHARE_WITH_SENDER` |
| Local development | `OTP_DEV_LOG=1` prints login codes and reset links to the console instead of emailing; `DISABLE_SCHEDULER=1` turns off background jobs |

Per-user settings (branding, default deadline and reminder cadence, webhook,
API keys, "notify me when viewed") live in **Settings** inside the app.

## Security

- **Encryption at rest** — every stored PDF (originals, sealed copies), every
  signature image and every uploaded ID document is encrypted on disk with
  AES-256-GCM. The key is `SIGNFLOW_SECRET` (recommended when hosted) or an
  auto-generated `secret.key` in the data folder.
- **Passwords** are bcrypt-hashed. Login is throttled per email (5 failures →
  15 min lock) and per IP. Access-code entry is throttled per signing link.
- **Signing links** are 32-character random capability tokens; changing a
  signer's email revokes the old link. **Access codes** optionally gate a
  document; share them out-of-band.
- **Web layer** sets security headers, trusts the proxy only when told to,
  escapes everything placed in emails, validates PDFs at upload (corrupt or
  password-protected files are rejected immediately), and limits signer
  attachments to PDF/PNG/JPG under 10 MB server-side.
- **What this does NOT replace:** on a laptop, turn on full-disk encryption.
  When hosted, HTTPS protects data in transit. Protect your backup zips: locally
  they contain the key.

## Your data is permanent (and how to back it up)

All data — accounts, documents, signed PDFs, audit history — is stored in a
folder called **SignFlowData** in your home folder (Mac: `~/SignFlowData`,
Windows: `C:\Users\<you>\SignFlowData`), deliberately **outside** the app
folder, so you can replace the app folder to update it. Hosted deployments use
the `STORAGE_DIR` env var pointing at a persistent disk; the server prints a
loud warning at startup (and `/api/health` reports it) if that disk is missing,
because without it everything is erased on each deploy.

Double-click **backup-mac.command** / **BACKUP-WINDOWS.bat** to save a dated
zip to your Desktop. With the OneDrive archive configured, every completed
document is also copied into your Microsoft 365 tenant automatically.

## Templates, bulk send, reminders, deadlines

- **Templates** — in Prepare, click *Save as template*. The PDF, signer roles,
  field layout and options are saved; *Templates* → *Use template* creates a
  pre-filled draft.
- **Bulk send** — switch Prepare to *Bulk send*, paste `Name, email` lines or
  import a CSV. Each recipient gets a private copy, tracked separately. Emails
  go out in the background.
- **Deadlines & reminders** — per document or as account defaults (Settings →
  Sending defaults). Reminders go only to the signer whose turn it is, at most
  10 per signer. Expired envelopes are closed and the sender is notified.

## Sign-in options: Google, Microsoft, emailed code

| Method | What to configure |
|---|---|
| **Emailed one-time code** | Nothing extra — works as soon as the platform sender (SMTP) is set up. |
| **Google** | The platform Google OAuth app (see *Operator setup* below). Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. |
| **Microsoft** | The platform Microsoft app (see *Operator setup*). Set `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT`. |

Accounts are matched by email. Set `SSO_ALLOWED_DOMAINS` for a company-only
deployment. Accounts created via SSO/code have no password; *Forgot password*
lets them set one.

## Connected accounts: send from your inbox, save to your drive

Nobody except the operator ever touches a server or an admin portal. Each user
opens **Settings → Connected accounts** and clicks **Connect Microsoft 365** or
**Connect Google**. A normal consent screen asks for permission to send mail as
them and to write files to their drive (`Mail.Send` + `Files.ReadWrite`, or
`gmail.send` + `drive.file`). From then on:

- **Signing requests, reminders and completion copies are sent from the user's
  own mailbox** (they appear in their Sent Items). If nothing is connected, the
  platform sender is used with *Reply-To* set to the user, so replies still
  reach them. If a connected inbox fails, the platform sender is the fallback.
- **Completed documents are saved to the folder they picked** in OneDrive or
  Google Drive (a folder picker lets them browse or create folders). Inside it:
  `<SignFlow folder or Unfiled>/<date>_<time>_<signer>.pdf`.
- Tokens are stored encrypted and refreshed automatically; a broken connection
  shows a *Reconnect* button and the audit trail records what happened.

## Workspaces

Every user gets a personal workspace; admins invite colleagues by email
(**Settings → Workspace**). Admins choose, per workspace:

| Setting | Options |
|---|---|
| **Who sends the emails** | Each member from their own connected inbox (default), or one shared inbox for the whole workspace, e.g. `contracts@company.com`, connected once by any member |
| **Where completed documents are saved** | Each member's own drive and folder, or one shared drive folder (with a sub-folder per sender) |
| **Who sees which documents** | Members see only their own (admins see all), or everyone sees everything |

Roles: owner (one), admin, member. Folders and templates are shared across the
workspace. Members who leave keep their documents in the workspace and get a
fresh personal workspace.

## Operator setup (once, for the whole platform)

This is the only server-side configuration, and it is the operator's, not the
customers'. It is what Zoho and Adobe do behind the scenes.

1. **Microsoft app** — entra.microsoft.com → App registrations → New
   registration. Supported account types: **Accounts in any organizational
   directory and personal Microsoft accounts** (multi-tenant). Redirect URIs
   (Web): `https://YOUR-APP/api/auth/sso/microsoft/callback` and
   `https://YOUR-APP/api/connect/microsoft/callback`. Create a client secret.
   Set `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT=common`. Delegated
   permissions are requested dynamically; no admin consent is needed in tenants
   that allow user consent. Complete Microsoft *publisher verification* to
   remove the "unverified" warning.
2. **Google app** — console.cloud.google.com → OAuth consent screen (External,
   published) → Credentials → OAuth client ID (Web). Redirect URIs:
   `https://YOUR-APP/api/auth/sso/google/callback` and
   `https://YOUR-APP/api/connect/google/callback`. Enable the Gmail API and
   Google Drive API. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
   **Note:** `gmail.send` is a Google *restricted* scope — public release
   requires Google's verification and an annual third-party security
   assessment. `drive.file` only needs brand verification. Until then, Google
   users' email goes through the platform sender.
3. **Platform sender** — any transactional SMTP (Brevo, Postmark, SES, or a
   mailbox): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`.
   Used for login codes, password resets, and as the default/fallback for users
   who have not connected an inbox.
4. **Hosting** — persistent disk + `STORAGE_DIR`, `SIGNFLOW_SECRET`, `APP_URL`,
   `COOKIE_SECURE=1`. Check `/api/health`.

The older app-only `ONEDRIVE_*` variables still work as an operator-level
fallback archive when a user has connected nothing.

## API

Create a key in *Settings → API & webhooks* and send it as
`Authorization: Bearer sf_live_…`. The API is the same one the app uses.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Deployment health (storage, email, key source) |
| POST | `/api/envelopes` | Upload PDF (multipart `pdf`, optional `title`, `message`) → draft |
| GET | `/api/envelopes?q=&status=&folder=&sort=&limit=&offset=` | List with search/filters |
| GET | `/api/envelopes/stats` | Counts, completed last 30 days, avg hours to sign |
| GET / PATCH / DELETE | `/api/envelopes/:id` | Detail incl. signers, fields, events, attachments / rename / delete (not completed) |
| PUT | `/api/envelopes/:id/draft` | Autosave Prepare state |
| POST | `/api/envelopes/:id/send` | `{signers:[{name,email,attachments?,private_message?}], fields:[…], sequential?, folder_id?, access_code?, expiry_days?, reminder_days?, cc?:[{name,email}], title?, message?}` |
| POST | `/api/envelopes/:id/bulk-send` | `{recipients:[{name,email}], fields, attachments?, …}` |
| POST | `/api/envelopes/:id/void` · `/remind` · `/seal` · `/archive` | Lifecycle actions |
| POST / PATCH | `/api/envelopes/:id/signers/:sid/resend` · `/api/envelopes/:id/signers/:sid` | Resend link / change name+email (new link) |
| GET | `/api/envelopes/:id/download[?copy=signer]` · `/original` · `/pdf` · `/attachments/:aid` | Files |
| GET / POST / DELETE | `/api/folders`, `/api/folders/:id` | Folders |
| GET / POST / PATCH / DELETE | `/api/templates`, `/api/templates/:id`, `/api/templates/:id/use` | Templates |
| GET / PUT | `/api/settings` · `/api/settings/password` · `/api/settings/api-keys` · `/api/settings/webhook/test` | Account settings |
| GET | `/api/connections` · `/api/connect/:provider` (→ consent) · `/api/connections/:id/folders` | Connected accounts, folder picker |
| PUT / DELETE | `/api/connections/mail-choice` · `/api/connections/archive-target` · `/api/connections/:id` | Choose inbox / drive folder, disconnect |
| GET / PUT | `/api/org` · `/api/org/invites` · `/api/org/members/:id` · `/api/org/join/:token` · `/api/org/test-email` | Workspace, members, invitations |
| GET | `/api/sign/:token` · `/pdf` · `/download` | Signer's view / PDF / signed copy |
| POST | `/api/sign/:token` · `/decline` | Submit consent + signature + values + attachments / decline |

Fields: `{type: signature|initials|date|text|checkbox, page (0-based), x, y, w, h (normalized 0–1, top-left origin), signerIndex, label?, required?, prefill?}`.

**Webhooks** POST `{event, created_at, data}` with events `envelope.sent`,
`envelope.completed`, `envelope.declined`, `envelope.voided`,
`envelope.expired`; header `X-SignFlow-Signature: sha256=<HMAC of body with your secret>`.
Failed deliveries retry 5 times with back-off.

## Project layout

```
server/src/
  index.js      – Express app, health, static frontend, scheduler start
  auth.js       – accounts, sessions, password login/reset, API-key auth
  sso.js        – Google / Microsoft sign-in (OpenID Connect + PKCE)
  otp.js        – emailed one-time code login
  settings.js   – profile, branding, defaults, webhook, API keys
  connections.js– OAuth "connect your account" (Microsoft/Google), tokens, folder picker
  storage.js    – archive to the user's/workspace's OneDrive or Google Drive
  orgs.js       – workspaces, members, invitations, shared sending/storage
  scope.js      – who may see / edit which envelopes
  envelopes.js  – sender routes: upload, list, send, bulk, lifecycle
  signing.js    – signer routes: view, sign, decline, download
  templates.js  – reusable templates
  fields.js     – field layout validation
  complete.js   – notify signers, seal, completion emails, webhook, archive
  scheduler.js  – reminders, expiry, webhook retries, housekeeping
  webhooks.js   – signed webhook delivery queue
  pdf.js        – pdf-lib stamping (rotation-aware), certificate, validation
  onedrive.js   – Microsoft Graph archive
  mailer.js     – send via the user's Microsoft 365 / Gmail, or the platform sender
  crypto.js     – AES-256-GCM at rest
  db.js         – SQLite schema + migrations
client/src/
  pages/        – Dashboard, Prepare, SignPage, EnvelopeDetail, Templates, Settings, AuthPage
  components/   – PdfViewer (responsive), SignatureModal (draw/type/upload/saved), Layout, Toast
```

## Deployment

See [DEPLOY.md](DEPLOY.md) for the plain-language Render guide. The essentials:
a **persistent disk** mounted where `STORAGE_DIR` points, `SIGNFLOW_SECRET` set
as a secret, `APP_URL` set to the public address, and SMTP variables. Check
`/api/health` after deploying. Oracle Cloud "Always Free" is the no-cost
alternative with a real disk.

## Roadmap

Email OTP for signers · multiple documents per envelope · text-tag field
placement · public web forms · PAdES digital seal / Aadhaar eSign · radio and
dropdown fields · localisation · DOCX/image upload. Details and reasoning in
[docs/COMPARISON.md](docs/COMPARISON.md).

## Legal notes (not legal advice)

Electronic signatures of this kind (intent + consent + identity attribution +
tamper-evident record) are broadly valid for ordinary commercial contracts under
India's IT Act 2000, the US ESIGN Act, and eIDAS (SES level). Some documents are
excluded everywhere (wills, certain property/negotiable instruments, etc.), and
regulated use cases may require certificate-based digital signatures (e.g. Aadhaar
eSign / DSC in India). Have a lawyer review before relying on it in production.
