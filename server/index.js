'use strict';

/**
 * BFF Photo Booth — host server.
 *
 * Runs on the MacBook that owns the printer. Guests join the same Wi-Fi,
 * open http://<mac-lan-ip>:8080 on their phone, pick four photos, and the
 * composed 300 DPI print is POSTed back here. This process is the only
 * thing that talks to the printer: it writes the PNG to ./prints and hands
 * it to the local CUPS queue with `lp`.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const cups = require('./cups');
const config = require('./config');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DRY_RUN = process.env.DRY_RUN === '1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PRINTS_DIR = process.env.PRINTS_DIR || path.join(__dirname, '..', 'prints');
const MAX_BODY = 32 * 1024 * 1024; // 32 MB — a 300 DPI 4x6 PNG lands well under this
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 30 };

fs.mkdirSync(PRINTS_DIR, { recursive: true });

/** jobId -> { id, file, copies, layout, status, createdAt, cupsJobId, error } */
const jobs = new Map();
const MAX_JOB_HISTORY = 500; // a long party should not grow the map forever
const hits = new Map(); // ip -> timestamps

// ---------------------------------------------------------------- helpers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function clientIp(req) {
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (recent.length >= RATE_LIMIT.max) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, 256 * 1024);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Returns the extension for a supported image, or null. */
function imageKind(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      out.push({ iface: name, address: addr.address });
    }
  }
  // en0 (Wi-Fi on a MacBook) first — that is the one guests can reach.
  return out.sort((a, b) => (a.iface === 'en0' ? -1 : b.iface === 'en0' ? 1 : 0));
}

function activePort() {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : PORT;
}

function primaryUrl() {
  const lan = lanAddresses()[0];
  return `http://${lan ? lan.address : 'localhost'}:${activePort()}`;
}

// ---------------------------------------------------------------- printing

async function resolvePrinter(requested) {
  const cfg = config.load();
  if (DRY_RUN) return { name: requested || cfg.printer || 'Dry-Run-Printer', error: null };

  const { printers, default: fallback, error } = await cups.listPrinters();
  if (error && !printers.length) return { name: null, error };

  const wanted = requested || cfg.printer || fallback;
  if (!wanted) return { name: null, error: 'No printer is configured on this Mac.' };

  // Only ever pass a name CUPS itself reported back to us.
  const match = printers.find((p) => p.name === wanted);
  if (!match) return { name: null, error: `Unknown printer "${wanted}".` };
  return { name: match.name, error: null };
}

async function sendToQueue(job) {
  const cfg = config.load();
  job.status = 'printing';

  if (DRY_RUN) {
    job.status = 'queued';
    job.cupsJobId = `dry-run-${job.id.slice(0, 6)}`;
    job.printedAt = Date.now();
    return job;
  }

  const { name, error } = await resolvePrinter(job.printer);
  if (!name) {
    job.status = 'failed';
    job.error = error;
    return job;
  }

  const options = { 'print-quality': '5' };
  if (cfg.fitToPage) options['fit-to-page'] = 'true';

  const result = await cups.print(job.file, {
    printer: name,
    copies: job.copies,
    media: job.media || cfg.media,
    options,
  });

  if (!result.ok) {
    job.status = 'failed';
    job.error = result.error;
  } else {
    job.status = 'queued';
    job.printer = name;
    job.cupsJobId = result.jobId;
    job.printedAt = Date.now();
  }
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    layout: job.layout,
    copies: job.copies,
    printer: job.printer || null,
    cupsJobId: job.cupsJobId || null,
    error: job.error || null,
    createdAt: job.createdAt,
    guest: job.guest || null,
    image: `/prints/${path.basename(job.file)}`,
  };
}

// ---------------------------------------------------------------- routes

