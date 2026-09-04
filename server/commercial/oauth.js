'use strict';

/**
 * Social sign-in (Google, Facebook, Apple) — standard OAuth2 authorization-code flow, no
 * SDK dependency. Each provider activates when its keys are in the environment; until then
 * the buttons show "soon". Google and Facebook use the classic code→token→profile flow;
 * Apple additionally needs an ES256-signed client secret and posts its callback (form_post).
 *
 * Env:
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   FACEBOOK_APP_ID / FACEBOOK_APP_SECRET
 *   APPLE_CLIENT_ID / APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY (.p8 contents)
 */

const crypto = require('node:crypto');

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
  facebook: {
    authUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
    scope: 'email public_profile',
  },
  apple: {
    authUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    scope: 'name email',
    formPost: true,
  },
};

const b64urlJson = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function decodeJwtPayload(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

function clientId(provider) {
  return { google: process.env.GOOGLE_CLIENT_ID, facebook: process.env.FACEBOOK_APP_ID, apple: process.env.APPLE_CLIENT_ID }[provider];
}

function configured(provider) {
  if (provider === 'google') return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  if (provider === 'facebook') return Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);
  if (provider === 'apple') return Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);
  return false;
}

function statusMap() {
  return { google: configured('google'), facebook: configured('facebook'), apple: configured('apple') };
}

/** Apple's client secret is an ES256 JWT signed with the team's .p8 key. */
function appleClientSecret() {
  const header = { alg: 'ES256', kid: process.env.APPLE_KEY_ID };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: process.env.APPLE_TEAM_ID,
    iat: now,
    exp: now + 3600,
    aud: 'https://appleid.apple.com',
    sub: process.env.APPLE_CLIENT_ID,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = String(process.env.APPLE_PRIVATE_KEY).replace(/\\n/g, '\n');
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${sig.toString('base64url')}`;
}

function clientSecret(provider) {
  if (provider === 'google') return process.env.GOOGLE_CLIENT_SECRET;
  if (provider === 'facebook') return process.env.FACEBOOK_APP_SECRET;
  if (provider === 'apple') return appleClientSecret();
  return '';
}

function buildAuthUrl(provider, redirectUri, state) {
  const p = PROVIDERS[provider];
  const u = new URL(p.authUrl);
  u.searchParams.set('client_id', clientId(provider));
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', p.scope);
  u.searchParams.set('state', state);
  if (provider === 'google') u.searchParams.set('prompt', 'select_account');
  if (p.formPost) u.searchParams.set('response_mode', 'form_post');
  return u.toString();
}

async function exchangeCode(provider, code, redirectUri) {
  const p = PROVIDERS[provider];
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId(provider),
    client_secret: clientSecret(provider),
  });
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || `token exchange failed (${res.status})`);
  return data;
}

/** Returns { subject, email, name } from the provider's tokens. */
async function fetchProfile(provider, tokens) {
  if (provider === 'google' || provider === 'apple') {
    const claims = decodeJwtPayload(tokens.id_token);
    return { subject: claims.sub, email: claims.email || null, name: claims.name || '' };
  }
  if (provider === 'facebook') {
    const res = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(tokens.access_token)}`);
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'profile fetch failed');
    return { subject: data.id, email: data.email || null, name: data.name || '' };
  }
  throw new Error('unknown provider');
}

module.exports = { PROVIDERS, configured, statusMap, buildAuthUrl, exchangeCode, fetchProfile };
