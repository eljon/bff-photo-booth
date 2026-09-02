'use strict';

/**
 * Print vouchers — single-use codes a guest must enter to print.
 *
 * Each code is 6 characters from a 31-letter alphabet with the ambiguous glyphs removed
 * (no I, L, O, 0, 1), so a printed voucher is unmistakable. That is 31^6 ≈ 887 million
 * combinations; a party hands out ~1000, so guessing a live code is a one-in-a-million
 * shot per try — and print attempts are rate limited on top of that.
 *
 * Codes are generated cryptographically at random (never sequential), stored on disk so
 * they survive a restart, and marked used the moment a print is accepted. A print that
 * fails or the host skips refunds the code so it is not burned by a booth error.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 chars — no I, L, O, 0, 1
const LEN = 6;
const MAX_CODES = 100_000; // a sane ceiling so a fat-fingered count can't exhaust memory

/** One unguessable 6-char code. */
function makeCode() {
  const bytes = crypto.randomBytes(LEN);
  let out = '';
  for (let i = 0; i < LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Normalise what a guest typed to how codes are stored: upper-case, letters/digits only. */
function normalize(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, LEN);
}

class VoucherStore {
  constructor(file) {
    this.file = file;
    this.codes = new Map(); // code -> { used, usedAt?, printNo? }
    this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [code, v] of Object.entries(data.codes || {})) {
        this.codes.set(code, { used: Boolean(v.used), usedAt: v.usedAt || 0, printNo: v.printNo || null });
      }
    } catch { /* first run, or nothing stored yet */ }
  }

  async _save() {
    try {
      const data = JSON.stringify({ codes: Object.fromEntries(this.codes) });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, this.file);
    } catch (err) {
      console.error('  ⚠ could not save vouchers:', err.message);
    }
  }

  /** Add `count` fresh unique codes; returns the new codes (upper bound enforced). */
  generate(count) {
    const want = Math.max(0, Math.min(Number(count) || 0, MAX_CODES - this.codes.size));
    const added = [];
    while (added.length < want) {
      const code = makeCode();
      if (this.codes.has(code)) continue; // vanishingly rare, but never collide
      this.codes.set(code, { used: false, usedAt: 0, printNo: null });
      added.push(code);
    }
    if (added.length) this._save();
    return added;
  }

  /** Check a code WITHOUT spending it. Returns { ok, reason } — for a fast, cheap reject
   *  before the image is uploaded, and to feed the brute-force guard. */
  peek(input) {
    const code = normalize(input);
    const v = this.codes.get(code);
    if (!v) return { ok: false, reason: 'unknown' };
    if (v.used) return { ok: false, reason: 'used' };
    return { ok: true, code };
  }

  /** Spend a code. Returns { ok, reason } — reason is 'unknown' or 'used' on failure. */
  redeem(input, printNo = null) {
    const code = normalize(input);
    const v = this.codes.get(code);
    if (!v) return { ok: false, reason: 'unknown' };
    if (v.used) return { ok: false, reason: 'used' };
    v.used = true;
    v.usedAt = Date.now();
    v.printNo = printNo;
    this._save();
    return { ok: true, code };
  }

  /** Return a spent code to the pool (a failed/skipped print should not burn it). */
  refund(input) {
    const code = normalize(input);
    const v = this.codes.get(code);
    if (v && v.used) { v.used = false; v.usedAt = 0; v.printNo = null; this._save(); }
  }

  /** Wipe every code (host reset). */
  clear() {
    this.codes.clear();
    this._save();
  }

  stats() {
    let used = 0;
    for (const v of this.codes.values()) if (v.used) used += 1;
    return { total: this.codes.size, used, unused: this.codes.size - used };
  }

  /** All codes with their state, newest generation last. For the host's download. */
  list() {
    return [...this.codes.entries()].map(([code, v]) => ({ code, used: v.used }));
  }
}

module.exports = { VoucherStore, LEN, ALPHABET };
