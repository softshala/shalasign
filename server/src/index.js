import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STORAGE_DIR } from './db.js';
import { registerAuthRoutes } from './auth.js';
import { registerSsoRoutes } from './sso.js';
import { registerOtpRoutes } from './otp.js';
import { registerSettingsRoutes } from './settings.js';
import { registerTemplateRoutes } from './templates.js';
import { registerEnvelopeRoutes } from './envelopes.js';
import { registerSigningRoutes } from './signing.js';
import { registerConnectionRoutes } from './connections.js';
import { registerOrgRoutes } from './orgs.js';
import { startScheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(STORAGE_DIR, 'uploads'), { recursive: true });

const app = express();
app.disable('x-powered-by');
// Behind Render/any reverse proxy: trust the first hop so req.ip and secure cookies are right.
if (process.env.RENDER || process.env.TRUST_PROXY) app.set('trust proxy', 1);

// Security headers (no dependency needed).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (process.env.COOKIE_SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(cookieParser());
app.use(express.json({ limit: '40mb' })); // signature + up to several 10 MB attachments as base64

// ---------- Health / deployment check (no secrets) ----------
function storageIsMount() {
  try { return fs.statSync(STORAGE_DIR).dev !== fs.statSync(path.dirname(STORAGE_DIR)).dev; } catch { return false; }
}
app.get('/api/health', (_req, res) => {
  const hosted = !!(process.env.RENDER || process.env.STORAGE_DIR);
  const persistent = !hosted || storageIsMount();
  res.json({
    ok: true,
    version: process.env.npm_package_version || '1.0.0',
    uptime_seconds: Math.round(process.uptime()),
    hosted_on_render: !!process.env.RENDER,
    storage_dir_from_env: !!process.env.STORAGE_DIR,
    storage_is_persistent_disk: persistent,
    encryption_key_source: process.env.SIGNFLOW_SECRET ? 'env' : 'file-in-storage-dir',
    email_configured: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    connect_providers: { microsoft: !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET), google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) },
    warnings: [
      ...(!persistent ? ['Storage is NOT a persistent disk: accounts, documents and sessions are erased on every deploy/restart. Attach a disk and set STORAGE_DIR to its mount path.'] : []),
      ...(process.env.RENDER && !process.env.SIGNFLOW_SECRET ? ['SIGNFLOW_SECRET is not set: the encryption key lives on the data disk, so disk backups can be decrypted by whoever holds them.'] : []),
      ...(!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) ? ['Platform email (SMTP_*) is not configured: users must connect their own inbox to send; login codes and password resets are off.'] : []),
    ],
  });
});

// ---------- Routes ----------
registerAuthRoutes(app);
registerSsoRoutes(app);
registerOtpRoutes(app);
registerSettingsRoutes(app);
registerTemplateRoutes(app);
registerEnvelopeRoutes(app);
registerSigningRoutes(app);
registerConnectionRoutes(app);
registerOrgRoutes(app);

// JSON 404 for unknown API routes, and a JSON error handler.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => { // eslint-disable-line no-unused-vars
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large. Attachments must be under 10 MB each.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

// ---------- Static frontend (production build) ----------
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { maxAge: '1h', index: false }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`SignFlow server on http://localhost:${PORT}`);
  if ((process.env.RENDER || process.env.STORAGE_DIR) && !storageIsMount()) {
    console.warn('\n!!! WARNING: STORAGE_DIR is not on a persistent disk. All accounts, documents and sessions');
    console.warn(`!!! will be ERASED on the next deploy or restart. Storage dir: ${STORAGE_DIR}`);
    console.warn('!!! Fix: attach a disk to the service and set STORAGE_DIR to its mount path (see render.yaml).\n');
  }
  if (process.env.RENDER && !process.env.SIGNFLOW_SECRET) console.warn('!!! WARNING: SIGNFLOW_SECRET is not set; the encryption key is stored next to the data.');
  if (!process.env.DISABLE_SCHEDULER) startScheduler();
});
