import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createApp, Store } = require('../server/commercial/app.js');
const auth = require('../server/commercial/auth.js');

async function startSaas() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-'));
  const server = http.createServer(createApp(new Store(dir)));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
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

test('logout clears the session', async (t) => {
  const s = await startSaas();
  t.after(() => s.close());
  const cookie = cookieFrom(await post(s.base, '/api/auth/signup', { email: 'out@b.com', password: 'password123' }));
  const bye = await post(s.base, '/api/auth/logout', {}, cookie);
  const cleared = cookieFrom(bye); // Max-Age=0
  const me = await j(await fetch(`${s.base}/api/me`, { headers: { cookie: cleared } }));
  assert.equal(me.data.user, null);
});
