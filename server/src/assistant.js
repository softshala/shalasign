// In-app assistant: Claude with the SignFlow tools, acting as the logged-in user.
// POST /api/assistant/chat { messages: [...prior turns], message: "text" }
//   → { reply, actions: [{tool, input, ok, summary}], messages: full history to send back next time }
import Anthropic from '@anthropic-ai/sdk';
import db, { getOrg, getSettings, isOrgAdmin } from './db.js';
import { requireAuth } from './auth.js';
import { anthropicTools, runTool } from './tools.js';
import { appUrl } from './mailer.js';
import { encStr, decStr } from './crypto.js';

const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5-5';
// The operator's own key is used ONLY when they explicitly opt in to paying for everyone.
const platformKey = () => (process.env.ASSISTANT_SHARED_KEY === '1' ? process.env.ANTHROPIC_API_KEY || null : null);
export const assistantEnabled = () => true; // the feature exists; whether a given user can use it depends on resolveKey()

/** Which Anthropic key runs the assistant for this user: workspace key (admin-set) → their own key → platform (opt-in). */
export function resolveKey(user) {
  const org = getOrg(user.org_id);
  if (org?.anthropic_key) return { key: decStr(org.anthropic_key), source: 'workspace', hint: org.anthropic_key_hint };
  const s = getSettings(user.id);
  if (s.anthropic_key) return { key: decStr(s.anthropic_key), source: 'user', hint: s.anthropic_key_hint };
  if (platformKey()) return { key: platformKey(), source: 'platform', hint: null };
  return null;
}
const clients = new Map();
const getClient = (key) => { if (!clients.has(key)) { if (clients.size > 500) clients.clear(); clients.set(key, new Anthropic({ apiKey: key })); } return clients.get(key); };
const hintOf = (k) => `…${k.slice(-4)}`;
const validKey = (k) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k);
async function verifyKey(key) {
  // Cheapest possible call: no tokens are generated.
  await getClient(key).models.retrieve(MODEL);
}

const MAX_TURNS = 8;       // tool-call rounds per user message
const MAX_HISTORY = 40;    // messages kept from the client-provided history

function systemPrompt(user) {
  const org = getOrg(user.org_id);
  return `You are the SignFlow assistant, embedded in the SignFlow e-signature web app. You act on behalf of the logged-in user using the tools; everything you do is recorded in the audit trail under their name.

User: ${user.name} <${user.email}>, role ${user.role} in workspace "${org?.name || 'personal'}". App URL: ${appUrl()}. Today: ${new Date().toISOString().slice(0, 10)}.

How to work:
- Prefer doing the task over describing it. Look things up with the tools instead of guessing ids, template names or signer emails.
- Before sending anything, make sure you have every signer's name and email and every merge value the template needs; ask for what is missing in one short question.
- Never invent email addresses. If the user names a person without an email, ask for it.
- void_document is irreversible: state what will be voided and get an explicit yes before calling it with confirm=true.
- After an action, confirm what happened in one or two sentences and include the open_in_app link. Mention whether emails were sent and from which address.
- If a tool returns an error, explain it plainly and suggest the fix (for example connecting an inbox in Settings).
- Keep replies short and plain. Use a bulleted list only for several documents. No markdown headers.`;
}

const summarize = (name, input, result) => {
  try {
    switch (name) {
      case 'send_from_template': case 'send_document': return `Sent "${result.id}" to ${(input.signers || []).map((s) => s.email).join(', ')}${result.emailed ? ` from ${result.email_from}` : ' (no email configured — links returned)'}`;
      case 'create_document': return `Created draft "${input.title}" (${result.pages} page${result.pages === 1 ? '' : 's'})`;
      case 'remind_signers': return `Reminded ${(result.reminded || []).join(', ') || 'signers'}`;
      case 'void_document': return `Voided ${input.id}`;
      case 'change_signer_email': return `Updated signer on ${input.id}`;
      case 'move_to_folder': return `Moved ${input.id}`;
      default: return null;
    }
  } catch { return null; }
};

