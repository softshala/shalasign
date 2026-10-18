import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const KEY = 'signflow.assistant.v1';

/** Floating "Ask SignFlow" chat powered by Claude with the SignFlow tools. */
export default function Assistant() {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState(() => { try { return JSON.parse(sessionStorage.getItem(KEY) || '{"turns":[],"messages":[]}'); } catch { return { turns: [], messages: [] }; } });
  const endRef = useRef(null);

  useEffect(() => { api('/api/assistant/status').then(setStatus).catch(() => setStatus({ enabled: false })); }, []);
  useEffect(() => { try { sessionStorage.setItem(KEY, JSON.stringify(thread)); } catch { /* ignore */ } endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [thread, open]);

  if (!status) return null;

  const send = async (e) => {
    e?.preventDefault();
    const text = input.trim(); if (!text || busy) return;
    setInput(''); setBusy(true);
    setThread((t) => ({ ...t, turns: [...t.turns, { role: 'user', text }] }));
    try {
      const r = await api('/api/assistant/chat', { method: 'POST', body: { message: text, messages: thread.messages } });
      setThread((t) => ({ messages: r.messages, turns: [...t.turns, { role: 'assistant', text: r.reply || '(done)', actions: r.actions }] }));
    } catch (err) {
      setThread((t) => ({ ...t, turns: [...t.turns, { role: 'assistant', text: err.message, error: true }] }));
    } finally { setBusy(false); }
  };
  const reset = () => setThread({ turns: [], messages: [] });

  const suggestions = ['What is waiting for signature?', 'Send the NDA template to …', 'Remind everyone who has not signed', 'Which inbox do my emails go from?'];

  return (
    <>
      <button className="assistant-fab" onClick={() => setOpen(!open)} aria-label="Ask SignFlow assistant" title="Ask SignFlow">✨ Ask</button>
      {open && (
        <div className="assistant-panel" role="dialog" aria-label="SignFlow assistant">
          <div className="assistant-head">
            <strong>✨ SignFlow assistant</strong>
            <span className="muted small">{status.enabled ? `acts as you · ${status.source === 'workspace' ? 'workspace key' : status.source === 'user' ? 'your key' : 'shared key'} ${status.hint || ''}` : 'not connected'}</span>
            <span style={{ marginLeft: 'auto' }} className="row">
              {thread.turns.length > 0 && <button className="ghost small" onClick={reset} title="New conversation">New</button>}
              <button className="ghost small" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </span>
          </div>
          <div className="assistant-body">
            {!status.enabled && (
              <div className="notice warn" style={{ margin: 0 }}>
                <strong>Connect your Anthropic account to use the assistant.</strong><br />
                Usage is billed to your own Anthropic account, not to SignFlow. Add your API key in <a href="/settings?tab=claude">Settings → Claude &amp; MCP</a>.
                {status.is_admin && <><br />As a workspace admin you can also add one key for your whole team there.</>}
              </div>
            )}
            {status.enabled && thread.turns.length === 0 && (
              <div className="muted" style={{ fontSize: 13 }}>
                <p style={{ marginTop: 0 }}>Ask in plain words. I can look up documents, send templates, upload and send PDFs, remind signers, void, and explain your setup.</p>
                <div className="stack" style={{ gap: 6 }}>{suggestions.map((s) => <button key={s} className="secondary small" style={{ justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => setInput(s)}>{s}</button>)}</div>
              </div>
            )}
            {thread.turns.map((t, i) => (
              <div key={i} className={`assistant-msg ${t.role} ${t.error ? 'bad' : ''}`}>
                {t.actions?.length > 0 && (
                  <div className="assistant-actions">
                    {t.actions.map((a, k) => <span key={k} className={`att-chip ${a.ok ? '' : 'bad'}`} title={JSON.stringify(a.input)}>{a.ok ? '✓' : '⚠'} {a.summary || a.tool.replace(/_/g, ' ')}</span>)}
                  </div>
                )}
                <Linkify text={t.text} />
              </div>
            ))}
            {busy && <div className="assistant-msg assistant"><span className="muted">Working…</span></div>}
            <div ref={endRef} />
          </div>
          <form className="assistant-input" onSubmit={send}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={status.enabled ? 'e.g. Send the NDA template to asha@acme.com, company Acme' : 'Add your Anthropic API key in Settings first'} disabled={busy || !status.enabled} autoFocus />
            <button disabled={busy || !input.trim() || !status.enabled}>Send</button>
          </form>
        </div>
      )}
    </>
  );
}

function Linkify({ text }) {
  const parts = String(text || '').split(/(https?:\/\/[^\s)]+)/g);
  return <div style={{ whiteSpace: 'pre-wrap' }}>{parts.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target={p.startsWith(window.location.origin) ? '_self' : '_blank'} rel="noopener noreferrer">{p.replace(window.location.origin, '')}</a> : p))}</div>;
}
