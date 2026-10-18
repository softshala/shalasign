// Minimal OAuth 2.1 authorization server so claude.ai (and any MCP client)
// can connect with "Sign in with ShalaSign": discovery metadata, dynamic
// client registration, PKCE authorization code with a consent screen, and
// refreshable bearer tokens that map to a ShalaSign user.
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import db from './db.js';
import { currentUser, requireAuth } from './auth.js';
import { appUrl } from './mailer.js';
import { nowSql } from './util.js';

const ACCESS_TTL_S = 60 * 60;            // 1 hour
const REFRESH_TTL_S = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_S = 10 * 60;
const SCOPES = ['shalasign'];
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64url = (b) => Buffer.from(b).toString('base64url');
const validRedirect = (u) => { try { const x = new URL(u); return (x.protocol === 'https:' || x.hostname === 'localhost' || x.hostname === '127.0.0.1' || x.protocol.endsWith(':') && !/^https?:$/.test(x.protocol)) && !x.hash; } catch { return false; } };

export function registerOAuthRoutes(app) {
  // ---- discovery ----
  const resourceMeta = (_req, res) => res.json({ resource: `${appUrl()}/mcp`, authorization_servers: [appUrl()], bearer_methods_supported: ['header'], scopes_supported: SCOPES, resource_name: 'ShalaSign' });
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({
    issuer: appUrl(),
    authorization_endpoint: `${appUrl()}/oauth/authorize`,
    token_endpoint: `${appUrl()}/oauth/token`,
    registration_endpoint: `${appUrl()}/oauth/register`,
    revocation_endpoint: `${appUrl()}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: SCOPES,
  }));

  // ---- dynamic client registration (RFC 7591) ----
  app.post('/oauth/register', (req, res) => {
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u) => typeof u === 'string' && validRedirect(u)).slice(0, 10) : [];
    if (!uris.length) return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must contain https (or localhost) URLs' });
    const id = `sfc_${nanoid(16)}`;
    const confidential = b.token_endpoint_auth_method === 'client_secret_post';
    const secret = confidential ? `sfcs_${nanoid(32)}` : null;
    db.prepare(`INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, logo_uri, client_uri) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, secret ? sha(secret) : null, String(b.client_name || 'MCP client').slice(0, 80), JSON.stringify(uris), String(b.logo_uri || '').slice(0, 300), String(b.client_uri || '').slice(0, 300));
    res.status(201).json({ client_id: id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000), client_name: b.client_name || 'MCP client', redirect_uris: uris, token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPES.join(' ') });
  });

  // ---- authorization: validate, then hand off to the React consent page ----
  app.get('/oauth/authorize', (req, res) => {
    const q = req.query;
    const client = db.prepare(`SELECT * FROM oauth_clients WHERE id = ?`).get(String(q.client_id || ''));
    const redirectUri = String(q.redirect_uri || '');
    if (!client) return res.status(400).send('Unknown client_id');
    if (!JSON.parse(client.redirect_uris).includes(redirectUri)) return res.status(400).send('redirect_uri is not registered for this client');
    const back = (params) => res.redirect(`${redirectUri}${redirectUri.includes('?') ? '&' : '?'}${new URLSearchParams({ ...(q.state ? { state: String(q.state) } : {}), ...params })}`);
    if (q.response_type !== 'code') return back({ error: 'unsupported_response_type' });
    if (!q.code_challenge || (q.code_challenge_method || 'plain') !== 'S256') return back({ error: 'invalid_request', error_description: 'PKCE S256 code_challenge is required' });
    const consentUrl = `/oauth/consent?${new URLSearchParams({ client_id: client.id, redirect_uri: redirectUri, state: String(q.state || ''), code_challenge: String(q.code_challenge), scope: String(q.scope || 'shalasign'), resource: String(q.resource || '') })}`;
    if (!currentUser(req)) return res.redirect(`/login?next=${encodeURIComponent(consentUrl)}`);
    res.redirect(consentUrl);
  });

  // What the consent page shows.
  app.get('/api/oauth/consent', requireAuth, (req, res) => {
    const client = db.prepare(`SELECT id, name, logo_uri, client_uri, redirect_uris FROM oauth_clients WHERE id = ?`).get(String(req.query.client_id || ''));
    if (!client) return res.status(404).json({ error: 'Unknown client' });
    res.json({ client: { id: client.id, name: client.name, logo_uri: client.logo_uri, client_uri: client.client_uri, redirect_host: (() => { try { return new URL(String(req.query.redirect_uri || JSON.parse(client.redirect_uris)[0])).host; } catch { return ''; } })() }, user: { name: req.user.name, email: req.user.email }, scopes: SCOPES });
  });

  // Approve → authorization code → redirect URL for the browser to follow.
  app.post('/api/oauth/approve', requireAuth, (req, res) => {
    const b = req.body || {};
    const client = db.prepare(`SELECT * FROM oauth_clients WHERE id = ?`).get(String(b.client_id || ''));
    if (!client || !JSON.parse(client.redirect_uris).includes(String(b.redirect_uri || ''))) return res.status(400).json({ error: 'Invalid client or redirect_uri' });
    const url = new URL(b.redirect_uri);
    if (b.state) url.searchParams.set('state', String(b.state));
    if (!b.approve) { url.searchParams.set('error', 'access_denied'); return res.json({ redirect: url.toString() }); }
    if (!b.code_challenge) return res.status(400).json({ error: 'code_challenge missing' });
    const code = `sfac_${nanoid(40)}`;
    db.prepare(`INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sha(code), client.id, req.user.id, String(b.redirect_uri), String(b.code_challenge), String(b.scope || 'shalasign'), String(b.resource || ''), nowSql(new Date(Date.now() + CODE_TTL_S * 1000)));
    url.searchParams.set('code', code);
    res.json({ redirect: url.toString() });
  });

  // ---- token endpoint ----
  app.post('/oauth/token', (req, res) => {
    const b = { ...(req.body || {}) };
    const fail = (error, desc, status = 400) => res.status(status).json({ error, error_description: desc });
    const client = db.prepare(`SELECT * FROM oauth_clients WHERE id = ?`).get(String(b.client_id || ''));
    if (!client) return fail('invalid_client', 'Unknown client_id', 401);
    if (client.secret_hash && sha(b.client_secret || '') !== client.secret_hash) return fail('invalid_client', 'Bad client secret', 401);

    if (b.grant_type === 'authorization_code') {
      const row = db.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`).get(sha(b.code || ''));
      if (!row || row.used || row.client_id !== client.id) return fail('invalid_grant', 'Code is invalid or already used');
      if (row.expires_at < nowSql()) return fail('invalid_grant', 'Code expired');
      if (row.redirect_uri !== String(b.redirect_uri || row.redirect_uri)) return fail('invalid_grant', 'redirect_uri mismatch');
      const expected = b64url(crypto.createHash('sha256').update(String(b.code_verifier || '')).digest());
      if (expected !== row.code_challenge) return fail('invalid_grant', 'PKCE verification failed');
      db.prepare(`UPDATE oauth_codes SET used = 1 WHERE code_hash = ?`).run(row.code_hash);
      return res.json(issueTokens(client.id, row.user_id, row.scope));
    }
    if (b.grant_type === 'refresh_token') {
      const row = db.prepare(`SELECT * FROM oauth_tokens WHERE refresh_hash = ? AND client_id = ?`).get(sha(b.refresh_token || ''), client.id);
      if (!row || row.revoked) return fail('invalid_grant', 'Refresh token is invalid');
      if (row.refresh_expires_at < nowSql()) return fail('invalid_grant', 'Refresh token expired');
      db.prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE id = ?`).run(row.id); // rotation
      return res.json(issueTokens(client.id, row.user_id, row.scope));
    }
    fail('unsupported_grant_type', 'Use authorization_code or refresh_token');
  });

  app.post('/oauth/revoke', (req, res) => {
    const t = String(req.body?.token || '');
    db.prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE access_hash = ? OR refresh_hash = ?`).run(sha(t), sha(t));
    res.json({ ok: true });
  });

  // Users can see and revoke connected apps in Settings.
  app.get('/api/oauth/grants', requireAuth, (req, res) => {
    const rows = db.prepare(`SELECT t.client_id, c.name, MAX(t.created_at) AS last_issued, MAX(t.last_used_at) AS last_used, COUNT(*) AS tokens FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id WHERE t.user_id = ? AND t.revoked = 0 AND t.refresh_expires_at > datetime('now') GROUP BY t.client_id`).all(req.user.id);
    res.json(rows);
  });
  app.delete('/api/oauth/grants/:clientId', requireAuth, (req, res) => {
    db.prepare(`UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ?`).run(req.user.id, req.params.clientId);
    res.json({ ok: true });
  });
}

function issueTokens(clientId, userId, scope) {
  const access = `sf_at_${nanoid(40)}`;
  const refresh = `sf_rt_${nanoid(40)}`;
  db.prepare(`INSERT INTO oauth_tokens (id, client_id, user_id, scope, access_hash, access_expires_at, refresh_hash, refresh_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nanoid(12), clientId, userId, scope, sha(access), nowSql(new Date(Date.now() + ACCESS_TTL_S * 1000)), sha(refresh), nowSql(new Date(Date.now() + REFRESH_TTL_S * 1000)));
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
}

/** Resolve an OAuth access token to a user row (used by auth.currentUser). */
export function userForAccessToken(token) {
  const row = db.prepare(`SELECT u.*, t.id AS token_id FROM oauth_tokens t JOIN users u ON u.id = t.user_id WHERE t.access_hash = ? AND t.revoked = 0 AND t.access_expires_at > datetime('now')`).get(sha(token));
  if (row) db.prepare(`UPDATE oauth_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.token_id);
  return row || null;
}
