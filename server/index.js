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
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const cups = require('./cups');
const config = require('./config');
const { VoucherStore, LEN: VOUCHER_LEN } = require('./vouchers');
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

// Guest-only: serve the guest app on a machine that is not the printer. No host
// screen, no host-control APIs, and printing is off unless --print-host points
// at a booth that can print. Usually launched via `npm run guest`, which also
// updates to the latest code first. See server/guest.js.
const GUEST_ONLY = process.argv.includes('--guest-only') || process.env.GUEST_ONLY === '1';

// Optional upstream booth (or relay) that owns a printer. When set in guest-only
// mode, print traffic is proxied there so guests can still print. Ignored outside
// guest-only mode — a full booth prints locally.
const PRINT_HOST_ARG = process.argv.find((arg) => arg.startsWith('--print-host=')) || '';
const PRINT_HOST_RAW = (PRINT_HOST_ARG.split('=')[1] || process.env.PRINT_HOST || '').trim();
let PRINT_HOST = null;
if (GUEST_ONLY && PRINT_HOST_RAW) {
  try {
    const parsed = new URL(PRINT_HOST_RAW);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
    PRINT_HOST = parsed.origin; // drop any path/query — we join our own paths onto it
  } catch {
    console.error(`  --print-host must be an http(s) URL; got "${PRINT_HOST_RAW}". Starting without host printing.`);
  }
}

// Host controls do not exist on a guest-only booth; the guest app never calls
// these, so a 404 keeps them off a public tunnel with no operator behind it.
const GUEST_ONLY_BLOCKED = new Set(['/api/queue', '/api/config', '/api/approve', '/api/reject', '/api/cancel']);
// Print traffic a guest-only booth forwards to --print-host, when one is set.
const PROXIED_API = new Set(['/api/printers', '/api/print', '/api/job']);

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

// Where the host screen sends operators to download the printer helper app. Point this at
// wherever CI publishes the installers (GitHub Releases by default). Per-OS filenames are
// resolved by the host page from the release tag; override the base for a private mirror.
const HELPER_DOWNLOAD_BASE = process.env.HELPER_DOWNLOAD_BASE
  || 'https://github.com/eljon/bff-photo-booth/releases/latest/download';
const HELPER_RELEASES_PAGE = process.env.HELPER_RELEASES_PAGE
  || 'https://github.com/eljon/bff-photo-booth/releases/latest';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PRINTS_DIR = process.env.PRINTS_DIR || path.join(__dirname, '..', 'prints');
const MAX_BODY = 32 * 1024 * 1024; // 32 MB — a 300 DPI 4x6 page lands well under this
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 30 };
const CLAIM_TIMEOUT_MS = 2 * 60 * 1000; // an agent that goes quiet loses its job
const AGENT_ONLINE_MS = 90 * 1000;

