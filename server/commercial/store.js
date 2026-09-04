'use strict';

/**
 * Durable store for the commercial (multi-tenant) layer: users, sessions, entitlements.
 *
 * JSON-file backed for now, behind a small interface so it can move to Postgres later
 * (see docs/ARCHITECTURE-SAAS.md) without the rest of the app changing. Writes are atomic
 * (temp file + rename). This is deliberately simple — the trial runs on one relay.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_DIR = process.env.SAAS_DATA || path.join(__dirname, '..', '..', 'saas-data');

class Store {
  constructor(dir = DEFAULT_DIR) {
    this.file = path.join(dir, 'commercial.json');
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.data = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        secret: raw.secret || crypto.randomBytes(32).toString('hex'),
        users: raw.users || {},
        sessions: raw.sessions || {},
        entitlements: raw.entitlements || {},
      };
    } catch {
      return { secret: crypto.randomBytes(32).toString('hex'), users: {}, sessions: {}, entitlements: {} };
    }
  }

  _save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get secret() { return this.data.secret; }

  // ── users ────────────────────────────────────────────────────────────────
  userByEmail(email) {
    const key = String(email || '').trim().toLowerCase();
    return Object.values(this.data.users).find((u) => u.email === key) || null;
  }
  userById(id) { return this.data.users[id] || null; }
  userByProvider(provider, subject) {
    if (!subject) return null;
    return Object.values(this.data.users).find((u) => u.provider === provider && u.providerSubject === subject) || null;
  }

  /** Find or create the account behind a social login. Matches on (provider, subject) first;
   *  if the verified email already has an account, links this provider to it. */
  findOrCreateOAuth({ provider, subject, email, name }) {
    const existing = this.userByProvider(provider, subject);
    if (existing) return existing;
    const byEmail = email ? this.userByEmail(email) : null;
    if (byEmail) {
      byEmail.provider = byEmail.provider === 'password' ? byEmail.provider : provider;
      byEmail.providerSubject = subject;
      if (!byEmail.name && name) byEmail.name = name;
      this._save();
      return byEmail;
    }
    return this.createUser({ email, name, provider, providerSubject: subject });
  }

  createUser({ email, name, provider = 'password', passHash = null, providerSubject = null }) {
    const id = `usr_${crypto.randomBytes(9).toString('hex')}`;
    const user = {
      id,
      email: String(email || '').trim().toLowerCase(),
      name: name || '',
      provider,
      providerSubject,
      passHash,
      createdAt: Date.now(),
    };
    this.data.users[id] = user;
    this._save();
    return user;
  }

  // ── sessions (the purchasable unit) ────────────────────────────────────────
  sessionsForUser(userId) {
    return Object.values(this.data.sessions)
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  sessionById(id) { return this.data.sessions[id] || null; }

  createSession({ userId, name, printQuota = null, status = 'active' }) {
    const id = `ses_${crypto.randomBytes(9).toString('hex')}`;
    const session = {
      id,
      userId,
      name: name || 'Untitled event',
      status, // active | expired | exhausted | cancelled
      printQuota, // null = unlimited within the plan
      printsUsed: 0,
      boothToken: crypto.randomBytes(24).toString('hex'), // reserved for per-session booth wiring
      createdAt: Date.now(),
    };
    this.data.sessions[id] = session;
    this._save();
    return session;
  }

  updateSession(id, patch) {
    const s = this.data.sessions[id];
    if (!s) return null;
    Object.assign(s, patch);
    this._save();
    return s;
  }

  // ── entitlements (the payment ledger) ──────────────────────────────────────
  createEntitlement({ userId, sessionId, amountCents, currency = 'usd', status = 'paid', stripeCheckoutId = null }) {
    const id = `ent_${crypto.randomBytes(9).toString('hex')}`;
    const ent = { id, userId, sessionId, amountCents, currency, status, stripeCheckoutId, createdAt: Date.now() };
    this.data.entitlements[id] = ent;
    this._save();
    return ent;
  }
  entitlementByCheckout(stripeCheckoutId) {
    return Object.values(this.data.entitlements).find((e) => e.stripeCheckoutId === stripeCheckoutId) || null;
  }
}

module.exports = { Store, DEFAULT_DIR };
