// Who can see / change which envelopes inside a workspace.
import db, { getOrg, isOrgAdmin } from './db.js';

/** Admins see everything in the org; members see their own unless the org shares visibility. */
export function canSeeAll(user) {
  if (!user?.org_id) return false;
  if (isOrgAdmin(user)) return true;
  return getOrg(user.org_id)?.visibility === 'all';
}

/** SQL fragment restricting envelopes (aliased `e`) to what this user may see. */
export function envelopeScope(user) {
  return canSeeAll(user) ? { sql: 'e.org_id = ?', params: [user.org_id] } : { sql: 'e.user_id = ?', params: [user.id] };
}

export function findEnvelope(user, id) {
  const s = envelopeScope(user);
  return db.prepare(`SELECT e.* FROM envelopes e WHERE e.id = ? AND ${s.sql}`).get(id, ...s.params);
}

/** May this user change (send, void, delete, remind…) the envelope? Owner or org admin. */
export function canEdit(user, env) {
  return env.user_id === user.id || (env.org_id && env.org_id === user.org_id && isOrgAdmin(user));
}
