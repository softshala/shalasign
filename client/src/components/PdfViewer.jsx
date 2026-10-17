import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Renders every page of a PDF at a fixed display width and lets the parent
 * draw an absolutely-positioned overlay on each page (fields, signatures).
 *
 * props:
 *   url            – PDF url
 *   pageWidth      – display width in CSS px (default 760)
 *   renderOverlay  – (pageIndex, {width, height}) => JSX
 *   onPageClick    – (pageIndex, {x, y}) normalized top-left coords
 */
export default function PdfViewer({ url, pageWidth = 760, renderOverlay, onPageClick, headers }) {
  const [pages, setPages] = useState([]); // [{index, width, height}]
  const canvasRefs = useRef({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const doc = await pdfjs.getDocument({ url, httpHeaders: headers || {} }).promise;
      const metas = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = pageWidth / base.width;
        const vp = page.getViewport({ scale });
        metas.push({ index: i - 1, width: vp.width, height: vp.height });
        if (cancelled) return;
        setPages([...metas]);
        // wait a tick for the canvas to mount, then render
        await new Promise((r) => setTimeout(r, 0));
        const canvas = canvasRefs.current[i - 1];
        if (!canvas) continue;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = vp.width * dpr;
        canvas.height = vp.height * dpr;
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      }
    })().catch((e) => console.error('PDF render failed', e));
    return () => { cancelled = true; };
  }, [url, pageWidth, JSON.stringify(headers || {})]);

  return (
    <div>
      {pages.map((p) => (
        <div
          key={p.index}
          className="pdf-stage"
          style={{ width: p.width, height: p.height }}
          onClick={(e) => {
            if (!onPageClick) return;
            const rect = e.currentTarget.getBoundingClientRect();
            onPageClick(p.index, {
              x: (e.clientX - rect.left) / p.width,
              y: (e.clientY - rect.top) / p.height,
            });
          }}
        >
          <canvas ref={(el) => (canvasRefs.current[p.index] = el)} />
          {renderOverlay && renderOverlay(p.index, { width: p.width, height: p.height })}
        </div>
      ))}
      {pages.length === 0 && <p className="muted">Loading document…</p>}
    </div>
  );
}
