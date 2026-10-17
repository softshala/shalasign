import { useEffect, useRef, useState } from 'react';

const SAVED_KEY = 'signflow.savedSignature';

/**
 * Draw / type / upload a signature. Calls onDone(dataUrlPng).
 * Remembers the last adopted signature in this browser so returning signers
 * can reuse it with one tap.
 */
export default function SignatureModal({ signerName, onDone, onCancel, title = 'Add your signature' }) {
  const saved = (() => { try { return localStorage.getItem(SAVED_KEY) || ''; } catch { return ''; } })();
  const [mode, setMode] = useState(saved ? 'saved' : 'draw');
  const [typed, setTyped] = useState(signerName || '');
  const [uploaded, setUploaded] = useState('');
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState('');
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const last = useRef(null);

  // Size the canvas to its CSS width (responsive) with a crisp backing store.
  useEffect(() => {
    if (mode !== 'draw') return;
    const c = canvasRef.current;
    if (!c) return;
    const setup = () => {
      const cssW = Math.max(240, c.clientWidth || 430);
      const cssH = Math.round(cssW * 0.37);
      const dpr = window.devicePixelRatio || 1;
      // Preserve existing ink across resizes.
      let snapshot = null;
      if (hasInk.current) { try { snapshot = c.toDataURL(); } catch { /* ignore */ } }
      c.width = cssW * dpr; c.height = cssH * dpr; c.style.height = `${cssH}px`;
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#17264a';
      if (snapshot) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, cssW, cssH); img.src = snapshot; }
    };
    setup();
    const ro = new ResizeObserver(setup);
    ro.observe(c);
    return () => ro.disconnect();
  }, [mode]);

  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const start = (e) => {
    e.preventDefault();
    canvasRef.current.setPointerCapture?.(e.pointerId);
    drawing.current = true; last.current = pos(e);
    const ctx = canvasRef.current.getContext('2d');
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y);
  };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const p = pos(e); const ctx = canvasRef.current.getContext('2d');
    // quadratic smoothing between points
    const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
    ctx.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
    ctx.stroke(); ctx.beginPath(); ctx.moveTo(mid.x, mid.y);
    last.current = p; hasInk.current = true;
  };
  const end = () => { drawing.current = false; };
  const clear = () => {
    const c = canvasRef.current; const ctx = c.getContext('2d');
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.restore();
    hasInk.current = false;
  };

  // Trim transparent margins so the signature fills its field nicely.
  const trimmed = (canvas) => {
    const ctx = canvas.getContext('2d');
    const { width: W, height: H } = canvas;
    const data = ctx.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) return canvas.toDataURL('image/png');
    const pad = 8;
    const out = document.createElement('canvas');
    out.width = maxX - minX + 1 + pad * 2; out.height = maxY - minY + 1 + pad * 2;
    out.getContext('2d').drawImage(canvas, minX, minY, maxX - minX + 1, maxY - minY + 1, pad, pad, maxX - minX + 1, maxY - minY + 1);
    return out.toDataURL('image/png');
  };

  const onUpload = (file) => {
    setErr('');
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return setErr('Please choose a PNG or JPG image.');
    if (file.size > 2 * 1024 * 1024) return setErr('Image must be under 2 MB.');
    const reader = new FileReader();
    reader.onload = () => {
      // Normalise to PNG with a white background knocked out where possible (keep simple: re-encode).
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        const scale = Math.min(1, 900 / img.width);
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        setUploaded(c.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const confirm = () => {
    setErr('');
    let dataUrl;
    if (mode === 'saved') dataUrl = saved;
    else if (mode === 'draw') {
      if (!hasInk.current) return setErr('Please draw your signature first.');
      dataUrl = trimmed(canvasRef.current);
    } else if (mode === 'type') {
      if (!typed.trim()) return setErr('Please type your name.');
      const c = document.createElement('canvas');
      c.width = 900; c.height = 240;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#17264a';
      ctx.font = "92px 'Dancing Script', 'Segoe Script', 'Brush Script MT', cursive";
      ctx.textBaseline = 'middle';
      let size = 92;
      while (size > 30 && ctx.measureText(typed.trim()).width > 850) { size -= 4; ctx.font = `${size}px 'Dancing Script', 'Segoe Script', 'Brush Script MT', cursive`; }
      ctx.fillText(typed.trim(), 24, 125);
      dataUrl = trimmed(c);
    } else {
      if (!uploaded) return setErr('Please choose an image.');
      dataUrl = uploaded;
    }
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

        {mode === 'saved' && (
          <div>
            <p className="muted" style={{ marginTop: 0 }}>Your signature from last time on this device:</p>
            <img src={saved} alt="Saved signature" className="sig-preview" />
          </div>
        )}
        {mode === 'draw' && (
          <>
            <canvas ref={canvasRef} className="sig-canvas" aria-label="Signature drawing area"
              onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerLeave={end} />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="secondary small" onClick={clear}>Clear</button>
              <span className="muted">Sign with your finger, stylus or mouse.</span>
            </div>
          </>
        )}
        {mode === 'type' && (
          <>
            <input style={{ width: '100%' }} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type your full name" autoFocus />
            <div className="typed-sig" style={{ marginTop: 10 }}>{typed || ' '}</div>
          </>
        )}
        {mode === 'upload' && (
          <>
            <input type="file" accept="image/png,image/jpeg" onChange={(e) => onUpload(e.target.files?.[0])} />
            <p className="hint">A photo or scan of your signature on white paper works best.</p>
            {uploaded && <img src={uploaded} alt="Uploaded signature" className="sig-preview" style={{ marginTop: 8 }} />}
          </>
        )}

        {err && <p className="error">{err}</p>}
        <label className="row" style={{ marginTop: 14, fontSize: 13, gap: 8 }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember this signature on this device
        </label>
        <div className="row spread" style={{ marginTop: 16 }}>
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button onClick={confirm}>Adopt signature</button>
        </div>
      </div>
    </div>
  );
}
