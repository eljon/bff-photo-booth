'use strict';

/**
 * BFF Photo Booth — server.
 *
 * Runs in one of two shapes:
 *
 *   booth  (default) — runs on the MacBook that owns the printer. It serves
 *                      the guest app and prints locally with `lp`. Reachable
 *                      over the LAN, or from anywhere via `--tunnel`.
 *
 *   relay  (MODE=relay) — runs on any public host. It serves the guest app
 *                      and parks finished prints; the MacBook runs
 *                      `npm run agent`, which makes outbound calls only:
 *                      long-poll for a job, fetch it, print it, report back.
 *                      The Mac needs no inbound ports and no shared network
 *                      with the guests.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const cups = require('./cups');
const config = require('./config');
const tunnel = require('./tunnel');
const build = require('./version');
const { openInBrowser } = require('./open-browser');

const MODE = process.env.MODE === 'relay' ? 'relay' : 'booth';
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DRY_RUN = process.env.DRY_RUN === '1';
const BOOTH_TOKEN = process.env.BOOTH_TOKEN || null;
const TUNNEL_ARG = process.argv.find((arg) => arg.startsWith('--tunnel')) || '';
const NO_TUNNEL = process.argv.includes('--no-tunnel');
const TUNNEL_KINDS = ['ssh', 'tailscale', 'ngrok', 'named', 'cloudflared'];

// A tunnel chosen once is remembered, so the command to start the booth stops
// changing depending on what you picked weeks ago.
const askedKind = (TUNNEL_ARG.split('=')[1] || process.env.TUNNEL || '').toLowerCase();
const storedKind = config.load().tunnel || '';
const rememberedKind = NO_TUNNEL ? '' : storedKind;
const TUNNEL_CHOICE = TUNNEL_KINDS.includes(askedKind) ? askedKind : rememberedKind;
const TUNNEL_PREFER = TUNNEL_KINDS.includes(TUNNEL_CHOICE) ? TUNNEL_CHOICE : 'auto';
const WANT_TUNNEL = !NO_TUNNEL && (Boolean(TUNNEL_ARG) || Boolean(process.env.TUNNEL) || Boolean(rememberedKind));

// Remember an explicit choice for next time; --no-tunnel forgets it.
if (MODE !== 'relay') {
  if (TUNNEL_KINDS.includes(askedKind) && askedKind !== storedKind) config.save({ tunnel: askedKind });
  else if (NO_TUNNEL && storedKind) config.save({ tunnel: '' });
}
// A booth you can reach from anywhere wants its control screen up straight
// away. --open forces it for a plain LAN start, --no-open suppresses it.
const NO_OPEN = process.argv.includes('--no-open') || process.env.NO_OPEN === '1';
const FORCE_OPEN = process.argv.includes('--open');
const TUNNEL_WAIT_MS = Number(process.env.TUNNEL_WAIT_MS) || 30_000;

/** Set when a tunnel was asked for but never came up, so the banner can say so. */
let tunnelFailed = false;
const PUBLIC_URL = process.env.PUBLIC_URL || null;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PRINTS_DIR = process.env.PRINTS_DIR || path.join(__dirname, '..', 'prints');
const MAX_BODY = 32 * 1024 * 1024; // 32 MB — a 300 DPI 4x6 page lands well under this
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 30 };
const CLAIM_TIMEOUT_MS = 2 * 60 * 1000; // an agent that goes quiet loses its job
const AGENT_ONLINE_MS = 90 * 1000;

