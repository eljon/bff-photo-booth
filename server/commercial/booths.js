'use strict';

/**
 * Per-session booths. Each paid session gets its OWN booth — a separate relay process
 * (server/index.js in relay mode) with an isolated data directory, config, print queue,
 * photos, and host token. This reuses the entire single-tenant booth (guest app, host
 * screen, agent API, gallery, vouchers, reprint) with no duplication, and gives each
 * session true isolation: one session's prints, printers and settings never touch another's.
 *
 * Booths are spawned on demand (when the owner opens one) on a loopback port, and stopped
 * after a spell of inactivity so idle sessions don't hold a process. For local use the
 * owner's browser reaches the booth directly at 127.0.0.1:<port>; the cloud version fronts
 * these with per-session subdomains (see docs/ARCHITECTURE-SAAS.md) — the mechanism is the
 * same, only the addressing changes.
 */

const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_DIR } = require('./store');
const INDEX = path.join(__dirname, '..', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function healthy(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 900 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitHealthy(port, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await healthy(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

class BoothManager {
  constructor({ dir = DEFAULT_DIR, host = '127.0.0.1', idleMs = 30 * 60 * 1000 } = {}) {
    this.dir = dir;
    this.host = host;
    this.idleMs = idleMs;
    this.booths = new Map(); // sessionId -> { proc, info, lastAccess, starting }
    this._sweep = setInterval(() => this.sweepIdle(), 60 * 1000);
    if (this._sweep.unref) this._sweep.unref();
  }

  boothDir(id) { return path.join(this.dir, 'booths', id); }
  alive(id) { const b = this.booths.get(id); return Boolean(b && b.proc && b.proc.exitCode === null); }

  /** Ensure this session's booth is running; return { port, url }. */
  async ensure(session) {
    const id = session.id;
    const existing = this.booths.get(id);
    if (existing && existing.starting) { await existing.starting; }
    if (this.alive(id)) { this.booths.get(id).lastAccess = Date.now(); return this.booths.get(id).info; }

    const port = await freePort();
    const dir = this.boothDir(id);
    fs.mkdirSync(path.join(dir, 'prints'), { recursive: true });

    const proc = spawn(process.execPath, [INDEX, '--no-tunnel'], {
      env: {
        ...process.env,
        MODE: 'relay',
        HOST: this.host,
        PORT: String(port),
        BOOTH_TOKEN: session.boothToken,
        BOOTH_NAME: session.name,
        PRINTS_DIR: path.join(dir, 'prints'),
        PHOTOBOOTH_CONFIG: path.join(dir, 'config.json'),
        // A per-session guest key so its QR links are stable and distinct.
        ACCESS_KEY: session.boothToken.slice(0, 12),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const info = { port, url: `http://${this.host}:${port}` };
    const entry = { proc, info, lastAccess: Date.now(), stderr: () => stderr };
    entry.starting = waitHealthy(port).then((ok) => { entry.starting = null; entry.healthy = ok; });
    this.booths.set(id, entry);
    proc.on('exit', () => { if (this.booths.get(id) === entry) this.booths.delete(id); });

    await entry.starting;
    return info;
  }

  stop(id) {
    const b = this.booths.get(id);
    if (b && b.proc) { try { b.proc.kill('SIGTERM'); } catch { /* already gone */ } }
    this.booths.delete(id);
  }

  sweepIdle() {
    const now = Date.now();
    for (const [id, b] of this.booths) if (now - b.lastAccess > this.idleMs) this.stop(id);
  }

  closeAll() {
    clearInterval(this._sweep);
    for (const id of [...this.booths.keys()]) this.stop(id);
  }
}

module.exports = { BoothManager };
