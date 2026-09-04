'use strict';

/**
 * Guest-only launcher.
 *
 * One command to run the newest guest app on a machine that is NOT the printer:
 *
 *     caffeinate -dims npm run guest -- --tunnel=tailscale
 *
 * It does two things the plain server does not:
 *
 *   1. Updates to the latest code first (best-effort), so you get the newest
 *      guest app without running `git pull` yourself. Offline, a dirty tree, or
 *      no upstream just skips the update and starts what is on disk — a party is
 *      never blocked on a fetch.
 *
 *   2. Starts the booth in guest-only mode (GUEST_ONLY=1): the guest app only,
 *      no host screen. Add --print-host=<booth url> to send prints to a booth
 *      Mac that owns a printer; without it, guests save/share to their phones.
 *
 * Any extra arguments (e.g. --tunnel=tailscale, --print-host=…) pass straight
 * through to the server.
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function inGitRepo() {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && String(result.stdout).trim() === 'true';
}

/** Fast-forward to origin's latest. Best-effort — never fatal. */
function updateToLatest() {
  if (process.env.GUEST_NO_UPDATE === '1') {
    console.log('  GUEST_NO_UPDATE=1: skipping the update, starting what is on disk.');
    return;
  }
  if (!inGitRepo()) {
    console.log('  Not a git checkout, skipping the update, starting what is on disk.');
    return;
  }
  console.log('  Fetching the latest guest app…');
  const result = spawnSync('git', ['pull', '--ff-only'], { cwd: ROOT, stdio: 'inherit', timeout: 30_000 });
  if (result.status === 0) return;
  console.log('  Could not fast-forward (offline, local changes, or no upstream).');
  console.log('  Starting the version already on disk.');
}

updateToLatest();

// Launch the server guest-only, forwarding any extra CLI args. Reads the freshly
// pulled files, so the version and guest app are whatever the update landed.
const args = ['server/index.js', '--guest-only', ...process.argv.slice(2)];
const child = spawn(process.execPath, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, GUEST_ONLY: '1' },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 0 : code);
});
