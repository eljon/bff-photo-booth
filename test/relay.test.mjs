import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, startAgent, until, makePng } from './helpers.mjs';

const TOKEN = 'test-booth-token-123';
const relayEnv = { MODE: 'relay', BOOTH_TOKEN: TOKEN, DRY_RUN: '' };
const host = { 'x-booth-token': TOKEN };

async function startRelay(extra = {}) {
  return startServer({ ...relayEnv, ...extra });
}

async function printAsGuest(booth, { key = booth.accessKey(), copies = 1, layout = 'strip' } = {}) {
  const response = await fetch(`${booth.base}/api/print?layout=${layout}&copies=${copies}${key ? `&k=${encodeURIComponent(key)}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: makePng(8, 12),
  });
  return { status: response.status, data: await response.json() };
}

test('a relay refuses to start without a booth token', async () => {
  await assert.rejects(
    () => startServer({ MODE: 'relay', BOOTH_TOKEN: '' }),
    /server exited|did not start/,
  );
});

test('a public booth prints for anyone with the link — no key in the way', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());

  const session = await (await fetch(`${booth.base}/api/session`)).json();
  assert.equal(session.keyRequired, false, 'guests should not need a key by default');
  assert.equal(session.remote, true);

  // 503 is "no booth Mac connected yet", not "who are you" — the point is that
  // it got past the door.
  const anonymous = await printAsGuest(booth, { key: '' });
  assert.equal(anonymous.status, 503);
  assert.notEqual(anonymous.status, 401);
});

test('the key restriction still works when a host turns it on', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());

  await fetch(`${booth.base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...host },
    body: JSON.stringify({ guestKeyRequired: true }),
  });

  assert.equal((await printAsGuest(booth, { key: '' })).status, 401);
  assert.equal((await printAsGuest(booth, { key: 'not-the-key' })).status, 401);
  assert.equal((await printAsGuest(booth)).status, 503, 'the real key gets through');
});

test('host controls are closed to strangers once the booth is public', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());

  for (const path of ['/api/config', '/api/queue']) {
    const open = await fetch(`${booth.base}${path}`);
    assert.equal(open.status, 401, `${path} should need the booth token`);
    const authed = await fetch(`${booth.base}${path}`, { headers: host });
    assert.equal(authed.status, 200, `${path} should open with the booth token`);
  }

  const settings = await fetch(`${booth.base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ printingEnabled: false }),
  });
  assert.equal(settings.status, 401);
});

test('the agent API rejects a bad token', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());

  const response = await fetch(`${booth.base}/api/agent/jobs`, { headers: { 'x-booth-token': 'wrong' } });
  assert.equal(response.status, 401);
});

test('a booth with no Mac connected tells guests instead of swallowing the print', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());

  const { status, data } = await printAsGuest(booth);
  assert.equal(status, 503);
  assert.match(data.error, /offline/i);
});

test('end to end: guest prints, the Mac agent picks it up and reports the queue', async (t) => {
  const booth = await startRelay();
  const agent = await startAgent(booth.base, TOKEN);
  t.after(() => Promise.all([agent.close(), booth.close()]));

  // the Mac announces itself and its printers
  const printers = await until(async () => {
    const data = await (await fetch(`${booth.base}/api/printers`)).json();
    return data.agentOnline ? data : null;
  });
  assert.equal(printers.remote, true);
  assert.deepEqual(printers.printers.map((p) => p.name), ['Dry-Run-Printer']);

  const { status, data } = await printAsGuest(booth, { copies: 2 });
  assert.equal(status, 200);
  assert.ok(['pending', 'claimed', 'printing', 'done'].includes(data.job.status), `unexpected status ${data.job.status}`);

  const finished = await until(async () => {
    const job = await (await fetch(`${booth.base}/api/job?id=${data.job.id}`)).json();
    return job.job.status === 'done' ? job.job : null;
  });
  assert.match(finished.cupsJobId, /^dry-run-/);
  assert.equal(finished.copies, 2);

  // the agent really downloaded the composed page onto the Mac
  const { readdirSync } = await import('node:fs');
  assert.equal(readdirSync(agent.printsDir).length, 1);
});

test('a held print only reaches the Mac after the host approves it', async (t) => {
  const booth = await startRelay();
  const agent = await startAgent(booth.base, TOKEN);
  t.after(() => Promise.all([agent.close(), booth.close()]));

  await until(async () => (await (await fetch(`${booth.base}/api/printers`)).json()).agentOnline);
  await fetch(`${booth.base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...host },
    body: JSON.stringify({ requireApproval: true }),
  });

  const { data } = await printAsGuest(booth);
  assert.equal(data.job.status, 'awaiting-approval');

  await new Promise((resolve) => setTimeout(resolve, 500));
  const stillWaiting = await (await fetch(`${booth.base}/api/job?id=${data.job.id}`)).json();
  assert.equal(stillWaiting.job.status, 'awaiting-approval', 'the agent must not take an unapproved job');

  await fetch(`${booth.base}/api/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...host },
    body: JSON.stringify({ id: data.job.id }),
  });

  const finished = await until(async () => {
    const job = await (await fetch(`${booth.base}/api/job?id=${data.job.id}`)).json();
    return job.job.status === 'done' ? job.job : null;
  });
  assert.match(finished.cupsJobId, /^dry-run-/);
});

