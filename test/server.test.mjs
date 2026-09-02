import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, makePng, until } from './helpers.mjs';

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

test('each print gets a running number (P1, P2, …) shown everywhere and in the filename', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  const send = async () => (await fetch(`${booth.base}/api/print?layout=grid&copies=1`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: makePng(8, 12),
  })).json();

  const first = await send();
  const second = await send();

  assert.equal(first.job.printNo, 1, 'numbering starts at 1');
  assert.equal(second.job.printNo, 2, 'and increments');
  // the number is baked into the saved file (so the image URL carries it too)
  assert.match(first.job.image, /\/prints\/P1_/);
  assert.match(second.job.image, /\/prints\/P2_/);

  // and it survives on the host queue view
  const q = await (await fetch(`${booth.base}/api/queue`)).json();
  assert.ok(q.jobs.every((j) => typeof j.printNo === 'number'), 'every queued job carries its number');
});

test('serves the viewer board at /view', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  const page = await fetch(`${booth.base}/view`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Now printing/i);
  assert.match(html, /Up next/i);
});

test('the sticker can be switched from the host, and only to a real one', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  // The guest session carries the chosen sticker; the host config lists the choices.
  const session = await (await fetch(`${booth.base}/api/session`)).json();
  assert.equal(session.sticker, 'backgrounds/sticker.png', 'defaults to the bundled sticker');

  const cfg = await (await fetch(`${booth.base}/api/config`)).json();
  assert.ok(Array.isArray(cfg.stickers), 'the host gets the list of stickers');
  assert.ok(cfg.stickers.some((s) => s.path === 'backgrounds/sticker.png'), 'including the bundled one');
  assert.ok(cfg.stickers.every((s) => /^backgrounds\/.+\.png$/i.test(s.path)), 'stickers are the .png files in backgrounds');

  // A bogus sticker path is ignored — it can't point the badge anywhere it likes.
  await fetch(`${booth.base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sticker: '../secret.png' }),
  });
  const afterBad = await (await fetch(`${booth.base}/api/session`)).json();
  assert.equal(afterBad.sticker, 'backgrounds/sticker.png', 'a path not in the list is refused');

  // A real one from the list sticks.
  const pick = cfg.stickers[cfg.stickers.length - 1].path;
  await fetch(`${booth.base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sticker: pick }),
  });
  const afterGood = await (await fetch(`${booth.base}/api/session`)).json();
  assert.equal(afterGood.sticker, pick, 'a sticker from the list is saved');
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
  assert.equal(data.job.status, 'printing'); // first job goes straight onto the printer
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

test('a booth can gate printing behind single-use print codes (vouchers)', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());
  const H = { 'content-type': 'application/json' };

  await fetch(`${booth.base}/api/config`, { method: 'POST', headers: H, body: JSON.stringify({ requireVoucher: true }) });
  const gen = await (await fetch(`${booth.base}/api/vouchers`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'generate', count: 5 }) })).json();
  assert.equal(gen.added, 5);
  assert.equal(gen.codes.length, 5);
  const code = gen.codes[0];
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/, 'six unambiguous chars, no I/L/O/0/1');

  // Guests are told a code is required.
  assert.equal((await (await fetch(`${booth.base}/api/session`)).json()).codeRequired, true);

  const printWith = (c) => fetch(`${booth.base}/api/print?layout=grid${c != null ? `&code=${encodeURIComponent(c)}` : ''}`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: makePng(),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

  // No code, or a wrong one, is refused with a code error — never printed.
  assert.equal((await printWith(null)).status, 402);
  const wrong = await printWith('ZZZZZZ');
  assert.equal(wrong.status, 402);
  assert.equal(wrong.data.codeError, true);

  // The real code prints — and cannot be used a second time.
  const ok = await printWith(code);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.job.status, 'printing');
  const reuse = await printWith(code);
  assert.equal(reuse.status, 402);
  assert.equal(reuse.data.reason, 'used');

  const stats = await (await fetch(`${booth.base}/api/vouchers`)).json();
  assert.equal(stats.used, 1);
  assert.equal(stats.unused, 4);
});

test('too many wrong codes trip a brute-force cool-off', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());
  const H = { 'content-type': 'application/json' };
  await fetch(`${booth.base}/api/config`, { method: 'POST', headers: H, body: JSON.stringify({ requireVoucher: true }) });
  await fetch(`${booth.base}/api/vouchers`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'generate', count: 5 }) });

  const guess = (c) => fetch(`${booth.base}/api/print?layout=grid&code=${c}`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: makePng(),
  }).then((r) => r.status);

  // The first several wrong guesses are rejected (402); after the limit the address is
  // locked out (429), so brute-forcing the code space is throttled to a crawl.
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push(await guess(`WRO${String(i).padStart(3, '0')}`));
  assert.ok(statuses.slice(0, 8).every((s) => s === 402), `early guesses refused: ${statuses}`);
  assert.ok(statuses.slice(8).some((s) => s === 429), `later guesses locked out: ${statuses}`);
});

