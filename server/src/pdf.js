import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import crypto from 'crypto';
import fs from 'fs';
import { readDecrypted, decStr } from './crypto.js';

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Parse an uploaded PDF so corrupt / password-protected files are rejected at
 * upload time instead of weeks later when the last signer finishes.
 * Returns { pages }.
 */
export async function validatePdf(bytes) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    throw new Error('This file is not a readable PDF. Re-export it (e.g. "Print to PDF") and try again.');
  }
  if (doc.isEncrypted) {
    // pdf-lib can load but not modify encrypted PDFs; sealing would fail.
    throw new Error('This PDF is password-protected or has editing restrictions. Remove the protection (print it to a new PDF) and upload again.');
  }
  const pages = doc.getPageCount();
  if (!pages) throw new Error('This PDF has no pages.');
  return { pages };
}

/**
 * Only characters the standard (WinAnsi) fonts can draw. Anything else (Indic
 * scripts, emoji, CJK) is dropped so sealing never crashes on a name. If a
 * string becomes empty, the caller's fallback is used.
 */
function makeSafe(font) {
  const cache = new Map();
  const ok = (ch) => {
    if (cache.has(ch)) return cache.get(ch);
    let good = true;
    try { font.encodeText(ch); } catch { good = false; }
    cache.set(ch, good);
    return good;
  };
  return (text, fallback = '') => {
    const out = Array.from(String(text ?? '')).filter((ch) => ch === ' ' || ok(ch)).join('').replace(/\s+/g, ' ').trim();
    return out || fallback;
  };
}

/**
 * Convert a normalized field rect (top-left origin, in the *displayed* page,
 * which honours /Rotate and the CropBox like pdf.js does) into pdf-lib drawing
 * parameters in unrotated user space. Returns { x, y, w, h, rotate, ax, ay }
 * where (ax, ay) is the anchor to pass to drawImage/drawText with `rotate`.
 */
export function placeRect(page, f) {
  const cb = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const viewW = rot === 90 || rot === 270 ? cb.height : cb.width;
  const viewH = rot === 90 || rot === 270 ? cb.width : cb.height;
  const dx = f.x * viewW, dy = f.y * viewH, dw = f.w * viewW, dh = f.h * viewH;

  let x, y, w, h, ax, ay;
  if (rot === 90) {
    x = cb.x + dy; y = cb.y + dx; w = dh; h = dw; ax = x + w; ay = y;
  } else if (rot === 180) {
    x = cb.x + cb.width - dx - dw; y = cb.y + dy; w = dw; h = dh; ax = x + w; ay = y + h;
  } else if (rot === 270) {
    x = cb.x + cb.width - dy - dh; y = cb.y + cb.height - dx - dw; w = dh; h = dw; ax = x; ay = y + h;
  } else {
    x = cb.x + dx; y = cb.y + cb.height - dy - dh; w = dw; h = dh; ax = x; ay = y;
  }
  // Size of the drawn item in its own (unrotated) frame = displayed size.
  return { x, y, w, h, rotate: rot, ax, ay, dw, dh };
}

/**
 * Stamp all filled fields into the PDF, append a Certificate of Completion,
 * optionally the audit trail, and any signer attachments. Returns PDF bytes.
 */
export async function sealEnvelope({ envelope, signers, fields, events, attachments = [], includeAuditTrail = true, includeAttachments = true, brand = {} }) {
  const srcBytes = readDecrypted(envelope.original_pdf);
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = makeSafe(helv);
  const pages = doc.getPages();
  const signerById = Object.fromEntries(signers.map((s) => [s.id, s]));

  for (const f of fields) {
    const page = pages[f.page];
    if (!page) continue;
    const r = placeRect(page, f);
    const rotate = degrees(r.rotate);

    // Merge fields placed over a {{tag}}: paint the tag area white first.
    if (f.cover) page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(1, 1, 1), borderWidth: 0 });

    if (f.type === 'signature' || f.type === 'initials') {
      const signer = signerById[f.signer_id];
      const dataUrl = decStr(signer?.signature_image);
      if (!dataUrl) continue;
      // Signer-chosen placement inside the field (fractions of the field rect).
      let fit = null;
      try { fit = JSON.parse(f.meta || 'null')?.fit || null; } catch { /* ignore */ }
      const sub = fit ? placeRect(page, { x: f.x + fit.x * f.w, y: f.y + fit.y * f.h, w: fit.w * f.w, h: fit.h * f.h }) : r;
      const base64 = dataUrl.split(',')[1];
      const imgBytes = Buffer.from(base64, 'base64');
      let img;
      try { img = dataUrl.startsWith('data:image/jpeg') ? await doc.embedJpg(imgBytes) : await doc.embedPng(imgBytes); }
      catch { continue; }
      const scale = Math.min(sub.dw / img.width, sub.dh / img.height);
      const iw = img.width * scale, ih = img.height * scale;
      // centre the image inside the (sub-)field in the displayed frame, then rotate with the page
      const offX = (sub.dw - iw) / 2, offY = (sub.dh - ih) / 2;
      const [ax, ay] = anchorWithOffset(sub, offX, offY);
      page.drawImage(img, { x: ax, y: ay, width: iw, height: ih, rotate });
      const caption = safe(`Signed by ${signer.name} · ${signer.signed_at} UTC`, `Signed ${signer.signed_at} UTC`);
      const [cx, cy] = anchorWithOffset(r, 0, -8);
      page.drawText(caption, { x: cx, y: cy, size: 6, font: helv, color: rgb(0.35, 0.35, 0.35), rotate });
    } else if (f.type === 'checkbox') {
      if (f.value === 'true') {
        const [ax, ay] = anchorWithOffset(r, r.dw * 0.18, r.dh * 0.12);
        page.drawText('X', { x: ax, y: ay, size: r.dh * 0.8, font: helvBold, color: rgb(0, 0, 0), rotate });
      }
      page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, borderColor: rgb(0, 0, 0), borderWidth: 0.7 });
    } else {
      const text = safe(f.value || '', '');
      if (!text) continue;
      let size = Math.min(r.dh * 0.6, 12);
      while (size > 4 && helv.widthOfTextAtSize(text, size) > r.dw - 4) size -= 0.5;
      const [ax, ay] = anchorWithOffset(r, 2, (r.dh - size) / 2);
      page.drawText(text, { x: ax, y: ay, size, font: helv, color: rgb(0, 0, 0), rotate });
    }
  }

  appendCertificate(doc, { envelope, signers, events, attachments, helv, helvBold, safe, includeAuditTrail, brand });

  if (includeAttachments) {
    await appendAttachments(doc, { attachments, signerById, helv, helvBold, safe });
  }

  const finalBytes = await doc.save();
  return Buffer.from(finalBytes);
}

