import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import crypto from 'crypto';
import fs from 'fs';
import { readDecrypted, decStr } from './crypto.js';

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Stamp all filled fields into the PDF, append a Certificate of Completion,
 * optionally the audit trail, and any signer attachments. Returns PDF bytes.
 *
 * Options:
 *   includeAuditTrail  – full event log (sender copy) vs signers-only (signer copy)
 *   includeAttachments – append uploaded signer documents (Aadhaar/PAN/etc.)
 *
 * Field coordinates are normalized [0,1] with a TOP-LEFT origin (as captured
 * in the browser). pdf-lib uses a bottom-left origin in PDF points.
 */
export async function sealEnvelope({ envelope, signers, fields, events, attachments = [], includeAuditTrail = true, includeAttachments = true }) {
  const srcBytes = readDecrypted(envelope.original_pdf);
  const doc = await PDFDocument.load(srcBytes);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();

  const signerById = Object.fromEntries(signers.map((s) => [s.id, s]));

  for (const f of fields) {
    const page = pages[f.page];
    if (!page) continue;
    const { width: pw, height: ph } = page.getSize();
    const x = f.x * pw;
    const w = f.w * pw;
    const h = f.h * ph;
    const y = ph - f.y * ph - h; // top-left -> bottom-left origin

    if (f.type === 'signature' || f.type === 'initials') {
      const signer = signerById[f.signer_id];
      const dataUrl = decStr(signer?.signature_image);
      if (!dataUrl) continue;
      const base64 = dataUrl.split(',')[1];
      const imgBytes = Buffer.from(base64, 'base64');
      const img = dataUrl.startsWith('data:image/jpeg')
        ? await doc.embedJpg(imgBytes)
        : await doc.embedPng(imgBytes);
      const scale = Math.min(w / img.width, h / img.height);
      const iw = img.width * scale;
      const ih = img.height * scale;
      page.drawImage(img, { x: x + (w - iw) / 2, y: y + (h - ih) / 2, width: iw, height: ih });
      page.drawText(`Signed by ${signer.name} · ${signer.signed_at} UTC`, {
        x, y: Math.max(y - 9, 2), size: 6, font: helv, color: rgb(0.35, 0.35, 0.35),
      });
    } else if (f.type === 'checkbox') {
      if (f.value === 'true') {
        page.drawText('X', { x: x + w * 0.2, y: y + h * 0.15, size: h * 0.8, font: helvBold, color: rgb(0, 0, 0) });
      }
      page.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0, 0, 0), borderWidth: 0.7 });
    } else {
      const text = f.value || '';
      let size = Math.min(h * 0.6, 12);
      while (size > 4 && helv.widthOfTextAtSize(text, size) > w - 4) size -= 0.5;
      page.drawText(text, { x: x + 2, y: y + (h - size) / 2, size, font: helv, color: rgb(0, 0, 0) });
    }
  }

  appendCertificate(doc, { envelope, signers, events, attachments, helv, helvBold, includeAuditTrail });

  if (includeAttachments) {
    await appendAttachments(doc, { attachments, signerById, helv, helvBold });
  }

  const finalBytes = await doc.save();
  return Buffer.from(finalBytes);
}

