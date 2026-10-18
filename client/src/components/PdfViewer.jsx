import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Renders every page of a PDF, sized to the container (max `maxWidth`), and lets
 * the parent draw an absolutely-positioned overlay on each page.
 *
 * props:
 *   url, headers      – where to fetch the PDF
 *   maxWidth          – CSS px cap for page width (default 820)
 *   renderOverlay     – (pageIndex, {width, height}) => JSX
 *   onPageClick       – (pageIndex, {x, y}) normalized top-left coords (ignored if a drag just happened)
 *   onReady           – (numPages) called once metadata is known
 *   pageRefs          – optional ref object; pageRefs.current[index] = DOM element (for scrolling)
 */
export default function PdfViewer({ url, headers, maxWidth = 820, renderOverlay, onPageClick, onReady, pageRefs }) {
  const [doc, setDoc] = useState(null);
  const [pages, setPages] = useState([]); // [{index, baseW, baseH}]
  const [width, setWidth] = useState(maxWidth);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const wrapRef = useRef(null);
  const docRef = useRef(null);
  const canvasRefs = useRef({});
  const renderTasks = useRef({});

  // Measure container width (responsive).
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(280, Math.min(maxWidth, el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxWidth]);

  // Load document + page metadata (one automatic retry on failure, then a Retry button).
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setPages([]); setError('');
    (async () => {
      try {
        let d;
        try { d = await pdfjs.getDocument({ url, httpHeaders: headers || {}, withCredentials: true }).promise; }
        catch (e1) { if (cancelled) return; await new Promise((r) => setTimeout(r, 800)); d = await pdfjs.getDocument({ url, httpHeaders: headers || {}, withCredentials: true }).promise; }
        if (cancelled) { d.destroy?.(); return; }
        docRef.current?.destroy?.(); docRef.current = d;
        const metas = [];
        for (let i = 1; i <= d.numPages; i++) {
          const page = await d.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          metas.push({ index: i - 1, baseW: vp.width, baseH: vp.height });
        }
        if (cancelled) return;
        setDoc(d); setPages(metas); onReady?.(d.numPages);
      } catch (e) {
        console.error('PDF load failed', e);
        if (!cancelled) setError(e?.message?.includes('401') ? 'Access denied' : 'Could not load the document. Try refreshing the page.');
      }
    })();
    return () => { cancelled = true; };
  }, [url, JSON.stringify(headers || {}), attempt]);
  useEffect(() => () => { docRef.current?.destroy?.(); docRef.current = null; }, []);

  // Render pages whenever the doc or width changes.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      for (const p of pages) {
        if (cancelled) return;
        const canvas = canvasRefs.current[p.index];
        if (!canvas) continue;
        const page = await doc.getPage(p.index + 1);
        const scale = width / p.baseW;
        const vp = page.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderTasks.current[p.index]?.cancel?.();
        const task = page.render({ canvasContext: ctx, viewport: vp });
        renderTasks.current[p.index] = task;
        try { await task.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') console.error(e); }
      }
    })();
    return () => { cancelled = true; };
  }, [doc, pages, width]);

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      {error && <p className="error">{error} <button className="secondary small" onClick={() => setAttempt((a) => a + 1)}>Retry</button></p>}
      {pages.map((p) => {
        const h = (p.baseH / p.baseW) * width;
        return (
          <div
            key={p.index}
            ref={(el) => { if (pageRefs) pageRefs.current[p.index] = el; }}
            className="pdf-stage"
            style={{ width, height: h }}
            onClick={(e) => {
              if (!onPageClick) return;
              if (e.target.closest?.('.field-box')) return;
              const rect = e.currentTarget.getBoundingClientRect();
              onPageClick(p.index, { x: (e.clientX - rect.left) / width, y: (e.clientY - rect.top) / h });
            }}
          >
            <canvas ref={(el) => (canvasRefs.current[p.index] = el)} />
            <span className="page-num">{p.index + 1} / {pages.length}</span>
            {renderOverlay && renderOverlay(p.index, { width, height: h })}
          </div>
        );
      })}
      {!error && pages.length === 0 && <p className="muted" style={{ textAlign: 'center' }}>Loading document…</p>}
    </div>
  );
}