// Offset (ox, oy) is expressed in the displayed frame (x right, y up from the
// field's bottom-left). Map it onto the page's rotation.
function anchorWithOffset(r, ox, oy) {
  switch (r.rotate) {
    case 90: return [r.ax - oy, r.ay + ox];
    case 180: return [r.ax - ox, r.ay - oy];
    case 270: return [r.ax + oy, r.ay - ox];
    default: return [r.ax + ox, r.ay + oy];
  }
}

function appendCertificate(doc, { envelope, signers, events, attachments, helv, helvBold, safe, includeAuditTrail, brand }) {
  const PW = 612, PH = 792;
  let page = doc.addPage([PW, PH]);
  let cursor = PH - 54;

  const attBySigner = {};
  for (const a of attachments) (attBySigner[a.signer_id] ||= []).push(a);

  const newPageIfNeeded = (needed = 14) => {
    if (cursor < 40 + needed) { page = doc.addPage([PW, PH]); cursor = PH - 54; }
  };
  const line = (text, { size = 9, font = helv, color = rgb(0.1, 0.1, 0.1), x = 48 } = {}) => {
    const t = safe(text, '');
    newPageIfNeeded(size + 4);
    // wrap long lines
    const maxW = PW - x - 48;
    let rest = t;
    while (rest.length) {
      let cut = rest.length;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxW) cut = Math.floor(cut * 0.9);
      page.drawText(rest.slice(0, cut), { x, y: cursor, size, font, color });
      cursor -= size + 5;
      rest = rest.slice(cut).trimStart();
      if (rest) newPageIfNeeded(size + 4);
    }
  };

  page.drawText('Certificate of Completion', { x: 48, y: cursor, size: 18, font: helvBold, color: rgb(0.1, 0.1, 0.1) });
  cursor -= 22;
  if (brand.company) line(safe(brand.company, ''), { size: 10, color: rgb(0.3, 0.3, 0.3) });
  cursor -= 8;
  line(`Envelope ID: ${envelope.id}`, { size: 10 });
  line(`Document: ${envelope.title}`, { size: 10 });
  if (envelope.page_count) line(`Pages: ${envelope.page_count}`, { size: 9, color: rgb(0.3, 0.3, 0.3) });
  line(`Original document SHA-256: ${envelope.sha256_original}`, { size: 8, color: rgb(0.3, 0.3, 0.3) });
  line(`Sent: ${envelope.sent_at || envelope.created_at} UTC`, { size: 9 });
  line(`Status: Completed · ${envelope.completed_at || new Date().toISOString()} UTC`, { size: 10 });
  if (brand.senderName) line(`Sender: ${brand.senderName} <${brand.senderEmail}>`, { size: 9 });
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

  if (includeAuditTrail) {
    line('Audit trail', { size: 12, font: helvBold });
    for (const e of events) {
      line(`${e.created_at} UTC · ${e.type} · ${e.actor}${e.ip ? ' · ' + e.ip : ''}`, { size: 8, font: helvBold });
      if (e.detail) line(e.detail.slice(0, 220), { size: 8, x: 60, color: rgb(0.3, 0.3, 0.3) });
    }
    cursor -= 10;
  }

  line('This page was generated by ShalaSign and is part of the signed document.', { size: 7, color: rgb(0.45, 0.45, 0.45) });
  line('Integrity: verify the document SHA-256 against the value stored in the ShalaSign audit log.', { size: 7, color: rgb(0.45, 0.45, 0.45) });
}

async function appendAttachments(doc, { attachments, signerById, helv, helvBold, safe }) {
  const PW = 612, PH = 792;
  for (const a of attachments) {
    if (!a.stored_path || !fs.existsSync(a.stored_path)) continue;
    const signer = signerById[a.signer_id];
    const caption = safe(`Attachment: ${a.label} — ${signer?.name || ''} (${a.original_name || 'file'})`, 'Attachment');
    const bytes = readDecrypted(a.stored_path);
    const mime = (a.mime || '').toLowerCase();

    if (mime.includes('pdf')) {
      const cap = doc.addPage([PW, PH]);
      cap.drawText(caption, { x: 48, y: PH - 60, size: 11, font: helvBold, color: rgb(0.1, 0.1, 0.1) });
      try {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
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
