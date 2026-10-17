import { useEffect, useRef, useState } from 'react';

/** Draw-or-type signature capture. Calls onDone(dataUrlPng). */
export default function SignatureModal({ signerName, onDone, onCancel }) {
  const [mode, setMode] = useState('draw');
  const [typed, setTyped] = useState(signerName || '');
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  useEffect(() => {
    if (mode !== 'draw') return;
    const c = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    c.width = 430 * dpr; c.height = 160 * dpr;
    c.style.width = '430px'; c.style.height = '160px';
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#17264a';
  }, [mode]);

  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    const t = e.touches?.[0] || e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };
  const start = (e) => { drawing.current = true; const p = pos(e); const ctx = canvasRef.current.getContext('2d'); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const p = pos(e); const ctx = canvasRef.current.getContext('2d');
    ctx.lineTo(p.x, p.y); ctx.stroke(); hasInk.current = true;
  };
  const end = () => { drawing.current = false; };
  const clear = () => {
    const c = canvasRef.current;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    hasInk.current = false;
  };

  const confirm = () => {
    if (mode === 'draw') {
      if (!hasInk.current) return alert('Please draw your signature first');
      onDone(canvasRef.current.toDataURL('image/png'));
    } else {
      if (!typed.trim()) return alert('Please type your name');
      const c = document.createElement('canvas');
      c.width = 860; c.height = 240;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#17264a';
      ctx.font = "92px 'Segoe Script', 'Brush Script MT', cursive";
      ctx.textBaseline = 'middle';
      ctx.fillText(typed.trim(), 24, 125);
      onDone(c.toDataURL('image/png'));
    }
  };

  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Add your signature</h3>
        <div className="tabs">
          <button className={mode === 'draw' ? 'active' : ''} onClick={() => setMode('draw')}>Draw</button>
          <button className={mode === 'type' ? 'active' : ''} onClick={() => setMode('type')}>Type</button>
        </div>
        {mode === 'draw' ? (
          <>
            <canvas
              ref={canvasRef} className="sig-canvas"
              onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
              onTouchStart={start} onTouchMove={move} onTouchEnd={end}
            />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="secondary" onClick={clear}>Clear</button>
            </div>
          </>
        ) : (
          <>
            <input style={{ width: '100%' }} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type your full name" />
            <div className="typed-sig" style={{ marginTop: 10 }}>{typed || ' '}</div>
          </>
        )}
        <div className="row spread" style={{ marginTop: 16 }}>
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button onClick={confirm}>Adopt signature</button>
        </div>
      </div>
    </div>
  );
}