if (MODE === 'relay' && !BOOTH_TOKEN) {
  console.error('MODE=relay needs BOOTH_TOKEN set — the booth agent and the host screen sign in with it.');
  console.error('Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
  process.exit(1);
}

try {
  fs.mkdirSync(PRINTS_DIR, { recursive: true });
  fs.accessSync(PRINTS_DIR, fs.constants.W_OK);
} catch (err) {
  console.error(`Cannot write prints to ${PRINTS_DIR}: ${err.message}`);
  console.error('Point PRINTS_DIR somewhere writable (a mounted volume needs to be writable by this user).');
  process.exit(1);
}

/** jobId -> job record. See publicJob() for the shape guests and hosts see. */
const jobs = new Map();
const MAX_JOB_HISTORY = 500; // a long party should not grow the map forever
const hits = new Map(); // ip -> print timestamps

/**
 * id -> { buf, type, origin, created }. Photos a guest chose to share to
 * Facebook, held in memory just long enough for Facebook's scraper to fetch the
 * link preview. Public by design (that is the whole point of a share link), so
 * ids are random and the store is small and short-lived.
 */
const shares = new Map();
const MAX_SHARES = 60;
const SHARE_TTL_MS = 2 * 60 * 60 * 1000; // two hours — long enough to post, then gone

function pruneShares() {
  const now = Date.now();
  for (const [id, s] of shares) if (now - s.created > SHARE_TTL_MS) shares.delete(id);
  while (shares.size > MAX_SHARES) shares.delete(shares.keys().next().value);
}
const agentWaiters = new Set(); // long-poll resolvers waiting for work

/** What the Mac-side agent last told us about itself. */
const agent = { lastSeen: 0, printers: [], name: null, dryRun: false };

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
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (forwarded || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** A guest-supplied origin is only trusted if it is a bare http(s) origin. */
function safeOrigin(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Constant-time compare that tolerates length differences. */
function secretsMatch(a, b) {
  if (!a || !b) return false;
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
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

/**
 * The addresses this booth answers on, split by how far they actually reach.
 * A LAN address only works for phones on this same Wi-Fi; the public one works
 * from anywhere. Keeping them apart matters — labelling a LAN address as the
 * guest link is a promise the booth cannot keep.
 */
function addresses() {
  const lan = lanAddresses().map((entry) => `http://${entry.address}:${activePort()}`);
  return {
    public: PUBLIC_URL || tunnel.url() || null,
    lan: lan.length ? lan : [`http://localhost:${activePort()}`],
  };
}

/** The address guests should use, best first. */
function joinUrls() {
  const { public: publicUrl, lan } = addresses();
  return publicUrl ? [publicUrl, ...lan] : lan;
}

/** True once the booth is reachable from outside the local network. */
function isExposed() {
  return MODE === 'relay' || Boolean(PUBLIC_URL || tunnel.url());
}

/**
 * Off unless the host deliberately turns it on. An older config may still say
 * 'auto', which is no longer a thing — only an explicit true counts.
 */
function guestKeyRequired() {
  return config.load().guestKeyRequired === true;
}

/** Guests print with a key that rides along in the QR link. */
function guestAuthorised(req, url) {
  if (!guestKeyRequired()) return true;
  const supplied = req.headers['x-booth-key'] || url.searchParams.get('k');
  return secretsMatch(supplied, config.load().accessKey);
}

/** Host controls (and the agent) need the booth token once we are public. */
function presentedToken(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  return req.headers['x-booth-token'] || bearer;
}

/**
 * The host screen is open unless you deliberately set BOOTH_TOKEN. A tunnel URL
 * is unguessable enough for a party; relay mode always has a token, because a
 * permanent public address is a different proposition.
 */
function hostAuthorised(req) {
  if (!BOOTH_TOKEN) return true;
  return secretsMatch(presentedToken(req), BOOTH_TOKEN);
}

function agentAuthorised(req) {
  if (!BOOTH_TOKEN) return false; // relay mode always has an explicit token
  return secretsMatch(presentedToken(req), BOOTH_TOKEN);
}

const agentOnline = () => Date.now() - agent.lastSeen < AGENT_ONLINE_MS;

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

/** Wake any agent that is parked on a long poll. */
function notifyAgents() {
  for (const resolve of agentWaiters) resolve();
  agentWaiters.clear();
}

/**
 * Move a job towards the printer. In booth mode that means calling `lp` right
 * here; in relay mode it means making the job claimable by the Mac's agent.
 */
async function sendToQueue(job) {
  const cfg = config.load();

  if (MODE === 'relay') {
    job.status = 'pending';
    job.error = null;
    notifyAgents();
    return job;
  }

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

function imageUrl(job) {
  return `/prints/${path.basename(job.file)}?t=${job.token}`;
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
    image: imageUrl(job),
  };
}

/** Oldest job an agent may take, requeueing anything a dead agent claimed. */
function nextClaimableJob() {
  const now = Date.now();
  const ordered = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const job of ordered) {
    if (job.status === 'claimed' && now - (job.claimedAt || 0) > CLAIM_TIMEOUT_MS) {
      job.status = 'pending';
      job.error = null;
    }
    if (job.status === 'pending') return job;
  }
  return null;
}

// ---------------------------------------------------------------- agent API

async function handleAgentApi(req, res, url) {
  if (MODE !== 'relay') return sendJson(res, 404, { ok: false, error: 'This booth prints locally; it has no agent API.' });
  if (!agentAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Bad booth token.' });

  const cfg = config.load();

  // The Mac says hello and tells us which printers it can actually reach.
  if (url.pathname === '/api/agent/hello' && req.method === 'POST') {
    const body = await readJson(req);
    agent.lastSeen = Date.now();
    agent.name = String(body.name || 'booth agent').slice(0, 60);
    agent.dryRun = Boolean(body.dryRun);
    agent.printers = Array.isArray(body.printers)
      ? body.printers.slice(0, 40).map((p) => ({
          name: String(p.name || '').slice(0, 128),
          state: String(p.state || '').slice(0, 60),
          ready: Boolean(p.ready),
        })).filter((p) => p.name)
      : [];
    return sendJson(res, 200, { ok: true, config: cfg });
  }

  // Long poll: hand over the next job, or hold the connection until one lands.
  if (url.pathname === '/api/agent/jobs' && req.method === 'GET') {
    agent.lastSeen = Date.now();
    const waitMs = Math.min(50_000, Math.max(0, Number(url.searchParams.get('wait')) || 0) * 1000);

    const claim = () => {
      const job = nextClaimableJob();
      if (!job) return null;
      job.status = 'claimed';
      job.claimedAt = Date.now();
      return {
        id: job.id,
        copies: job.copies,
        printer: job.printer || cfg.printer,
        media: job.media || cfg.media,
        fitToPage: cfg.fitToPage,
        layout: job.layout,
        image: imageUrl(job),
      };
    };

    const ready = claim();
    if (ready) return sendJson(res, 200, { ok: true, job: ready });
    if (!waitMs) return sendJson(res, 200, { ok: true, job: null });

    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        agentWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      agentWaiters.add(finish);
      res.on('close', finish);
    });
    if (res.writableEnded || res.destroyed) return undefined;
    agent.lastSeen = Date.now();
    return sendJson(res, 200, { ok: true, job: claim() });
  }

  // The Mac reports what CUPS said.
  if (url.pathname === '/api/agent/result' && req.method === 'POST') {
    agent.lastSeen = Date.now();
    const body = await readJson(req);
    const job = jobs.get(body.id);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job.' });

    if (body.ok) {
      job.status = 'queued';
      job.cupsJobId = body.cupsJobId ? String(body.cupsJobId).slice(0, 120) : null;
      job.printer = body.printer ? String(body.printer).slice(0, 128) : job.printer;
      job.printedAt = Date.now();
      job.error = null;
    } else {
      job.status = 'failed';
      job.error = String(body.error || 'The booth printer refused the job.').slice(0, 300);
    }
    return sendJson(res, 200, { ok: true, job: publicJob(job) });
  }

  return sendJson(res, 404, { ok: false, error: 'No such endpoint.' });
}

// ---------------------------------------------------------------- guest API

async function handleApi(req, res, url) {
  if (url.pathname.startsWith('/api/agent/')) return handleAgentApi(req, res, url);

  const cfg = config.load();

  // Cheap unauthenticated probe for platform health checks and uptime pings.
  if (url.pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      version: build.version,
      commit: build.commit,
      mode: MODE,
      agentOnline: MODE === 'relay' ? agentOnline() : true,
      printingEnabled: cfg.printingEnabled,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }

  if (url.pathname === '/api/session' && req.method === 'GET') {
    return sendJson(res, 200, {
      version: build.version,
      boothName: cfg.boothName,
      message: cfg.message,
      maxCopies: cfg.maxCopies,
      defaultCopies: cfg.copies,
      shareHashtag: cfg.shareHashtag, // Facebook caption; client defaults to #bff2026
      printingEnabled: cfg.printingEnabled,
      requireApproval: cfg.requireApproval,
      keyRequired: guestKeyRequired(),
      remote: MODE === 'relay',
      dryRun: DRY_RUN,
    });
  }

  if (url.pathname === '/api/printers' && req.method === 'GET') {
    if (MODE === 'relay') {
      return sendJson(res, 200, {
        dryRun: agent.dryRun,
        remote: true,
        agentOnline: agentOnline(),
        cupsAvailable: agentOnline(),
        printers: agent.printers,
        default: cfg.printer || (agent.printers[0] ? agent.printers[0].name : null),
      });
    }
    if (DRY_RUN) {
      return sendJson(res, 200, {
        dryRun: true,
        agentOnline: true,
        cupsAvailable: false,
        printers: [{ name: 'Dry-Run-Printer', state: 'idle', ready: true }],
        default: 'Dry-Run-Printer',
      });
    }
    const [{ printers, default: fallback, error }, cupsAvailable] = await Promise.all([
      cups.listPrinters(),
      cups.available(),
    ]);
    return sendJson(res, 200, { dryRun: false, agentOnline: true, cupsAvailable, printers, default: cfg.printer || fallback, error });
  }

  if (url.pathname === '/api/queue' && req.method === 'GET') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const cupsJobs = MODE === 'relay' || DRY_RUN ? [] : await cups.listJobs();
    const recent = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40).map(publicJob);
    return sendJson(res, 200, { cupsJobs, jobs: recent, agent: { online: agentOnline(), name: agent.name, lastSeen: agent.lastSeen } });
  }

  if (url.pathname === '/api/config' && req.method === 'GET') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    return sendJson(res, 200, {
      config: cfg,
      version: build.version,
      commit: build.commit,
      mode: MODE,
      dryRun: DRY_RUN,
      exposed: isExposed(),
      keyRequired: guestKeyRequired(),
      agent: { online: agentOnline(), name: agent.name, printers: agent.printers },
      pinned: config.pinnedKeys(),
      urls: joinUrls(),
    });
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const patch = await readJson(req);
    return sendJson(res, 200, { config: config.save(patch) });
  }

  if (url.pathname === '/api/print' && req.method === 'POST') {
    if (!cfg.printingEnabled) {
      return sendJson(res, 503, { ok: false, error: 'Printing is switched off for this booth — save the photo to your phone instead.' });
    }
    if (!guestAuthorised(req, url)) {
      return sendJson(res, 401, { ok: false, error: 'Scan the booth QR code to print.' });
    }
    if (MODE === 'relay' && !agentOnline()) {
      return sendJson(res, 503, { ok: false, error: 'The booth printer is offline right now. Save the photo and try again in a minute.' });
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

    // The guest app rotates the sheet to match the photos. Only honour that when
    // the host is on 4x6/6x4 photo paper; a host who chose Letter/A4 keeps it.
    // orient is never passed to lp directly — it only selects a known media.
    const orient = url.searchParams.get('orient') === 'landscape' ? 'landscape' : 'portrait';
    const photoPaper = cfg.media === 'Custom.4x6in' || cfg.media === 'Custom.6x4in';
    const jobMedia = photoPaper
      ? (orient === 'landscape' ? 'Custom.6x4in' : 'Custom.4x6in')
      : null;

    const id = crypto.randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(PRINTS_DIR, `${stamp}_${layout}_${id.slice(0, 8)}.${kind}`);
    await fsp.writeFile(file, body);

    const job = {
      id,
      token: crypto.randomBytes(12).toString('hex'),
      file,
      layout,
      guest,
      copies,
      printer: requestedPrinter,
      media: jobMedia,
      status: cfg.requireApproval ? 'awaiting-approval' : 'pending',
      createdAt: Date.now(),
      claimedAt: 0,
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
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const { id } = await readJson(req);
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job.' });
    await sendToQueue(job);
    return sendJson(res, job.status === 'failed' ? 502 : 200, { ok: job.status !== 'failed', job: publicJob(job) });
  }

  if (url.pathname === '/api/reject' && req.method === 'POST') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const { id } = await readJson(req);
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job.' });
    job.status = 'rejected';
    return sendJson(res, 200, { ok: true, job: publicJob(job) });
  }

  if (url.pathname === '/api/cancel' && req.method === 'POST') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const { cupsJobId } = await readJson(req);
    if (!cupsJobId || !/^[\w.-]+$/.test(String(cupsJobId))) {
      return sendJson(res, 400, { ok: false, error: 'Bad job id.' });
    }
    if (MODE === 'relay') {
      return sendJson(res, 409, { ok: false, error: 'Cancel this one on the booth Mac — the queue lives there.' });
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

  // Park a photo the guest wants to post to Facebook, so we can hand Facebook a
  // public link that shows it (see the /s/ share page). Returns just an id.
  if (url.pathname === '/api/share' && req.method === 'POST') {
    if (rateLimited(req)) {
      return sendJson(res, 429, { ok: false, error: 'One moment — try that again in a bit.' });
    }
    const body = await readBody(req);
    const kind = imageKind(body);
    if (!kind) return sendJson(res, 400, { ok: false, error: 'Expected a PNG or JPEG image body.' });
    pruneShares();
    const id = crypto.randomUUID().replace(/-/g, '');
    shares.set(id, {
      buf: body,
      type: kind === 'png' ? 'image/png' : 'image/jpeg',
      origin: safeOrigin(url.searchParams.get('origin')),
      created: Date.now(),
    });
    return sendJson(res, 200, { ok: true, id });
  }

  return sendJson(res, 404, { ok: false, error: 'No such endpoint.' });
}

/** Base URL Facebook should use for absolute og:image links. */
function shareBase(req, share) {
  if (share && share.origin) return share.origin;
  const host = req.headers.host || `localhost:${activePort()}`;
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.|\[?::1)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * The public share page. Facebook fetches /s/{id} and reads its Open Graph tags
 * to build the link preview (the guest's photo as og:image); a person who opens
 * it just sees the photo. /s/{id}/img serves the image bytes.
 */
function handleShare(req, res, url) {
  pruneShares();
  const match = url.pathname.match(/^\/s\/([a-f0-9]{16,40})(\/img)?$/i);
  const share = match ? shares.get(match[1].toLowerCase()) : null;
  if (!match || !share) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('This shared photo has expired.');
    return;
  }

  if (match[2]) {
    res.writeHead(200, { 'content-type': share.type, 'content-length': share.buf.length, 'cache-control': 'public, max-age=3600' });
    res.end(req.method === 'HEAD' ? undefined : share.buf);
    return;
  }

  const cfg = config.load();
  const imgUrl = `${shareBase(req, share)}/s/${match[1].toLowerCase()}/img`;
  const title = escapeHtml(cfg.boothName || 'Photo Booth');
  const desc = escapeHtml(cfg.shareHashtag || '#bff2026');
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${imgUrl}">
<meta property="og:image:alt" content="${title}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${imgUrl}">
<title>${title}</title>
<style>html,body{margin:0;height:100%;background:#15111b;display:flex;align-items:center;justify-content:center}img{max-width:100%;max-height:100vh}</style>
</head><body><img src="${imgUrl}" alt="${title}"></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' });
  res.end(req.method === 'HEAD' ? undefined : html);
}

// ---------------------------------------------------------------- static

/** A print is visible to its own guest (via the job token) and to the host. */
function mayReadPrint(req, url, filename) {
  if (!isExposed()) return true;
  if (hostAuthorised(req)) return true;
  const token = url.searchParams.get('t');
  if (!token) return false;
  for (const job of jobs.values()) {
    if (path.basename(job.file) === filename) return secretsMatch(token, job.token);
  }
  return false;
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/host') rel = '/host.html';

  const fromPrints = rel.startsWith('/prints/');
  const root = fromPrints ? PRINTS_DIR : PUBLIC_DIR;
  const relative = fromPrints ? rel.slice('/prints/'.length) : rel.slice(1);
  const file = path.resolve(root, relative);

  if (!file.startsWith(path.resolve(root))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (fromPrints && !mayReadPrint(req, url, path.basename(file))) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }

  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': fromPrints ? 'private, max-age=300' : 'no-cache',
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
    else if (url.pathname.startsWith('/s/') && (req.method === 'GET' || req.method === 'HEAD')) handleShare(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
    else res.writeHead(405).end('Method not allowed');
  } catch (err) {
    const status = err.status || 500;
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message || 'Server error' });
    else res.end();
  }
});

