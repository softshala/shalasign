// Validation of field layouts coming from the browser.
export const FIELD_TYPES = new Set(['signature', 'initials', 'date', 'text', 'checkbox']);

/**
 * Normalize + validate fields. Throws Error(message) on bad input.
 *   signerCount       – how many signers/roles exist (signerIndex must be < this)
 *   requireSignature  – at least one signature field overall (default true)
 *   requirePerSigner  – every signer must own at least one field (default false)
 */
/** Column/merge key: trimmed, max 60 chars, no braces. Matching is case-insensitive. */
export const normalizeKey = (k) => String(k || '').replace(/[{}]/g, '').trim().slice(0, 60);
const keyEq = (a, b) => normalizeKey(a).toLowerCase() === normalizeKey(b).toLowerCase();

/** All merge keys referenced by fields (unique, in order). */
export const mergeKeysOf = (fields) => [...new Set(fields.map((f) => f.merge_key).filter(Boolean))];

/** Replace {{Key}} inside a free-text string (title/message) with data values; unknown keys are left as-is. */
export function mergeText(text, data) {
  return String(text || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => {
    const hit = Object.keys(data || {}).find((c) => keyEq(c, k));
    return hit !== undefined && data[hit] !== undefined && data[hit] !== null ? String(data[hit]) : m;
  });
}

/**
 * Fill merge-bound fields from a data row. Returns { fields, missing } where `missing`
 * lists keys that are required (field.required) but have no non-empty value.
 */
export function applyMerge(fields, data) {
  const missing = [];
  const out = fields.map((f) => {
    if (!f.merge_key) return f;
    const col = Object.keys(data || {}).find((c) => keyEq(c, f.merge_key));
    const raw = col !== undefined ? data[col] : undefined;
    const val = raw === undefined || raw === null ? '' : String(raw).trim().slice(0, 500);
    if (!val && f.required && !missing.includes(f.merge_key)) missing.push(f.merge_key);
    return { ...f, value: val || f.value || null };
  });
  return { fields: out, missing };
}

export function normalizeFields(fields, signerCount, { requireSignature = true, requirePerSigner = false } = {}) {
  if (!Array.isArray(fields)) throw new Error('fields must be an array');
  if (fields.length > 500) throw new Error('Too many fields (max 500)');
  const out = fields.map((f, i) => {
    if (!f || !FIELD_TYPES.has(f.type)) throw new Error(`Field ${i + 1}: unknown type`);
    const num = (v, name) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`Field ${i + 1}: ${name} must be a number`);
      return n;
    };
    const page = Math.max(0, Math.floor(num(f.page ?? 0, 'page')));
    let x = num(f.x, 'x'), y = num(f.y, 'y'), w = num(f.w, 'w'), h = num(f.h, 'h');
    if (w <= 0 || h <= 0 || w > 1 || h > 1) throw new Error(`Field ${i + 1}: invalid size`);
    x = Math.min(1 - w, Math.max(0, x));
    y = Math.min(1 - h, Math.max(0, y));
    const signerIndex = Math.floor(num(f.signerIndex ?? 0, 'signerIndex'));
    if (signerIndex < 0 || signerIndex >= signerCount) throw new Error(`Field ${i + 1} is assigned to a signer that no longer exists`);
    const mergeKey = f.merge_key ? normalizeKey(f.merge_key) : null;
    if (mergeKey && f.type !== 'text') throw new Error(`Field ${i + 1}: only text fields can be filled from data`);
    return {
      type: f.type, page, x, y, w, h, signerIndex,
      label: String(f.label || (mergeKey ? mergeKey : '')).slice(0, 80),
      required: f.required === false ? 0 : 1,
      value: f.type === 'text' && typeof f.prefill === 'string' && f.prefill !== '' ? f.prefill.slice(0, 500) : null,
      merge_key: mergeKey,
      cover: f.cover ? 1 : 0,
    };
  });
  if (requireSignature && !out.some((f) => f.type === 'signature')) throw new Error('Place at least one signature field');
  if (requirePerSigner) {
    for (let s = 0; s < signerCount; s++) {
      if (!out.some((f) => f.signerIndex === s && (f.type === 'signature' || f.type === 'initials'))) {
        throw new Error(`Signer ${s + 1} has no signature or initials field. Every signer needs somewhere to sign.`);
      }
    }
  }
  return out;
}
