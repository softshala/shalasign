import nodemailer from 'nodemailer';
import db, { getSettings } from './db.js';
import { esc } from './util.js';

/**
 * Email delivery. Configured entirely from environment variables (.env):
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / FROM_EMAIL / APP_URL
 * If SMTP is not configured the app still works — links are shown in the UI
 * and every "email" is logged to the console.
 *
 * Every template is branded per sender (company name, colour, logo, footer)
 * from user_settings, and every interpolated value is HTML-escaped.
 */

const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const transporter = configured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    })
  : null;

export const mailEnabled = () => configured;

export function appUrl() {
  return (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
}

/** Branding for emails/signing page of a given sender. */
export function brandFor(userId) {
  const s = userId ? getSettings(userId) : {};
  const owner = userId ? db.prepare(`SELECT name, email FROM users WHERE id = ?`).get(userId) : null;
  return {
    company: s.company || '',
    color: /^#[0-9a-f]{6}$/i.test(s.brand_color || '') ? s.brand_color : '#2f6fed',
    logoUrl: s.logo_data ? `${appUrl()}/api/public/logo/${userId}` : '',
    footer: s.email_footer || '',
    senderName: owner?.name || '',
    senderEmail: owner?.email || '',
  };
}

async function send(to, subject, html, attachments) {
  if (!configured) {
    console.log(`[mail disabled] To: ${to} | ${subject}`);
    return { skipped: true };
  }
  try {
    await transporter.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER, to, subject, html, attachments });
    return { sent: true };
  } catch (err) {
    console.error(`Email to ${to} failed:`, err.message);
    return { error: err.message };
  }
}

