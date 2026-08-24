'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = process.env.PHOTOBOOTH_CONFIG || path.join(__dirname, '..', 'photobooth.config.json');

const DEFAULTS = {
  boothName: 'BFF Photo Booth',
  printer: null,            // null => CUPS default destination
  media: 'Custom.4x6in',    // paper size passed to lp
  fitToPage: true,
  copies: 1,
  maxCopies: 3,
  requireApproval: false,   // host taps "Print" on /host before anything reaches the queue
  printingEnabled: true,    // false => download-only mode (no printer at the party)
  message: 'Pick 4 photos. Make a strip. Take it home.',
};

let cache = null;

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    stored = {};
  }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

function save(patch) {
  const next = { ...load() };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] === undefined) continue;
    const def = DEFAULTS[key];
    let value = patch[key];
    if (typeof def === 'boolean') value = Boolean(value);
    else if (typeof def === 'number') value = Number(value) || def;
    else if (value !== null) value = String(value).slice(0, 200);
    next[key] = value;
  }
  next.copies = Math.max(1, Math.min(next.maxCopies, next.copies));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  cache = next;
  return cache;
}

module.exports = { load, save, DEFAULTS, CONFIG_PATH };
