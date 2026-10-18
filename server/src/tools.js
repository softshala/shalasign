// The actions Claude can take in SignFlow — shared by the MCP server (Claude
// outside the app) and the in-app assistant. Every tool calls SignFlow's own
// REST API over loopback with the caller's credentials, so permissions,
// validation and audit trail are identical to clicking in the UI.
import { z } from 'zod';
import { appUrl } from './mailer.js';

const LOCAL = () => `http://127.0.0.1:${process.env.PORT || 4000}`;

/** ctx = { headers: { authorization | cookie } } taken from the calling request. */
async function api(ctx, path, { method = 'GET', body, formData } = {}) {
  const r = await fetch(`${LOCAL()}${path}`, {
    method,
    headers: { ...ctx.headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: formData ? formData : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
  if (!r.ok) throw new Error(data?.error || `SignFlow API ${method} ${path} failed (${r.status})`);
  return data;
}

const signerSchema = z.object({ name: z.string().describe('Full name'), email: z.string().describe('Email address') });
const fieldSchema = z.object({
  type: z.enum(['signature', 'initials', 'date', 'text', 'checkbox']),
  page: z.number().int().min(0).describe('0-based page index'),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1),
  signerIndex: z.number().int().min(0).describe('Index into the signers array'),
  label: z.string().optional(), required: z.boolean().optional(), merge_key: z.string().optional(),
});

const fmtEnvelope = (e) => ({
  id: e.id, title: e.title, status: e.status, created_at: e.created_at, sent_at: e.sent_at, completed_at: e.completed_at, expires_at: e.expires_at,
  signers: (e.signers || []).map((s) => ({ name: s.name, email: s.email, status: s.status, signed_at: s.signed_at, your_turn: s.your_turn, signing_url: s.status === 'pending' ? s.signing_url : undefined })),
  folder: e.folder_name || null, owner: e.owner?.name, seal_error: e.seal_error || undefined, archive_url: e.archive_url || undefined,
  open_in_app: `${appUrl()}/envelope/${e.id}`,
  download_url: e.status === 'completed' ? `${appUrl()}/api/envelopes/${e.id}/download` : undefined,
});

/** Default field layout when the caller gives none: a signature + date for each signer, stacked at the bottom of the last page. */
function autoFields(signerCount, pageCount) {
  const page = Math.max(0, (pageCount || 1) - 1);
  const out = [];
  for (let i = 0; i < signerCount; i++) {
    const y = 0.86 - i * 0.09;
    out.push({ type: 'signature', page, x: 0.08, y, w: 0.3, h: 0.06, signerIndex: i });
    out.push({ type: 'date', page, x: 0.42, y: y + 0.015, w: 0.16, h: 0.035, signerIndex: i });
  }
  return out;
}

export const TOOLS = [
  {
    name: 'list_documents',
    description: 'List envelopes (documents sent for signature) visible to the user, newest first. Filter by status or search by title, signer name or email.',
    schema: z.object({
      status: z.enum(['all', 'draft', 'sent', 'completed', 'voided', 'declined', 'expired']).optional().describe('Default all. "sent" = awaiting signature.'),
      query: z.string().optional().describe('Search text: title, signer name or email'),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async (ctx, a) => {
      const qs = new URLSearchParams({ status: a.status || 'all', q: a.query || '', limit: String(a.limit || 20) });
      const d = await api(ctx, `/api/envelopes?${qs}`);
      return { total: d.total, documents: d.items.map((e) => ({ id: e.id, title: e.title, status: e.status, signers: `${e.signers_signed}/${e.signers_total} signed`, waiting_on: e.waiting_on || undefined, signer_names: e.signer_names, sent_by: e.owner_name, created_at: e.created_at, expires_at: e.expires_at, open_in_app: `${appUrl()}/envelope/${e.id}` })) };
    },
  },
  {
    name: 'get_document',
    description: 'Full detail of one envelope: signers and their status, signing links for pending signers, deadline, fields, recent audit events, download link when completed.',
    schema: z.object({ id: z.string().describe('Envelope id') }),
    run: async (ctx, a) => {
      const e = await api(ctx, `/api/envelopes/${encodeURIComponent(a.id)}`);
      return { ...fmtEnvelope(e), message: e.message, cc: e.cc, merge: e.merge, fields: e.fields.map((f) => ({ type: f.type, page: f.page, label: f.label, merge_key: f.merge_key, value: f.value })), recent_events: e.events.slice(-12).map((ev) => `${ev.created_at} ${ev.type} ${ev.actor}${ev.detail ? ' — ' + ev.detail : ''}`) };
    },
  },
  {
    name: 'get_stats',
    description: 'Dashboard numbers: how many documents are awaiting signature, completed, drafts, expiring soon, average hours to complete.',
    schema: z.object({}),
    run: async (ctx) => api(ctx, '/api/envelopes/stats'),
  },
  {
    name: 'list_templates',
    description: 'List reusable templates with their signer roles, fields and merge keys. Use before send_from_template.',
    schema: z.object({}),
    run: async (ctx) => (await api(ctx, '/api/templates')).map((t) => ({ id: t.id, name: t.name, roles: t.roles.map((r) => r.name), merge_keys: [...new Set(t.fields.map((f) => f.merge_key).filter(Boolean))], fields: t.fields.length, used: t.use_count })),
  },
  {
    name: 'send_from_template',
    description: 'Send a template to signers. Provide one signer per template role, in role order. Provide merge values for any merge keys the template uses. Emails go out immediately.',
    schema: z.object({
      template_id: z.string(),
      signers: z.array(signerSchema).min(1).describe('One per role, in the role order from list_templates'),
      title: z.string().optional().describe('Document title; may contain {{MergeKey}}'),
      message: z.string().optional().describe('Note shown to signers in the email and on the signing page'),
      merge: z.record(z.string(), z.string()).optional().describe('Merge values, e.g. {"Company":"Acme"}'),
      expiry_days: z.number().int().min(0).max(365).optional(),
      reminder_days: z.number().int().min(0).max(30).optional(),
      sequential: z.boolean().optional().describe('Sign in order (default true)'),
      cc: z.array(z.string()).optional().describe('Emails that receive the completed copy'),
    }),
    run: async (ctx, a) => {
      const t = await api(ctx, `/api/templates/${encodeURIComponent(a.template_id)}`);
      if (a.signers.length !== t.roles.length) throw new Error(`Template "${t.name}" has ${t.roles.length} role(s) (${t.roles.map((r) => r.name).join(', ')}) but ${a.signers.length} signer(s) were given. Provide exactly one signer per role, in that order.`);
      const draft = await api(ctx, `/api/templates/${encodeURIComponent(a.template_id)}/use`, { method: 'POST', body: { title: a.title || t.name } });
      const signers = a.signers.map((s, i) => ({ ...s, attachments: t.roles[i]?.attachments || [] }));
      const sent = await api(ctx, `/api/envelopes/${draft.id}/send`, { method: 'POST', body: {
        signers, fields: t.fields, sequential: a.sequential ?? (t.options?.sequential !== false), title: a.title || t.name, message: a.message ?? t.options?.message ?? '',
        merge: a.merge || {}, expiry_days: a.expiry_days ?? t.options?.expiry_days, reminder_days: a.reminder_days ?? t.options?.reminder_days,
        cc: (a.cc || []).map((email) => ({ name: email.split('@')[0], email })), access_code: t.options?.access_code || null,
      } });
      return { id: draft.id, status: sent.status, emailed: sent.emailed, email_from: sent.email_account, signing_links: sent.links, open_in_app: `${appUrl()}/envelope/${draft.id}` };
    },
  },
  {
    name: 'create_document',
    description: 'Upload a PDF to create a draft envelope. Give either a public PDF URL or base64 PDF bytes. Returns the draft id and page count; then call send_document (or let the user finish it in the app).',
    schema: z.object({
      title: z.string(),
      pdf_url: z.string().optional().describe('Publicly reachable https URL of a PDF'),
      pdf_base64: z.string().optional().describe('Base64-encoded PDF bytes'),
    }),
    run: async (ctx, a) => {
      let bytes;
      if (a.pdf_base64) bytes = Buffer.from(a.pdf_base64, 'base64');
      else if (a.pdf_url) {
        if (!/^https?:\/\//i.test(a.pdf_url)) throw new Error('pdf_url must be http(s)');
        const host = new URL(a.pdf_url).hostname;
        if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || host.endsWith('.internal')) throw new Error('That URL is not allowed');
        const r = await fetch(a.pdf_url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`Could not download the PDF (${r.status})`);
        const ab = await r.arrayBuffer(); if (ab.byteLength > 25 * 1024 * 1024) throw new Error('PDF is larger than 25 MB');
        bytes = Buffer.from(ab);
      } else throw new Error('Provide pdf_url or pdf_base64');
      const fd = new FormData();
      fd.append('pdf', new Blob([bytes], { type: 'application/pdf' }), `${a.title.replace(/[^\w. -]/g, '_')}.pdf`);
      fd.append('title', a.title);
      const d = await api(ctx, '/api/envelopes', { method: 'POST', formData: fd });
      return { id: d.id, pages: d.pages, title: d.title, prepare_in_app: `${appUrl()}/prepare/${d.id}` };
    },
  },
  {
    name: 'send_document',
    description: 'Send a draft envelope to signers. If no fields are given, a signature and date field is placed for each signer at the bottom of the last page. Emails go out immediately.',
    schema: z.object({
      id: z.string().describe('Draft envelope id'),
      signers: z.array(signerSchema).min(1).max(10),
      fields: z.array(fieldSchema).optional().describe('Omit to auto-place signature + date per signer'),
      message: z.string().optional(), sequential: z.boolean().optional(),
      expiry_days: z.number().int().min(0).max(365).optional(), reminder_days: z.number().int().min(0).max(30).optional(),
      merge: z.record(z.string(), z.string()).optional(), cc: z.array(z.string()).optional(), access_code: z.string().optional(),
    }),
    run: async (ctx, a) => {
      const e = await api(ctx, `/api/envelopes/${encodeURIComponent(a.id)}`);
      if (e.status !== 'draft') throw new Error(`Envelope is already ${e.status}`);
      const fields = a.fields?.length ? a.fields : autoFields(a.signers.length, e.page_count);
      const sent = await api(ctx, `/api/envelopes/${e.id}/send`, { method: 'POST', body: { signers: a.signers, fields, message: a.message, sequential: a.sequential ?? true, expiry_days: a.expiry_days, reminder_days: a.reminder_days, merge: a.merge || {}, cc: (a.cc || []).map((email) => ({ name: email.split('@')[0], email })), access_code: a.access_code || null } });
      return { id: e.id, status: sent.status, emailed: sent.emailed, email_from: sent.email_account, auto_placed_fields: !a.fields?.length, signing_links: sent.links, open_in_app: `${appUrl()}/envelope/${e.id}` };
    },
  },
  {
    name: 'remind_signers',
    description: 'Send a reminder email now to every signer whose turn it is on an envelope awaiting signature.',
    schema: z.object({ id: z.string() }),
    run: async (ctx, a) => api(ctx, `/api/envelopes/${encodeURIComponent(a.id)}/remind`, { method: 'POST', body: {} }),
  },
  {
    name: 'void_document',
    description: 'Cancel an envelope that is awaiting signature. Irreversible: signers can no longer sign. Only call after the user has explicitly confirmed; pass confirm=true.',
    schema: z.object({ id: z.string(), reason: z.string().optional(), confirm: z.boolean().describe('Must be true; set only after the user confirmed') }),
    run: async (ctx, a) => { if (!a.confirm) throw new Error('Ask the user to confirm voiding this document first, then call again with confirm=true.'); return api(ctx, `/api/envelopes/${encodeURIComponent(a.id)}/void`, { method: 'POST', body: { reason: a.reason || 'Voided via assistant' } }); },
  },
  {
    name: 'change_signer_email',
    description: 'Correct a pending signer\'s name or email on a sent envelope. The old link stops working and a new one is emailed.',
    schema: z.object({ id: z.string(), current_email: z.string(), new_email: z.string().optional(), new_name: z.string().optional() }),
    run: async (ctx, a) => {
      const e = await api(ctx, `/api/envelopes/${encodeURIComponent(a.id)}`);
      const s = e.signers.find((x) => x.email.toLowerCase() === a.current_email.toLowerCase());
      if (!s) throw new Error(`No signer with email ${a.current_email} on this envelope`);
      return api(ctx, `/api/envelopes/${e.id}/signers/${s.id}`, { method: 'PATCH', body: { email: a.new_email || s.email, name: a.new_name || s.name } });
    },
  },
  {
    name: 'list_folders',
    description: 'List workspace folders used to organise documents.',
    schema: z.object({}),
    run: async (ctx) => api(ctx, '/api/folders'),
  },
  {
    name: 'move_to_folder',
    description: 'Move an envelope into a folder (or out of all folders with folder_id null). Creates the folder if a folder_name is given and does not exist.',
    schema: z.object({ id: z.string(), folder_id: z.string().nullable().optional(), folder_name: z.string().optional() }),
    run: async (ctx, a) => {
      let fid = a.folder_id ?? null;
      if (a.folder_name) { const folders = await api(ctx, '/api/folders'); fid = folders.find((f) => f.name.toLowerCase() === a.folder_name.toLowerCase())?.id || (await api(ctx, '/api/folders', { method: 'POST', body: { name: a.folder_name } })).id; }
      return api(ctx, `/api/envelopes/${encodeURIComponent(a.id)}/folder`, { method: 'POST', body: { folder_id: fid } });
    },
  },
  {
    name: 'get_my_setup',
    description: 'How the user\'s account is configured: which inbox sends their emails, where completed documents are archived, workspace name and role.',
    schema: z.object({}),
    run: async (ctx) => { const [c, me] = await Promise.all([api(ctx, '/api/connections'), api(ctx, '/api/auth/me')]); return { user: { name: me.name, email: me.email, role: me.role, workspace: me.org?.name }, sends_email_via: c.effective.mail, archives_to: c.effective.storage, settings_url: `${appUrl()}/settings?tab=connections` }; },
  },
];

/** Anthropic Messages API tool definitions (JSON Schema). */
export const anthropicTools = () => TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: z.toJSONSchema(t.schema) }));

/** Run one tool by name. Validates input with zod; returns JSON-serialisable result. Throws Error with a user-readable message. */
export async function runTool(ctx, name, input) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown tool ${name}`);
  const parsed = t.schema.safeParse(input ?? {});
  if (!parsed.success) throw new Error(`Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
  return t.run(ctx, parsed.data);
}
