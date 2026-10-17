// Validation of field layouts coming from the browser.
export const FIELD_TYPES = new Set(['signature', 'initials', 'date', 'text', 'checkbox']);

/**
 * Normalize + validate fields. Throws Error(message) on bad input.
 *   signerCount       – how many signers/roles exist (signerIndex must be < this)
 *   requireSignature  – at least one signature field overall (default true)
 *   requirePerSigner  – every signer must own at least one field (default false)
 */
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
    return {
      type: f.type, page, x, y, w, h, signerIndex,
      label: String(f.label || '').slice(0, 80),
      required: f.required === false ? 0 : 1,
      value: f.type === 'text' && typeof f.prefill === 'string' ? f.prefill.slice(0, 500) : null,
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