function banner() {
  const cfg = config.load();
  const { public: publicUrl, lan } = addresses();
  const key = guestKeyRequired() ? `/?k=${cfg.accessKey}` : '';
  const title = `${cfg.boothName}${MODE === 'relay' ? ' · relay' : ''}`;

  console.log('');
  console.log(`  ${title}  v${build.label}`);
  console.log(`  ${'-'.repeat(title.length + build.label.length + 4)}`);

  if (publicUrl) {
    console.log(`  Guests scan or type:  ${publicUrl}${key}   <- works on any network`);
    for (const url of lan) console.log(`  On this Wi-Fi only:   ${url}${key}`);
  } else {
    for (const url of lan) console.log(`  On this Wi-Fi only:   ${url}${key}`);
  }
  // Always the local address: this screen is for whoever is at the Mac, and
  // localhost never waits on DNS or a tunnel.
  console.log(`  Host screen:          http://localhost:${activePort()}/host`);

  if (!publicUrl && tunnelFailed) {
    console.log('');
    console.log('  The tunnel did not come up, so guests can only reach this booth');
    console.log('  on your own Wi-Fi. Stop with Control-C and try npm run tunnel again.');
  } else if (!publicUrl) {
    console.log('');
    console.log('  Guests must be on the same Wi-Fi as this Mac.');
    console.log('  To let them join from anywhere — mobile data, another network —');
    console.log('  stop this with Control-C and run:  npm run tunnel');
  }

  if (MODE === 'relay') console.log('  Waiting for the booth Mac to connect (npm run agent).');
  if (DRY_RUN) console.log('  DRY_RUN=1 — composites are saved but never sent to a printer.');

  if (isExposed() && !BOOTH_TOKEN) {
    console.log('  Host screen is open to anyone with that link. Set BOOTH_TOKEN to require a password.');
  }
  if (publicUrl && WANT_TUNNEL && !tunnel.isPersistent()) {
    console.log('  This link is temporary. For one that survives restarts and sleep, see docs/PERSISTENT-LINK.md');
  }
  console.log('');
}

