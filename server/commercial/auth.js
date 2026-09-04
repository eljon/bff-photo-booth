'use strict';

/**
 * Auth for the commercial layer: email+password today, social sign-in (Google / Apple /
 * Facebook) behind a provider registry that activates when its OAuth keys are set.
 *
 * Sessions are stateless, HMAC-signed cookies (userId + expiry) — no server-side session
 * table needed. Passwords are scrypt-hashed with a per-user salt.
 */

const crypto = require('node:crypto');

const COOKIE = 'saas_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── passwords ────────────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, keyHex] = stored.split('$');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ── signed session cookie ──────────────────────────────────────────────────────
function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeToken(userId, secret) {
  const payload = `${userId}.${Date.now() + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload, secret)}`;
}

function readToken(token, secret) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [userId, expiry, mac] = parts;
  const payload = `${userId}.${expiry}`;
  const good = sign(payload, secret);
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  if (Number(expiry) < Date.now()) return null;
  return userId;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const pair of header.split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, userId, secret, { secure = true } = {}) {
  const token = makeToken(userId, secret);
  const attrs = [`${COOKIE}=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}

function currentUserId(req, secret) {
  return readToken(parseCookies(req)[COOKIE], secret);
}

// ── social providers (activate when keys are present) ───────────────────────────
/** Which social logins are configured. The UI shows all four but marks the unconfigured
 *  ones as "coming soon" until their env keys are set. */
function socialProviders() {
  return {
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    apple: Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID),
    facebook: Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET),
  };
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  makeToken,
  readToken,
  setSessionCookie,
  clearSessionCookie,
  currentUserId,
  socialProviders,
};
