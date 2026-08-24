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
  message: 'Pick 4 photos. Make a strip. Take it home.',
  // 'auto' asks for the QR key only once the booth is reachable from outside
  // the local network; true/false override that.
  guestKeyRequired: 'auto',
  accessKey: '',            // generated on first run, carried in the QR link
};

let cache = null;

function newKey() {
  return crypto.randomBytes(9).toString('base64url');
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    stored = {};
  }
  cache = { ...DEFAULTS, ...stored };
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

  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] === undefined) continue;
    const def = DEFAULTS[key];
    let value = patch[key];

    if (key === 'guestKeyRequired') {
      next[key] = value === 'auto' ? 'auto' : Boolean(value);
      continue;
    }
    if (key === 'accessKey') continue; // rotated deliberately, never set by hand

    if (typeof def === 'boolean') value = Boolean(value);
    else if (typeof def === 'number') value = Number(value) || def;
    else if (value !== null) value = String(value).slice(0, 200);
    next[key] = value;
  }

  if (patch.rotateKey) next.accessKey = newKey();
  next.maxCopies = Math.max(1, Math.min(10, next.maxCopies));
  next.copies = Math.max(1, Math.min(next.maxCopies, next.copies));

  persist(next);
  cache = next;
  return cache;
}

module.exports = { load, save, DEFAULTS, CONFIG_PATH };
