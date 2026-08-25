import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, makePng } from './helpers.mjs';

test('serves the guest app and its session settings', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  const page = await fetch(`${booth.base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Photo Booth/);

  const session = await (await fetch(`${booth.base}/api/session`)).json();
  assert.equal(session.dryRun, true);
  assert.equal(session.printingEnabled, true);
  assert.ok(session.maxCopies >= 1);
});

test('accepts a composed print and writes it to the prints folder', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  const response = await fetch(`${booth.base}/api/print?layout=strip&copies=2&guest=Sam`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: makePng(8, 12),
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.job.status, 'queued');
  assert.equal(data.job.copies, 2);
  assert.equal(data.job.layout, 'strip');
  assert.equal(data.job.guest, 'Sam');

  const files = fs.readdirSync(booth.printsDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /_strip_[0-9a-f]{8}\.png$/);

  const served = await fetch(`${booth.base}${data.job.image}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
});

test('reports a live queue position and ETA for each print', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  const submit = () => fetch(`${booth.base}/api/print?layout=grid`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: makePng(),
  }).then((r) => r.json());

  const a = await submit();
  const b = await submit();
  const c = await submit();

  // Each print lines up behind the ones before it, 30s apart.
  assert.equal(a.job.queue.position, 1);
  assert.equal(b.job.queue.position, 2);
  assert.equal(c.job.queue.position, 3);
  assert.equal(c.job.queue.total, 3);

  assert.ok(a.job.queue.etaSeconds <= 30 && a.job.queue.etaSeconds >= 25, `a ETA ${a.job.queue.etaSeconds}`);
  assert.ok(b.job.queue.etaSeconds <= 60 && b.job.queue.etaSeconds >= 55, `b ETA ${b.job.queue.etaSeconds}`);
  assert.ok(c.job.queue.etaSeconds <= 90 && c.job.queue.etaSeconds >= 85, `c ETA ${c.job.queue.etaSeconds}`);

  // The same standing is available by polling /api/job.
  const polled = await (await fetch(`${booth.base}/api/job?id=${b.job.id}`)).json();
  assert.equal(polled.job.queue.position, 2);
  assert.ok(polled.job.queue.readyAt > Date.now());
});

test('rejects bodies that are not images', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  const response = await fetch(`${booth.base}/api/print`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: Buffer.from('<script>not a photo</script>'),
  });
  assert.equal(response.status, 400);
  assert.equal(fs.readdirSync(booth.printsDir).length, 0);
});

test('clamps copies to the booth maximum', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  await fetch(`${booth.base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxCopies: 2 }),
  });

  const data = await (await fetch(`${booth.base}/api/print?copies=99`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: makePng(),
  })).json();
  assert.equal(data.job.copies, 2);
});

test('holds prints for the host when approval is required', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  await fetch(`${booth.base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requireApproval: true }),
  });

  const queued = await (await fetch(`${booth.base}/api/print?layout=grid`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: makePng(),
  })).json();
  assert.equal(queued.job.status, 'awaiting-approval');

  const listed = await (await fetch(`${booth.base}/api/queue`)).json();
  assert.equal(listed.jobs.filter((job) => job.status === 'awaiting-approval').length, 1);

  const approved = await (await fetch(`${booth.base}/api/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: queued.job.id }),
  })).json();
  assert.equal(approved.job.status, 'queued');
});

test('refuses prints when the host switches printing off', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  await fetch(`${booth.base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ printingEnabled: false }),
  });

  const response = await fetch(`${booth.base}/api/print`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: makePng(),
  });
  assert.equal(response.status, 503);
});

test('will not serve files outside the public folder', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  for (const attack of ['/../package.json', '/prints/../../package.json', '/%2e%2e/package.json']) {
    const response = await fetch(`${booth.base}${attack}`, { redirect: 'manual' });
    assert.ok(response.status >= 400, `${attack} should not be served (got ${response.status})`);
  }
});

test('validates job ids before shelling out to cancel', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  const response = await fetch(`${booth.base}/api/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cupsJobId: 'job-1; rm -rf /' }),
  });
  assert.equal(response.status, 400);
});

test('rate limits a guest hammering the print button', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  let limited = false;
  for (let i = 0; i < 32; i++) {
    const response = await fetch(`${booth.base}/api/print`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: makePng(),
    });
    if (response.status === 429) {
      limited = true;
      break;
    }
  }
  assert.ok(limited, 'expected a 429 within 32 rapid prints');
});
