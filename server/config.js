'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_PATH = process.env.PHOTOBOOTH_CONFIG || path.join(__dirname, '..', 'photobooth.config.json');

const DEFAULTS = {
  boothName: 'BFF Photo Booth',
  printer: null,            // null => the Mac's default destination
  media: 'Custom.4x6in',    // paper size passed to lp
  fitToPage: true,
  copies: 1,
  maxCopies: 3,
  requireApproval: false,   // host taps "Print" on /host before anything reaches the queue
  printingEnabled: true,    // false => download-only mode (no printer at the party)
  message: 'Pick 4 photos. Take it home.',
  // Off by default: guests scan and print, nothing in the way. Turn it on and
  // only phones that came in through the QR link can print.
  guestKeyRequired: false,
  accessKey: '',            // generated on first run, carried in the QR link
};

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

module.exports = { load, save, pinnedKeys, DEFAULTS, CONFIG_PATH };