async function handleApi(req, res, url) {
  const cfg = config.load();

  if (url.pathname === '/api/session' && req.method === 'GET') {
    return sendJson(res, 200, {
      boothName: cfg.boothName,
      message: cfg.message,
      maxCopies: cfg.maxCopies,
      defaultCopies: cfg.copies,
      printingEnabled: cfg.printingEnabled,
      requireApproval: cfg.requireApproval,
      dryRun: DRY_RUN,
    });
  }

  if (url.pathname === '/api/printers' && req.method === 'GET') {
    if (DRY_RUN) {
      return sendJson(res, 200, {
        dryRun: true,
        cupsAvailable: false,
        printers: [{ name: 'Dry-Run-Printer', state: 'idle', ready: true, detail: 'DRY_RUN=1 — nothing is sent to a real queue.' }],
        default: 'Dry-Run-Printer',
      });
    }
    const [{ printers, default: fallback, error }, cupsAvailable] = await Promise.all([
      cups.listPrinters(),
      cups.available(),
    ]);
    return sendJson(res, 200, { dryRun: false, cupsAvailable, printers, default: cfg.printer || fallback, error });
  }

  if (url.pathname === '/api/queue' && req.method === 'GET') {
    const cupsJobs = DRY_RUN ? [] : await cups.listJobs();
    const recent = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40).map(publicJob);
    return sendJson(res, 200, { cupsJobs, jobs: recent });
  }

  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { config: cfg, dryRun: DRY_RUN, urls: lanAddresses().map((l) => `http://${l.address}:${activePort()}`) });
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    const patch = await readJson(req);
    return sendJson(res, 200, { config: config.save(patch) });
  }

  if (url.pathname === '/api/print' && req.method === 'POST') {
    if (!cfg.printingEnabled) {
      return sendJson(res, 503, { ok: false, error: 'Printing is switched off for this booth — save the photo to your phone instead.' });
    }
    if (rateLimited(req)) {
      return sendJson(res, 429, { ok: false, error: 'That is a lot of prints. Give the printer a minute.' });
    }

    const body = await readBody(req);
    const kind = imageKind(body);
    if (!kind) {
      return sendJson(res, 400, { ok: false, error: 'Expected a PNG or JPEG image body.' });
    }

    const layout = (url.searchParams.get('layout') || 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
    const guest = (url.searchParams.get('guest') || '').replace(/[^\p{L}\p{N} '._-]/gu, '').slice(0, 40);
    const copies = Math.max(1, Math.min(cfg.maxCopies, Number(url.searchParams.get('copies')) || cfg.copies));
    const requestedPrinter = (url.searchParams.get('printer') || '').slice(0, 128) || null;

    const id = crypto.randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(PRINTS_DIR, `${stamp}_${layout}_${id.slice(0, 8)}.${kind}`);
    await fsp.writeFile(file, body);

    const job = {
      id,
      file,
      layout,
      guest,
      copies,
      printer: requestedPrinter,
      media: null,
      status: cfg.requireApproval ? 'awaiting-approval' : 'pending',
      createdAt: Date.now(),
      cupsJobId: null,
      error: null,
    };
    jobs.set(id, job);
    while (jobs.size > MAX_JOB_HISTORY) jobs.delete(jobs.keys().next().value);

    if (!cfg.requireApproval) await sendToQueue(job);

    const status = job.status === 'failed' ? 502 : 200;
    return sendJson(res, status, { ok: job.status !== 'failed', job: publicJob(job) });
  }

  if (url.pathname === '/api/approve' && req.method === 'POST') {
    const { id } = await readJson(req);
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job.' });
    await sendToQueue(job);
    return sendJson(res, job.status === 'failed' ? 502 : 200, { ok: job.status !== 'failed', job: publicJob(job) });
  }

  if (url.pathname === '/api/reject' && req.method === 'POST') {
    const { id } = await readJson(req);
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job.' });
    job.status = 'rejected';
    return sendJson(res, 200, { ok: true, job: publicJob(job) });
  }

  if (url.pathname === '/api/cancel' && req.method === 'POST') {
    const { cupsJobId } = await readJson(req);
    if (!cupsJobId || !/^[\w.-]+$/.test(String(cupsJobId))) {
      return sendJson(res, 400, { ok: false, error: 'Bad job id.' });
    }
    if (DRY_RUN) return sendJson(res, 200, { ok: true, dryRun: true });
    const result = await cups.cancel(cupsJobId);
    return sendJson(res, result.ok ? 200 : 502, result);
  }

  if (url.pathname === '/api/job' && req.method === 'GET') {
    const job = jobs.get(url.searchParams.get('id'));
    if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job.' });
    return sendJson(res, 200, { ok: true, job: publicJob(job) });
  }

  return sendJson(res, 404, { ok: false, error: 'No such endpoint.' });
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/host') rel = '/host.html';

  const root = rel.startsWith('/prints/') ? PRINTS_DIR : PUBLIC_DIR;
  const relative = rel.startsWith('/prints/') ? rel.slice('/prints/'.length) : rel.slice(1);
  const file = path.resolve(root, relative);

  if (!file.startsWith(path.resolve(root))) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': root === PRINTS_DIR ? 'public, max-age=300' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
    else res.writeHead(405).end('Method not allowed');
  } catch (err) {
    const status = err.status || 500;
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message || 'Server error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const cfg = config.load();
  const urls = lanAddresses();
  console.log('');
  console.log(`  ${cfg.boothName}`);
  console.log(`  ${'-'.repeat(cfg.boothName.length)}`);
  console.log(`  Guests scan or type:  ${primaryUrl()}`);
  for (const lan of urls.slice(1)) console.log(`  also reachable at:    http://${lan.address}:${activePort()}  (${lan.iface})`);
  console.log(`  Host screen:          ${primaryUrl()}/host`);
  if (DRY_RUN) console.log('  DRY_RUN=1 — composites are saved to ./prints but never sent to a printer.');
  console.log('');
});

module.exports = { server };
