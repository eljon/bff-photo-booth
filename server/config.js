'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_PATH = process.env.PHOTOBOOTH_CONFIG || path.join(__dirname, '..', 'photobooth.config.json');

const DEFAULTS = {
  boothName: 'BFF Photo Booth',
  printer: null,            // null => the Mac's default destination (legacy single printer)
  // Multiple printers the host chose to run in parallel. Each: { agentId, name, label }.
  // agentId is 'local' for a printer on the booth Mac, or a connected computer's id in
  // relay mode. label is the host-set name/number shown to guests and on the board.
  // Empty => fall back to the single `printer` (or the one default destination).
  printers: [],
  media: 'Custom.4x6in',    // paper size passed to lp
  mediaType: 'photographic', // MediaType for lp — photo paper mode (else plain, grainy)
  borderless: true,         // fill the sheet edge-to-edge, and auto-pick the printer's borderless size
  fitToPage: true,          // only used when borderless is off: shrink to the printable area
  copies: 1,
  maxCopies: 3,
  requireApproval: false,   // host taps "Print" on /host before anything reaches the queue
  printingEnabled: true,    // false => download-only mode (no printer at the party)
  message: 'Make a strip. Take it home.',
  // Off by default: guests scan and print, nothing in the way. Turn it on and
  // only phones that came in through the QR link can print.
  guestKeyRequired: false,
  // Which tunnel this booth uses. Set once with --tunnel=…, remembered after,
  // so starting the booth is the same command every time.
  tunnel: '',
  accessKey: '',            // generated on first run, carried in the QR link
  // The corner badge stamped on every strip. Any .png dropped into
  // public/backgrounds/ shows up as a choice on the host screen.
  sticker: 'backgrounds/sticker.png',
};

const BACKGROUNDS_DIR = path.join(__dirname, '..', 'public', 'backgrounds');

/** Pretty a filename into a label: "temple-sticker.png" -> "Temple". */
function stickerLabel(file) {
  return file
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]?sticker[-_]?/i, ' ')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Sticker';
}

/** Every sticker the booth can stamp — the .png files in public/backgrounds
 *  (the papers are .jpg, so this cleanly separates stickers from backgrounds). */
function listStickers() {
  let files = [];
  try {
    files = fs.readdirSync(BACKGROUNDS_DIR).filter((f) => /\.png$/i.test(f));
  } catch {
    files = [];
  }
  files.sort();
  return files.map((file) => ({ id: file, name: stickerLabel(file), path: `backgrounds/${file}` }));
}

let cache = null;

function newKey() {
  return crypto.randomBytes(9).toString('base64url');
}

/**
 * Settings a stateless deploy can pin from the environment. ACCESS_KEY matters
 * most: without it a redeploy would mint a new guest key and every QR code you
 * printed for the party would stop working.
 */
const ENV_PINNED = {
  accessKey: process.env.ACCESS_KEY,
  boothName: process.env.BOOTH_NAME,
};

function pinned() {
  const out = {};
  for (const [key, value] of Object.entries(ENV_PINNED)) {
    if (value) out[key] = String(value).slice(0, 200);
  }
  return out;
}

/** Which settings the host screen cannot change, because the env owns them. */
function pinnedKeys() {
  return Object.keys(pinned());
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    stored = {};
  }
  cache = { ...DEFAULTS, ...stored, ...pinned() };
  if (!cache.accessKey) {
    cache.accessKey = newKey();
    persist(cache);
  }
  return cache;
}

function persist(value) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(value, null, 2));
  } catch (err) {
    console.error(`  Could not write ${CONFIG_PATH}: ${err.message}`);
  }
}

function save(patch) {
  const next = { ...load() };
  const locked = new Set(pinnedKeys());

  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] === undefined || locked.has(key)) continue;
    const def = DEFAULTS[key];
    let value = patch[key];

    if (key === 'guestKeyRequired') {
      next[key] = value === true || value === 'true';
      continue;
    }
    if (key === 'accessKey') continue; // rotated deliberately, never set by hand
    if (key === 'printers') {
      next[key] = Array.isArray(value)
        ? value.slice(0, 40).map((p) => ({
            agentId: String((p && p.agentId) || 'local').slice(0, 80),
            name: String((p && p.name) || '').slice(0, 128),
            label: String((p && p.label) || '').slice(0, 40),
          })).filter((p) => p.name)
        : [];
      continue;
    }
    if (key === 'sticker') {
      // Only accept a sticker the booth actually has, so this can't be pointed
      // at an arbitrary path.
      if (listStickers().some((s) => s.path === value)) next[key] = String(value);
      continue;
    }

    if (typeof def === 'boolean') value = Boolean(value);
    else if (typeof def === 'number') value = Number(value) || def;
    else if (value !== null) value = String(value).slice(0, 200);
    next[key] = value;
  }

  if (patch.rotateKey && !locked.has('accessKey')) next.accessKey = newKey();
  next.maxCopies = Math.max(1, Math.min(10, next.maxCopies));
  next.copies = Math.max(1, Math.min(next.maxCopies, next.copies));

  persist(next);
  cache = { ...next, ...pinned() };
  return cache;
}

module.exports = { load, save, pinnedKeys, listStickers, DEFAULTS, CONFIG_PATH };