const layout = (body, brand = {}) => {
  const color = brand.color || '#2f6fed';
  const header = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.company || 'Logo')}" style="max-height:40px;max-width:200px;display:block">`
    : `<span style="font-size:20px;font-weight:700;color:${color}">&#9998; ${esc(brand.company || 'SignFlow')}</span>`;
  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1b2430">
    <div style="padding:18px 0">${header}</div>
    <div style="border:1px solid #e2e6ec;border-radius:10px;padding:26px">${body}</div>
    <p style="color:#9aa2ad;font-size:12px;margin-top:14px;line-height:1.5">
      ${brand.footer ? esc(brand.footer) + '<br>' : ''}
      ${brand.company ? `Sent via SignFlow on behalf of ${esc(brand.company)}.` : 'Sent via SignFlow.'}
    </p>
  </div>`;
};

const button = (href, label, color) =>
  `<p style="margin:26px 0"><a href="${esc(href)}" style="background:${color};color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${esc(label)}</a></p>
   <p style="color:#68707c;font-size:13px">Or paste this link into your browser:<br>${esc(href)}</p>`;

const fmtDate = (sql) => (sql ? String(sql).slice(0, 16) + ' UTC' : '');

// ---------- Signing request / reminder ----------
export function sendSignRequest({ signer, envelope, senderNote, brand = {}, isReminder = false, privateMessage = '' }) {
  const link = `${appUrl()}/sign/${signer.token}`;
  const who = brand.senderName ? `${esc(brand.senderName)}${brand.company ? ` (${esc(brand.company)})` : ''}` : (brand.company ? esc(brand.company) : 'Someone');
  const due = envelope.expires_at ? `<p style="color:#c77700;font-size:13px">Please sign by <strong>${esc(fmtDate(envelope.expires_at))}</strong>.</p>` : '';
  return send(
    signer.email,
    `${isReminder ? 'Reminder: ' : ''}Signature requested: ${envelope.title}`,
    layout(`
      <p>Hi ${esc(signer.name)},</p>
      <p>${isReminder ? 'This is a friendly reminder that ' : ''}${who} has asked you to review and sign <strong>${esc(envelope.title)}</strong>.</p>
      ${senderNote ? `<p style="color:#68707c;font-style:italic">"${esc(senderNote)}"</p>` : ''}
      ${privateMessage ? `<p style="color:#68707c;font-style:italic">Note for you: "${esc(privateMessage)}"</p>` : ''}
      ${due}
      ${button(link, 'Review & sign document', brand.color || '#2f6fed')}
      <p style="color:#9aa2ad;font-size:12px">This signing link is unique to you — please don't forward this email.</p>
    `, brand)
  );
}

// ---------- Completion (signers, CC, sender) ----------
export function sendCompletionEmail({ to, name, envelope, pdfContent, filename, brand = {}, audience = 'signer' }) {
  const intro = audience === 'sender'
    ? `<p><strong>${esc(envelope.title)}</strong> has been signed by all parties. Your copy with the full certificate of completion and audit trail is attached.</p>`
    : audience === 'cc'
      ? `<p>You were copied on <strong>${esc(envelope.title)}</strong>, which has now been signed by all parties. The signed document is attached.</p>`
      : `<p><strong>${esc(envelope.title)}</strong> has been signed by all parties. The final signed document with its certificate of completion is attached.</p>`;
  return send(
    to,
    `Completed: ${envelope.title}`,
    layout(`
      <p>Hi ${esc(name || '')},</p>
      ${intro}
      <p style="color:#68707c;font-size:13px">Document fingerprint (SHA-256):<br><code>${esc(envelope.sha256_final || '')}</code></p>
    `, brand),
    pdfContent ? [{ filename: filename || 'signed.pdf', content: pdfContent }] : undefined
  );
}

export function sendDeclineNotice({ to, envelope, signerName, reason, brand = {} }) {
  return send(
    to,
    `Declined: ${envelope.title}`,
    layout(`
      <p><strong>${esc(signerName)}</strong> declined to sign <strong>${esc(envelope.title)}</strong>.</p>
      ${reason ? `<p style="color:#68707c;font-style:italic">Reason: "${esc(reason)}"</p>` : ''}
      <p>The envelope has been stopped. You can send a corrected document as a new envelope.</p>
      ${button(`${appUrl()}/envelope/${envelope.id}`, 'Open envelope', brand.color || '#2f6fed')}
    `, brand)
  );
}

export function sendExpiredNotice({ to, envelope, brand = {}, pending = [] }) {
  return send(
    to,
    `Expired: ${envelope.title}`,
    layout(`
      <p><strong>${esc(envelope.title)}</strong> reached its signing deadline (${esc(fmtDate(envelope.expires_at))}) without all signatures.</p>
      ${pending.length ? `<p style="color:#68707c">Still pending: ${pending.map(esc).join(', ')}</p>` : ''}
      <p>Signing links no longer work. You can send the document again as a new envelope.</p>
      ${button(`${appUrl()}/envelope/${envelope.id}`, 'Open envelope', brand.color || '#2f6fed')}
    `, brand)
  );
}

export function sendViewedNotice({ to, envelope, signerName, brand = {} }) {
  return send(
    to,
    `Viewed: ${envelope.title}`,
    layout(`
      <p><strong>${esc(signerName)}</strong> opened <strong>${esc(envelope.title)}</strong> for the first time.</p>
      ${button(`${appUrl()}/envelope/${envelope.id}`, 'Track envelope', brand.color || '#2f6fed')}
    `, brand)
  );
}

// ---------- Account emails ----------
export function sendLoginCode({ to, code, minutes }) {
  return send(
    to,
    `${code} is your SignFlow sign-in code`,
    layout(`
      <p>Use this code to sign in to SignFlow:</p>
      <p style="font-size:34px;letter-spacing:10px;font-weight:700;font-family:Menlo,Consolas,monospace;margin:18px 0">${esc(code)}</p>
      <p style="color:#68707c;font-size:13px">It expires in ${minutes} minutes. If you didn't request it, you can ignore this email — nobody can sign in without the code.</p>
    `)
  );
}

export function sendPasswordReset({ to, name, link }) {
  return send(
    to,
    'Reset your SignFlow password',
    layout(`
      <p>Hi ${esc(name)},</p>
      <p>Click below to choose a new password. The link works once and expires in 1 hour.</p>
      ${button(link, 'Reset password', '#2f6fed')}
      <p style="color:#68707c;font-size:13px">If you didn't ask for this, ignore this email — your password stays the same.</p>
    `)
  );
}
