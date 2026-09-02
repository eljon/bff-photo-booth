'use strict';

/**
 * Thin wrapper around the CUPS command line tools that ship with macOS
 * (lpstat / lp / cancel). Every call uses execFile with an argument array,
 * so nothing a guest types can ever reach a shell.
 */

const { execFile } = require('node:child_process');

const EXEC_TIMEOUT_MS = 10_000;
// Submitting a print can block far longer than a status query: on the first job
// after the printer has slept, `lp` waits for the USB/backend to wake it before
// it returns the request id. A short timeout kills that wait and makes us report
// a failure for a job CUPS actually queued — so give printing a generous window.
const PRINT_TIMEOUT_MS = 60_000;

function run(cmd, args, timeout = EXEC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        killed: Boolean(err && (err.killed || err.signal)),
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
 * Parse `lpstat -p -d` output into a printer list. The state clause varies:
 *   printer Canon_G4010_series is idle.  enabled since ...
 *   printer Canon_G4010_series now printing Canon_G4010_series-42.  enabled since ...
 *   printer Canon_G4010_series disabled since ...
 * The crucial part is recognising the printer NAME in every form — a printer that
 * is mid-print must still appear, or the next job is rejected as "unknown printer"
 * and nothing can ever queue behind a print in progress.
 */
function parsePrinters(stdout) {
  const printers = [];
  let fallback = null;

  for (const line of (stdout || '').split('\n')) {
    const p = line.match(/^printer\s+(\S+)\s+(.*)$/i);
    if (p) {
      const rest = p[2].toLowerCase();
      let state = 'unknown';
      if (rest.includes('printing') || rest.includes('processing')) state = 'printing';
      else if (rest.includes('idle')) state = 'idle';
      else if (rest.includes('disabled') || rest.includes('stopped')) state = 'disabled';
      else if (rest.startsWith('is ')) state = rest.slice(3).split(/[.\s]/)[0] || 'unknown';
      printers.push({
        name: p[1],
        state,
        ready: state === 'idle' || state === 'printing',
        detail: line.trim(),
      });
      continue;
    }
    const d = line.match(/^system default destination:\s*(\S+)/i);
    if (d) fallback = d[1];
  }

  return { printers, default: fallback };
}

async function listPrinters() {
  const res = await run('lpstat', ['-p', '-d']);
  if (!res.ok && !res.stdout) return { printers: [], default: null, error: res.stderr || res.error };

  const { printers, default: fallback } = parsePrinters(res.stdout);
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

  const res = await run('lp', args, PRINT_TIMEOUT_MS);
  if (!res.ok) {
    const error = res.killed
      ? `The printer did not respond within ${Math.round(PRINT_TIMEOUT_MS / 1000)}s. It may still print, so check the tray.`
      : (res.stderr || res.error || 'lp failed').trim();
    return { ok: false, jobId: null, error, killed: res.killed, args };
  }
  // "request id is Canon_SELPHY_CP1500-42 (1 file(s))"
  const m = res.stdout.match(/request id is (\S+)/i);
  return { ok: true, jobId: m ? m[1] : null, stdout: res.stdout.trim(), args };
}

/** Does a CUPS media/PageSize id name a borderless (full-bleed) size? Drivers spell
 *  it many ways: 4x6.FullBleed, 4x6.bl, om_borderless…, w288h432.fb, "borderless". */
function isBorderlessMedia(id) {
  return /border|frameless|full.?bleed|\bfb\b|(?:^|[._-])bl(?:$|[._-])/i.test(String(id || ''));
}

/**
 * Parse `lpoptions -p PRINTER -l` output for the PageSize choices the driver
 * exposes. Each option line is "Keyword/Label: a b *default c" — the "*" marks the
 * current default, and each token is a machine id we can pass straight to `lp`.
 */
function parseMediaOptions(stdout) {
  for (const line of (stdout || '').split('\n')) {
    const m = line.match(/^PageSize\/[^:]*:\s*(.+)$/);
    if (!m) continue;
    return m[1]
      .trim()
      .split(/\s+/)
      .map((tok) => ({ id: tok.replace(/^\*/, ''), isDefault: tok.startsWith('*') }))
      .filter((o) => o.id)
      .map((o) => ({ ...o, borderless: isBorderlessMedia(o.id) }));
  }
  return [];
}

/** Given a printer's page-size options and a requested size (e.g. "Custom.4x6in"
 *  or "4x6"), return the id of the borderless variant of that same size — matched
 *  by its dimensions regardless of order — or null. So "4x6"/"6x4"/"Custom.4x6in"
 *  all resolve to "4x6.Fullbleed" when the driver offers it. */
function borderlessFor(options, requested) {
  const dims = (id) => (String(id || '').match(/\d+/g) || []).map(Number).sort((a, b) => a - b).join('x');
  // Base name: drop the borderless suffix, a leading "Custom.", a trailing "in".
  const base = (id) => String(id || '').toLowerCase()
    .replace(/\.(fullbleed|bl|fb)$/i, '').replace(/^custom\./, '').replace(/in$/, '');
  const wantDims = dims(requested);
  const wantBase = base(requested);
  const hit = (options || []).find((o) =>
    o.borderless && (((wantDims && dims(o.id) === wantDims)) || base(o.id) === wantBase));
  return hit ? hit.id : null;
}

/** The page sizes a printer supports, borderless variants flagged. */
async function mediaOptions(printer) {
  if (!printer) return { options: [], error: 'no printer' };
  const res = await run('lpoptions', ['-p', printer, '-l']);
  if (!res.ok && !res.stdout) return { options: [], error: (res.stderr || res.error || 'lpoptions failed').trim() };
  return { options: parseMediaOptions(res.stdout), error: null };
}

/**
 * Options for `lp`. Borderless asks the printer to go edge-to-edge in the two ways
 * CUPS supports, so it works whichever kind of queue this is:
 *   • Driverless / AirPrint (common for Canon on macOS): borderless means ZERO
 *     media margins — `media-*-margin=0` (hundredths of a mm) builds a media-col
 *     with no margins, the standard IPP borderless request.
 *   • Classic PPD driver: it uses the borderless PageSize the host picked (passed
 *     as the media size), and ignores the margin hints.
 * `print-scaling=fill` then makes the image cover the whole sheet (a slight
 * over-run) so no white edge shows. All of this takes precedence over fit-to-page,
 * which instead shrinks the image into the printable area, leaving a border.
 */
function buildPrintOptions({ borderless = false, fitToPage = false, mediaType = '' } = {}) {
  const options = { 'print-quality': '5', cupsPrintQuality: 'High' };
  // Photo paper mode — without it a photo prints in plain-paper mode and looks
  // grainy/washed. `mediaType` is a driver value (e.g. "photographic"); CUPS
  // ignores it on queues that don't have it.
  if (mediaType) options.MediaType = mediaType;
  if (borderless) {
    options['print-scaling'] = 'fill';
    options['media-left-margin'] = '0';
    options['media-right-margin'] = '0';
    options['media-top-margin'] = '0';
    options['media-bottom-margin'] = '0';
  } else if (fitToPage) {
    options['fit-to-page'] = 'true';
  }
  return options;
}

async function cancel(jobId) {
  const res = await run('cancel', ['--', String(jobId)]);
  return { ok: res.ok, error: res.ok ? null : (res.stderr || res.error || '').trim() };
}

module.exports = {
  available, listPrinters, parsePrinters, listJobs, print,
  buildPrintOptions, mediaOptions, parseMediaOptions, isBorderlessMedia, borderlessFor, cancel, run,
};
