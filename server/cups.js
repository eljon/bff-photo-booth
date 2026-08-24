'use strict';

/**
 * Thin wrapper around the CUPS command line tools that ship with macOS
 * (lpstat / lp / cancel). Every call uses execFile with an argument array,
 * so nothing a guest types can ever reach a shell.
 */

const { execFile } = require('node:child_process');

const EXEC_TIMEOUT_MS = 10_000;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        error: err ? err.message : null,
      });
    });
  });
}

async function available() {
  const res = await run('lpstat', ['-r']);
  return res.ok || /scheduler is running/i.test(res.stdout);
}

/**
 * `lpstat -p -d` output looks like:
 *   printer Canon_SELPHY_CP1500 is idle.  enabled since Sat Aug 23 12:00:00 2025
 *   system default destination: Canon_SELPHY_CP1500
 */
async function listPrinters() {
  const res = await run('lpstat', ['-p', '-d']);
  if (!res.ok && !res.stdout) return { printers: [], default: null, error: res.stderr || res.error };

  const printers = [];
  let fallback = null;

  for (const line of res.stdout.split('\n')) {
    const p = line.match(/^printer\s+(\S+)\s+is\s+([^.]+)\.?/i);
    if (p) {
      const state = p[2].trim().toLowerCase();
      printers.push({
        name: p[1],
        state,
        ready: state.startsWith('idle') || state.startsWith('printing'),
        detail: line.trim(),
      });
      continue;
    }
    const d = line.match(/^system default destination:\s*(\S+)/i);
    if (d) fallback = d[1];
  }

  return { printers, default: fallback || (printers[0] ? printers[0].name : null), error: null };
}

/** `lpstat -o` — jobs that have not finished yet. */
async function listJobs() {
  const res = await run('lpstat', ['-o']);
  const jobs = [];
  for (const line of res.stdout.split('\n')) {
    // Canon_SELPHY-42  eljon  1048576  Sat Aug 23 12:00:00 2025
    const m = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (m) jobs.push({ id: m[1], owner: m[2], size: Number(m[3]), submitted: m[4].trim() });
  }
  return jobs;
}

/**
 * Send a file to a printer queue.
 * `printer` is validated against the live printer list by the caller.
 */
async function print(file, { printer, copies = 1, media, options = {} } = {}) {
  const args = [];
  if (printer) args.push('-d', printer);
  args.push('-n', String(Math.max(1, Math.min(10, Number(copies) || 1))));
  if (media) args.push('-o', `media=${media}`);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === '') continue;
    args.push('-o', `${key}=${value}`);
  }
  args.push('--', file);

  const res = await run('lp', args);
  if (!res.ok) {
    return { ok: false, jobId: null, error: (res.stderr || res.error || 'lp failed').trim(), args };
  }
  // "request id is Canon_SELPHY_CP1500-42 (1 file(s))"
  const m = res.stdout.match(/request id is (\S+)/i);
  return { ok: true, jobId: m ? m[1] : null, stdout: res.stdout.trim(), args };
}

async function cancel(jobId) {
  const res = await run('cancel', ['--', String(jobId)]);
  return { ok: res.ok, error: res.ok ? null : (res.stderr || res.error || '').trim() };
}

module.exports = { available, listPrinters, listJobs, print, cancel, run };
