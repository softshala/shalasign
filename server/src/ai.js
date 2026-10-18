// AI features that run on the sender's own Anthropic key:
//   POST /api/ai/suggest-fields  – Claude reads the document's text layout and proposes where fields go
//   summarizeInBackground()      – "What am I signing?" summary generated when a document is sent
import Anthropic from '@anthropic-ai/sdk';
import db, { audit } from './db.js';
import { requireAuth } from './auth.js';
import { resolveKey } from './assistant.js';
import { findEnvelope, canEdit } from './scope.js';
import { setting } from './platform.js';

const model = () => setting('assistant_model') || 'claude-opus-5-5';
const clients = new Map();
const client = (key) => { if (!clients.has(key)) { if (clients.size > 500) clients.clear(); clients.set(key, new Anthropic({ apiKey: key })); } return clients.get(key); };

/** Pull the first JSON value out of a model reply (tolerates prose around it). */
function extractJson(text) {
  const m = String(text || '').match(/[\[{][\s\S]*[\]}]/);
  if (!m) throw new Error('No JSON in reply');
  return JSON.parse(m[0]);
}

async function ask(key, system, user, maxTokens = 4000) {
  const r = await client(key).beta.messages.create({
    model: model(), max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
    output_config: { effort: 'medium' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
  });
  if (r.stop_reason === 'refusal') throw new Error('The model declined this request.');
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

const SUGGEST_SYSTEM = `You place e-signature fields on a document. You receive the document's text as lines with normalized positions (page index, x, y, w, h in 0..1, top-left origin) and the list of signers (index, name, role).
Return ONLY a JSON array of fields: {"type":"signature"|"initials"|"date"|"text"|"checkbox","page":n,"x":0..1,"y":0..1,"w":0..1,"h":0..1,"signerIndex":n,"label":"short label","reason":"why here"}.
Rules:
- Put a signature field where the document expects a signature: after labels like "Signature", "Signed", "Authorised signatory", "For <party>", or an underline/blank next to a party name. Width about 0.22–0.3, height about 0.05–0.06, placed to the right of or just below the label, never covering the label text.
- Put a date field next to "Date" labels near signature blocks (w≈0.14, h≈0.03). Put text fields for blanks like "Name:", "Designation:", "Place:" that the signer should fill (w≈0.2–0.3, h≈0.03), with the label.
- Map parties to signers in order: the first party/role mentioned → signerIndex 0, the second → 1, etc. If only one signer exists, assign everything to 0. Use the signer roles/names if they match party names in the text.
- Checkbox only for explicit "☐ / [ ] I agree" style options.
- Fields must stay inside the page (x+w ≤ 1, y+h ≤ 1). Prefer fewer, confident fields over many guesses. Every signer should get at least one signature field; if the document has no obvious place, put it near the bottom of the last page.
- No prose, no markdown fences — just the JSON array.`;

const SUMMARY_SYSTEM = `You write a plain-language briefing for someone about to sign a document. Return ONLY JSON: {"summary":"2–3 sentences: what this document is and who the parties are","key_points":["up to 6 short bullets of the most important terms (amounts, dates, duration, termination, confidentiality, penalties)"],"obligations":["up to 5 short bullets: what the signer commits to"],"caution":"one sentence on anything unusual or one-sided, or empty string"}. Be neutral and specific; quote numbers and dates exactly; never invent terms that are not in the text. No markdown fences.`;

export function registerAiRoutes(app) {
  app.post('/api/ai/suggest-fields', requireAuth, async (req, res) => {
    const k = resolveKey(req.user);
    if (!k) return res.status(402).json({ error: 'Add your Anthropic API key in Settings → Claude & MCP to use AI field suggestions.', needs_key: true });
    const { envelope_id, lines = [], pages = [], signers = [] } = req.body || {};
    const env = findEnvelope(req.user, String(envelope_id || ''));
    if (!env || !canEdit(req.user, env)) return res.status(404).json({ error: 'Envelope not found' });
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'This PDF has no extractable text (it may be a scan). Place fields by hand or use {{tags}}.' });
    const compactLines = lines.slice(0, 450).map((l) => `p${l.page} x=${(+l.x).toFixed(3)} y=${(+l.y).toFixed(3)} w=${(+l.w).toFixed(3)} h=${(+l.h).toFixed(3)} | ${String(l.text).slice(0, 160)}`).join('\n');
    const signerList = (signers.length ? signers : [{ name: 'Signer 1' }]).slice(0, 10).map((s, i) => `${i}: ${s.role ? s.role + ' — ' : ''}${s.name || `Signer ${i + 1}`}`).join('\n');
    try {
      const text = await ask(k.key, SUGGEST_SYSTEM, `Pages: ${JSON.stringify(pages)}\nSigners:\n${signerList}\n\nDocument lines:\n${compactLines}`);
      const raw = extractJson(text);
      const types = new Set(['signature', 'initials', 'date', 'text', 'checkbox']);
      const fields = (Array.isArray(raw) ? raw : []).filter((f) => f && types.has(f.type)).map((f) => {
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
        const w = clamp(f.w, 0.015, 0.6), h = clamp(f.h, 0.01, 0.15);
        return { type: f.type, page: Math.max(0, Math.min((pages.length || 1) - 1, Math.floor(Number(f.page) || 0))), x: clamp(f.x, 0, 1 - w), y: clamp(f.y, 0, 1 - h), w, h, signerIndex: Math.max(0, Math.min(Math.max(signers.length, 1) - 1, Math.floor(Number(f.signerIndex) || 0))), label: String(f.label || '').slice(0, 60), reason: String(f.reason || '').slice(0, 140), required: true };
      }).slice(0, 60);
      audit(env.id, 'ai.suggested_fields', `${req.user.name} <${req.user.email}>`, `Claude suggested ${fields.length} field(s)`);
      res.json({ fields, model: model() });
    } catch (e) {
      console.error('[ai] suggest-fields', e.message);
      res.status(e?.status === 401 ? 401 : 502).json({ error: e?.status === 401 ? 'Anthropic rejected the API key. Update it in Settings → Claude & MCP.' : `Could not get suggestions: ${e.message}` });
    }
  });
}

/** Generate the signer briefing for an envelope from its text; never throws. */
export function summarizeInBackground(envelopeId, userId, documentText) {
  const text = String(documentText || '').trim();
  if (text.length < 200) return;
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  const k = user ? resolveKey(user) : null;
  if (!k) return;
  (async () => {
    try {
      const reply = await ask(k.key, SUMMARY_SYSTEM, `Document text (may be truncated):\n\n${text.slice(0, 14000)}`, 1500);
      const j = extractJson(reply);
      const summary = { summary: String(j.summary || '').slice(0, 800), key_points: (j.key_points || []).slice(0, 6).map((s) => String(s).slice(0, 200)), obligations: (j.obligations || []).slice(0, 5).map((s) => String(s).slice(0, 200)), caution: String(j.caution || '').slice(0, 300), model: model(), generated_at: new Date().toISOString() };
      db.prepare(`UPDATE envelopes SET summary_json = ? WHERE id = ?`).run(JSON.stringify(summary), envelopeId);
      audit(envelopeId, 'ai.summary', 'system', `Signer briefing generated (${summary.model})`);
    } catch (e) {
      console.error('[ai] summary', envelopeId, e.message);
    }
  })();
}