if (MODE === 'relay' && !BOOTH_TOKEN) {
  console.error('MODE=relay needs BOOTH_TOKEN set. The booth agent and the host screen sign in with it.');
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
let printSeq = 0; // hands each print a running number: P1, P2, P3… (survives restarts)
const MAX_JOB_HISTORY = 1500; // a long party should not grow the map forever
const PRINT_MS = Number(process.env.PRINT_MS) || 30 * 1000; // seed estimate of one print's time; refined from real runs
const MAX_PRINT_MS = 5 * 60 * 1000; // a print stuck longer than this is treated as done
const DRY_PRINT_MS = Number(process.env.DRY_PRINT_MS) || PRINT_MS; // simulated print time (dry run)
const hits = new Map(); // ip -> print timestamps
const agentWaiters = new Set(); // long-poll resolvers waiting for work

// Connected computers (agents), keyed by a stable agent id. One host can run several
// printers by connecting several Macs/PCs — each runs `npm run agent` and reports its own
// printers here. An agent that sends no id (e.g. a single-Mac setup) uses the id 'default'.
const agents = new Map(); // id -> { id, name, printers:[{name,state,ready}], lastSeen, dryRun }

/** Agents seen within the online window, most-recent first. */
function onlineAgents() {
  const now = Date.now();
  return [...agents.values()]
    .filter((a) => now - a.lastSeen < AGENT_ONLINE_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen);
}
/** One agent's friendly name, for labels on the board and the guest app. */
function agentName(id) {
  if (!id || id === 'local') return 'This Mac';
  const a = agents.get(id);
  return (a && a.name) || 'a computer';
}

/** A compact summary of the connected computers, for the host screen and the board. */
function agentSummary() {
  const on = onlineAgents();
  const name = on.length === 1 ? on[0].name : on.length ? `${on.length} computers` : null;
  return {
    online: on.length > 0,
    count: on.length,
    name,
    lastSeen: on[0] ? on[0].lastSeen : 0,
    agents: on.map((a) => ({ id: a.id, name: a.name, dryRun: a.dryRun, printers: a.printers })),
  };
}

// ---------------------------------------------------------------- persistence
// In relay (cloud) mode the queue lives ON DISK, so a guest's print is safe on the
// server through a restart or redeploy — not just in memory. The composed image is
// already written to PRINTS_DIR; here we persist the job metadata beside it in
// queue.json and reload it on boot. (Booth/LAN mode prints straight to CUPS and is
// left in memory, so a restart never risks reprinting what already came out.)
const QUEUE_FILE = path.join(PRINTS_DIR, 'queue.json');
const PERSIST_FIELDS = ['id', 'token', 'file', 'layout', 'guest', 'printNo', 'orient', 'copies', 'printer', 'agentId', 'voucher', 'media', 'status', 'createdAt', 'claimedAt', 'printedAt', 'doneAt', 'cupsJobId', 'error'];
let persistTimer = null;

/** Write the whole queue to disk atomically (temp file, then rename). Relay only. */
async function saveQueue() {
  if (MODE !== 'relay') return;
  try {
    const data = JSON.stringify([...jobs.values()].map((job) => {
      const out = {};
      for (const k of PERSIST_FIELDS) if (job[k] !== undefined) out[k] = job[k];
      return out;
    }));
    const tmp = `${QUEUE_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, QUEUE_FILE);
  } catch (err) {
    console.error('  could not save the queue:', err.message);
  }
}

/** Debounced save — a burst of changes collapses into one write. */
function persist() {
  if (MODE !== 'relay' || persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; saveQueue(); }, 250);
  if (persistTimer.unref) persistTimer.unref();
}

/** Reload the queue on boot (relay only). A job that was mid-print when we stopped
 *  is re-queued — the restart interrupted it, so it prints again when the booth is
 *  ready. Jobs whose image file is gone are dropped. */
function loadQueue() {
  if (MODE !== 'relay') return;
  let list;
  try { list = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return; }
  if (!Array.isArray(list)) return;
  let restored = 0, requeued = 0;
  for (const entry of list.slice(-MAX_JOB_HISTORY)) {
    if (!entry || !entry.id || !entry.file || !fs.existsSync(entry.file)) continue;
    const job = { claimedAt: 0, printedAt: 0, doneAt: 0, cupsJobId: null, error: null, ...entry };
    if (job.status === 'claimed' || job.status === 'printing') {
      job.status = 'pending'; job.cupsJobId = null; job.claimedAt = 0; job.printedAt = 0; requeued++;
    }
    jobs.set(job.id, job);
    if (job.printNo > printSeq) printSeq = job.printNo; // continue numbering where we left off
    restored++;
  }
  if (restored) {
    const waiting = [...jobs.values()].filter((j) => j.status === 'pending' || j.status === 'awaiting-approval').length;
    console.log(`  restored ${restored} job${restored === 1 ? '' : 's'} from disk, ${waiting} still to print${requeued ? `, ${requeued} re-queued` : ''}.`);
  }
}

loadQueue();

// Single-use print codes (vouchers). Stored beside the queue so they survive a restart.
const vouchers = new VoucherStore(path.join(PRINTS_DIR, 'vouchers.json'));

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

/**
 * Whether this instance can actually put ink on paper. A full booth follows its
 * config; a guest-only booth can only print when it has an upstream --print-host
 * to forward to, otherwise guests save/share to their phones.
 */
function printingEnabledEffective(cfg) {
  return GUEST_ONLY ? Boolean(PRINT_HOST) : cfg.printingEnabled;
}

/**
 * Guest-only: forward a print-path request straight to the upstream booth that
 * owns the printer. Streams the body through untouched (a 4x6 PNG, a job poll,
 * an image fetch), so there is no CORS and the guest key in the query still
 * authorises upstream. The upstream's job/image URLs are same-origin to the
 * guest because /prints/* is proxied too.
 */
function proxyToPrintHost(req, res, url) {
  let target;
  try {
    target = new URL(url.pathname + url.search, PRINT_HOST);
  } catch {
    return sendJson(res, 502, { ok: false, error: 'The booth host address is not usable.' });
  }
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: target.host };
  delete headers.connection;

  const proxyReq = lib.request(target, { method: req.method, headers }, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });
  proxyReq.setTimeout(30_000, () => proxyReq.destroy(new Error('the booth host did not answer in time')));
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: `Cannot reach the booth printer right now. Save to your phone instead. (${err.message})` });
    } else {
      res.destroy();
    }
  });
  req.pipe(proxyReq);
  return undefined;
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

// Brute-force guard for print codes: a handful of wrong codes from one address triggers a
// cool-off, so guessing the ~1000 live codes out of 887 million is not just improbable per
// try but rate-throttled to a crawl (see CODE_MISS_MAX per 10-minute window).
const codeMisses = new Map(); // ip -> [timestamps of wrong-code tries]
const CODE_MISS_WINDOW = 10 * 60 * 1000;
const CODE_MISS_MAX = 8;
function recentMisses(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const arr = (codeMisses.get(ip) || []).filter((t) => now - t < CODE_MISS_WINDOW);
  codeMisses.set(ip, arr);
  return arr;
}
const codeLockedOut = (req) => recentMisses(req).length >= CODE_MISS_MAX;
function noteWrongCode(req) { recentMisses(req).push(Date.now()); }

// Pairing: let the printer helper connect without the operator pasting BOOTH_TOKEN.
// The host screen (already authed) mints a short-lived, single-use code; the helper
// exchanges it for the booth token. Codes are 4 chars from a 30-char unambiguous
// alphabet (~810k combos) and are easy to read off the screen. A code is normally
// claimed within seconds and is single-use; what keeps a short code safe is the
// per-IP claim lockout below (a handful of wrong tries triggers a cool-off), not the
// combo count. Relay mode only — a local booth prints on its own Mac.
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_LEN = 4;
const PAIR_TTL_MS = 10 * 60 * 1000;
const pairings = new Map(); // code -> { expires }
function sweepPairings() {
  const now = Date.now();
  for (const [code, p] of pairings) if (p.expires <= now) pairings.delete(code);
}
function newPairCode() {
  const bytes = crypto.randomBytes(PAIR_LEN);
  let out = '';
  for (let i = 0; i < PAIR_LEN; i += 1) out += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  return out;
}
// A wrong pairing code is brute-force material too — same cool-off treatment as vouchers.
const pairMisses = new Map(); // ip -> [timestamps]
function recentPairMisses(req) {
  const ip = clientIp(req);
  const arr = (pairMisses.get(ip) || []).filter((t) => Date.now() - t < CODE_MISS_WINDOW);
  pairMisses.set(ip, arr);
  return arr;
}
const pairLockedOut = (req) => recentPairMisses(req).length >= CODE_MISS_MAX;
function notePairMiss(req) { recentPairMisses(req).push(Date.now()); }

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
/** The public base URL inferred from the incoming request — how a cloud host (Render,
 *  Fly, a reverse proxy) tells us the real address without any PUBLIC_URL config. */
function requestBase(req) {
  if (!req) return null;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return null;
  const proto = req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

function addresses(req) {
  const lan = lanAddresses().map((entry) => `http://${entry.address}:${activePort()}`);
  // A relay is reached through its public hostname, so when PUBLIC_URL isn't pinned we
  // trust the request's forwarded host — the QR then points at the real address with
  // no extra config on any platform.
  const publicUrl = PUBLIC_URL || tunnel.url() || (MODE === 'relay' ? requestBase(req) : null);
  return {
    public: publicUrl,
    lan: lan.length ? lan : [`http://localhost:${activePort()}`],
  };
}

/** The address guests should use, best first. */
function joinUrls(req) {
  const { public: publicUrl, lan } = addresses(req);
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

const agentOnline = () => onlineAgents().length > 0;

// ---------------------------------------------------------------- printer slots
// A "slot" is one printer the host chose to run: { agentId, name, label }. Prints are
// dispatched across all free slots at once (concurrency = number of slots), and each new
// print goes to whichever slot is free first. When the host has selected none, we fall back
// to the single default destination (concurrency 1) — exactly the old one-printer behaviour.

/** The printers the host selected to run, or [] when none are chosen. */
function enabledSlots(cfg) {
  if (Array.isArray(cfg.printers) && cfg.printers.length) {
    // Guests see the host's typed name/number. When the host left the name blank it was
    // stored as the raw CUPS name — treat that as "unnamed" and show a clean "#N" instead,
    // so a guest never sees a long driver string like "CANON_G4010_series".
    return cfg.printers.map((p, i) => ({
      agentId: p.agentId || 'local',
      name: p.name,
      label: (p.label && p.label !== p.name) ? p.label : `#${i + 1}`,
    }));
  }
  // Nothing chosen: in relay mode spread across every printer the connected computers
  // report; in booth mode use the single default destination (one serial slot).
  if (MODE === 'relay') {
    const out = [];
    for (const a of onlineAgents()) for (const pr of a.printers) out.push({ agentId: a.id, name: pr.name, label: `#${out.length + 1}` });
    return out;
  }
  return [];
}

/** How many prints can run at once, from the configured slots (at least 1). */
function laneCount(cfg) {
  return Math.max(1, enabledSlots(cfg).length);
}

/** The (agentId|name) keys of printers busy with a print right now. */
function busyPrinterKeys() {
  const set = new Set();
  for (const j of jobs.values()) {
    if (ON_PRINTER.has(j.status) && j.printer) set.add(`${j.agentId || 'local'}|${j.printer}`);
  }
  return set;
}

/** The label a guest/board should show for the printer a job landed on. */
function printerLabelFor(cfg, job) {
  if (!job.printer) return null;
  const hit = enabledSlots(cfg).find((s) => s.agentId === (job.agentId || 'local') && s.name === job.printer);
  // Only ever the host-set name/number — never the raw CUPS name (null if we can't map it).
  return (hit && hit.label) || null;
}

/** A printer label safe to drop into a filename (and a URL path). */
function fileSafeLabel(label) {
  return String(label || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

/** Once a job lands on a printer, fold that printer's label into the saved filename so the
 *  stored photo records which printer produced it (e.g. …_grid_ab12cd34__1.png). Best-effort:
 *  on any fs error, keep the original name — never let a rename break a print. */
function tagFileWithPrinter(job) {
  try {
    if (!job.file || job.printerTagged) return;
    const tag = fileSafeLabel(printerLabelFor(config.load(), job));
    if (!tag) return;
    const dir = path.dirname(job.file);
    const ext = path.extname(job.file);
    const stem = path.basename(job.file, ext);
    if (stem.endsWith(`__${tag}`)) { job.printerTagged = true; return; }
    const next = path.join(dir, `${stem}__${tag}${ext}`);
    fs.renameSync(job.file, next);
    job.file = next;
    job.printerTagged = true;
  } catch (err) {
    console.error(`  (could not tag print file with printer: ${err.message})`);
  }
}

/** The sticker to actually stamp: the configured one if it's still on disk, else the
 *  first available, so a renamed/removed file never leaves the badge blank. */
function effectiveSticker(cfg) {
  const stickers = config.listStickers();
  if (stickers.some((s) => s.path === cfg.sticker)) return cfg.sticker;
  return stickers.length ? stickers[0].path : cfg.sticker;
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

/** Wake any agent that is parked on a long poll. */
function notifyAgents() {
  for (const resolve of agentWaiters) resolve();
  agentWaiters.clear();
}

// The server owns the print queue. Jobs wait here as 'pending' and are dispatched
// to the printer one at a time; the next is released only once the printer reports
// the current one finished — so a guest's position reflects the real printer, not
// a stopwatch. Statuses: awaiting-approval pending printing (booth) / claimed
// (relay agent) done | failed | rejected.
let avgPrintMs = PRINT_MS;   // rolling estimate, learned from real print durations
let dispatching = false;     // guard so we never dispatch two jobs at once
let printerWatch = null;     // interval polling CUPS until the current print finishes

const ACTIVE = new Set(['awaiting-approval', 'pending', 'printing', 'claimed']);
const ON_PRINTER = new Set(['printing', 'claimed']); // the job actually at the printer

const jobStartedAt = (job) => job.printedAt || job.claimedAt || 0;

/** A print that fails or is skipped should not burn the guest's code — hand it back. */
function refundVoucher(job) {
  if (job && job.voucher) { vouchers.refund(job.voucher); job.voucher = null; }
}

/** Learn from a finished print so future ETAs track this printer's real speed. */
function recordDuration(ms) {
  if (ms > 3000 && ms < MAX_PRINT_MS) avgPrintMs = Math.round(avgPrintMs * 0.6 + ms * 0.4);
}

/** Mark the job on the printer finished, learn its duration, release the next. */
function completeJob(job) {
  if (!ON_PRINTER.has(job.status)) return;
  job.status = 'done';
  job.doneAt = Date.now();
  recordDuration(job.doneAt - (jobStartedAt(job) || job.doneAt));
  persist();
  console.log(`  finished job ${job.id.slice(0, 8)}${job.cupsJobId ? ` (CUPS ${job.cupsJobId})` : ''}`);
  // Fire-and-forget: releasing the next job must never crash the booth if it trips.
  pumpPrinter().catch((err) => console.error('  could not release the next print:', err.message));
}

/** Send one job to a local printer and mark it printing (booth mode). `assigned` names the
 *  printer slot the scheduler picked; null means the single default destination. */
async function dispatchToPrinter(job, assigned = null) {
  job.agentId = 'local';
  if (DRY_RUN) {
    job.status = 'printing';
    job.printer = assigned || job.printer || 'Dry-Run-Printer';
    job.printedAt = Date.now();
    job.cupsJobId = `dry-run-${job.id.slice(0, 6)}`;
    const timer = setTimeout(() => completeJob(job), DRY_PRINT_MS);
    if (timer.unref) timer.unref();
    return;
  }

  const cfg = config.load();
  const { name, error } = await resolvePrinter(assigned || job.printer);
  if (!name) {
    job.status = 'failed';
    job.error = error;
    refundVoucher(job);
    console.error(`  print failed for job ${job.id.slice(0, 8)}: ${error}`);
    return;
  }

  const options = cups.buildPrintOptions({ borderless: cfg.borderless, fitToPage: cfg.fitToPage, mediaType: cfg.mediaType });

  // Borderless on this printer means its own full-bleed page size (e.g.
  // 4x6.Fullbleed). Auto-pick it for the requested size so borderless just works.
  let media = job.media || cfg.media;
  if (cfg.borderless && !cups.isBorderlessMedia(media)) {
    try {
      const { options: sizes } = await cups.mediaOptions(name);
      const bl = cups.borderlessFor(sizes, media);
      if (bl) { console.log(`  · borderless: ${media} ${bl}`); media = bl; }
    } catch { /* fall back to the requested size */ }
  }

  const result = await cups.print(job.file, { printer: name, copies: job.copies, media, options });
  if (!result.ok) {
    job.status = 'failed';
    job.error = result.error;
    refundVoucher(job);
    console.error(`  print failed for job ${job.id.slice(0, 8)} on ${name}: ${result.error}`);
    return;
  }
  job.status = 'printing';
  job.printer = name;
  tagFileWithPrinter(job); // record the printer in the stored filename
  job.cupsJobId = result.jobId;
  job.printedAt = Date.now();
  job.seenActive = false;
  console.log(`  printing job ${job.id.slice(0, 8)} on ${name}${result.jobId ? ` (CUPS ${result.jobId})` : ''}`);
  startPrinterWatch();
}

/**
 * Advance the queue (booth mode): fill every free printer with the oldest waiting jobs,
 * so several printers run at once and each new print goes to whichever slot is free first.
 * With no printers chosen it falls back to one serial slot. In relay mode the connected
 * computers pull jobs themselves, so here we just wake them.
 */
async function pumpPrinter() {
  if (MODE === 'relay') { notifyAgents(); return; }
  if (dispatching) return;
  dispatching = true;
  try {
    for (;;) {
      const cfg = config.load();
      const slots = enabledSlots(cfg);
      const oldestPending = () => [...jobs.values()]
        .filter((j) => j.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)[0];

      let assigned = null; // the printer name to send to, or null for the default slot
      if (slots.length) {
        const busy = busyPrinterKeys();
        const free = slots.find((s) => !busy.has(`local|${s.name}`));
        if (!free) break;
        assigned = free.name;
      } else {
        // One default destination: strictly one print at a time.
        if ([...jobs.values()].some((j) => j.status === 'printing')) break;
      }

      const next = oldestPending();
      if (!next) break;
      await dispatchToPrinter(next, assigned);
      // A job that couldn't go frees nothing — loop again to try the next job/slot.
    }
  } finally {
    dispatching = false;
  }
}

/** Poll CUPS until each printing job leaves the active list, then advance. Watches every
 *  printer at once, so several prints can run in parallel. */
function startPrinterWatch() {
  if (printerWatch || DRY_RUN) return;
  printerWatch = setInterval(async () => {
    const printing = [...jobs.values()].filter((j) => j.status === 'printing');
    if (!printing.length) { clearInterval(printerWatch); printerWatch = null; return; }
    let active;
    try {
      active = await cups.listJobs(); // lpstat -o — jobs not yet finished (all printers)
    } catch { return; /* transient lpstat hiccup — try again next tick */ }
    for (const job of printing) {
      const elapsed = Date.now() - (job.printedAt || 0);
      if (elapsed > MAX_PRINT_MS) { completeJob(job); continue; } // never wait forever
      const present = Boolean(job.cupsJobId) && active.some((j) => j.id === job.cupsJobId);
      if (present) job.seenActive = true;
      // CUPS drops a job from its queue the moment the backend finishes SENDING it to
      // the printer — which on any printer with a page buffer is well before the sheet
      // is physically out. Releasing the next print then just fills the printer's own
      // hardware queue. So hold the printer busy until the job has BOTH cleared CUPS
      // and been printing for at least one physical interval (PRINT_MS, env-tunable).
      const clearedCups = !present && (job.seenActive || elapsed > 8000);
      if (clearedCups && elapsed >= PRINT_MS) completeJob(job);
    }
  }, 2000);
  if (printerWatch.unref) printerWatch.unref();
}

function imageUrl(job) {
  return `/prints/${path.basename(job.file)}?t=${job.token}`;
}

// The FIFO schedule over the jobs actually in the queue right now — the one on the
// printer plus everything waiting behind it (real state, not a stopwatch). Returns
// those jobs oldest-first and a map of job id epoch ms it will finish printing.
// The job on the printer is anchored to when it really started (so its remaining
// time counts down for real); each waiting job takes one avgPrintMs slot after.
function printSchedule(now) {
  const active = [...jobs.values()]
    .filter((job) => ACTIVE.has(job.status))
    .sort((a, b) => a.createdAt - b.createdAt);
  const lanes = laneCount(config.load());
  const laneFree = new Array(lanes).fill(now); // when each printer next becomes free
  const finishAt = new Map();
  const earliestLane = () => { let m = 0; for (let i = 1; i < lanes; i++) if (laneFree[i] < laneFree[m]) m = i; return m; };

  // Jobs already on a printer hold a lane, anchored to when they really started.
  for (const job of active) {
    if (!(ON_PRINTER.has(job.status) && jobStartedAt(job))) continue;
    const end = Math.max(jobStartedAt(job) + avgPrintMs, now);
    finishAt.set(job.id, end);
    const m = earliestLane();
    laneFree[m] = Math.max(laneFree[m], end);
  }
  // Everything waiting takes the next-free lane, one avgPrintMs slot each.
  for (const job of active) {
    if (finishAt.has(job.id)) continue;
    const m = earliestLane();
    const end = Math.max(laneFree[m], now) + avgPrintMs;
    laneFree[m] = end;
    finishAt.set(job.id, end);
  }
  return { active, finishAt };
}

// The guest-facing queue standing of one job: its real place in line (1 = on the
// printer / next) and how long until it prints, from the learned print speed. null
// once the job is done, failed, or rejected.
function queueInfo(job, now = Date.now()) {
  if (!ACTIVE.has(job.status)) return null;
  const { active, finishAt } = printSchedule(now);
  const idx = active.findIndex((j) => j.id === job.id);
  if (idx < 0) return null;
  const readyAt = finishAt.get(job.id);
  return {
    position: idx + 1,
    ahead: idx,
    total: active.length,
    etaSeconds: Math.max(0, Math.round((readyAt - now) / 1000)),
    readyAt,
    printing: ON_PRINTER.has(job.status),
  };
}

function publicJob(job) {
  const cfg = config.load();
  return {
    id: job.id,
    status: job.status,
    layout: job.layout,
    printNo: job.printNo || null,
    orient: job.orient || 'portrait',
    copies: job.copies,
    printer: job.printer || null,
    printerLabel: printerLabelFor(cfg, job), // host-set name/number shown to guests
    computer: job.printer ? agentName(job.agentId) : null, // which Mac/PC it's printing on
    cupsJobId: job.cupsJobId || null,
    error: job.error || null,
    createdAt: job.createdAt,
    guest: job.guest || null,
    image: imageUrl(job),
    queue: queueInfo(job),
  };
}

/** Pick a job for a polling computer (agent) and pin it to one of that computer's free
 *  printers, so several computers/printers drain the queue in parallel and each print lands
 *  on whichever printer is free first. Requeues anything a dead computer claimed. */
function nextClaimableJob(agentId) {
  const cfg = config.load();
  const now = Date.now();
  const ordered = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const job of ordered) {
    if (job.status === 'claimed' && now - (job.claimedAt || 0) > CLAIM_TIMEOUT_MS) {
      job.status = 'pending';
      job.printer = null;
      job.agentId = null;
      job.error = null;
    }
  }

  // The printers this computer is allowed to run. When the host chose specific printers,
  // only that computer's chosen ones; otherwise every printer this computer reports.
  const chosen = enabledSlots(cfg).filter((s) => s.agentId === agentId);
  const self = agents.get(agentId);
  const slots = chosen.length
    ? chosen
    : (Array.isArray(cfg.printers) && cfg.printers.length)
      ? [] // host chose printers, but none on this computer — it stays idle
      : (self ? self.printers.map((p) => ({ agentId, name: p.name, label: p.name })) : []);

  const busy = busyPrinterKeys();
  const free = slots.find((s) => !busy.has(`${agentId}|${s.name}`));
  if (!free) return null;
  const next = ordered.find((job) => job.status === 'pending');
  if (!next) return null;
  return { job: next, printer: free.name };
}

// ---------------------------------------------------------------- agent API

async function handleAgentApi(req, res, url) {
  if (MODE !== 'relay') return sendJson(res, 404, { ok: false, error: 'This booth prints locally; it has no agent API.' });
  if (!agentAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Bad booth token.' });

  const cfg = config.load();
  // Which computer is calling. Several can connect at once; each carries a stable id.
  // An agent that sends none (e.g. a lone Mac) falls back to the id 'default'.
  const agentId = String(req.headers['x-agent-id'] || 'default').slice(0, 80);

  /** Note this computer as seen, upserting its record. */
  const touchAgent = (patch = {}) => {
    const prev = agents.get(agentId) || { id: agentId, name: agentId, printers: [], dryRun: false };
    agents.set(agentId, { ...prev, ...patch, id: agentId, lastSeen: Date.now() });
  };

  // A computer says hello and tells us which printers it can actually reach.
  if (url.pathname === '/api/agent/hello' && req.method === 'POST') {
    const body = await readJson(req);
    touchAgent({
      name: String(body.name || 'booth agent').slice(0, 60),
      dryRun: Boolean(body.dryRun),
      printers: Array.isArray(body.printers)
        ? body.printers.slice(0, 40).map((p) => ({
            name: String(p.name || '').slice(0, 128),
            state: String(p.state || '').slice(0, 60),
            ready: Boolean(p.ready),
          })).filter((p) => p.name)
        : [],
    });
    return sendJson(res, 200, { ok: true, config: cfg });
  }

  // Long poll: hand over the next job for one of this computer's free printers, or hold
  // the connection until one lands.
  if (url.pathname === '/api/agent/jobs' && req.method === 'GET') {
    touchAgent();
    const waitMs = Math.min(50_000, Math.max(0, Number(url.searchParams.get('wait')) || 0) * 1000);

    const claim = () => {
      const chosen = nextClaimableJob(agentId);
      if (!chosen) return null;
      const { job, printer } = chosen;
      job.status = 'claimed';
      job.claimedAt = Date.now();
      job.agentId = agentId;
      job.printer = printer || cfg.printer || null;
      tagFileWithPrinter(job); // record the printer in the stored filename before the agent fetches it
      persist();
      return {
        id: job.id,
        copies: job.copies,
        printer: job.printer,
        media: job.media || cfg.media,
        mediaType: cfg.mediaType,
        borderless: cfg.borderless,
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
    touchAgent();
    return sendJson(res, 200, { ok: true, job: claim() });
  }

  // The computer reports what CUPS said.
  if (url.pathname === '/api/agent/result' && req.method === 'POST') {
    touchAgent();
    const body = await readJson(req);
    const job = jobs.get(body.id);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job.' });

    if (body.ok) {
      job.cupsJobId = body.cupsJobId ? String(body.cupsJobId).slice(0, 120) : null;
      job.printer = body.printer ? String(body.printer).slice(0, 128) : job.printer;
      job.agentId = agentId;
      job.error = null;
      // Three shapes of "ok":
      //   done:true    — the printer really finished (the Mac agent watched CUPS). Trust it.
      //   started:true — it began printing; the real 'done' will follow. Show "Printing now"
      //                  and keep a long safety net so a crashed agent can't wedge it.
      //   neither      — the agent dispatched it but can't report completion, so
      //                  fall back to finishing after the learned print time (an estimate).
      if (body.done) {
        completeJob(job); // learns the true duration and releases the next
      } else if (ON_PRINTER.has(job.status)) {
        job.status = 'printing';
        if (!job.printedAt) job.printedAt = Date.now();
        persist();
        const id = job.id;
        const after = body.started ? MAX_PRINT_MS : avgPrintMs;
        const timer = setTimeout(() => { const j = jobs.get(id); if (j) completeJob(j); }, after);
        if (timer.unref) timer.unref();
      }
      notifyAgents();
    } else {
      job.status = 'failed';
      job.error = String(body.error || 'The booth printer refused the job.').slice(0, 300);
      refundVoucher(job);
      persist();
      notifyAgents(); // let the agent pick up the next one
    }
    return sendJson(res, 200, { ok: true, job: publicJob(job) });
  }

  return sendJson(res, 404, { ok: false, error: 'No such endpoint.' });
}

// ---------------------------------------------------------------- guest API

async function handleApi(req, res, url) {
  if (url.pathname.startsWith('/api/agent/')) return handleAgentApi(req, res, url);

  if (GUEST_ONLY) {
    if (GUEST_ONLY_BLOCKED.has(url.pathname)) {
      return sendJson(res, 404, { ok: false, error: 'This is a guest-only booth. Host controls live on the printing Mac.' });
    }
    if (PRINT_HOST && PROXIED_API.has(url.pathname)) {
      return proxyToPrintHost(req, res, url);
    }
  }

  const cfg = config.load();

  // Cheap unauthenticated probe for platform health checks and uptime pings.
  if (url.pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      version: build.version,
      commit: build.commit,
      mode: GUEST_ONLY ? 'guest-only' : MODE,
      agentOnline: MODE === 'relay' ? agentOnline() : true,
      printingEnabled: printingEnabledEffective(cfg),
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
      printingEnabled: printingEnabledEffective(cfg),
      requireApproval: GUEST_ONLY ? false : cfg.requireApproval,
      codeRequired: !GUEST_ONLY && cfg.requireVoucher === true, // a single-use print code
      codeLength: VOUCHER_LEN,
      keyRequired: guestKeyRequired(),
      remote: MODE === 'relay' || Boolean(PRINT_HOST),
      dryRun: DRY_RUN,
      sticker: effectiveSticker(cfg),
    });
  }

  if (url.pathname === '/api/printers' && req.method === 'GET') {
    if (MODE === 'relay') {
      // Every printer across every connected computer, each tagged with its computer so the
      // host can pick which to run and give each a name/number.
      const list = [];
      for (const a of onlineAgents()) {
        for (const pr of a.printers) list.push({ agentId: a.id, agentName: a.name, name: pr.name, state: pr.state, ready: pr.ready });
      }
      return sendJson(res, 200, {
        dryRun: onlineAgents().some((a) => a.dryRun),
        remote: true,
        agentOnline: agentOnline(),
        cupsAvailable: agentOnline(),
        printers: list,
        agents: agentSummary().agents,
        default: cfg.printer || (list[0] ? list[0].name : null),
      });
    }
    if (DRY_RUN) {
      return sendJson(res, 200, {
        dryRun: true,
        agentOnline: true,
        cupsAvailable: false,
        printers: [{ agentId: 'local', agentName: 'This Mac', name: 'Dry-Run-Printer', state: 'idle', ready: true }],
        default: 'Dry-Run-Printer',
      });
    }
    const [{ printers, default: fallback, error }, cupsAvailable] = await Promise.all([
      cups.listPrinters(),
      cups.available(),
    ]);
    const tagged = printers.map((p) => ({ ...p, agentId: 'local', agentName: 'This Mac' }));
    return sendJson(res, 200, { dryRun: false, agentOnline: true, cupsAvailable, printers: tagged, default: cfg.printer || fallback, error });
  }

  // The page sizes a printer really supports, so the host can pick the exact
  // borderless size the driver exposes (its name varies by driver, so we read it
  // rather than guess). Booth mode only — a relay printer lives on the Mac.
  if (url.pathname === '/api/media' && req.method === 'GET') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    if (MODE === 'relay' || DRY_RUN) return sendJson(res, 200, { printer: null, options: [], error: null });
    const requested = (url.searchParams.get('printer') || '').slice(0, 128) || null;
    const { name } = await resolvePrinter(requested);
    const { options, error } = name ? await cups.mediaOptions(name) : { options: [], error: 'no printer' };
    return sendJson(res, 200, { printer: name, options, error });
  }

  if (url.pathname === '/api/queue' && req.method === 'GET') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const cupsJobs = MODE === 'relay' || DRY_RUN ? [] : await cups.listJobs();
    const recent = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40).map(publicJob);
    return sendJson(res, 200, { cupsJobs, jobs: recent, agent: agentSummary() });
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
      agent: agentSummary(),
      pinned: config.pinnedKeys(),
      urls: joinUrls(req),
      stickers: config.listStickers(),
      helper: { downloadBase: HELPER_DOWNLOAD_BASE, releasesPage: HELPER_RELEASES_PAGE },
    });
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const patch = await readJson(req);
    return sendJson(res, 200, { config: config.save(patch) });
  }

  // Pairing — the host mints a short-lived code the printer helper redeems for the
  // booth token, so the operator never copies a secret by hand. Relay only.
  if (url.pathname === '/api/pair/new' && req.method === 'POST') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    if (MODE !== 'relay') return sendJson(res, 400, { ok: false, error: 'Pairing is only for the cloud relay.' });
    sweepPairings();
    const code = newPairCode();
    pairings.set(code, { expires: Date.now() + PAIR_TTL_MS });
    return sendJson(res, 200, { ok: true, code, expiresInMs: PAIR_TTL_MS });
  }

  // Redeemed by the helper (no host token — the code IS the credential). Single-use,
  // expiring, and rate-limited against guessing. Returns the booth token on success.
  if (url.pathname === '/api/pair/claim' && req.method === 'POST') {
    if (MODE !== 'relay') return sendJson(res, 400, { ok: false, error: 'Pairing is only for the cloud relay.' });
    if (pairLockedOut(req)) return sendJson(res, 429, { ok: false, error: 'Too many attempts. Wait a few minutes and get a fresh code.' });
    const body = await readJson(req);
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    sweepPairings();
    if (!code || !pairings.has(code)) {
      notePairMiss(req);
      return sendJson(res, 404, { ok: false, error: 'That code is invalid or has expired. Get a fresh one from the host screen.' });
    }
    pairings.delete(code); // single-use
    return sendJson(res, 200, { ok: true, token: BOOTH_TOKEN, boothName: cfg.boothName || 'BFF Photo Booth' });
  }

  // Print codes (vouchers). The host generates a batch, hands them out, and downloads the
  // list to print. Guests spend one per print (see /api/print).
  if (url.pathname === '/api/vouchers' && req.method === 'GET') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    return sendJson(res, 200, { requireVoucher: cfg.requireVoucher === true, codeLength: VOUCHER_LEN, ...vouchers.stats() });
  }

  if (url.pathname === '/api/vouchers' && req.method === 'POST') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const { action, count } = await readJson(req);
    if (action === 'clear') {
      vouchers.clear();
      return sendJson(res, 200, { ok: true, ...vouchers.stats() });
    }
    if (action === 'generate') {
      const added = vouchers.generate(Math.max(1, Math.min(10_000, Number(count) || 1000)));
      return sendJson(res, 200, { ok: true, added: added.length, codes: added, ...vouchers.stats() });
    }
    return sendJson(res, 400, { ok: false, error: 'Unknown voucher action.' });
  }

  // Download the codes as a CSV to print onto vouchers. `only=unused` skips spent codes.
  // A browser download can't set headers, so the token may ride in the query here.
  if (url.pathname === '/api/vouchers/export' && req.method === 'GET') {
    const authed = hostAuthorised(req) || (BOOTH_TOKEN && secretsMatch(url.searchParams.get('token'), BOOTH_TOKEN));
    if (!authed) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const onlyUnused = url.searchParams.get('only') === 'unused';
    const rows = vouchers.list().filter((v) => !onlyUnused || !v.used);
    const csv = ['code,status', ...rows.map((v) => `${v.code},${v.used ? 'used' : 'unused'}`)].join('\r\n');
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="print-codes-${stamp}.csv"`,
      'cache-control': 'no-store',
    });
    res.end(csv);
    return undefined;
  }

  if (url.pathname === '/api/print' && req.method === 'POST') {
    if (!printingEnabledEffective(cfg)) {
      return sendJson(res, 503, { ok: false, error: 'Printing is switched off for this booth. Save the photo to your phone instead.' });
    }
    if (!guestAuthorised(req, url)) {
      return sendJson(res, 401, { ok: false, error: 'Scan the booth QR code to print.' });
    }
    // NOTE: a relay does NOT reject a print just because the booth Mac is offline.
    // The cloud relay owns the queue: the job is accepted and held here, and the
    // agent drains it the moment it reconnects. So a guest can always submit even
    // when the host's internet is down.
    if (rateLimited(req)) {
      return sendJson(res, 429, { ok: false, error: 'That is a lot of prints. Give the printer a minute.' });
    }

    // Read the whole upload BEFORE we answer — replying mid-upload (e.g. to reject a bad code)
    // resets the connection, which the guest sees as "lost connection" instead of the real error.
    const body = await readBody(req);
    const kind = imageKind(body);
    if (!kind) {
      return sendJson(res, 400, { ok: false, error: 'Expected a PNG or JPEG image body.' });
    }

    // Single-use print code (voucher). Spend it now; a failed or skipped print refunds it.
    // Repeated wrong guesses from one address trip the brute-force cool-off.
    let voucherCode = null;
    if (cfg.requireVoucher) {
      if (codeLockedOut(req)) {
        return sendJson(res, 429, { ok: false, codeError: true, error: 'Too many wrong codes. Wait a minute, then try again.' });
      }
      const supplied = url.searchParams.get('code') || req.headers['x-print-code'] || '';
      const r = vouchers.redeem(supplied);
      if (!r.ok) {
        noteWrongCode(req);
        return sendJson(res, 402, {
          ok: false, codeError: true, reason: r.reason,
          error: r.reason === 'used' ? 'That print code has already been used.' : 'That print code is not valid.',
        });
      }
      voucherCode = r.code;
    }

    const layout = (url.searchParams.get('layout') || 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
    const guest = (url.searchParams.get('guest') || '').replace(/[^\p{L}\p{N} '._-]/gu, '').slice(0, 40);
    const copies = Math.max(1, Math.min(cfg.maxCopies, Number(url.searchParams.get('copies')) || cfg.copies));
    // The server load-balances across the host's chosen printers (free-first), so a guest
    // never picks the printer — it is assigned when the print is dispatched.

    // The guest app rotates the sheet to match the photos. Only honour that when
    // the host is on 4x6/6x4 photo paper; a host who chose Letter/A4 keeps it.
    // orient is never passed to lp directly — it only selects a known media.
    const orient = url.searchParams.get('orient') === 'landscape' ? 'landscape' : 'portrait';
    const photoPaper = cfg.media === 'Custom.4x6in' || cfg.media === 'Custom.6x4in';
    const jobMedia = photoPaper
      ? (orient === 'landscape' ? 'Custom.6x4in' : 'Custom.4x6in')
      : null;

    const id = crypto.randomUUID();
    const printNo = ++printSeq; // P1, P2, P3…
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(PRINTS_DIR, `P${printNo}_${stamp}_${layout}_${id.slice(0, 8)}.${kind}`);
    await fsp.writeFile(file, body);

    const job = {
      id,
      token: crypto.randomBytes(12).toString('hex'),
      file,
      layout,
      guest,
      printNo,
      copies,
      orient, // the design's orientation — the stored bitmap is rotated for paper when landscape
      printer: null,  // assigned by the scheduler to whichever printer is free first
      agentId: null,  // the computer that ends up printing it
      voucher: voucherCode, // the single-use code spent on this print (refunded if it fails)
      media: jobMedia,
      status: cfg.requireApproval ? 'awaiting-approval' : 'pending',
      createdAt: Date.now(),
      claimedAt: 0,
      cupsJobId: null,
      error: null,
    };
    jobs.set(id, job);
    while (jobs.size > MAX_JOB_HISTORY) jobs.delete(jobs.keys().next().value);
    await saveQueue(); // durable before we answer the guest — their print is on the server

    const online = MODE === 'relay' ? agentOnline() : true;
    if (MODE === 'relay' && !online && job.status !== 'awaiting-approval') {
      const waiting = [...jobs.values()].filter((j) => j.status === 'pending').length;
      console.log(`  queued job ${id.slice(0, 8)}, the booth Mac is offline; ${waiting} waiting for it to reconnect`);
    }

    if (!cfg.requireApproval) await pumpPrinter();

    const status = job.status === 'failed' ? 502 : 200;
    return sendJson(res, status, { ok: job.status !== 'failed', job: publicJob(job), agentOnline: online });
  }

  if (url.pathname === '/api/approve' && req.method === 'POST') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const { id } = await readJson(req);
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job.' });
    if (ACTIVE.has(job.status) && job.status !== 'awaiting-approval') {
      return sendJson(res, 200, { ok: true, job: publicJob(job) }); // already queued
    }
    job.status = 'pending'; // release it into the queue
    job.error = null;
    await saveQueue();
    await pumpPrinter();
    return sendJson(res, job.status === 'failed' ? 502 : 200, { ok: job.status !== 'failed', job: publicJob(job) });
  }

  if (url.pathname === '/api/reject' && req.method === 'POST') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const { id } = await readJson(req);
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job.' });
    job.status = 'rejected';
    refundVoucher(job); // a skipped print hands the guest's code back
    persist();
    return sendJson(res, 200, { ok: true, job: publicJob(job) });
  }

  // Cancel one of the booth's OWN prints by its job id — works in every mode. Pulls it out of
  // the queue, cancels the CUPS job if it is already at a local printer, refunds the code, and
  // releases the next print. (A print already sent to a printer on a remote agent can't be
  // recalled mid-sheet, but it still leaves the queue.)
  if (url.pathname === '/api/cancel-job' && req.method === 'POST') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const { id } = await readJson(req);
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job.' });
    if (!ACTIVE.has(job.status)) return sendJson(res, 200, { ok: true, job: publicJob(job) }); // already finished

    // Booth mode: if it is on a local printer, tell CUPS to drop it too.
    if (MODE !== 'relay' && !DRY_RUN && job.status === 'printing' && job.cupsJobId) {
      try { await cups.cancel(job.cupsJobId); } catch { /* best effort */ }
    }
    job.status = 'cancelled';
    job.error = null;
    refundVoucher(job); // a cancelled print hands the guest's code back
    persist();
    if (MODE === 'relay') notifyAgents(); else await pumpPrinter(); // free the printer, advance
    return sendJson(res, 200, { ok: true, job: publicJob(job) });
  }

  if (url.pathname === '/api/cancel' && req.method === 'POST') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const { cupsJobId } = await readJson(req);
    if (!cupsJobId || !/^[\w.-]+$/.test(String(cupsJobId))) {
      return sendJson(res, 400, { ok: false, error: 'Bad job id.' });
    }
    if (MODE === 'relay') {
      return sendJson(res, 409, { ok: false, error: 'Cancel this one on the booth Mac. The queue lives there.' });
    }
    if (DRY_RUN) return sendJson(res, 200, { ok: true, dryRun: true });
    const result = await cups.cancel(cupsJobId);
    return sendJson(res, result.ok ? 200 : 502, result);
  }

  if (url.pathname === '/api/job' && req.method === 'GET') {
    const job = jobs.get(url.searchParams.get('id'));
    if (!job) return sendJson(res, 404, { ok: false, error: 'Unknown job.' });
    return sendJson(res, 200, { ok: true, job: publicJob(job), agentOnline: MODE === 'relay' ? agentOnline() : true });
  }

  // Every saved photo (host only) — the gallery lists these; each is fetched from
  // /prints/<name>?token=… and can be downloaded one by one or all at once.
  if (url.pathname === '/api/prints' && req.method === 'GET') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const files = await listPrintFiles();
    const byFile = jobsByFile();
    const cfg = config.load();
    return sendJson(res, 200, {
      ok: true,
      count: files.length,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      prints: files.map((f) => enrichPrint(f, byFile, cfg)),
    });
  }

  // Reprint one or more saved photos. priority "front" jumps ahead of the queue; "queue"
  // (default) joins the back. Host action — no voucher, no approval gate.
  if (url.pathname === '/api/prints/reprint' && req.method === 'POST') {
    if (!hostAuthorised(req)) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    const body = await readJson(req);
    const names = (Array.isArray(body.names) ? body.names : (body.name ? [body.name] : []))
      .map((n) => path.basename(String(n)))
      .filter((n) => GALLERY_EXT.has(path.extname(n).toLowerCase()));
    if (!names.length) return sendJson(res, 400, { ok: false, error: 'No photos to reprint.' });
    const front = body.priority === 'front';
    const cfg = config.load();
    const byFile = jobsByFile();
    const actives = [...jobs.values()].filter((j) => ACTIVE.has(j.status));
    const frontBase = (actives.length ? Math.min(...actives.map((j) => j.createdAt)) : Date.now()) - 1000;

    const created = [];
    let i = 0;
    for (const name of names) {
      let buf;
      try { buf = await fsp.readFile(path.join(PRINTS_DIR, name)); } catch { continue; }
      const kind = path.extname(name).slice(1).toLowerCase();
      const orig = byFile.get(name);
      const layout = (orig && orig.layout) || parsePrintName(name).layout || 'reprint';
      const id = crypto.randomUUID();
      const printNo = ++printSeq;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(PRINTS_DIR, `P${printNo}_${stamp}_${layout}_${id.slice(0, 8)}.${kind}`);
      await fsp.writeFile(file, buf);
      const photoPaper = cfg.media === 'Custom.4x6in' || cfg.media === 'Custom.6x4in';
      jobs.set(id, {
        id,
        token: crypto.randomBytes(12).toString('hex'),
        file,
        layout,
        guest: 'Reprint',
        printNo,
        copies: Math.max(1, Math.min(cfg.maxCopies, Number(body.copies) || 1)),
        orient: (orig && orig.orient) || 'portrait',
        printer: null,
        agentId: null,
        voucher: null,
        media: (orig && orig.media) || (photoPaper ? ((orig && orig.orient) === 'landscape' ? 'Custom.6x4in' : 'Custom.4x6in') : null),
        status: 'pending',
        createdAt: front ? frontBase + i : Date.now() + i, // keep selection order; front sits ahead of the queue
        claimedAt: 0,
        cupsJobId: null,
        error: null,
      });
      created.push(jobs.get(id));
      i += 1;
    }
    while (jobs.size > MAX_JOB_HISTORY) jobs.delete(jobs.keys().next().value);
    if (!created.length) return sendJson(res, 400, { ok: false, error: 'None of those photos could be reprinted.' });
    await saveQueue();
    await pumpPrinter();
    return sendJson(res, 200, { ok: true, reprinted: created.length, jobs: created.map(publicJob) });
  }

  // All photos (or a selected subset via ?names=a,b,c) as one ZIP. Token rides in the query
  // so a plain browser download is authorised.
  if (url.pathname === '/api/prints/download.zip' && req.method === 'GET') {
    const authed = hostAuthorised(req) || (BOOTH_TOKEN && secretsMatch(url.searchParams.get('token'), BOOTH_TOKEN));
    if (!authed) return sendJson(res, 401, { ok: false, error: 'Host token required.' });
    let files = await listPrintFiles();
    const wanted = url.searchParams.get('names');
    if (wanted) {
      const set = new Set(wanted.split(',').filter(Boolean).map((s) => path.basename(decodeURIComponent(s))));
      files = files.filter((f) => set.has(f.name));
    }
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="booth-photos.zip"',
      'cache-control': 'no-store',
    });
    await streamZip(res, files);
    return undefined;
  }

  return sendJson(res, 404, { ok: false, error: 'No such endpoint.' });
}

// ---------------------------------------------------------------- static

// ---------------------------------------------------------------- gallery / export

const GALLERY_EXT = new Set(['.png', '.jpg', '.jpeg']);

/** Every saved photo on disk (the source of truth, not the in-memory queue), newest first. */
async function listPrintFiles() {
  let names = [];
  try { names = await fsp.readdir(PRINTS_DIR); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!GALLERY_EXT.has(path.extname(name).toLowerCase())) continue;
    try {
      const st = await fsp.stat(path.join(PRINTS_DIR, name));
      if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs });
    } catch { /* vanished between readdir and stat — skip */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Best-effort parse of the running number and printer tag out of a saved filename
 *  (P12_<stamp>_<layout>_<id8>[__<printer>].png), for photos whose job has been pruned. */
function parsePrintName(name) {
  const no = /^P(\d+)_/.exec(name);
  const tag = /__([^.]+)\.[^.]+$/.exec(name);
  const layout = /_([a-z0-9-]+)_[0-9a-f]{8}/i.exec(name);
  return {
    printNo: no ? Number(no[1]) : null,
    tag: tag ? tag[1].replace(/-/g, ' ') : null,
    layout: layout ? layout[1] : null,
  };
}

/** One gallery entry, enriched from the live job when we still have it, else from the
 *  filename (the queue keeps only the most recent MAX_JOB_HISTORY jobs; files live longer). */
function enrichPrint(f, jobByFile, cfg) {
  const job = jobByFile.get(f.name);
  const parsed = parsePrintName(f.name);
  return {
    name: f.name,
    size: f.size,
    mtime: f.mtime,
    printNo: (job && job.printNo) || parsed.printNo || null,
    printer: job ? printerLabelFor(cfg, job) : (parsed.tag || null),
    status: job ? job.status : 'saved',
    layout: (job && job.layout) || parsed.layout || null,
    at: job ? (job.doneAt || job.printedAt || job.createdAt || f.mtime) : f.mtime,
    computer: job && job.printer ? agentName(job.agentId) : null,
    error: (job && job.error) || null,
  };
}

const jobsByFile = () => new Map([...jobs.values()].map((j) => [path.basename(j.file), j]));

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** Stream a store-only (uncompressed) ZIP of the given files to res. Photos are already
 *  compressed, so storing is both fast and small enough, and needs no zip library. One file
 *  is read into memory at a time. */
async function streamZip(res, files) {
  const write = (buf) => new Promise((resolve, reject) => res.write(buf, (err) => (err ? reject(err) : resolve())));
  const central = [];
  let offset = 0;
  for (const f of files) {
    let data;
    try { data = await fsp.readFile(path.join(PRINTS_DIR, f.name)); } catch { continue; }
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);
    const { time, date } = dosDateTime(new Date(f.mtime));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // flags: UTF-8 filename
    local.writeUInt16LE(0, 8);        // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    await write(Buffer.concat([local, nameBuf]));
    await write(data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 30);          // extra + comment len (both 0)
    cd.writeUInt16LE(0, 34);          // disk number start
    cd.writeUInt16LE(0, 36);          // internal attrs
    cd.writeUInt32LE(0, 38);          // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  await write(Buffer.concat([centralBuf, eocd]));
  res.end();
}

/** A print is visible to its own guest (via the job token) and to the host. The host token
 *  is also accepted in the query (?token=) so the gallery's <img>/download links work — a
 *  browser can't set a header on those. */
function mayReadPrint(req, url, filename) {
  if (!isExposed()) return true;
  if (hostAuthorised(req)) return true;
  if (BOOTH_TOKEN && secretsMatch(url.searchParams.get('token'), BOOTH_TOKEN)) return true;
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
  if (rel === '/gallery') rel = '/gallery.html'; // host-only: all photos + download
  if (rel === '/view') rel = '/view.html';   // the big-screen queue board

  // A guest-only booth has no host screen, and its prints live on the upstream
  // print host (proxied) rather than on this disk.
  if (GUEST_ONLY) {
    if (rel === '/host.html') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('No host screen on a guest-only booth.');
      return;
    }
    if (PRINT_HOST && rel.startsWith('/prints/')) {
      proxyToPrintHost(req, res, url);
      return;
    }
  }

  const fromPrints = rel.startsWith('/prints/');
  const root = fromPrints ? PRINTS_DIR : PUBLIC_DIR;
  const relative = fromPrints ? rel.slice('/prints/'.length) : rel.slice(1);
  let file = path.resolve(root, relative);

  // A per-job token (?t=) identifies the job, so serve its CURRENT file even if the name in
  // the URL is stale — the file is renamed to fold in the printer once it lands on one, and
  // an already-issued guest/agent URL must keep working across that rename.
  if (fromPrints) {
    const t = url.searchParams.get('t');
    if (t) {
      const owner = [...jobs.values()].find((j) => secretsMatch(t, j.token));
      if (owner) file = path.resolve(owner.file);
    }
  }

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
  const shape = GUEST_ONLY ? ' · guest-only' : MODE === 'relay' ? ' · relay' : '';
  const title = `${cfg.boothName}${shape}`;

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
  // localhost never waits on DNS or a tunnel. A guest-only booth has none.
  if (!GUEST_ONLY) console.log(`  Host screen:          http://localhost:${activePort()}/host`);

  if (!publicUrl && tunnelFailed) {
    console.log('');
    console.log('  The tunnel did not come up, so guests can only reach this booth');
    console.log('  on your own Wi-Fi. Stop with Control-C and try npm run tunnel again.');
  } else if (!publicUrl) {
    console.log('');
    console.log('  Guests must be on the same Wi-Fi as this Mac.');
    console.log('  To let them join from anywhere, on mobile data or another network,');
    console.log('  stop this with Control-C and run:  npm run tunnel');
  }

  if (MODE === 'relay') console.log('  Waiting for the booth Mac to connect (npm run agent).');
  if (DRY_RUN) console.log('  DRY_RUN=1: composites are saved but never sent to a printer.');

  if (GUEST_ONLY) {
    console.log(PRINT_HOST
      ? `  Guest-only booth: prints go to the booth host at ${PRINT_HOST}`
      : '  Guest-only booth: no printer here, so guests save/share to their phones.');
    console.log('  Pass --print-host=<booth url> to send prints to a booth Mac.');
  }

  if (!GUEST_ONLY && isExposed() && !BOOTH_TOKEN) {
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
            ? `  Tunnel dropped, reconnecting in ${event.inSeconds}s. The guest link does not change.`
            : `  Tunnel dropped, reconnecting in ${event.inSeconds}s. A quick tunnel gets a NEW guest link;\n  open the host screen again for the new QR code.`);
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
      console.log(`  ${result.label}${tunnel.isPersistent() ? '' : ' (this address changes every launch)'}`);
    }
  }

  banner();

  // The host screen is for whoever is sitting at this Mac, so open it on
  // localhost. Going through the tunnel would mean waiting on DNS that this
  // machine may not see for a minute even while phones resolve it fine.
  const shouldOpen = MODE !== 'relay' && !GUEST_ONLY && !NO_OPEN && (FORCE_OPEN || isExposed());
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
        ? `  Guest link answered after ${attempts}s. Ready to scan.`
        : '  Could not reach the guest link from this Mac. That is usually local DNS catching up;\n  try it on a phone, and give it a minute before worrying.');
    });
  }
});

// A booth runs unattended through a whole party. An isolated promise rejection
// (a flaky lpstat, a printer that vanishes mid-job) is safe to log and shrug off.
process.on('unhandledRejection', (err) => {
  console.error('  unhandled rejection (booth kept running):', err && err.message ? err.message : err);
});
// An uncaught exception, though, can leave the process in a broken state that
// still "runs" but serves nothing — the dead-but-alive booth. Log it and EXIT so
// the supervisor (npm start server/booth.js) brings up a clean one right away,
// instead of sitting there wedged.
process.on('uncaughtException', (err) => {
  console.error('  fatal error, restarting the booth:', err && err.stack ? err.stack : err);
  try { tunnel.close(); } catch { /* ignore */ }
  process.exit(1);
});

process.on('SIGINT', () => {
  tunnel.close();
  process.exit(0);
});

module.exports = { server };
