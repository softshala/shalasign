// Detect {{tags}} typed into a PDF and turn them into field definitions.
//
//   {{sig:1}} / {{signature:2}}   → signature field for signer 1 / 2
//   {{initials:1}}                → initials field
//   {{date:1}}                    → date-signed field
//   {{check:1}} / {{checkbox:1}}  → checkbox
//   {{text:1:Employee ID}}        → text field for signer 1 labelled "Employee ID"
//   {{Company}} / {{Start Date}}  → merge field (text, filled from data, tag hidden)
//
// Positions come from pdf.js text extraction, mapped through the page viewport
// so rotated pages behave exactly like the on-screen viewer.
import * as pdfjs from 'pdfjs-dist';

const TAG_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const SIG_W = 0.22, SIG_H = 0.05, INIT_W = 0.09, INIT_H = 0.045, DATE_W = 0.14, DATE_H = 0.032, CHK = 0.02;

export function parseTag(inner) {
  const parts = inner.split(/[:|]/).map((p) => p.trim());
  const head = parts[0].toLowerCase();
  const signerIndex = Math.max(0, (parseInt(parts[1], 10) || 1) - 1);
  if (['sig', 'signature', 'sign'].includes(head)) return { type: 'signature', signerIndex };
  if (['initials', 'initial', 'init'].includes(head)) return { type: 'initials', signerIndex };
  if (['date', 'datesigned'].includes(head)) return { type: 'date', signerIndex };
  if (['check', 'checkbox', 'tick'].includes(head)) return { type: 'checkbox', signerIndex, label: parts[2] || '' };
  if (['text', 'input', 'field'].includes(head)) return { type: 'text', signerIndex, label: parts[2] || '', required: parts[3]?.toLowerCase() !== 'optional' };
  // anything else is a merge key
  return { type: 'text', signerIndex: 0, merge_key: inner.trim(), cover: true, label: inner.trim(), required: true };
}

/** Scan a PDF and return field definitions (normalized coords) + the list of merge keys found. */
export async function scanTags(url, headers = {}) {
  const doc = await pdfjs.getDocument({ url, httpHeaders: headers, withCredentials: true }).promise;
  const fields = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!item.str || !item.str.includes('{{')) continue;
      const [a, b, , , e, f] = item.transform;
      const fontH = Math.hypot(a, b) || 10;
      const totalW = item.width || 0;
      let m;
      TAG_RE.lastIndex = 0;
      while ((m = TAG_RE.exec(item.str))) {
        const startFrac = m.index / item.str.length, endFrac = (m.index + m[0].length) / item.str.length;
        // tag box in PDF user space (baseline-left origin)
        const x0 = e + totalW * startFrac, x1 = e + totalW * endFrac;
        const y0 = f - fontH * 0.25, y1 = f + fontH * 0.95; // include descender/ascender
        // → viewport space (top-left origin, rotation applied), then normalize
        const pts = [vp.convertToViewportPoint(x0, y0), vp.convertToViewportPoint(x1, y0), vp.convertToViewportPoint(x0, y1), vp.convertToViewportPoint(x1, y1)];
        const minX = Math.min(...pts.map((q) => q[0])) / vp.width, maxX = Math.max(...pts.map((q) => q[0])) / vp.width;
        const minY = Math.min(...pts.map((q) => q[1])) / vp.height, maxY = Math.max(...pts.map((q) => q[1])) / vp.height;
        const spec = parseTag(m[1]);
        let w = maxX - minX, h = maxY - minY, x = minX, y = minY;
        // Non-merge fields get sensible sizes anchored at the tag's top-left.
        if (spec.type === 'signature') { w = Math.max(w, SIG_W); h = Math.max(h, SIG_H); }
        else if (spec.type === 'initials') { w = Math.max(w, INIT_W); h = Math.max(h, INIT_H); }
        else if (spec.type === 'date') { w = Math.max(w, DATE_W); h = Math.max(h, DATE_H); }
        else if (spec.type === 'checkbox') { w = CHK; h = CHK * (vp.width / vp.height); }
        else if (spec.type === 'text' && !spec.merge_key) { w = Math.max(w, 0.18); h = Math.max(h, 0.03); }
        else { w = Math.max(w, 0.06); h = Math.max(h, 0.02); }
        x = Math.min(1 - w, Math.max(0, x)); y = Math.min(1 - h, Math.max(0, y));
        // For non-merge tags, hide the tag text too (it is an instruction, not content).
        fields.push({ ...spec, page: p - 1, x, y, w, h, cover: true, tag: m[0] });
      }
    }
  }
  const keys = [...new Set(fields.filter((f) => f.merge_key).map((f) => f.merge_key))];
  const pages = doc.numPages;
  try { await doc.destroy(); } catch { /* ignore */ }
  return { fields, keys, pages };
}
