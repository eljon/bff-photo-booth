'use strict';

/**
 * BFF Photo Booth — booth agent.
 *
 * Runs on the MacBook that owns the printer, next to nothing else. It makes
 * only OUTBOUND https calls to the relay, so the Mac needs no inbound ports,
 * no port forwarding, and no shared network with the guests:
 *
 *   1. say hello, and report which printers this Mac can actually reach
 *   2. long-poll for a job
 *   3. download the finished page, hand it to CUPS with `lp`
 *   4. report the CUPS job id (or the failure) back to the relay
 *
 *   RELAY_URL=https://booth.example.com BOOTH_TOKEN=… npm run agent
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const cups = require('./cups');
const build = require('./version');

const RELAY_URL = (process.env.RELAY_URL || '').replace(/\/+$/, '');
const BOOTH_TOKEN = process.env.BOOTH_TOKEN || '';
const DRY_RUN = process.env.DRY_RUN === '1';
const PRINTS_DIR = process.env.PRINTS_DIR || path.join(__dirname, '..', 'prints');
const AGENT_NAME = process.env.AGENT_NAME || `${os.hostname()} booth`;
const POLL_SECONDS = 25;
const HELLO_EVERY_MS = 60_000;

if (!RELAY_URL || !BOOTH_TOKEN) {
  console.error('The agent needs RELAY_URL and BOOTH_TOKEN.');
  console.error('  RELAY_URL=https://your-booth.example.com BOOTH_TOKEN=… npm run agent');
  process.exit(1);
}

fs.mkdirSync(PRINTS_DIR, { recursive: true });

const headers = { 'x-booth-token': BOOTH_TOKEN };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toLocaleTimeString();
const log = (message) => console.log(`  ${stamp()}  ${message}`);

let lastHello = 0;
let backoff = 1000;

async function relay(pathname, options = {}) {
  const response = await fetch(`${RELAY_URL}${pathname}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  if (response.status === 401) throw new Error('the relay rejected BOOTH_TOKEN');
  return response;
}

async function localPrinters() {
  if (DRY_RUN) return [{ name: 'Dry-Run-Printer', state: 'idle', ready: true }];
  const { printers } = await cups.listPrinters();
  return printers.map(({ name, state, ready }) => ({ name, state, ready }));
}

async function sayHello() {
  const printers = await localPrinters();
  const response = await relay('/api/agent/hello', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: AGENT_NAME, printers, dryRun: DRY_RUN, version: build.version }),
  });
  if (!response.ok) throw new Error(`hello failed (${response.status})`);
  lastHello = Date.now();
  return printers;
}

/** Pull the composed page down so `lp` has a real file to send. */
async function downloadJob(job) {
  const response = await relay(job.image);
  if (!response.ok) throw new Error(`could not download the print (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(new URL(job.image, RELAY_URL).pathname) || '.png';
  const file = path.join(PRINTS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}_${job.layout}_${job.id.slice(0, 8)}${extension}`);
  await fsp.writeFile(file, buffer);
  return file;
}

async function printJob(job) {
  const file = await downloadJob(job);

  if (DRY_RUN) {
    log(`dry run — saved ${path.basename(file)} instead of printing`);
    return { ok: true, cupsJobId: `dry-run-${job.id.slice(0, 6)}`, printer: 'Dry-Run-Printer' };
  }

  // Never hand the relay's printer name to `lp` unchecked — it has to be one
  // this Mac actually has.
  const { printers, default: fallback } = await cups.listPrinters();
  const wanted = job.printer || fallback;
  const match = printers.find((printer) => printer.name === wanted);
  if (!match) {
    return { ok: false, error: wanted ? `this Mac has no printer called "${wanted}"` : 'no printer is set up on this Mac' };
  }

  const options = { 'print-quality': '5' };
  if (job.fitToPage) options['fit-to-page'] = 'true';

  const result = await cups.print(file, {
    printer: match.name,
    copies: job.copies,
    media: job.media,
    options,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, cupsJobId: result.jobId, printer: match.name };
}

async function report(job, outcome) {
  await relay('/api/agent/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: job.id, ...outcome }),
  });
}

async function tick() {
  if (Date.now() - lastHello > HELLO_EVERY_MS) {
    const printers = await sayHello();
    if (!printers.length) log('warning: this Mac reports no printers — add one in System Settings');
  }

  const response = await relay(`/api/agent/jobs?wait=${POLL_SECONDS}`);
  if (!response.ok) throw new Error(`poll failed (${response.status})`);
  const { job } = await response.json();
  if (!job) return;

  log(`job ${job.id.slice(0, 8)} · ${job.layout} · ${job.copies} ${job.copies === 1 ? 'copy' : 'copies'}`);
  try {
    const outcome = await printJob(job);
    await report(job, outcome);
    log(outcome.ok ? `  → printer queue: ${outcome.cupsJobId || 'accepted'}` : `  → failed: ${outcome.error}`);
  } catch (err) {
    await report(job, { ok: false, error: err.message }).catch(() => {});
    log(`  → failed: ${err.message}`);
  }
}

async function main() {
  console.log('');
  console.log(`  ${AGENT_NAME}  v${build.label}`);
  console.log(`  relay:    ${RELAY_URL}`);
  console.log(`  printers: ${(await localPrinters()).map((p) => p.name).join(', ') || 'none found'}`);
  if (DRY_RUN) console.log('  DRY_RUN=1 — jobs are downloaded but never printed.');
  console.log('');

  for (;;) {
    try {
      await tick();
      backoff = 1000;
    } catch (err) {
      log(`${err.message} — retrying in ${Math.round(backoff / 1000)}s`);
      await wait(backoff);
      backoff = Math.min(30_000, backoff * 2);
      lastHello = 0; // re-announce ourselves once we are back
    }
  }
}

main();
