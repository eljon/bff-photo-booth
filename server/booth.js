'use strict';

/**
 * Booth supervisor. Runs the server and, if it ever exits — a crash, a fatal
 * uncaught error, an OOM — brings it straight back, so an unattended party booth
 * heals itself instead of sitting dead until someone notices. This is what
 * `npm start` runs; Control-C stops it and the child together.
 *
 * All command-line args are forwarded, so `npm start -- --tunnel=tailscale` works
 * exactly as before.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ENTRY = path.join(__dirname, 'index.js');
const args = process.argv.slice(2);

let child = null;
let stopping = false;
let restarts = 0;
let startedAt = 0;

function start() {
  startedAt = Date.now();
  child = spawn(process.execPath, [ENTRY, ...args], { stdio: 'inherit', env: process.env });

  child.on('exit', (code, signal) => {
    if (stopping) return;
    // A clean, intentional stop (exit 0 with no signal) is respected — don't loop.
    if (code === 0 && !signal) { process.exit(0); return; }

    // Reset the backoff once it has run healthily for a while.
    if (Date.now() - startedAt > 60_000) restarts = 0;
    restarts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(restarts, 5));
    console.error(`\n  ⚠ booth server stopped (${signal || 'exit ' + code}). Restarting in ${Math.round(delay / 1000)}s…  [#${restarts}]\n`);
    setTimeout(() => { if (!stopping) start(); }, delay);
  });

  child.on('error', (err) => {
    console.error('  ⚠ could not launch the booth server:', err.message);
  });
}

function shutdown(signal) {
  stopping = true;
  if (child) child.kill(signal);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('  Booth supervisor keeps the server up. Control-C to stop.');
start();