function appendCertificate(doc, { envelope, signers, events, attachments, helv, helvBold, includeAuditTrail }) {
  const PW = 612, PH = 792;
  let page = doc.addPage([PW, PH]);
  let cursor = PH - 54;

  const attBySigner = {};
  for (const a of attachments) (attBySigner[a.signer_id] ||= []).push(a);

  const newPageIfNeeded = (needed = 14) => {
    if (cursor < 40 + needed) {
      page = doc.addPage([PW, PH]);
      cursor = PH - 54;
    }
  };
  const line = (text, { size = 9, font = helv, color = rgb(0.1, 0.1, 0.1), x = 48 } = {}) => {
    newPageIfNeeded(size + 4);
    page.drawText(text, { x, y: cursor, size, font, color });
    cursor -= size + 5;
  };

  page.drawText('Certificate of Completion', { x: 48, y: cursor, size: 18, font: helvBold, color: rgb(0.1, 0.1, 0.1) });
  cursor -= 30;
  line(`Envelope ID: ${envelope.id}`, { size: 10 });
  line(`Document: ${envelope.title}`, { size: 10 });
  line(`Original document SHA-256: ${envelope.sha256_original}`, { size: 8, color: rgb(0.3, 0.3, 0.3) });
  line(`Status: Completed · ${envelope.completed_at || new Date().toISOString()} UTC`, { size: 10 });
  cursor -= 10;

  line('Signers', { size: 12, font: helvBold });
  for (const s of signers) {
    line(`${s.name} <${s.email}>`, { size: 10, font: helvBold });
    line(`Consent to electronic records: ${s.consent_at || '-'} UTC`, { size: 8, x: 60 });
    line(`Signed: ${s.signed_at || '-'} UTC · IP: ${s.ip || '-'}`, { size: 8, x: 60 });
    line(`Device: ${(s.user_agent || '-').slice(0, 95)}`, { size: 8, x: 60, color: rgb(0.3, 0.3, 0.3) });
    for (const a of (attBySigner[s.id] || [])) {
      line(`Attached: ${a.label} (${a.original_name || 'file'})`, { size: 8, x: 60, color: rgb(0.2, 0.4, 0.2) });
    }
    cursor -= 4;
  }
  cursor -= 8;

  // Audit trail is included only on the sender's copy.
  if (includeAuditTrail) {
    line('Audit trail', { size: 12, font: helvBold });
    for (const e of events) {
      line(`${e.created_at} UTC · ${e.type} · ${e.actor}${e.ip ? ' · ' + e.ip : ''}`, { size: 8, font: helvBold });
      if (e.detail) line(e.detail.slice(0, 110), { size: 8, x: 60, color: rgb(0.3, 0.3, 0.3) });
    }
    cursor -= 10;
  }

  line('This page was generated by SignFlow and is part of the signed document.', { size: 7, color: rgb(0.45, 0.45, 0.45) });
  line('Integrity: verify the document SHA-256 against the value stored in the SignFlow audit log.', { size: 7, color: rgb(0.45, 0.45, 0.45) });
}

// Append each uploaded attachment: images become a captioned page, PDFs have
// their pages copied in with a caption page before them.
async function appendAttachments(doc, { attachments, signerById, helv, helvBold }) {
  const PW = 612, PH = 792;
  for (const a of attachments) {
    if (!a.stored_path || !fs.existsSync(a.stored_path)) continue;
    const signer = signerById[a.signer_id];
    const caption = `Attachment: ${a.label} — ${signer?.name || ''} (${a.original_name || 'file'})`;
    const bytes = readDecrypted(a.stored_path);
    const mime = (a.mime || '').toLowerCase();

    if (mime.includes('pdf')) {
      const cap = doc.addPage([PW, PH]);
      cap.drawText(caption, { x: 48, y: PH - 60, size: 11, font: helvBold, color: rgb(0.1, 0.1, 0.1) });
      try {
        const src = await PDFDocument.load(bytes);
        const copied = await doc.copyPages(src, src.getPageIndices());
        copied.forEach((p) => doc.addPage(p));
      } catch {
        cap.drawText('(Could not embed this PDF attachment; stored separately.)', { x: 48, y: PH - 80, size: 9, font: helv, color: rgb(0.6, 0.2, 0.2) });
      }
    } else if (mime.includes('png') || mime.includes('jpeg') || mime.includes('jpg')) {
      const page = doc.addPage([PW, PH]);
      page.drawText(caption, { x: 48, y: PH - 60, size: 11, font: helvBold, color: rgb(0.1, 0.1, 0.1) });
      try {
        const img = mime.includes('png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const maxW = PW - 96, maxH = PH - 140;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const iw = img.width * scale, ih = img.height * scale;
        page.drawImage(img, { x: (PW - iw) / 2, y: PH - 90 - ih, width: iw, height: ih });
      } catch {
        page.drawText('(Could not embed this image attachment.)', { x: 48, y: PH - 80, size: 9, font: helv, color: rgb(0.6, 0.2, 0.2) });
      }
    } else {
      const page = doc.addPage([PW, PH]);
      page.drawText(caption, { x: 48, y: PH - 60, size: 11, font: helvBold, color: rgb(0.1, 0.1, 0.1) });
      page.drawText('(File type not previewable; stored with the envelope.)', { x: 48, y: PH - 80, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4) });
    }
  }
}
