import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, startAgent, until, makePng } from './helpers.mjs';

const TOKEN = 'test-booth-token-123';
// A short print time so "printing → done" (now timed on the relay, not instant) resolves
// quickly in tests while still exercising the real not-done-yet gap.
const relayEnv = { MODE: 'relay', BOOTH_TOKEN: TOKEN, DRY_RUN: '', PRINT_MS: '300' };
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

  // No Mac connected yet, but the relay OWNS the queue — it takes the print and
  // holds it until the booth reconnects, rather than turning the guest away.
  const anonymous = await printAsGuest(booth, { key: '' });
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.data.job.status, 'pending', 'the print waits in the queue');
  assert.equal(anonymous.data.agentOnline, false, 'and we tell the guest the booth is offline');
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
  assert.equal((await printAsGuest(booth)).status, 200, 'the real key gets through and queues');
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

test('a booth with no Mac connected queues the print for when it reconnects', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());

  const { status, data } = await printAsGuest(booth);
  assert.equal(status, 200, 'the relay accepts and holds the print');
  assert.equal(data.ok, true);
  assert.equal(data.agentOnline, false);
  assert.equal(data.job.status, 'pending', 'it waits in the queue for the booth');
});

test('the queue is durable — a print survives a relay restart', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());

  const { status, data } = await printAsGuest(booth, { copies: 3 });
  assert.equal(status, 200);
  assert.equal(data.job.status, 'pending');

  // The relay process stops and starts again (redeploy / crash) on the same disk.
  await booth.restart();

  const after = await (await fetch(`${booth.base}/api/job?id=${data.job.id}`)).json();
  assert.equal(after.job.status, 'pending', 'the queued print is still there after the restart');
  assert.equal(after.job.copies, 3, 'and its details survived');
});

test('/print is gone — the browser-printer path was removed', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());
  assert.equal((await fetch(`${booth.base}/print`)).status, 404, '/print no longer serves a page');
});

test('pairing: minting needs the host token; claiming needs a valid code', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());

  // Minting a code is a host action.
  const unauth = await fetch(`${booth.base}/api/pair/new`, { method: 'POST' });
  assert.equal(unauth.status, 401, 'no host token, no code');

  const minted = await (await fetch(`${booth.base}/api/pair/new`, { method: 'POST', headers: host })).json();
  assert.equal(minted.ok, true);
  assert.match(minted.code, /^[A-Z0-9]{8}$/, 'an 8-char code is minted');

  // A wrong code is rejected without leaking the token.
  const bad = await fetch(`${booth.base}/api/pair/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'ZZZZZZZZ' }),
  });
  assert.equal(bad.status, 404);
  assert.equal((await bad.json()).token, undefined);

  // The real code trades for the booth token exactly once.
  const claim = await (await fetch(`${booth.base}/api/pair/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: minted.code }),
  })).json();
  assert.equal(claim.ok, true);
  assert.equal(claim.token, TOKEN, 'the helper receives the booth token');

  const reuse = await fetch(`${booth.base}/api/pair/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: minted.code }),
  });
  assert.equal(reuse.status, 404, 'a code is single-use');
});

test('pairing: an agent started with only a code connects and reports its printers', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());

  const minted = await (await fetch(`${booth.base}/api/pair/new`, { method: 'POST', headers: host })).json();

  // The helper knows only the relay URL and the pairing code — no booth token.
  const agent = await startAgent(booth.base, '', { PAIR_CODE: minted.code });
  t.after(() => agent.close());

  const online = await until(async () => {
    const data = await (await fetch(`${booth.base}/api/printers`)).json();
    return data.agentOnline ? data : null;
  });
  assert.equal(online.agentOnline, true, 'the paired agent shows as connected');
  assert.ok(online.printers.length >= 1, 'and the host can now see its printers');
});

test('a print submitted while the Mac is offline drains once it reconnects', async (t) => {
  const booth = await startRelay();
  t.after(() => booth.close());

  // No agent yet — the guest still submits, and the relay queues the job.
  const { status, data } = await printAsGuest(booth, { copies: 1 });
  assert.equal(status, 200);
  assert.equal(data.job.status, 'pending');

  // The Mac comes online; it should pick up the waiting job and print it.
  const agent = await startAgent(booth.base, TOKEN);
  t.after(() => agent.close());

  const finished = await until(async () => {
    const job = await (await fetch(`${booth.base}/api/job?id=${data.job.id}`)).json();
    return job.job.status === 'done' ? job.job : null;
  });
  assert.match(finished.cupsJobId, /^dry-run-/);
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

test('two computers share one queue — prints land on whichever is free, tagged by computer', async (t) => {
  const booth = await startRelay();
  const one = await startAgent(booth.base, TOKEN, { AGENT_ID: 'mac-1', AGENT_NAME: 'Mac One' });
  const two = await startAgent(booth.base, TOKEN, { AGENT_ID: 'mac-2', AGENT_NAME: 'Mac Two' });
  t.after(() => Promise.all([one.close(), two.close(), booth.close()]));

  // Both computers connect and report their printers.
  await until(async () => {
    const data = await (await fetch(`${booth.base}/api/printers`)).json();
    return (data.agents || []).length >= 2 ? data : null;
  });

  const j1 = (await printAsGuest(booth)).data.job;
  const j2 = (await printAsGuest(booth)).data.job;

  const finished = async (id) => until(async () => {
    const j = (await (await fetch(`${booth.base}/api/job?id=${id}`)).json()).job;
    return j.status === 'done' ? j : null;
  });
  const d1 = await finished(j1.id);
  const d2 = await finished(j2.id);

  // Each print was handled by one of the connected computers and carries its name.
  assert.ok(['Mac One', 'Mac Two'].includes(d1.computer), `computer ${d1.computer}`);
  assert.ok(['Mac One', 'Mac Two'].includes(d2.computer), `computer ${d2.computer}`);
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
  assert.equal(status, 200, 'no agent yet, but the relay queues the print');

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
