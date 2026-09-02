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
// A stable id for THIS computer, so the relay can tell several connected Macs/PCs apart and
// assign each print to whichever computer's printer is free first. Set AGENT_ID to pin it;
// otherwise it is remembered in a small file beside the prints so it survives restarts.
const AGENT_ID = resolveAgentId();
const POLL_SECONDS = 25;
const HELLO_EVERY_MS = 60_000;
// Minimum time one sheet holds the printer before the agent pulls the next job.
// CUPS reports a job done when it finishes SENDING to the printer, which on buffered
// printers is before the page is out — so without this floor the agent hands `lp`
// the next job too soon and the printer's own queue fills up. Tune to your printer.
const PRINT_MS = Number(process.env.PRINT_MS) || 30 * 1000;

if (!RELAY_URL || !BOOTH_TOKEN) {
  console.error('The agent needs RELAY_URL and BOOTH_TOKEN.');
  console.error('  RELAY_URL=https://your-booth.example.com BOOTH_TOKEN=… npm run agent');
  process.exit(1);
}

fs.mkdirSync(PRINTS_DIR, { recursive: true });

/** A stable per-computer id: the pinned AGENT_ID, else the machine's hostname. Distinct
 *  machines get distinct ids automatically; set AGENT_ID to run two agents on one machine. */
function resolveAgentId() {
  return String(process.env.AGENT_ID || os.hostname() || 'agent').slice(0, 80);
}

const headers = { 'x-booth-token': BOOTH_TOKEN, 'x-agent-id': AGENT_ID };
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

  const options = cups.buildPrintOptions({ borderless: job.borderless, fitToPage: job.fitToPage, mediaType: job.mediaType });

  // Borderless means this Mac's own full-bleed page size for the requested size.
  let media = job.media;
  if (job.borderless && media && !cups.isBorderlessMedia(media)) {
    const { options: sizes } = await cups.mediaOptions(match.name);
    const bl = cups.borderlessFor(sizes, media);
    if (bl) media = bl;
  }

  const result = await cups.print(file, {
    printer: match.name,
    copies: job.copies,
    media,
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

/** Wait until CUPS says the job has actually left the print queue — so the relay
 *  (and the guest) learn the print is DONE for real, not on a time estimate. Gives
 *  up after a long ceiling so a stuck job never wedges the agent forever. */
async function waitForCupsDone(cupsJobId, startedAt = Date.now()) {
  const started = Date.now();
  const MAX = 6 * 60 * 1000; // never wait longer than this for one sheet
  let seen = false;
  for (;;) {
    let active = [];
    try { active = await cups.listJobs(); } catch { /* transient lpstat hiccup — retry */ }
    const present = Boolean(cupsJobId) && active.some((j) => j.id === cupsJobId);
    if (present) seen = true;
    // Done only when the job has cleared CUPS (seen there then gone, or a short grace
    // if it finished before our first check) AND has held the printer for at least one
    // physical print interval — otherwise a buffered printer accepts the next sheet
    // immediately and its queue piles up.
    const clearedCups = !present && (seen || Date.now() - started > 8000);
    if (clearedCups && Date.now() - startedAt >= PRINT_MS) return;
    if (Date.now() - started > MAX) return;
    await wait(1500);
  }
}

/** Carry one claimed job through to completion. The relay already pinned it to one of this
 *  computer's printers (job.printer), so several of these can run at once, one per printer. */
async function runJob(job) {
  log(`job ${job.id.slice(0, 8)} · ${job.layout} · ${job.copies} ${job.copies === 1 ? 'copy' : 'copies'}${job.printer ? ` · ${job.printer}` : ''}`);
  try {
    const outcome = await printJob(job);
    if (!outcome.ok) {
      await report(job, outcome);
      log(`  → failed: ${outcome.error}`);
      return;
    }
    if (DRY_RUN) {
      await report(job, { ...outcome, done: true }); // nothing real to wait for
      log('  → dry run — reported done');
      return;
    }
    // Two phases: tell the relay it STARTED (so the guest sees "Printing now"), then
    // watch CUPS and report DONE only once the sheet has really left the queue. This also
    // holds this printer busy for one real print and teaches the relay the true duration.
    const startedAt = Date.now();
    await report(job, { ...outcome, started: true });
    log(`  → printing (CUPS ${outcome.cupsJobId || 'accepted'})`);
    await waitForCupsDone(outcome.cupsJobId, startedAt);
    await report(job, { ...outcome, done: true });
    log('  → done');
  } catch (err) {
    await report(job, { ok: false, error: err.message }).catch(() => {});
    log(`  → failed: ${err.message}`);
  }
}

async function main() {
  const localCount = (await localPrinters()).length;
  console.log('');
  console.log(`  ${AGENT_NAME}  v${build.label}`);
  console.log(`  relay:    ${RELAY_URL}`);
  console.log(`  printers: ${(await localPrinters()).map((p) => p.name).join(', ') || 'none found'}`);
  if (DRY_RUN) console.log('  DRY_RUN=1 — jobs are downloaded but never printed.');
  console.log('');

  // How many prints this computer runs at once — one per printer it has (at least 1). The
  // relay only ever hands out a job for a printer that is actually free, so this is a ceiling.
  const maxConcurrent = Math.max(1, localCount);
  const inFlight = new Set(); // job ids currently printing on this computer

  for (;;) {
    try {
      if (Date.now() - lastHello > HELLO_EVERY_MS) {
        const printers = await sayHello();
        if (!printers.length) log('warning: this computer reports no printers — add one in System Settings');
      }
      if (inFlight.size >= maxConcurrent) { await wait(1000); continue; } // all printers busy

      // Poll: wait long when idle, briefly when prints are running so we come back to reap
      // them and grab the next free-printer job without delay.
      const waitS = inFlight.size ? 2 : POLL_SECONDS;
      const response = await relay(`/api/agent/jobs?wait=${waitS}`);
      if (!response.ok) throw new Error(`poll failed (${response.status})`);
      backoff = 1000;
      const { job } = await response.json();
      if (job && !inFlight.has(job.id)) {
        inFlight.add(job.id);
        runJob(job).finally(() => inFlight.delete(job.id)); // concurrent — do not await
      }
    } catch (err) {
      log(`${err.message} — retrying in ${Math.round(backoff / 1000)}s`);
      await wait(backoff);
      backoff = Math.min(30_000, backoff * 2);
      lastHello = 0; // re-announce ourselves once we are back
    }
  }
}

main();
