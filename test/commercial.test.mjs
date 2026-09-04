import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makePng } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createApp, Store } = require('../server/commercial/app.js');
const { BoothManager } = require('../server/commercial/booths.js');
const auth = require('../server/commercial/auth.js');
const oauth = require('../server/commercial/oauth.js');

// A raw GET that does NOT follow redirects, so we can read Location + Set-Cookie.
function rawGet(base, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}
const fakeJwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

async function startSaas() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-'));
  const booths = new BoothManager({ dir, idleMs: 60 * 60 * 1000 });
  const server = http.createServer(createApp(new Store(dir), booths));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: async () => { booths.closeAll(); await new Promise((r) => server.close(r)); },
  };
}

const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const j = async (res) => ({ status: res.status, data: await res.json().catch(() => ({})) });
function post(base, path, body, cookie) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body || {}),
  });
}

test('auth: password hashing round-trips and rejects wrong passwords', () => {
  const h = auth.hashPassword('correct horse battery');
  assert.ok(auth.verifyPassword('correct horse battery', h));
  assert.ok(!auth.verifyPassword('wrong', h));
});

test('auth: a signed session token round-trips and a tampered one fails', () => {
  const secret = 'test-secret';
  const tok = auth.makeToken('usr_1', secret);
  assert.equal(auth.readToken(tok, secret), 'usr_1');
  assert.equal(auth.readToken(`${tok}x`, secret), null);
  assert.equal(auth.readToken(tok, 'other-secret'), null);
});

test('signup, session cookie, and /api/me', async (t) => {
  const s = await startSaas();
  t.after(() => s.close());

  const res = await post(s.base, '/api/auth/signup', { email: 'a@b.com', name: 'Ana', password: 'password123' });
  const { status, data } = await j(res);
  assert.equal(status, 200);
  assert.equal(data.user.email, 'a@b.com');
  const cookie = cookieFrom(res);
  assert.match(cookie, /^saas_sid=/);

  const me = await j(await fetch(`${s.base}/api/me`, { headers: { cookie } }));
  assert.equal(me.data.user.email, 'a@b.com');
  assert.ok(me.data.providers, 'the UI is told which social providers are configured');

  // No cookie → not signed in.
  const anon = await j(await fetch(`${s.base}/api/me`));
  assert.equal(anon.data.user, null);
});

test('duplicate email is refused; wrong password fails login', async (t) => {
  const s = await startSaas();
  t.after(() => s.close());
  await post(s.base, '/api/auth/signup', { email: 'dup@b.com', password: 'password123' });
  assert.equal((await post(s.base, '/api/auth/signup', { email: 'dup@b.com', password: 'password123' })).status, 409);
  assert.equal((await post(s.base, '/api/auth/login', { email: 'dup@b.com', password: 'nope' })).status, 401);
  assert.equal((await post(s.base, '/api/auth/login', { email: 'dup@b.com', password: 'password123' })).status, 200);
});

test('buying a session needs sign-in and (dev mode) grants it immediately', async (t) => {
  const s = await startSaas();
  t.after(() => s.close());

  // Not signed in → refused.
  assert.equal((await post(s.base, '/api/sessions/buy', { name: 'Party' })).status, 401);

  const signup = await post(s.base, '/api/auth/signup', { email: 'buyer@b.com', password: 'password123' });
  const cookie = cookieFrom(signup);

  const buy = await j(await post(s.base, '/api/sessions/buy', { name: "Maria's 30th" }, cookie));
  assert.equal(buy.status, 200);
  assert.equal(buy.data.dev, true, 'no Stripe key → dev grant');
  assert.equal(buy.data.session.status, 'active');
  assert.equal(buy.data.session.name, "Maria's 30th");

  const list = await j(await fetch(`${s.base}/api/sessions`, { headers: { cookie } }));
  assert.equal(list.data.sessions.length, 1);
  assert.equal(list.data.sessions[0].status, 'active');

  // Another account can't see it.
  const other = cookieFrom(await post(s.base, '/api/auth/signup', { email: 'other@b.com', password: 'password123' }));
  const otherList = await j(await fetch(`${s.base}/api/sessions`, { headers: { cookie: other } }));
  assert.equal(otherList.data.sessions.length, 0, 'sessions are isolated per account');
});

test('each session opens its own isolated booth (separate queues)', async (t) => {
  const s = await startSaas();
  t.after(() => s.close());

  const cookie = cookieFrom(await post(s.base, '/api/auth/signup', { email: 'iso@b.com', password: 'password123' }));
  await post(s.base, '/api/sessions/buy', { name: 'Event A' }, cookie);
  await post(s.base, '/api/sessions/buy', { name: 'Event B' }, cookie);
  const list = (await j(await fetch(`${s.base}/api/sessions`, { headers: { cookie } }))).data.sessions;
  assert.equal(list.length, 2);

  // Open both booths — each is a separate relay process on its own port.
  const openA = (await j(await post(s.base, `/api/sessions/${list[0].id}/open`, {}, cookie))).data;
  const openB = (await j(await post(s.base, `/api/sessions/${list[1].id}/open`, {}, cookie))).data;
  assert.ok(openA.hostUrl && openB.hostUrl, 'both booths came up');
  const urlA = new URL(openA.hostUrl);
  const urlB = new URL(openB.hostUrl);
  assert.notEqual(urlA.port, urlB.port, 'the two booths run on different ports');
  const baseA = `${urlA.protocol}//${urlA.host}`;
  const baseB = `${urlB.protocol}//${urlB.host}`;
  const tokenA = urlA.searchParams.get('token');
  const tokenB = urlB.searchParams.get('token');
  const keyA = new URL(openA.guestUrl).searchParams.get('k');

  // A guest prints into booth A only.
  const printed = await fetch(`${baseA}/api/print?layout=grid&k=${encodeURIComponent(keyA)}`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: makePng(8, 12),
  });
  assert.equal(printed.status, 200);

  // Booth A has the photo; booth B has none — fully isolated.
  const galleryA = await j(await fetch(`${baseA}/api/prints`, { headers: { 'x-booth-token': tokenA } }));
  const galleryB = await j(await fetch(`${baseB}/api/prints`, { headers: { 'x-booth-token': tokenB } }));
  assert.equal(galleryA.data.count, 1, 'the print landed in booth A');
  assert.equal(galleryB.data.count, 0, 'booth B never saw it');
});