test('a guest can only fetch their own strip from a public booth', async (t) => {
  const booth = await startRelay();
  const agent = await startAgent(booth.base, TOKEN);
  t.after(() => Promise.all([agent.close(), booth.close()]));

  await until(async () => (await (await fetch(`${booth.base}/api/printers`)).json()).agentOnline);
  const { data } = await printAsGuest(booth);

  const withToken = await fetch(`${booth.base}${data.job.image}`);
  assert.equal(withToken.status, 200);

  const bare = await fetch(`${booth.base}${data.job.image.split('?')[0]}`);
  assert.equal(bare.status, 404, 'the raw filename must not be enough');

  const guessed = await fetch(`${booth.base}${data.job.image.split('?')[0]}?t=deadbeef`);
  assert.equal(guessed.status, 404);

  const asHost = await fetch(`${booth.base}${data.job.image.split('?')[0]}`, { headers: host });
  assert.equal(asHost.status, 200, 'the host can see every strip');
});

test('a LAN booth stays frictionless — no key, no token', async (t) => {
  const booth = await startServer(); // booth mode, DRY_RUN
  t.after(() => booth.close());

  const session = await (await fetch(`${booth.base}/api/session`)).json();
  assert.equal(session.keyRequired, false);
  assert.equal(session.remote, false);

  const { status } = await printAsGuest(booth, { key: '' });
  assert.equal(status, 200);
  assert.equal((await fetch(`${booth.base}/api/config`)).status, 200);
});

test('the health probe answers without a token, for platform checks', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());

  const response = await fetch(`${booth.base}/api/health`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.mode, 'relay');
  assert.equal(data.agentOnline, false, 'no Mac has connected yet');
  assert.equal(typeof data.uptimeSeconds, 'number');
});

test('ACCESS_KEY pins the guest key so a redeploy keeps printed QR codes working', async (t) => {
  const booth = await startRelay({ ACCESS_KEY: 'party-2026', BOOTH_NAME: 'Pinned Booth' });
  t.after(() => booth.close());

  const settings = await (await fetch(`${booth.base}/api/config`, { headers: host })).json();
  assert.equal(settings.config.accessKey, 'party-2026');
  assert.equal(settings.config.boothName, 'Pinned Booth');
  assert.deepEqual(settings.pinned.sort(), ['accessKey', 'boothName']);

  // the pinned key is still what the QR would carry if the host turns the
  // restriction on — it just is not demanded by default
  const { status } = await printAsGuest(booth, { key: 'party-2026' });
  assert.equal(status, 503, 'no agent yet, but nothing rejected the request');

  // and the host cannot rotate or rename around the environment
  await fetch(`${booth.base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...host },
    body: JSON.stringify({ rotateKey: true, boothName: 'Something Else' }),
  });
  const after = await (await fetch(`${booth.base}/api/config`, { headers: host })).json();
  assert.equal(after.config.accessKey, 'party-2026');
  assert.equal(after.config.boothName, 'Pinned Booth');
});

test('a tunnelled booth leaves the host screen open — no password to lose', async (t) => {
  // PUBLIC_URL exposes the booth exactly as a tunnel does, with no BOOTH_TOKEN.
  const booth = await startServer({ PUBLIC_URL: 'https://booth.example.com', BOOTH_TOKEN: '' });
  t.after(() => booth.close());

  const response = await fetch(`${booth.base}/api/config`);
  assert.equal(response.status, 200, 'the host screen should open without a password');

  const data = await response.json();
  assert.equal(data.exposed, true);
  assert.equal(data.keyRequired, false, 'guests print without a key by default');
  assert.equal(data.urls[0], 'https://booth.example.com', 'the QR points at the public address');

  // the settings screen is usable, not just readable
  const saved = await fetch(`${booth.base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ boothName: 'Open Booth' }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).config.boothName, 'Open Booth');
});

test('setting BOOTH_TOKEN puts the password back', async (t) => {
  const booth = await startServer({ PUBLIC_URL: 'https://booth.example.com', BOOTH_TOKEN: 'my-own-token' });
  t.after(() => booth.close());

  assert.equal((await fetch(`${booth.base}/api/config`, { headers: { 'x-booth-token': 'my-own-token' } })).status, 200);
  assert.equal((await fetch(`${booth.base}/api/config`, { headers: { 'x-booth-token': 'guessed' } })).status, 401);
});