server.listen(PORT, HOST, async () => {
  if (WANT_TUNNEL) {
    console.log('\n  Opening a public tunnel…');
    const result = await tunnel.open(activePort(), {
      prefer: TUNNEL_PREFER,
      onEvent: (event) => {
        if (event.event === 'error') {
          console.log(`  The tunnel exited straight away. It said:\n    ${event.detail}`);
        }
        if (event.event === 'restarting') {
          console.log(event.fixed
            ? `  Tunnel dropped — reconnecting in ${event.inSeconds}s. The guest link does not change.`
            : `  Tunnel dropped — reconnecting in ${event.inSeconds}s. A quick tunnel gets a NEW guest link;\n  open the host screen again for the new QR code.`);
        }
        if (event.event === 'url' && event.previous) {
          console.log(`  New guest link: ${event.url}${guestKeyRequired() ? `/?k=${config.load().accessKey}` : ''}`);
        }
      },
    });
    if (!result.url) {
      tunnelFailed = true;
      console.log(`  Tunnel unavailable: ${result.error}`);
    } else {
      console.log(`  ${result.label}${tunnel.isPersistent() ? '' : ' — this address changes every launch'}`);
    }
  }

  banner();

  // The host screen is for whoever is sitting at this Mac, so open it on
  // localhost. Going through the tunnel would mean waiting on DNS that this
  // machine may not see for a minute even while phones resolve it fine.
  const shouldOpen = MODE !== 'relay' && !NO_OPEN && (FORCE_OPEN || isExposed());
  if (shouldOpen) {
    const hostUrl = `http://localhost:${activePort()}/host`;
    const opened = await openInBrowser(hostUrl);
    console.log(opened ? '  Opened the host screen in your browser.' : `  Open the host screen yourself: ${hostUrl}`);
    console.log('');
  }

  // Confirm the guest link in the background — never make anyone wait for it.
  const publicUrl = tunnel.url() || PUBLIC_URL;
  if (publicUrl && WANT_TUNNEL) {
    tunnel.waitUntilLive(publicUrl, { timeoutMs: TUNNEL_WAIT_MS }).then(({ live, attempts }) => {
      console.log(live
        ? `  Guest link answered after ${attempts}s — ready to scan.`
        : '  Could not reach the guest link from this Mac. That is usually local DNS catching up;\n  try it on a phone, and give it a minute before worrying.');
    });
  }
});

process.on('SIGINT', () => {
  tunnel.close();
  process.exit(0);
});

module.exports = { server };
