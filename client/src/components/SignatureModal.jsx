import { useEffect, useRef, useState } from 'react';

const SAVED_KEY = 'signflow.savedSignature';

/**
 * Draw / type / upload a signature. Calls onDone(dataUrlPng).
 * Upload supports rotate, crop and background removal (photos of paper signatures).
 * Remembers the last adopted signature in this browser so returning signers reuse it.
 */
export default function SignatureModal({ signerName, onDone, onCancel, title = 'Add your signature' }) {
  const saved = (() => { try { return localStorage.getItem(SAVED_KEY) || ''; } catch { return ''; } })();
  const [mode, setMode] = useState(saved ? 'saved' : 'draw');
  const [typed, setTyped] = useState(signerName || '');
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState('');
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const last = useRef(null);

  // ---- upload state ----
  const [src, setSrc] = useState(null);            // HTMLImageElement of the uploaded file
  const [rotation, setRotation] = useState(0);     // 0/90/180/270
  const [removeBg, setRemoveBg] = useState(true);
  const [threshold, setThreshold] = useState(185);
  const [crop, setCrop] = useState(null);          // {x,y,w,h} fractions of the (rotated) image
  const [dragCrop, setDragCrop] = useState(null);
  const [processed, setProcessed] = useState('');
  const cropRef = useRef(null);

  useEffect(() => {
    if (mode !== 'draw') return;
    const c = canvasRef.current; if (!c) return;
    const setup = () => {
      const cssW = Math.max(240, c.clientWidth || 430); const cssH = Math.round(cssW * 0.37); const dpr = window.devicePixelRatio || 1;
      let snapshot = null; if (hasInk.current) { try { snapshot = c.toDataURL(); } catch { /* ignore */ } }
      c.width = cssW * dpr; c.height = cssH * dpr; c.style.height = `${cssH}px`;
      const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#17264a';
      if (snapshot) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, cssW, cssH); img.src = snapshot; }
    };
    setup(); const ro = new ResizeObserver(setup); ro.observe(c); return () => ro.disconnect();
  }, [mode]);

  const pos = (e) => { const r = canvasRef.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const start = (e) => { e.preventDefault(); canvasRef.current.setPointerCapture?.(e.pointerId); drawing.current = true; last.current = pos(e); const ctx = canvasRef.current.getContext('2d'); ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); };
  const move = (e) => { if (!drawing.current) return; e.preventDefault(); const p = pos(e); const ctx = canvasRef.current.getContext('2d'); const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 }; ctx.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(mid.x, mid.y); last.current = p; hasInk.current = true; };
  const end = () => { drawing.current = false; };
  const clear = () => { const c = canvasRef.current; const ctx = c.getContext('2d'); ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.restore(); hasInk.current = false; };

  // Trim transparent margins.
  const trimmed = (canvas) => {
    const ctx = canvas.getContext('2d'); const { width: W, height: H } = canvas; const data = ctx.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (data[(y * W + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
    if (maxX < 0) return canvas.toDataURL('image/png');
    const pad = 8; const out = document.createElement('canvas'); out.width = maxX - minX + 1 + pad * 2; out.height = maxY - minY + 1 + pad * 2;
    out.getContext('2d').drawImage(canvas, minX, minY, maxX - minX + 1, maxY - minY + 1, pad, pad, maxX - minX + 1, maxY - minY + 1);
    return out.toDataURL('image/png');
  };

  // ---- upload pipeline: rotate → crop → remove background → trim ----
  const onUpload = (file) => {
    setErr(''); if (!file) return;
    if (!/^image\/(png|jpeg|webp|heic|heif)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) return setErr('Please choose a PNG or JPG image.');
    if (file.size > 8 * 1024 * 1024) return setErr('Image must be under 8 MB.');
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { setSrc(img); setRotation(0); setCrop(null); URL.revokeObjectURL(url); };
    img.onerror = () => setErr('Could not read that image.');
    img.src = url;
  };
  const rotatedCanvas = () => {
    if (!src) return null;
    const maxSide = 1400; const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
    const w = Math.round(src.width * scale), h = Math.round(src.height * scale);
    const c = document.createElement('canvas'); const swap = rotation % 180 !== 0; c.width = swap ? h : w; c.height = swap ? w : h;
    const ctx = c.getContext('2d'); ctx.translate(c.width / 2, c.height / 2); ctx.rotate((rotation * Math.PI) / 180); ctx.drawImage(src, -w / 2, -h / 2, w, h);
    return c;
  };
  useEffect(() => {
    if (mode !== 'upload' || !src) { setProcessed(''); return; }
    const base = rotatedCanvas();
    let c = base;
    if (crop && crop.w > 0.02 && crop.h > 0.02) {
      const cc = document.createElement('canvas'); cc.width = Math.round(crop.w * base.width); cc.height = Math.round(crop.h * base.height);
      cc.getContext('2d').drawImage(base, crop.x * base.width, crop.y * base.height, cc.width, cc.height, 0, 0, cc.width, cc.height); c = cc;
    }
    if (removeBg) {
      const ctx = c.getContext('2d'); const im = ctx.getImageData(0, 0, c.width, c.height); const d = im.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum > threshold) d[i + 3] = 0;                                  // paper → transparent
        else { const k = Math.max(0, Math.min(1, (threshold - lum) / 90)); d[i + 3] = Math.round(d[i + 3] * (0.35 + 0.65 * k)); } // soften edges
      }
      ctx.putImageData(im, 0, 0);
    }
    setProcessed(trimmed(c));
  }, [mode, src, rotation, crop, removeBg, threshold]);

  // crop by dragging on the preview of the rotated image
  const cropPos = (e) => { const r = cropRef.current.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  const cropStart = (e) => { e.preventDefault(); cropRef.current.setPointerCapture?.(e.pointerId); const p = cropPos(e); setDragCrop({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); };
  const cropMove = (e) => { if (!dragCrop) return; const p = cropPos(e); setDragCrop({ ...dragCrop, x1: p.x, y1: p.y }); };
  const cropEnd = () => { if (!dragCrop) return; const x = Math.min(dragCrop.x0, dragCrop.x1), y = Math.min(dragCrop.y0, dragCrop.y1), w = Math.abs(dragCrop.x1 - dragCrop.x0), h = Math.abs(dragCrop.y1 - dragCrop.y0); if (w > 0.03 && h > 0.03) setCrop({ x, y, w, h }); setDragCrop(null); };
  const previewRotated = src ? rotatedCanvas().toDataURL('image/jpeg', 0.8) : '';
  const rectShown = dragCrop ? { x: Math.min(dragCrop.x0, dragCrop.x1), y: Math.min(dragCrop.y0, dragCrop.y1), w: Math.abs(dragCrop.x1 - dragCrop.x0), h: Math.abs(dragCrop.y1 - dragCrop.y0) } : crop;

  const confirm = () => {
    setErr('');
    let dataUrl;
    if (mode === 'saved') dataUrl = saved;
    else if (mode === 'draw') { if (!hasInk.current) return setErr('Please draw your signature first.'); dataUrl = trimmed(canvasRef.current); }
    else if (mode === 'type') {
      if (!typed.trim()) return setErr('Please type your name.');
      const c = document.createElement('canvas'); c.width = 900; c.height = 240; const ctx = c.getContext('2d'); ctx.fillStyle = '#17264a';
      let size = 92; ctx.font = `${size}px 'Dancing Script', 'Segoe Script', 'Brush Script MT', cursive`; ctx.textBaseline = 'middle';
      while (size > 30 && ctx.measureText(typed.trim()).width > 850) { size -= 4; ctx.font = `${size}px 'Dancing Script', 'Segoe Script', 'Brush Script MT', cursive`; }
      ctx.fillText(typed.trim(), 24, 125); dataUrl = trimmed(c);
    } else { if (!processed) return setErr('Please choose an image.'); dataUrl = processed; }
    if (remember) { try { localStorage.setItem(SAVED_KEY, dataUrl); } catch { /* private mode */ } }
    onDone(dataUrl);
  };

  return (
    <div className="modal-bg" onClick={onCancel} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <div className="tabs">
          {saved && <button className={mode === 'saved' ? 'active' : ''} onClick={() => setMode('saved')}>Saved</button>}
          <button className={mode === 'draw' ? 'active' : ''} onClick={() => setMode('draw')}>Draw</button>
          <button className={mode === 'type' ? 'active' : ''} onClick={() => setMode('type')}>Type</button>
          <button className={mode === 'upload' ? 'active' : ''} onClick={() => setMode('upload')}>Upload</button>
        </div>

        {mode === 'saved' && <div><p className="muted" style={{ marginTop: 0 }}>Your signature from last time on this device:</p><img src={saved} alt="Saved signature" className="sig-preview" /></div>}
        {mode === 'draw' && (<>
          <canvas ref={canvasRef} className="sig-canvas" aria-label="Signature drawing area" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerLeave={end} />
          <div className="row" style={{ marginTop: 10 }}><button className="secondary small" onClick={clear}>Clear</button><span className="muted">Sign with your finger, stylus or mouse.</span></div>
        </>)}
        {mode === 'type' && (<>
          <input style={{ width: '100%' }} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type your full name" autoFocus />
          <div className="typed-sig" style={{ marginTop: 10 }}>{typed || ' '}</div>
        </>)}
        {mode === 'upload' && (<>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => onUpload(e.target.files?.[0])} />
          <p className="hint">A photo or scan of your signature on white paper works best. Drag on the picture to crop.</p>
          {src && (
            <div className="grid-2" style={{ gap: 10, marginTop: 8 }}>
              <div>
                <div ref={cropRef} style={{ position: 'relative', userSelect: 'none', touchAction: 'none', cursor: 'crosshair', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: '#f3f4f6' }}
                  onPointerDown={cropStart} onPointerMove={cropMove} onPointerUp={cropEnd} onPointerCancel={cropEnd}>
                  <img src={previewRotated} alt="Uploaded" style={{ width: '100%', display: 'block', pointerEvents: 'none' }} draggable={false} />
                  {rectShown && <div style={{ position: 'absolute', left: `${rectShown.x * 100}%`, top: `${rectShown.y * 100}%`, width: `${rectShown.w * 100}%`, height: `${rectShown.h * 100}%`, border: '2px dashed var(--brand)', background: 'rgba(47,111,237,0.12)', pointerEvents: 'none' }} />}
                </div>
                <div className="row" style={{ marginTop: 6, gap: 6 }}>
                  <button className="secondary small" onClick={() => { setRotation((rotation + 90) % 360); setCrop(null); }}>↻ Rotate</button>
                  {crop && <button className="secondary small" onClick={() => setCrop(null)}>Reset crop</button>}
                </div>
              </div>
              <div>
                <div className="muted small" style={{ marginBottom: 4 }}>Result</div>
                <div style={{ background: 'repeating-conic-gradient(#eee 0 25%, #fff 0 50%) 0 0/16px 16px', border: '1px solid var(--border)', borderRadius: 8, padding: 8, minHeight: 90, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {processed ? <img src={processed} alt="Processed signature" style={{ maxWidth: '100%', maxHeight: 120 }} /> : <span className="muted small">…</span>}
                </div>
                <label className="row small" style={{ marginTop: 8, gap: 6 }}><input type="checkbox" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} /> Remove paper background</label>
                {removeBg && <label className="small" style={{ display: 'block', marginTop: 4 }}>Sensitivity <input type="range" min={120} max={240} value={threshold} onChange={(e) => setThreshold(+e.target.value)} style={{ width: '100%' }} /></label>}
              </div>
            </div>
          )}
        </>)}

        {err && <p className="error">{err}</p>}
        <label className="row" style={{ marginTop: 14, fontSize: 13, gap: 8 }}><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember this signature on this device</label>
        <div className="row spread" style={{ marginTop: 16 }}>
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button onClick={confirm}>Adopt signature</button>
        </div>
      </div>
    </div>
  );
}
