import nodemailer from 'nodemailer';

/**
 * Email delivery. Configured entirely from environment variables (.env):
 *
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=465
 *   SMTP_USER=you@gmail.com
 *   SMTP_PASS=your-app-password        (Gmail: create an "App password")
 *   FROM_EMAIL="SignFlow <you@gmail.com>"
 *   APP_URL=https://your-app.example.com   (used to build signing links)
 *
 * If SMTP is not configured, the app still works — links are just shown in
 * the UI instead of being emailed, and every "email" is logged to console.
 */

const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const transporter = configured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

export const mailEnabled = () => configured;

export function appUrl() {
  return (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
}

async function send(to, subject, html, attachments) {
  if (!configured) {
    console.log(`[mail disabled] To: ${to} | ${subject}`);
    return { skipped: true };
  }
  try {
    await transporter.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to, subject, html, attachments,
    });
    return { sent: true };
  } catch (err) {
    console.error(`Email to ${to} failed:`, err.message);
    return { error: err.message };
  }
}

const layout = (body) => `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1b2430">
    <div style="padding:18px 0;font-size:20px;font-weight:700;color:#2f6fed">&#9998; SignFlow</div>
    <div style="border:1px solid #e2e6ec;border-radius:10px;padding:26px">${body}</div>
    <p style="color:#9aa2ad;font-size:12px;margin-top:14px">
      This signing link is unique to you — don't forward this email.
    </p>
  </div>`;

export function sendSignRequest({ signer, envelope, senderNote }) {
  const link = `${appUrl()}/sign/${signer.token}`;
  return send(
    signer.email,
    `Signature requested: ${envelope.title}`,
    layout(`
      <p>Hi ${signer.name},</p>
      <p>You've been asked to review and sign <strong>${envelope.title}</strong>.</p>
      ${senderNote ? `<p style="color:#68707c;font-style:italic">"${senderNote}"</p>` : ''}
      <p style="margin:26px 0">
        <a href="${link}" style="background:#2f6fed;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">
          Review &amp; sign document
        </a>
      </p>
      <p style="color:#68707c;font-size:13px">Or paste this link into your browser:<br>${link}</p>
    `)
  );
}

export function sendCompletionEmail({ to, name, envelope, pdfContent }) {
  return send(
    to,
    `Completed: ${envelope.title}`,
    layout(`
      <p>Hi ${name},</p>
      <p><strong>${envelope.title}</strong> has been signed by all parties.
      The final signed document with its certificate of completion is attached.</p>
      <p style="color:#68707c;font-size:13px">Document fingerprint (SHA-256):<br><code>${envelope.sha256_final}</code></p>
    `),
    [{ filename: `${envelope.title.replace(/[^\w. -]/g, '_')}-signed.pdf`, content: pdfContent }]
  );
}
