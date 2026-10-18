// Extract the text layout of a PDF (line by line with normalized positions) in
// the browser with pdf.js. Used for Claude's field suggestions and for the
// "What am I signing?" summary. Positions use the displayed page (rotation
// applied), top-left origin, 0..1 — the same frame as fields.
import * as pdfjs from 'pdfjs-dist';

export async function extractTextLayout(url, headers = {}, { maxLines = 450, maxChars = 12000 } = {}) {
  const doc = await pdfjs.getDocument({ url, httpHeaders: headers, withCredentials: true }).promise;
  const pages = [];
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    pages.push({ page: p - 1, w: Math.round(vp.width), h: Math.round(vp.height) });
    const content = await page.getTextContent();
    const items = content.items.filter((it) => it.str && it.str.trim()).map((it) => {
      const [a, b, , , e, f] = it.transform;
      const fontH = Math.hypot(a, b) || 10;
      const pts = [vp.convertToViewportPoint(e, f - fontH * 0.25), vp.convertToViewportPoint(e + (it.width || 0), f + fontH * 0.95)];
      const x0 = Math.min(pts[0][0], pts[1][0]) / vp.width, x1 = Math.max(pts[0][0], pts[1][0]) / vp.width;
      const y0 = Math.min(pts[0][1], pts[1][1]) / vp.height, y1 = Math.max(pts[0][1], pts[1][1]) / vp.height;
      return { str: it.str, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    });
    // Group into lines by vertical proximity, then sort left to right.
    items.sort((p1, p2) => (p1.y - p2.y) || (p1.x - p2.x));
    let cur = null;
    for (const it of items) {
      if (cur && Math.abs(it.y - cur.y) < Math.max(cur.h, it.h) * 0.6) {
        cur.parts.push(it);
      } else {
        if (cur) lines.push(...finish(cur, p - 1));
        cur = { y: it.y, h: it.h, parts: [it] };
      }
    }
    if (cur) lines.push(...finish(cur, p - 1));
  }
  try { await doc.destroy(); } catch { /* ignore */ }
  // Cap size for the model.
  let out = lines.slice(0, maxLines);
  let chars = 0; out = out.filter((l) => { chars += l.text.length; return chars <= maxChars; });
  return { pages, lines: out, truncated: out.length < lines.length, fullText: lines.map((l) => l.text).join('\n') };
}

// A visual line may hold several columns ("Signature: ____      Date: ____"). Split on wide
// horizontal gaps so each label keeps its own x position for placement.
function finish(line, page) {
  const parts = line.parts.sort((a, b) => a.x - b.x);
  const spans = []; let cur = [parts[0]];
  for (let i = 1; i < parts.length; i++) { const prev = cur[cur.length - 1]; const gap = parts[i].x - (prev.x + prev.w); if (gap > 0.04) { spans.push(cur); cur = [parts[i]]; } else cur.push(parts[i]); }
  spans.push(cur);
  return spans.map((sp) => {
    const x = Math.min(...sp.map((p) => p.x)), x1 = Math.max(...sp.map((p) => p.x + p.w));
    const y = Math.min(...sp.map((p) => p.y)), y1 = Math.max(...sp.map((p) => p.y + p.h));
    const text = sp.map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim();
    return { page, text, x: +x.toFixed(4), y: +y.toFixed(4), w: +(x1 - x).toFixed(4), h: +(y1 - y).toFixed(4) };
  });
}
