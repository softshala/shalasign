import nodemailer from 'nodemailer';
import db, { getSettings } from './db.js';
import { esc } from './util.js';
import { smtpConfig, publicUrl, setting } from './platform.js';

/**
 * Email delivery with three transports, chosen per sender:
 *   1. the sender's own connected Microsoft 365 inbox (Graph sendMail)
 *   2. the sender's own connected Gmail (Gmail API)
 *   3. the platform SMTP sender (SMTP_* env) — zero-setup default; Reply-To is the sender
 * Account emails (login codes, password reset) always use the platform sender.
 * Every template is branded per sender and every interpolated value is escaped.
 */

// Transporter is rebuilt whenever the operator changes the SMTP settings.
let transporter = null, transporterKey = '';
function getTransporter() {
  const c = smtpConfig();
  if (!c) { transporter = null; transporterKey = ''; return null; }
  const key = JSON.stringify(c);
  if (transporter && transporterKey === key) return transporter;
  transporter = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.port === 465, auth: { user: c.user, pass: c.pass }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });
  transporterKey = key;
  return transporter;
}
const fromAddress = () => smtpConfig()?.from || '';

/** Platform SMTP configured? (used for account emails + fallback) */
export const mailEnabled = () => !!smtpConfig();

export function appUrl() {
  return publicUrl();
}

// Lazy import to avoid a circular dependency (connections.js imports appUrl from here).
let _conn = null;
async function connections() { if (!_conn) _conn = await import('./connections.js'); return _conn; }

/** Can this user send email at all (own inbox or platform)? Returns { via, account } or null. */
export async function mailRouteFor(userId) {
  if (userId) {
    const c = await connections();
    const r = c.resolveMailConnection(userId);
    if (r) return { via: r.conn.provider, account: r.conn.account_email, conn: r.conn };
  }
  if (smtpConfig()) return { via: 'platform', account: fromAddress() };
  return null;
}

/** Branding for emails/signing page of a given sender. */
export function brandFor(userId) {
  const s = userId ? getSettings(userId) : {};
  const owner = userId ? db.prepare(`SELECT name, email FROM users WHERE id = ?`).get(userId) : null;
  return {
    userId: userId || null,
    company: s.company || '',
    color: /^#[0-9a-f]{6}$/i.test(s.brand_color || '') ? s.brand_color : '#2f6fed',
    logoUrl: s.logo_data ? `${appUrl()}/api/public/logo/${userId}` : '',
    footer: s.email_footer || '',
    senderName: owner?.name || '',
    senderEmail: owner?.email || '',
  };
}

const GRAPH_ATTACH_MAX = 3 * 1024 * 1024; // Graph simple attachments ≈3 MB total

/**
 * Send one email. ctx: { userId (whose transport/branding), replyTo, fallbackHtml (used
 * when attachments are too large for the transport) }.
 */
async function send(to, subject, html, attachments, ctx = {}) {
  const route = await mailRouteFor(ctx.userId);
  if (!route) { console.log(`[mail disabled] To: ${to} | ${subject}`); return { skipped: true }; }
  const atts = (attachments || []).map((a) => ({ filename: a.filename, content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content), contentType: a.contentType || 'application/pdf' }));
  const totalBytes = atts.reduce((n, a) => n + a.content.length, 0);
  const plainHtml = html.replace('<!--ATTACHMENT_FALLBACK-->', '');
  try {
    if (route.via === 'microsoft') {
      const c = await connections();
      const tooBig = totalBytes > GRAPH_ATTACH_MAX;
      const body = tooBig && ctx.fallbackHtml ? html.replace('<!--ATTACHMENT_FALLBACK-->', ctx.fallbackHtml) : plainHtml;
      await c.apiFetch(route.conn, `${c.GRAPH}/me/sendMail`, { method: 'POST', body: {
        message: {
          subject, body: { contentType: 'HTML', content: body },
          toRecipients: [{ emailAddress: { address: to } }],
          ...(ctx.replyTo && ctx.replyTo !== route.account ? { replyTo: [{ emailAddress: { address: ctx.replyTo } }] } : {}),
          attachments: tooBig ? [] : atts.map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.contentType, contentBytes: a.content.toString('base64') })),
        },
        saveToSentItems: true,
      } });
      return { sent: true, via: 'microsoft', account: route.account };
    }
    if (route.via === 'google') {
      const c = await connections();
      const raw = buildMime({ from: route.account, to, subject, html: plainHtml, attachments: atts, replyTo: ctx.replyTo });
      await c.apiFetch(route.conn, `${c.GOOGLE_API}/gmail/v1/users/me/messages/send`, { method: 'POST', body: { raw: raw.toString('base64url') } });
      return { sent: true, via: 'google', account: route.account };
    }
    await getTransporter().sendMail({ from: fromAddress(), to, subject, html: plainHtml, attachments: atts, ...(ctx.replyTo ? { replyTo: ctx.replyTo } : {}) });
    return { sent: true, via: 'platform', account: route.account };
  } catch (err) {
    console.error(`Email to ${to} via ${route.via} failed:`, err.message);
    // Own-inbox failure → try the platform sender so the document still goes out.
    if (route.via !== 'platform' && smtpConfig()) {
      try {
        await getTransporter().sendMail({ from: fromAddress(), to, subject, html: plainHtml, attachments: atts, ...(ctx.replyTo ? { replyTo: ctx.replyTo } : {}) });
        return { sent: true, via: 'platform', account: fromAddress(), fallback_from: route.via, error: err.message };
      } catch (e2) { return { error: `${err.message}; platform fallback: ${e2.message}` }; }
    }
    return { error: err.message };
  }
}

