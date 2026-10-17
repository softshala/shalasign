# SignFlow — a self-hosted e-signature platform (MVP)

A working clone of the core of Zoho Sign / HelloSign / Odoo Sign: upload a PDF, place
signature fields, send signing links, capture drawn or typed signatures with consent,
and seal the completed document with a stamped signature, a Certificate of Completion
page, and a full audit trail.

## Stack

- **Backend**: Node.js 22.5+ + Express, SQLite (built-in `node:sqlite`, no native build), pdf-lib, multer
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
it serves the built frontend itself at http://localhost:4000.

## Security

- **Encryption at rest** — every stored PDF (originals, sealed copies), every
  signature image, and every uploaded ID document (Aadhaar/PAN) is encrypted on
  disk with AES-256-GCM. A raw copy of the data folder is unreadable without the
  key. The key is either `SIGNFLOW_SECRET` (set this in hosting, so the server's
  disk and backups can't be read even if copied) or an auto-generated
  `secret.key` locally.
- **Passwords** are stored bcrypt-hashed (never in plain text). Login is
  throttled after 5 failures; access-code entry is throttled after 8.
- **Access code** optionally gates each document; share it out-of-band.
- **Web layer** sends security headers, hides server internals, and enforces
  HSTS when running on HTTPS (`COOKIE_SECURE=1`).
- **What this does NOT replace:** on a laptop, turn on full-disk encryption
  (FileVault on Mac, BitLocker on Windows) — that protects everything if the
  device is lost. When hosted, HTTPS (automatic on Render) protects data in
  transit. No system is unbreakable; these layers bring it to standard practice.
- **Key + backups:** locally the `secret.key` lives in the data folder, so the
  backup zip can restore everything. That means: protect your backup zips (they
  contain the key). For the strongest hosted setup, set `SIGNFLOW_SECRET` as a
  secret in the host dashboard, not in any file.

## Your data is permanent (and how to back it up)

All data — accounts, documents, signed PDFs, audit history — is stored in a
folder called **SignFlowData** in your home folder (Mac: `~/SignFlowData`,
Windows: `C:\Users\<you>\SignFlowData`), deliberately **outside** the app
folder. This means you can delete and replace the whole `signflow` app folder
to update the app and your data is never touched. (Hosted deployments use the
`STORAGE_DIR` env var pointing at a persistent disk instead.)

Nothing digital is truly immortal on one machine (a disk can fail), so keep
backups: double-click **backup-mac.command** / **BACKUP-WINDOWS.bat** to save a
dated zip of everything to your Desktop, then copy that zip somewhere safe
(another drive, Google Drive, email). To restore, unzip it back into your home
folder. Once hosted online, the server's persistent disk plus the host's own
backups cover this automatically.

## Bulk send

In the Prepare screen, switch to **Bulk send** to send one document to many
people at once. Place your signature fields once, paste a recipient list
(`Name, email` per line), and each person receives their own private copy and
signing link — signed independently, tracked as separate documents.

## Folders

Group documents into folders (e.g. "Contractual NDA", "Offer Letter"). Create
folders from the dashboard, assign a document to one when sending, and filter
the dashboard by folder.

## Secure authentication

- **Login throttling** — after 5 failed logins for an email, that email is
  locked for 15 minutes to stop password guessing.
- **Signer access code** — optionally set a PIN on an envelope; signers must
  enter it before they can open or sign the document (share it out-of-band,
  e.g. by phone).

## Per-signer required attachments

When preparing an envelope the sender can require documents from any individual
signer (Aadhaar card, PAN card, or a custom label). That signer cannot finish
signing until they upload each required file (PNG/JPG/PDF, ≤10 MB). Uploaded
documents are appended to the sealed PDF — images as captioned pages, PDFs
copied in — and listed under that signer in the certificate.

## Two certificate versions

- **Sender's copy** (download from the envelope page): full Certificate of
  Completion including the complete audit trail, plus attachments.
- **Signers' copy** (emailed to each signer on completion): the same document
  and the signers + their details, but **without** the audit-trail event log.

## Accounts & login

Senders create an account (name + email + password) at `/login` and must be
logged in to upload, send, track, void or download envelopes. Each user sees
only their own envelopes. Passwords are stored bcrypt-hashed; sessions are
30-day httpOnly cookies (set `COOKIE_SECURE=1` in `.env` once the app runs
on https). **Signers never need an account** — their emailed link is their key.

## Sign-in options: Google, Microsoft, emailed code

Besides email + password, senders can sign in three more ways. Each one is
switched on by environment variables and the login page only shows the methods
that are configured. Accounts are matched by email address, so a colleague who
signed up with a password can later use Google or a code with the same email.

| Method | What to configure |
|---|---|
| **Emailed one-time code** | Nothing extra — works as soon as SMTP is set up. 6-digit code, valid 10 minutes, 5 attempts. For local development without SMTP set `OTP_DEV_LOG=1` and codes print in the server console. |
| **Google** | Google Cloud console → *APIs & Services → Credentials → Create credentials → OAuth client ID → Web application*. Authorized redirect URI: `https://YOUR-APP/api/auth/sso/google/callback`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. If the OAuth consent screen is in *Testing* mode, add your users as test users or publish it. |
| **Microsoft** | entra.microsoft.com → *App registrations → New registration*. Platform *Web*, redirect URI `https://YOUR-APP/api/auth/sso/microsoft/callback`. Then *Certificates & secrets → New client secret* and copy its **Value**. Set `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, and `MS_TENANT` (your Directory/tenant ID to allow only your organisation, `organizations` for any work account, or `common` for any Microsoft account). |

`APP_URL` must be the exact public address, because the redirect URIs are built
from it. For a company-internal deployment also set
`SSO_ALLOWED_DOMAINS=softshala.com` so only your own domain can create accounts
through these methods.

Accounts created via Google/Microsoft/code have no password; the password form
tells them so if they try it.

## OneDrive / SharePoint archive

Every completed document can be copied automatically to Microsoft 365, so the
signed PDFs live in a place your team already backs up and searches. The copy is
the **sender's sealed PDF** (stamped signatures + Certificate of Completion +
audit trail).

**Default layout — one archive account, a private folder per sender.** Point
`ONEDRIVE_USER` at a single account (e.g. `shubham@softshala.com`). Each
sender gets a folder named after them, and every file is named by completion
date, time and the signer's name. SignFlow shares each sender's folder with that
sender (read-only, sign-in required) the first time something lands in it, so
the account owner sees everything and each sender sees only their own:

```
SignFlow/
  Shubham Sharma/                  ← shared with shubham@softshala.com only
    2026-10-17_14-32-05_Asha Verma.pdf
    2026-10-18_09-05-41_Rohit Jain.pdf
  Priya Mehta/                     ← shared with priya@softshala.com only
    ...
```

Times are in `ONEDRIVE_TIMEZONE` (default `Asia/Kolkata`). The naming is a
template, `ONEDRIVE_PATH`, defaulting to `{sender_name}/{date}_{time}_{signer}`;
tokens are `{sender_name} {sender_email} {folder} {title} {id} {date} {time}
{signer} {signer_first} {signer_last} {signers}`, slashes create sub-folders and
`.pdf` is appended. For example `{sender_name}/{folder}/{date}_{title}` groups
by SignFlow folder and keeps the document title.

Alternatives: `ONEDRIVE_USER=@sender` archives into each sender's **own**
OneDrive instead (they must be users in your tenant; no sharing needed, flat
layout by default); `ONEDRIVE_SITE=...sharepoint.com/sites/Contracts` uses a
SharePoint library with the same layout and sharing.

The envelope page shows an **Open in OneDrive** link once archived, and a
**Copy to OneDrive** button to retry if an upload failed. The audit trail
records `archive.onedrive`, `archive.shared`, and any `archive.failed` /
`archive.share_failed`. The original data on SignFlow's own disk is unchanged —
OneDrive is an extra copy, not a move.

**Setup (reuses the Microsoft sign-in app registration):**

1. In entra.microsoft.com → *App registrations → SignFlow → API permissions →
   Add a permission → Microsoft Graph → **Application permissions*** add
   `Files.ReadWrite.All` (to archive into a user's OneDrive) **or**
   `Sites.ReadWrite.All` (to archive into a SharePoint site). Click
   **Grant admin consent**.
2. Set the destination env var: `ONEDRIVE_USER=archive@softshala.com` *or*
   `ONEDRIVE_SITE=softshala.sharepoint.com/sites/Contracts`. Optionally
   `ONEDRIVE_FOLDER` (default `SignFlow`). `MS_TENANT`, `MS_CLIENT_ID` and
   `MS_CLIENT_SECRET` must already be set.

Note on scope: these are *application* permissions, which let the server write
to **every** OneDrive (`Files.ReadWrite.All`) or **every** site
(`Sites.ReadWrite.All`) in the tenant, not just the one you point it at. That
is how Microsoft Graph app-only access works. Keep the client secret in Render's
Environment tab only. If your IT policy requires least privilege, use
`Sites.Selected` and grant the app access to one site via PowerShell; the code
needs no change for that.

## How the product works (the "reverse-engineered" model)

Every e-sign platform is built around the same five concepts:

1. **Envelope** — a container for one document + its signers + its fields + its
   lifecycle (`draft → sent → completed`, or `voided`). The original PDF's SHA-256
   is recorded at upload so tampering is detectable.
2. **Fields** — rectangles placed on the document by the sender (signature,
   initials, date, text, checkbox), each assigned to a signer. Stored as
   *normalized* coordinates (0–1, top-left origin) so they are resolution-independent;
   converted to PDF points (bottom-left origin) only at sealing time.
3. **Signing ceremony** — each signer gets a long random **capability token** in
   their URL (this is exactly how HelloSign/Zoho "no-account signing" links work).
   The ceremony enforces: it must be your turn (sequential routing), you must
   tick the **ESIGN/IT-Act consent** checkbox, and you must adopt a signature
   (drawn on canvas or typed and rendered to an image).
4. **Sealing** — when the last signer finishes, the server stamps every field
   into the PDF with pdf-lib, appends a **Certificate of Completion** page
   (signers, consent timestamps, IPs, user agents, full event log), saves the
   final PDF and records its SHA-256.
5. **Audit trail** — an append-only `audit_events` table records every
   created/sent/viewed/consented/signed/completed/sealed/voided event with actor,
   IP and timestamp. This is what gives an e-signature its evidentiary weight.

## API surface

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/auth/providers` | Which sign-in methods are configured |
| GET | `/api/auth/sso/:provider` → `/callback` | Google / Microsoft sign-in (`google`, `microsoft`) |
| POST | `/api/auth/otp/request` / `verify` | Emailed one-time code login |
| POST | `/api/envelopes` | Upload PDF (multipart `pdf`), create draft |
| POST | `/api/envelopes/:id/send` | Attach signers + fields, generate signing links |
| GET | `/api/envelopes` / `/:id` | List / detail incl. signers, fields, audit log |
| GET | `/api/envelopes/:id/pdf` | Original PDF (for the field editor) |
| GET | `/api/envelopes/:id/download` | Final sealed PDF |
| POST | `/api/envelopes/:id/archive` | Copy sealed PDF to OneDrive/SharePoint (retry) |
| POST | `/api/envelopes/:id/void` | Void an in-flight envelope |
| GET | `/api/sign/:token` | Signer's view (fields, turn status; logs "viewed") |
| GET | `/api/sign/:token/pdf` | PDF for the signing ceremony |
| POST | `/api/sign/:token` | Submit consent + signature + field values |

## Project layout

```
server/
  src/index.js   – Express app, all routes, sealing orchestration
  src/db.js      – SQLite schema (users, sessions, login_codes, envelopes, signers, fields, audit_events)
  src/auth.js    – accounts, sessions, password login
  src/sso.js     – Google / Microsoft sign-in (OpenID Connect + PKCE)
  src/otp.js     – emailed one-time code login
  src/onedrive.js – Microsoft Graph upload of sealed PDFs to OneDrive/SharePoint
  src/pdf.js     – pdf-lib stamping + Certificate of Completion + SHA-256
client/
  src/pages/Dashboard.jsx       – envelope list + upload
  src/pages/Prepare.jsx         – drag-and-drop field editor (sender)
  src/pages/SignPage.jsx        – signing ceremony (signer)
  src/pages/EnvelopeDetail.jsx  – tracking + audit trail + download
  src/components/PdfViewer.jsx  – pdfjs page renderer with field overlays
  src/components/SignatureModal.jsx – draw/type signature capture
```

## Email delivery (free)

Email is built in via nodemailer and configured from `server/.env`
(copy `server/.env.example`). Two free options:

- **Gmail SMTP** — free, ~500 emails/day. Enable 2-Step Verification, create an
  App Password at https://myaccount.google.com/apppasswords, put it in `.env`.
- **Brevo** (brevo.com) — free 300 emails/day, works with any sender address
  you verify.

Set `APP_URL` to the public URL of your deployment so emailed links work.
Behavior: on send, the first signer (or all, if parallel) gets a signing-link
email; each next signer is emailed when their turn comes; when everyone has
signed, all signers receive the sealed PDF with its certificate of completion.
Without `.env`, nothing breaks — links are shown in the UI to share manually.

## Free hosting

- **Oracle Cloud "Always Free" VM** — the only genuinely free option with
  persistent disk and no sleeping. Create an Always Free ARM VM (Ubuntu),
  `apt install nodejs npm nginx`, clone the app, `npm run build` in client,
  run the server with pm2, point a free DuckDNS subdomain at it, and add a free
  Let's Encrypt cert (`certbot --nginx`). Set `APP_URL` to that https URL.
- **Render.com free tier** — much easier (connect a GitHub repo and it deploys),
  but the free tier has no persistent disk and sleeps after 15 min idle: your
  SQLite data and uploaded PDFs are wiped on every restart/redeploy. Fine for
  demos, not for real signed documents unless you add a free Postgres
  (Neon/Supabase) and free object storage (Cloudflare R2).

## What this MVP deliberately leaves out (your roadmap)

- **Reminders & expiry** — scheduled re-send emails for unsigned envelopes.
- **Password reset & teams** — "forgot password" emails, org/team workspaces
  where colleagues share visibility of envelopes, roles/permissions.
- **Templates & bulk send** — save field layouts for reuse; CSV bulk send.
- **Cryptographic (PAdES) seals** — currently sealing = flattened stamps + hash +
  audit page (what most Zoho Sign/HelloSign envelopes effectively give you at the
  evidence level). To get Adobe's green "signature valid" checkmark, add a PKCS#7
  digital signature with an org certificate — easiest via pyHanko (Python sidecar)
  or Java iText; Node options exist ("@signpdf/signpdf") but handle fewer edge cases.
  Aadhaar eSign / eIDAS qualified signatures plug in at this same layer.
- **Webhooks & API keys** — so other systems can create envelopes and get
  completion callbacks (this is most of DocuSign's enterprise value).
- **Storage & scale** — swap local disk → S3, SQLite → Postgres; add rate limiting
  and virus scanning on uploads.

## Legal notes (not legal advice)

Electronic signatures of this kind (intent + consent + identity attribution +
tamper-evident record) are broadly valid for ordinary commercial contracts under
India's IT Act 2000, the US ESIGN Act, and eIDAS (SES level). Some documents are
excluded everywhere (wills, certain property/negotiable instruments, etc.), and
regulated use cases may require certificate-based digital signatures (e.g. Aadhaar
eSign / DSC in India). Have a lawyer review before relying on it in production.
