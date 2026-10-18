// "Sign in with Google" and "Sign in with Microsoft" via OpenID Connect
// (authorization-code flow with PKCE). No extra dependencies: Node 22 has
// global fetch and crypto.
//
// Configure with env vars (see .env.example):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT  (tenant id, "organizations" or "common")
//
// Redirect URIs to register with each provider:
//   {APP_URL}/api/auth/sso/google/callback
//   {APP_URL}/api/auth/sso/microsoft/callback
//
// Security model: we never trust the ID token's signature ourselves; instead we
// obtain the tokens directly from the provider's token endpoint over TLS (with
// our client secret) and read identity from the provider's userinfo endpoint.
// A `state` value bound to a short-lived httpOnly cookie blocks login-CSRF.
import crypto from 'crypto';
import { appUrl } from './mailer.js';
import { startSession, findOrCreateUser } from './auth.js';
import { googleConfig, microsoftConfig } from './platform.js';

const OAUTH_COOKIE = 'sf_oauth';
const LOGIN = (process.env.MS_LOGIN_BASE_URL || 'https://login.microsoftonline.com').replace(/\/$/, '');

// Built per request so operator changes in the console apply immediately.
function provider(name) {
  if (name === 'google') { const c = googleConfig(); return c && { label: 'Google', clientId: c.clientId, clientSecret: c.clientSecret, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', userinfoUrl: process.env.GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo' }; }
  if (name === 'microsoft') { const c = microsoftConfig(); return c && { label: 'Microsoft', clientId: c.clientId, clientSecret: c.clientSecret, authUrl: `${LOGIN}/${c.tenant}/oauth2/v2.0/authorize`, tokenUrl: `${LOGIN}/${c.tenant}/oauth2/v2.0/token`, userinfoUrl: (process.env.GRAPH_BASE_URL ? process.env.GRAPH_BASE_URL.replace(/\/v1\.0$/, '') : 'https://graph.microsoft.com') + '/oidc/userinfo' }; }
  return null;
}
export const ssoEnabled = (name) => !!provider(name);

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const redirectUri = (name) => `${appUrl()}/api/auth/sso/${name}/callback`;
const cookieOpts = (req) => ({ httpOnly: true, sameSite: 'lax', secure: !!process.env.COOKIE_SECURE || !!req?.secure, maxAge: 10 * 60 * 1000, path: '/api/auth/sso' });

function decodeJwtPayload(jwt) {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

export function registerSsoRoutes(app) {
  // Step 1: send the browser to the provider.
  app.get('/api/auth/sso/:provider', (req, res) => {
    const name = req.params.provider;
    const p = provider(name);
    if (!p) return res.status(404).json({ error: `${name} sign-in is not configured on this server` });

    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

    res.cookie(OAUTH_COOKIE, b64url(JSON.stringify({ state, verifier, provider: name })), cookieOpts(req));

    const params = new URLSearchParams({
      client_id: p.clientId,
      redirect_uri: redirectUri(name),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    res.redirect(`${p.authUrl}?${params}`);
  });

  // Step 2: the provider sends the browser back here with ?code&state.
  app.get('/api/auth/sso/:provider/callback', async (req, res) => {
    const name = req.params.provider;
    const p = provider(name);
    const fail = (msg) => {
      res.clearCookie(OAUTH_COOKIE, { path: '/api/auth/sso' });
      res.redirect(`${appUrl()}/login?error=${encodeURIComponent(msg)}`);
    };
    if (!p) return fail(`${name} sign-in is not configured`);

    let saved = null;
    try { saved = JSON.parse(Buffer.from(req.cookies?.[OAUTH_COOKIE] || '', 'base64url').toString('utf8')); } catch { /* missing */ }
    if (!saved || saved.provider !== name || !req.query.state || saved.state !== req.query.state) {
      return fail('Sign-in session expired or was tampered with. Please try again.');
    }
    if (req.query.error) return fail(String(req.query.error_description || req.query.error));
    if (!req.query.code) return fail('The provider did not return an authorization code.');

    try {
      // Exchange the code for tokens (confidential client + PKCE).
      const tokenRes = await fetch(p.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(req.query.code),
          redirect_uri: redirectUri(name),
          client_id: p.clientId,
          client_secret: p.clientSecret,
          code_verifier: saved.verifier,
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.access_token) {
        console.error(`[sso:${name}] token exchange failed:`, tokens);
        return fail(`${p.label} rejected the sign-in (${tokens.error || tokenRes.status}). Check the redirect URI and client secret.`);
      }

      // Identity: userinfo endpoint first, ID-token claims as fallback.
      const infoRes = await fetch(p.userinfoUrl, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const info = infoRes.ok ? await infoRes.json() : {};
      const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : {};

      const email = (info.email || claims.email || claims.preferred_username || '').toLowerCase().trim();
      if (!email || !email.includes('@')) return fail(`${p.label} did not share an email address for this account.`);
      if (name === 'google' && info.email_verified === false) return fail('This Google account\'s email is not verified.');

      const fullName = info.name || claims.name
        || [info.given_name || claims.given_name, info.family_name || claims.family_name].filter(Boolean).join(' ')
        || email.split('@')[0];

      const user = findOrCreateUser(email, fullName);
      res.clearCookie(OAUTH_COOKIE, { path: '/api/auth/sso' });
      startSession(res, user.id);
      res.redirect(`${appUrl()}/`);
    } catch (err) {
      console.error(`[sso:${name}] error:`, err);
      fail(err.status === 403 ? err.message : `${p.label} sign-in failed. Please try again.`);
    }
  });
}