function buildMime({ from, to, subject, html, attachments, replyTo }) {
  const boundary = 'sf_' + Math.random().toString(36).slice(2);
  const enc = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
  const lines = [
    `From: ${from}`, `To: ${to}`, ...(replyTo ? [`Reply-To: ${replyTo}`] : []), `Subject: ${enc(subject)}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(html, 'utf8').toString('base64'),
  ];
  for (const a of attachments) {
    lines.push(`--${boundary}`, `Content-Type: ${a.contentType}; name="${a.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${a.filename}"`, '', a.content.toString('base64'));
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

const layout = (body, brand = {}) => {
  const color = brand.color || '#2f6fed';
  const header = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.company || 'Logo')}" style="max-height:40px;max-width:200px;display:block">`
    : `<span style="font-size:20px;font-weight:700;color:${color}">&#9998; ${esc(brand.company || setting('platform_name') || 'ShalaSign')}</span>`;
  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1b2430">
    <div style="padding:18px 0">${header}</div>
    <div style="border:1px solid #e2e6ec;border-radius:10px;padding:26px">${body}</div>
    <p style="color:#9aa2ad;font-size:12px;margin-top:14px;line-height:1.5">
      ${brand.footer ? esc(brand.footer) + '<br>' : ''}
      ${brand.company ? `Sent via ${esc(setting('platform_name') || 'ShalaSign')} on behalf of ${esc(brand.company)}.` : `Sent via ${esc(setting('platform_name') || 'ShalaSign')}.`}
    </p>
  </div>`;
};
const button = (href, label, color) =>
  `<p style="margin:26px 0"><a href="${esc(href)}" style="background:${color};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${esc(label)}</a></p>
   <p style="color:#68707c;font-size:13px">Or paste this link into your browser:<br>${esc(href)}</p>`;
const fmtDate = (sql) => (sql ? String(sql).slice(0, 16) + ' UTC' : '');
const ctxFor = (brand) => ({ userId: brand.userId, replyTo: brand.senderEmail || undefined });

// ---------- Signing request / reminder ----------
export function sendSignRequest({ signer, envelope, senderNote, brand = {}, isReminder = false, privateMessage = '' }) {
  const link = `${appUrl()}/sign/${signer.token}`;
  const who = brand.senderName ? `${esc(brand.senderName)}${brand.company ? ` (${esc(brand.company)})` : ''}` : (brand.company ? esc(brand.company) : 'Someone');
  const due = envelope.expires_at ? `<p style="color:#c77700;font-size:13px">Please sign by <strong>${esc(fmtDate(envelope.expires_at))}</strong>.</p>` : '';
  return send(signer.email, `${isReminder ? 'Reminder: ' : ''}Signature requested: ${envelope.title}`, layout(`
      <p>Hi ${esc(signer.name)},</p>
      <p>${isReminder ? 'This is a friendly reminder that ' : ''}${who} has asked you to review and sign <strong>${esc(envelope.title)}</strong>.</p>
      ${senderNote ? `<p style="color:#68707c;font-style:italic">"${esc(senderNote)}"</p>` : ''}
      ${privateMessage ? `<p style="color:#68707c;font-style:italic">Note for you: "${esc(privateMessage)}"</p>` : ''}
      ${due}
      ${button(link, 'Review & sign document', brand.color || '#2f6fed')}
      <p style="color:#9aa2ad;font-size:12px">This signing link is unique to you — please don't forward this email.</p>
    `, brand), undefined, ctxFor(brand));
}

// ---------- Completion (signers, CC, sender) ----------
export function sendCompletionEmail({ to, name, envelope, pdfContent, filename, brand = {}, audience = 'signer', downloadUrl }) {
  const intro = audience === 'sender'
    ? `<p><strong>${esc(envelope.title)}</strong> has been signed by all parties. Your copy with the full certificate of completion and audit trail is attached.</p>`
    : audience === 'cc'
      ? `<p>You were copied on <strong>${esc(envelope.title)}</strong>, which has now been signed by all parties. The signed document is attached.</p>`
      : `<p><strong>${esc(envelope.title)}</strong> has been signed by all parties. The final signed document with its certificate of completion is attached.</p>`;
  const fallbackHtml = downloadUrl ? `<p style="color:#c77700">The signed document is too large to attach, so download it here:</p>${button(downloadUrl, 'Download signed document', brand.color || '#2f6fed')}` : '';
  return send(to, `Completed: ${envelope.title}`, layout(`
      <p>Hi ${esc(name || '')},</p>
      ${intro}
      <!--ATTACHMENT_FALLBACK-->
      <p style="color:#68707c;font-size:13px">Document fingerprint (SHA-256):<br><code>${esc(envelope.sha256_final || '')}</code></p>
    `, brand), pdfContent ? [{ filename: filename || 'signed.pdf', content: pdfContent }] : undefined, { ...ctxFor(brand), fallbackHtml });
}

export function sendDeclineNotice({ to, envelope, signerName, reason, brand = {} }) {
  return send(to, `Declined: ${envelope.title}`, layout(`
      <p><strong>${esc(signerName)}</strong> declined to sign <strong>${esc(envelope.title)}</strong>.</p>
      ${reason ? `<p style="color:#68707c;font-style:italic">Reason: "${esc(reason)}"</p>` : ''}
      <p>The envelope has been stopped. You can send a corrected document as a new envelope.</p>
      ${button(`${appUrl()}/envelope/${envelope.id}`, 'Open envelope', brand.color || '#2f6fed')}
    `, brand), undefined, ctxFor(brand));
}

export function sendExpiredNotice({ to, envelope, brand = {}, pending = [] }) {
  return send(to, `Expired: ${envelope.title}`, layout(`
      <p><strong>${esc(envelope.title)}</strong> reached its signing deadline (${esc(fmtDate(envelope.expires_at))}) without all signatures.</p>
      ${pending.length ? `<p style="color:#68707c">Still pending: ${pending.map(esc).join(', ')}</p>` : ''}
      <p>Signing links no longer work. You can send the document again as a new envelope.</p>
      ${button(`${appUrl()}/envelope/${envelope.id}`, 'Open envelope', brand.color || '#2f6fed')}
    `, brand), undefined, ctxFor(brand));
}

export function sendViewedNotice({ to, envelope, signerName, brand = {} }) {
  return send(to, `Viewed: ${envelope.title}`, layout(`
      <p><strong>${esc(signerName)}</strong> opened <strong>${esc(envelope.title)}</strong> for the first time.</p>
      ${button(`${appUrl()}/envelope/${envelope.id}`, 'Track envelope', brand.color || '#2f6fed')}
    `, brand), undefined, ctxFor(brand));
}

export function sendOrgInvite({ to, orgName, inviterName, link, brand = {} }) {
  return send(to, `${inviterName} invited you to ${orgName} on ShalaSign`, layout(`
      <p><strong>${esc(inviterName)}</strong> has invited you to join the <strong>${esc(orgName)}</strong> workspace on ShalaSign, so you can send and track documents for signature together.</p>
      ${button(link, 'Accept invitation', brand.color || '#2f6fed')}
      <p style="color:#68707c;font-size:13px">The invitation expires in 7 days.</p>
    `, brand), undefined, ctxFor(brand));
}

// ---------- Account emails (platform sender only) ----------
export function sendLoginCode({ to, code, minutes }) {
  return send(to, `${code} is your ShalaSign sign-in code`, layout(`
      <p>Use this code to sign in to ShalaSign:</p>
      <p style="font-size:34px;letter-spacing:10px;font-weight:700;font-family:Menlo,Consolas,monospace;margin:18px 0">${esc(code)}</p>
      <p style="color:#68707c;font-size:13px">It expires in ${minutes} minutes. If you didn't request it, you can ignore this email — nobody can sign in without the code.</p>
    `));
}

export function sendPasswordReset({ to, name, link }) {
  return send(to, 'Reset your ShalaSign password', layout(`
      <p>Hi ${esc(name)},</p>
      <p>Click below to choose a new password. The link works once and expires in 1 hour.</p>
      ${button(link, 'Reset password', '#2f6fed')}
      <p style="color:#68707c;font-size:13px">If you didn't ask for this, ignore this email — your password stays the same.</p>
    `));
}

/** Operator: test the platform sender itself (ignores the user's connected inbox). */
export async function sendPlatformTest({ to, name }) {
  const t = getTransporter();
  if (!t) return { error: 'Platform sender is not configured' };
  try { await t.sendMail({ from: fromAddress(), to, subject: `${setting('platform_name') || 'ShalaSign'} platform email test`, html: layout(`<p>Hi ${esc(name)},</p><p>The platform sender works. Login codes, password resets and documents from users without their own inbox will be sent like this.</p>`) }); return { sent: true }; }
  catch (e) { return { error: e.message }; }
}

/** Send a test email from whatever route the user currently has. */
export function sendTestEmail({ to, brand }) {
  return send(to, 'ShalaSign test email', layout(`<p>Hi ${esc(brand.senderName || '')},</p><p>This is a test email from ShalaSign. If you are reading it, your email connection works and signers will receive their documents like this.</p>`, brand), undefined, ctxFor(brand));
}
