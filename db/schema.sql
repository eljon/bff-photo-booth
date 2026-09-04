-- bff-photo-booth — Postgres schema for the multi-tenant / paid service.
--
-- This is the SaaS target (see docs/ARCHITECTURE-SAAS.md), not what the
-- single-tenant booth uses today (that stores prints/*.json on disk). It is a
-- starting point to review and evolve, not a migration that has been run.
--
-- Conventions:
--   * UUID primary keys (gen_random_uuid, from pgcrypto).
--   * Every tenant-owned row carries booth_id, so one query filter (and Row-
--     Level Security) isolates tenants.
--   * timestamptz everywhere; created_at/updated_at on mutable tables.
--   * Money in integer minor units (cents) — never floats.

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- Accounts
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per person. Identity comes from the auth provider (Supabase Auth /
-- Clerk / Firebase); we keep a local mirror so foreign keys and RLS are simple.
create table users (
  id            uuid primary key default gen_random_uuid(),
  auth_provider text not null,               -- 'google' | 'email' | 'facebook'
  auth_subject  text not null,               -- the provider's stable user id (sub)
  email         text,                         -- convenience copy; may be null for some providers
  display_name  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (auth_provider, auth_subject)
);
create index on users (email);

-- ─────────────────────────────────────────────────────────────────────────────
-- Booths — a user owns many. This is the tenant boundary.
-- ─────────────────────────────────────────────────────────────────────────────

create table booths (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  name        text not null,                  -- printed along the bottom of every strip
  -- Per-booth settings: today's photobooth.config.json, one blob per booth.
  -- (paper size, layout rules, requireVoucher, printing-on, ask-before-print, …)
  settings    jsonb not null default '{}'::jsonb,
  -- Guest token carried in the QR link (?k=…). Rotatable ("New guest link")
  -- without touching auth. Replaces the global ACCESS_KEY.
  guest_token text not null default encode(gen_random_bytes(12), 'hex'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on booths (user_id);
create unique index on booths (guest_token);

-- ─────────────────────────────────────────────────────────────────────────────
-- Printers — a booth has many, each bound to one helper install.
-- Mirrors config.printers = [{ agentId, name, label }] today.
-- ─────────────────────────────────────────────────────────────────────────────

create table printers (
  id         uuid primary key default gen_random_uuid(),
  booth_id   uuid not null references booths (id) on delete cascade,
  agent_id   text not null,                   -- which helper/computer owns this printer
  name       text not null,                   -- CUPS/queue name passed to lp
  label      text not null,                   -- what guests + the board see ("Printer 1")
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  unique (booth_id, agent_id, name)
);
create index on printers (booth_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Agents — helper installs / live connections per booth. Powers the host
-- screen's "booth mac: connected" and free-first job routing.
-- ─────────────────────────────────────────────────────────────────────────────

create table agents (
  id          uuid primary key default gen_random_uuid(),
  booth_id    uuid not null references booths (id) on delete cascade,
  agent_id    text not null,                  -- stable per-computer id (x-agent-id)
  name        text,                            -- "Eljon's MacBook booth"
  -- Per-agent credential the helper signs in with, instead of the shared token.
  token_hash  text not null,                  -- store only a hash of the secret
  last_seen   timestamptz,
  created_at  timestamptz not null default now(),
  unique (booth_id, agent_id)
);
create index on agents (booth_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Sessions — THE PURCHASABLE UNIT. A window of paid time / a print allowance
-- for a booth. Created by a Stripe checkout (via the entitlement below).
-- ─────────────────────────────────────────────────────────────────────────────

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  booth_id      uuid not null references booths (id) on delete cascade,
  status        text not null default 'active'
                  check (status in ('active', 'expired', 'exhausted', 'cancelled')),
  print_quota   integer,                       -- max prints; null = unlimited within the window
  prints_used   integer not null default 0,
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz,                   -- null = no time limit, quota-only
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on sessions (booth_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Entitlements — the ledger tying a Stripe payment to what it granted.
-- The Stripe webhook writes here; sessions/vouchers are minted from it.
-- ─────────────────────────────────────────────────────────────────────────────

create table entitlements (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users (id) on delete cascade,
  booth_id            uuid references booths (id) on delete set null,
  session_id          uuid references sessions (id) on delete set null,
  -- Stripe linkage — unique so webhook retries are idempotent.
  stripe_checkout_id  text unique,
  stripe_payment_id   text,
  amount_cents        integer not null,
  currency            text not null default 'usd',
  prints_granted      integer,                 -- what was bought; null = unlimited/time-based
  status              text not null default 'paid'
                        check (status in ('paid', 'refunded', 'disputed')),
  created_at          timestamptz not null default now()
);
create index on entitlements (user_id);
create index on entitlements (booth_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Vouchers — single-use print codes, now scoped to a paid session.
-- Same idea as server/vouchers.js; redeeming one draws down the session.
-- ─────────────────────────────────────────────────────────────────────────────

create table vouchers (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions (id) on delete cascade,
  code        text not null,                   -- 6-char, ambiguity-free alphabet, profanity-filtered
  redeemed_at timestamptz,                      -- null = unused
  job_id      uuid,                             -- set on redemption (FK added after jobs exists)
  created_at  timestamptz not null default now(),
  unique (session_id, code)
);
-- Fast "is this code valid for this session and unused?" lookup.
create index on vouchers (session_id, code) where redeemed_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Jobs — print jobs. Metadata here; the image lives in object storage.
-- Carries the existing status machine.
-- ─────────────────────────────────────────────────────────────────────────────

create table jobs (
  id          uuid primary key default gen_random_uuid(),
  booth_id    uuid not null references booths (id) on delete cascade,
  session_id  uuid references sessions (id) on delete set null,
  printer_id  uuid references printers (id) on delete set null,
  voucher_id  uuid references vouchers (id) on delete set null,
  status      text not null default 'pending'
                check (status in ('awaiting-approval', 'pending', 'printing',
                                  'claimed', 'done', 'failed', 'rejected', 'cancelled')),
  image_key   text not null,                   -- object-storage key of the composited strip
  layout      text,                            -- chosen grid variant
  cups_job_id text,                            -- printer-side id, for cancellation
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- The queue query the pump runs constantly.
create index on jobs (booth_id, status);
create index on jobs (printer_id, status);

-- Deferred FK: a voucher points at the job that consumed it.
alter table vouchers
  add constraint vouchers_job_id_fkey
  foreign key (job_id) references jobs (id) on delete set null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Notes
-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security: enable RLS on booths, printers, agents, sessions,
-- entitlements, vouchers, and jobs, with a policy of
--   "the row's booth_id belongs to a booth owned by the current auth user"
-- so a tenant can never read another tenant's data even if the app has a bug.
-- Guests are unauthenticated and reach jobs only through a server endpoint that
-- has already validated the booth's guest_token — they never query these tables
-- directly.
--
-- updated_at: add a trigger (or set it in the app) to bump updated_at on write;
-- omitted here to keep the schema readable.
