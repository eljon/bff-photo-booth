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
  hostToken: '',            // generated when a booth without BOOTH_TOKEN goes public
};

let cache = null;

function newKey() {
  return crypto.randomBytes(9).toString('base64url');
}

function newHostToken() {
  return crypto.randomBytes(12).toString('base64url');
}

/**
 * The password for the host screen. Set BOOTH_TOKEN and it is yours; otherwise
 * a booth that becomes public generates one and prints it at startup, so
 * `npm run tunnel` cannot lock you out of your own booth.
 */
function ensureHostToken() {
  const current = load();
  if (current.hostToken) return current.hostToken;
  const token = newHostToken();
  cache = { ...current, hostToken: token };
  persist(cache);
  return token;
}

/**
 * Settings a stateless deploy can pin from the environment. ACCESS_KEY matters
 * most: without it a redeploy would mint a new guest key and every QR code you
 * printed for the party would stop working.
 */
const ENV_PINNED = {
  accessKey: process.env.ACCESS_KEY,
  boothName: process.env.BOOTH_NAME,
  hostToken: process.env.BOOTH_TOKEN,
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
      next[key] = value === 'auto' ? 'auto' : Boolean(value);
      continue;
    }
    if (key === 'accessKey' || key === 'hostToken') continue; // never set by hand

    if (typeof def === 'boolean') value = Boolean(value);
    else if (typeof def === 'number') value = Number(value) || def;
    else if (value !== null) value = String(value).slice(0, 200);
    next[key] = value;
  }

  if (patch.rotateKey && !locked.has('accessKey')) next.accessKey = newKey();
  if (patch.rotateHostToken && !locked.has('hostToken')) next.hostToken = newHostToken();
  next.maxCopies = Math.max(1, Math.min(10, next.maxCopies));
  next.copies = Math.max(1, Math.min(next.maxCopies, next.copies));

  persist(next);
  cache = { ...next, ...pinned() };
  return cache;
}

module.exports = { load, save, ensureHostToken, pinnedKeys, DEFAULTS, CONFIG_PATH };
