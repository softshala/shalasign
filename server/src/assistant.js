// In-app assistant: Claude with the SignFlow tools, acting as the logged-in user.
// POST /api/assistant/chat { messages: [...prior turns], message: "text" }
//   → { reply, actions: [{tool, input, ok, summary}], messages: full history to send back next time }
import Anthropic from '@anthropic-ai/sdk';
import db, { getOrg } from './db.js';
import { requireAuth } from './auth.js';
import { anthropicTools, runTool } from './tools.js';
import { appUrl } from './mailer.js';

const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5-5';
export const assistantEnabled = () => !!process.env.ANTHROPIC_API_KEY;
let client = null;
const getClient = () => (client ||= new Anthropic());

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
  app.get('/api/assistant/status', requireAuth, (_req, res) => res.json({ enabled: assistantEnabled(), model: assistantEnabled() ? MODEL : null, tools: anthropicTools().map((t) => t.name) }));

  app.post('/api/assistant/chat', requireAuth, async (req, res) => {
    if (!assistantEnabled()) return res.status(503).json({ error: 'The assistant is not enabled on this server (ANTHROPIC_API_KEY is not set).' });
    if (req.authVia === 'api_key') return res.status(403).json({ error: 'The assistant is for interactive sessions' });
    const text = String(req.body?.message || '').trim().slice(0, 8000);
    const history = Array.isArray(req.body?.messages) ? req.body.messages.slice(-MAX_HISTORY) : [];
    if (!text) return res.status(400).json({ error: 'message is required' });

    // The assistant calls SignFlow's API as this user (cookie forwarded over loopback).
    const ctx = { headers: { cookie: req.headers.cookie || '' } };
    const messages = [...history, { role: 'user', content: text }];
    const actions = [];
    const anthropic = getClient();
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
      res.status(status).json({ error: err?.status === 401 ? 'The server\'s Anthropic API key was rejected.' : err?.status === 429 ? 'The assistant is busy right now. Try again in a moment.' : `Assistant error: ${err.message || 'unknown'}`, actions });
    }
  });
}

export const assistantInfo = () => ({ enabled: assistantEnabled(), model: MODEL, mcp_url: `${appUrl()}/mcp` });
export const _db = db;