export function registerAssistantRoutes(app) {
  app.get('/api/assistant/status', requireAuth, (req, res) => {
    const k = resolveKey(req.user);
    const s = getSettings(req.user.id); const org = getOrg(req.user.org_id);
    res.json({ enabled: !!k, source: k?.source || null, hint: k?.hint || null, model: MODEL, tools: anthropicTools().map((t) => t.name),
      has_own_key: !!s.anthropic_key, own_hint: s.anthropic_key_hint || null,
      workspace_key: !!org?.anthropic_key, workspace_hint: org?.anthropic_key_hint || null, is_admin: isOrgAdmin(req.user),
      platform_offered: !!platformKey() });
  });

  // Save / remove my own key (stored encrypted; never returned).
  app.put('/api/assistant/key', requireAuth, async (req, res) => {
    const key = String(req.body?.key || '').trim();
    if (!validKey(key)) return res.status(400).json({ error: 'That does not look like an Anthropic API key (they start with sk-ant-).' });
    try { await verifyKey(key); } catch (e) { return res.status(400).json({ error: e?.status === 401 ? 'Anthropic rejected this key. Check it in console.anthropic.com → API keys.' : `Could not verify the key: ${e.message}` }); }
    db.prepare(`INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`).run(req.user.id);
    db.prepare(`UPDATE user_settings SET anthropic_key = ?, anthropic_key_hint = ?, updated_at = datetime('now') WHERE user_id = ?`).run(encStr(key), hintOf(key), req.user.id);
    res.json({ ok: true, hint: hintOf(key) });
  });
  app.delete('/api/assistant/key', requireAuth, (req, res) => {
    db.prepare(`UPDATE user_settings SET anthropic_key = NULL, anthropic_key_hint = NULL WHERE user_id = ?`).run(req.user.id);
    res.json({ ok: true });
  });
  // Workspace key: one key for all members, set by an admin.
  app.put('/api/assistant/workspace-key', requireAuth, async (req, res) => {
    if (!isOrgAdmin(req.user)) return res.status(403).json({ error: 'Only workspace admins can set the workspace key' });
    const key = String(req.body?.key || '').trim();
    if (!validKey(key)) return res.status(400).json({ error: 'That does not look like an Anthropic API key (they start with sk-ant-).' });
    try { await verifyKey(key); } catch (e) { return res.status(400).json({ error: e?.status === 401 ? 'Anthropic rejected this key.' : `Could not verify the key: ${e.message}` }); }
    db.prepare(`UPDATE orgs SET anthropic_key = ?, anthropic_key_hint = ? WHERE id = ?`).run(encStr(key), hintOf(key), req.user.org_id);
    res.json({ ok: true, hint: hintOf(key) });
  });
  app.delete('/api/assistant/workspace-key', requireAuth, (req, res) => {
    if (!isOrgAdmin(req.user)) return res.status(403).json({ error: 'Only workspace admins can remove the workspace key' });
    db.prepare(`UPDATE orgs SET anthropic_key = NULL, anthropic_key_hint = NULL WHERE id = ?`).run(req.user.org_id);
    res.json({ ok: true });
  });

  app.post('/api/assistant/chat', requireAuth, async (req, res) => {
    const resolved = resolveKey(req.user);
    if (!resolved) return res.status(402).json({ error: 'Add your Anthropic API key in Settings → Claude & MCP to use the assistant. Usage is billed to your own Anthropic account.', needs_key: true });
    if (req.authVia === 'api_key') return res.status(403).json({ error: 'The assistant is for interactive sessions' });
    const text = String(req.body?.message || '').trim().slice(0, 8000);
    const history = Array.isArray(req.body?.messages) ? req.body.messages.slice(-MAX_HISTORY) : [];
    if (!text) return res.status(400).json({ error: 'message is required' });

    // The assistant calls SignFlow's API as this user (cookie forwarded over loopback).
    const ctx = { headers: { cookie: req.headers.cookie || '' } };
    const messages = [...history, { role: 'user', content: text }];
    const actions = [];
    const anthropic = getClient(resolved.key);
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await anthropic.beta.messages.create({
          model: MODEL,
          max_tokens: 8000,
          system: systemPrompt(req.user),
          tools: anthropicTools(),
          messages,
          output_config: { effort: 'medium' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
        messages.push({ role: 'assistant', content: response.content });
        if (response.stop_reason === 'refusal') {
          return res.json({ reply: "I can't help with that request.", actions, messages, stop: 'refusal' });
        }
        if (response.stop_reason === 'pause_turn') continue;
        const toolUses = response.content.filter((b) => b.type === 'tool_use');
        if (response.stop_reason !== 'tool_use' || !toolUses.length) {
          const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
          return res.json({ reply, actions, messages, truncated: response.stop_reason === 'max_tokens' });
        }
        const results = [];
        for (const tu of toolUses) {
          try {
            const result = await runTool(ctx, tu.name, tu.input);
            actions.push({ tool: tu.name, input: tu.input, ok: true, summary: summarize(tu.name, tu.input, result) });
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 60_000) });
          } catch (e) {
            actions.push({ tool: tu.name, input: tu.input, ok: false, summary: e.message });
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${e.message}`, is_error: true });
          }
        }
        messages.push({ role: 'user', content: results });
      }
      res.json({ reply: 'I stopped after several steps. Tell me how you would like to continue.', actions, messages, truncated: true });
    } catch (err) {
      console.error('[assistant]', err);
      const status = err?.status === 429 ? 429 : 502;
      const who = resolved.source === 'workspace' ? 'The workspace Anthropic key' : resolved.source === 'user' ? 'Your Anthropic API key' : 'The Anthropic key';
      res.status(status).json({ error: err?.status === 401 ? `${who} was rejected by Anthropic. Update it in Settings → Claude & MCP.` : err?.status === 429 ? 'Anthropic rate limit or credit limit reached on this key. Try again in a moment.' : err?.status === 400 && /credit|billing/i.test(err.message || '') ? 'This Anthropic account has no credits. Add credits in console.anthropic.com.' : `Assistant error: ${err.message || 'unknown'}`, actions });
    }
  });
}

export const assistantInfo = () => ({ model: MODEL, mcp_url: `${appUrl()}/mcp`, platform_key_shared: !!platformKey() });
