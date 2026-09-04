'use strict';

/**
 * The commercial (multi-tenant) web app: landing → sign up/in → dashboard → buy a
 * session (Stripe or dev-simulated) → open the host for a session.
 *
 * Self-contained and additive: it does not touch the single-tenant booth/relay. Run it
 * with `npm run saas`. Social sign-in and live Stripe activate when their keys are set;
 * until then email+password and a dev "simulate purchase" keep the whole flow demoable.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { Store } = require('./store');
const auth = require('./auth');
const payments = require('./payments');
const { BoothManager } = require('./booths');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 256 * 1024) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); resolve({ raw, json: raw ? safeParse(raw) : {} }); });
    req.on('error', reject);
  });
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').includes('https') || Boolean(req.socket.encrypted);
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));

function publicUser(u) {
  return u && { id: u.id, email: u.email, name: u.name, provider: u.provider };
}
function publicSession(s) {
  return {
    id: s.id, name: s.name, status: s.status,
    printQuota: s.printQuota, printsUsed: s.printsUsed, createdAt: s.createdAt,
    canOpen: s.status === 'active', // its own booth is spawned on demand via /open
  };
}

function createApp(store = new Store(), booths = new BoothManager()) {
  const secret = store.secret;

  async function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/landing.html' : pathname;
    if (rel === '/dashboard') rel = '/dashboard.html';
    const file = path.resolve(PUBLIC_DIR, rel.slice(1));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error('nf');
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  }

  async function handleApi(req, res, url) {
    const uid = auth.currentUserId(req, secret);
    const me = uid ? store.userById(uid) : null;
    const requireAuth = () => { if (!me) { sendJson(res, 401, { ok: false, error: 'Please sign in.' }); return false; } return true; };

    // ── auth ───────────────────────────────────────────────────────────────
    if (url.pathname === '/api/me' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, user: publicUser(me), providers: auth.socialProviders() });
    }

    if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
      const { json } = await readJson(req);
      const email = String(json.email || '').trim().toLowerCase();
      if (!validEmail(email)) return sendJson(res, 400, { ok: false, error: 'Enter a valid email.' });
      if (String(json.password || '').length < 8) return sendJson(res, 400, { ok: false, error: 'Password must be at least 8 characters.' });
      if (store.userByEmail(email)) return sendJson(res, 409, { ok: false, error: 'An account with that email already exists. Try signing in.' });
      const user = store.createUser({ email, name: String(json.name || '').slice(0, 80), passHash: auth.hashPassword(json.password) });
      auth.setSessionCookie(res, user.id, secret, { secure: isHttps(req) });
      return sendJson(res, 200, { ok: true, user: publicUser(user) });
    }

    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const { json } = await readJson(req);
      const user = store.userByEmail(json.email);
      if (!user || !auth.verifyPassword(json.password, user.passHash)) {
        return sendJson(res, 401, { ok: false, error: 'Wrong email or password.' });
      }
      auth.setSessionCookie(res, user.id, secret, { secure: isHttps(req) });
      return sendJson(res, 200, { ok: true, user: publicUser(user) });
    }

    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      auth.clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    // Social sign-in — activates when the provider's keys are set. Until then, tell the UI.
    if (url.pathname.startsWith('/api/auth/oauth/') && req.method === 'GET') {
      const provider = url.pathname.split('/').pop();
      const configured = auth.socialProviders()[provider];
      if (!configured) return sendJson(res, 501, { ok: false, error: `${provider} sign-in isn't configured yet.` });
      // Real OAuth redirect wiring lands with the provider keys (next increment).
      return sendJson(res, 501, { ok: false, error: `${provider} sign-in is configured but the redirect flow is not wired yet.` });
    }

    // ── sessions ─────────────────────────────────────────────────────────────
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      if (!requireAuth()) return undefined;
      return sendJson(res, 200, { ok: true, sessions: store.sessionsForUser(me.id).map(publicSession) });
    }

    // Open (spawn if needed) this session's own isolated booth, and return its host + guest
    // URLs. The host link carries the session's token so the owner's host screen unlocks.
    const openMatch = /^\/api\/sessions\/([\w-]+)\/open$/.exec(url.pathname);
    if (openMatch && req.method === 'POST') {
      if (!requireAuth()) return undefined;
      const session = store.sessionById(openMatch[1]);
      if (!session || session.userId !== me.id) return sendJson(res, 404, { ok: false, error: 'Session not found.' });
      if (session.status !== 'active') return sendJson(res, 402, { ok: false, error: 'This session is not active yet.' });
      try {
        const info = await booths.ensure(session);
        return sendJson(res, 200, {
          ok: true,
          hostUrl: `${info.url}/host?token=${encodeURIComponent(session.boothToken)}`,
          guestUrl: `${info.url}/?k=${encodeURIComponent(session.boothToken.slice(0, 12))}`,
        });
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: `Could not start the booth: ${err.message}` });
      }
    }

    // Buy a session. Live Stripe → returns a checkout URL to redirect to. Dev → creates the
    // session immediately and returns it (so the flow works with no Stripe account).
    if (url.pathname === '/api/sessions/buy' && req.method === 'POST') {
      if (!requireAuth()) return undefined;
      const { json } = await readJson(req);
      const name = String(json.name || 'New event').slice(0, 80);

      if (payments.isLive()) {
        const session = store.createSession({ userId: me.id, name, status: 'pending_payment' });
        const base = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
        try {
          const { url: checkoutUrl, checkoutId } = await payments.createCheckout({
            sessionId: session.id,
            userEmail: me.email,
            successUrl: `${base}/dashboard?paid=${session.id}`,
            cancelUrl: `${base}/dashboard?cancelled=${session.id}`,
          });
          store.updateSession(session.id, { checkoutId });
          return sendJson(res, 200, { ok: true, checkoutUrl });
        } catch (err) {
          store.updateSession(session.id, { status: 'cancelled' });
          return sendJson(res, 502, { ok: false, error: `Payment could not start: ${err.message}` });
        }
      }

      // Dev mode: grant immediately.
      const session = store.createSession({ userId: me.id, name, status: 'active' });
      store.createEntitlement({ userId: me.id, sessionId: session.id, amountCents: payments.PRICE_CENTS, status: 'dev' });
      return sendJson(res, 200, { ok: true, session: publicSession(session), dev: true });
    }

    // Stripe webhook — the source of truth for a real payment. Activates the pending session.
    if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') {
      const { raw } = await readJson(req);
      if (!payments.verifyWebhook(raw, req.headers['stripe-signature'])) {
        return sendJson(res, 400, { ok: false, error: 'Bad signature.' });
      }
      const event = safeParse(raw);
      if (event.type === 'checkout.session.completed') {
        const cs = event.data.object;
        const sessionId = (cs.metadata && cs.metadata.sessionId) || cs.client_reference_id;
        const session = sessionId && store.sessionById(sessionId);
        if (session && session.status !== 'active' && !store.entitlementByCheckout(cs.id)) {
          store.updateSession(session.id, { status: 'active' });
          store.createEntitlement({
            userId: session.userId, sessionId: session.id,
            amountCents: cs.amount_total || payments.PRICE_CENTS, currency: cs.currency || payments.CURRENCY,
            status: 'paid', stripeCheckoutId: cs.id,
          });
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: 'No such endpoint.' });
  }

  const app = async function app(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url.pathname);
      else res.writeHead(405).end('Method not allowed');
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status || 500, { ok: false, error: err.message || 'Server error' });
      else res.end();
    }
  };
  app.booths = booths; // exposed for lifecycle management / tests
  app.store = store;
  return app;
}

module.exports = { createApp, Store };