test('oauth: buildAuthUrl carries the standard params; unconfigured providers are off', () => {
  const url = new URL(oauth.buildAuthUrl('google', 'https://x/cb', 'state123'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://x/cb');
  assert.equal(url.searchParams.get('state'), 'state123');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.match(url.searchParams.get('scope'), /email/);
  assert.equal(new URL(oauth.buildAuthUrl('apple', 'https://x/cb', 's')).searchParams.get('response_mode'), 'form_post');
});

test('oauth: start redirects to the provider (configured) or 501 (not)', async (t) => {
  const s = await startSaas();
  t.after(() => s.close());

  // Not configured → 501.
  assert.equal((await rawGet(s.base, '/api/auth/oauth/google')).status, 501);

  process.env.GOOGLE_CLIENT_ID = 'test-client';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  t.after(() => { delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; });

  const start = await rawGet(s.base, '/api/auth/oauth/google');
  assert.equal(start.status, 302);
  assert.match(start.headers.location, /accounts\.google\.com/);
  assert.match(start.headers['set-cookie'][0], /^oauth_state=google:/);
});

test('oauth: a full Google callback signs the user in (mocked token endpoint)', async (t) => {
  const s = await startSaas();
  t.after(() => s.close());
  process.env.GOOGLE_CLIENT_ID = 'test-client';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  t.after(() => { delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; });

  // Intercept only Google's token endpoint; everything else hits the real server.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, opts) => {
    const s2 = typeof u === 'string' ? u : u.url;
    if (s2.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ id_token: fakeJwt({ sub: 'g-123', email: 'gee@x.com', name: 'Gee' }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(u, opts);
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const start = await rawGet(s.base, '/api/auth/oauth/google');
  const stateCookie = start.headers['set-cookie'][0].split(';')[0]; // oauth_state=google:nonce
  const nonce = stateCookie.split(':')[1];

  const cb = await rawGet(s.base, `/api/auth/oauth/google/callback?code=abc&state=${nonce}`, { cookie: stateCookie });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.location, '/dashboard');
  const session = (cb.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('saas_sid='));
  assert.ok(session, 'a session cookie was set');

  const me = await j(await fetch(`${s.base}/api/me`, { headers: { cookie: session } }));
  assert.equal(me.data.user.email, 'gee@x.com');

  // A tampered/mismatched state is rejected.
  const bad = await rawGet(s.base, '/api/auth/oauth/google/callback?code=abc&state=wrong', { cookie: stateCookie });
  assert.equal(bad.status, 302);
  assert.match(bad.headers.location, /error=/);
});

test('cloud: a session booth is reachable at its subdomain (proxied to its own process)', async (t) => {
  process.env.SAAS_BASE_DOMAIN = 'booth.test';
  t.after(() => { delete process.env.SAAS_BASE_DOMAIN; });
  const s = await startSaas();
  t.after(() => s.close());

  const cookie = cookieFrom(await post(s.base, '/api/auth/signup', { email: 'cloud@b.com', password: 'password123' }));
  const buy = (await j(await post(s.base, '/api/sessions/buy', { name: 'Cloud Event' }, cookie))).data;
  const slug = buy.session.slug;
  assert.match(slug, /^b[0-9a-f]+$/, 'the session has a DNS-safe slug');

  const open = (await j(await post(s.base, `/api/sessions/${buy.session.id}/open`, {}, cookie))).data;
  assert.match(open.hostUrl, new RegExp(`^http://${slug}\\.booth\\.test/host`), 'the host URL uses the subdomain');

  // A request carrying the booth's Host header is proxied to that booth's own process.
  const health = await rawGet(s.base, '/api/health', { host: `${slug}.booth.test` });
  assert.equal(health.status, 200);
  assert.match(health.body, /"mode":"relay"/, 'the subdomain reaches the isolated booth');

  // An unknown subdomain is refused.
  assert.equal((await rawGet(s.base, '/api/health', { host: 'nope.booth.test' })).status, 404);
});

test('logout clears the session', async (t) => {
  const s = await startSaas();
  t.after(() => s.close());
  const cookie = cookieFrom(await post(s.base, '/api/auth/signup', { email: 'out@b.com', password: 'password123' }));
  const bye = await post(s.base, '/api/auth/logout', {}, cookie);
  const cleared = cookieFrom(bye); // Max-Age=0
  const me = await j(await fetch(`${s.base}/api/me`, { headers: { cookie: cleared } }));
  assert.equal(me.data.user, null);
});