test('a skipped print hands the guest their code back', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());
  const H = { 'content-type': 'application/json' };

  await fetch(`${booth.base}/api/config`, { method: 'POST', headers: H, body: JSON.stringify({ requireVoucher: true, requireApproval: true }) });
  const gen = await (await fetch(`${booth.base}/api/vouchers`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'generate', count: 1 }) })).json();
  const code = gen.codes[0];

  const first = await (await fetch(`${booth.base}/api/print?layout=grid&code=${code}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: makePng() })).json();
  assert.equal(first.job.status, 'awaiting-approval');
  assert.equal((await (await fetch(`${booth.base}/api/vouchers`)).json()).unused, 0, 'the code is spent while it waits');

  // The host skips it → the code comes back and works again.
  await fetch(`${booth.base}/api/reject`, { method: 'POST', headers: H, body: JSON.stringify({ id: first.job.id }) });
  assert.equal((await (await fetch(`${booth.base}/api/vouchers`)).json()).unused, 1, 'a skipped print refunds the code');
  const again = await (await fetch(`${booth.base}/api/print?layout=grid&code=${code}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: makePng() })).json();
  assert.equal(again.job.status, 'awaiting-approval', 'the refunded code prints again');
});

test('several chosen printers print in parallel, each new print going to a free one', async (t) => {
  const booth = await startServer();
  t.after(() => booth.close());

  // The host picks two printers to run, each with a name/number.
  await fetch(`${booth.base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ printers: [
      { agentId: 'local', name: 'Alpha', label: 'Front #1' },
      { agentId: 'local', name: 'Bravo', label: 'Back #2' },
    ] }),
  });

  const submit = () => fetch(`${booth.base}/api/print?layout=grid`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: makePng(),
  }).then((r) => r.json());

  const a = await submit();
  const b = await submit();
  const c = await submit();

  // Two printers → two prints run at once; the third waits for one to free up.
  assert.equal(a.job.status, 'printing');
  assert.equal(b.job.status, 'printing', 'the second printer runs in parallel');
  assert.equal(c.job.status, 'pending', 'the third waits for a free printer');
  assert.notEqual(a.job.printer, b.job.printer, 'the two prints are on different printers');
  assert.ok(['Front #1', 'Back #2'].includes(a.job.printerLabel), `label ${a.job.printerLabel}`);
  assert.equal(a.job.computer, 'This Mac');

  // Two lanes → a and b finish in one slot (~30s), c in the second (~60s), not 90s.
  assert.ok(a.job.queue.etaSeconds <= 30 && b.job.queue.etaSeconds <= 30, 'both run now');
  assert.ok(c.job.queue.etaSeconds >= 25 && c.job.queue.etaSeconds <= 60, `c ETA ${c.job.queue.etaSeconds}`);
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

  // The first is on the printer; the rest wait behind it, one 30s slot apart.
  assert.equal(a.job.status, 'printing');
  assert.equal(b.job.status, 'pending');
  assert.equal(c.job.status, 'pending');
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
  assert.equal(approved.job.status, 'printing'); // released to the printer on approval
});

test('holds jobs in the server and releases the next only when the print finishes', async (t) => {
  const booth = await startServer({ DRY_PRINT_MS: '250' }); // each print "takes" 250ms
  t.after(() => booth.close());

  const submit = () => fetch(`${booth.base}/api/print?layout=grid`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: makePng(),
  }).then((r) => r.json());
  const poll = (id) => fetch(`${booth.base}/api/job?id=${id}`).then((r) => r.json()).then((d) => d.job);

  const a = await submit();
  const b = await submit();
  assert.equal(a.job.status, 'printing'); // a is on the printer
  assert.equal(b.job.status, 'pending');  // b waits — NOT sent to the printer yet
  assert.equal(b.job.queue.position, 2);

  // Once a finishes, b is released and moves onto the printer (position 1).
  const bPrinting = await until(async () => {
    const j = await poll(b.job.id);
    return j.status === 'printing' ? j : null;
  });
  assert.equal(bPrinting.queue.position, 1);
  assert.equal((await poll(a.job.id)).status, 'done'); // a really completed
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
