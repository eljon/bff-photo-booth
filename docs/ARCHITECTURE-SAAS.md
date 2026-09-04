# Architecture — turning the booth into a paid, multi-tenant service

This is the target design for the SaaS version: users sign up (Google / email /
Facebook), buy a session, open the host from their account, connect a printer,
and it works — no per-event server to stand up. It is written as a **plan**, not
as a description of what exists today. Where a piece already exists in this repo,
it says so, because most of the migration is *evolving* the current code rather
than replacing it.

The single-tenant booth (`server/index.js`, the tunnel, `prints/*.json`) keeps
working the whole time. Nothing here forces a big-bang rewrite.

---

## The one constraint that shapes everything: reaching the printer

A printer on a home or venue network is **not reachable from the internet**. No
cloud server can print to it directly. Something *next to the printer* must reach
*outward* and pull jobs down. That bridge can only be one of three things:

| Bridge | Install on the printer machine? | Silent auto-print? | Control (media / borderless / copies) |
| --- | --- | --- | --- |
| **Browser tab** — `window.print()` (removed from the current build; could return for SaaS) | Nothing | Only with Chrome `--kiosk-printing` (one-time) or a manual click | Weak — whatever the browser exposes |
| **Native helper** — a tiny signed tray/menubar app | One double-click | **Yes** | Full — talks to CUPS / `lp` |
| **Commercial cloud-print API** (PrintNode, ezeep) | Their client | Yes | Full, but per-device cost + third party |

> Google Cloud Print was shut down in 2020. There is **no** browser API that
> silently prints to a chosen printer with photo media settings. "Zero install"
> **and** "silent borderless 4×6" cannot both be true today — pick which one the
> product promises.

**Decision: ship a one-click signed native helper as the premium path.** A browser
`window.print()` bridge could return later as a zero-install fallback (it was
removed from the current build to avoid confusing it with the agent), but the
helper is the "it just works" experience customers pay for, and **we have already
built its hard half**
— `server/agent.js` is exactly this bridge: outbound-only long-poll, CUPS
printing, a per-machine `x-agent-id`, and one job per local printer. The SaaS
work is wrapping it in a signed, auto-updating app (Tauri or a small Electron/Go
tray app) that **authenticates to a user account** instead of a shared
`BOOTH_TOKEN`, and swapping its long-poll for the shared realtime channel below.

---

## Target topology

```
                 Guests' phones                Host (owner's browser)
                      │                                │
                      ▼                                ▼
        ┌─────────────────────────────────────────────────────────┐
        │        Stateless app servers (N replicas, autoscaled)    │
        │   guest app · host app · REST API · realtime endpoints   │
        └───────┬───────────────┬───────────────┬─────────────────┘
                │               │               │
        ┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼──────────┐
        │  Postgres    │ │ Object store │ │ Realtime /     │
        │ (accounts,   │ │ (photos,     │ │ pub-sub        │
        │  sessions,   │ │  strips) via │ │ (agent + guest │
        │  jobs, etc.) │ │  presigned   │ │  live updates) │
        └──────────────┘ │  uploads     │ └─────┬──────────┘
                         └──────────────┘       │
                                                ▼
                                   Printer helper app (per booth)
                                   ── outbound only ── prints via CUPS
```

Every server is **stateless**: any replica can serve any request because all
state lives in Postgres, object storage, or the realtime backplane. That is what
makes horizontal autoscaling possible.

---

## What each piece of today's code becomes

| Today (single-tenant) | Becomes (multi-tenant) | Why |
| --- | --- | --- |
| `jobs` / `agents` / `codeMisses` in-memory `Map`s | Rows in Postgres + a Redis/pubsub backplane | Many replicas can't share RAM. This is the highest-leverage refactor. |
| `prints/queue.json`, `vouchers.json` (atomic file writes) | Postgres tables | Concurrency, queries, per-tenant isolation, backups |
| `PRINTS_DIR` on a mounted disk | Object storage (Cloudflare R2 / S3), **presigned direct upload** | Server never streams image bytes; scales to thousands of booths |
| Agent long-poll (`/api/agent/jobs?wait=`) held by one process | Realtime channel (Ably / Pusher / Supabase Realtime, or WS + Redis) | A long-poll pinned to one replica breaks behind a load balancer |
| Shared `BOOTH_TOKEN` unlocks host + signs in agent | Per-user auth (managed provider) + per-booth agent credentials | Multi-tenant security; revoke one booth without touching others |
| `ACCESS_KEY` guest key in the QR link | Per-booth guest token minted from the DB | Same idea, scoped per booth |
| `requireVoucher` + `VoucherStore` | Kept, but sits **under** paid entitlements | A purchased session grants the right to print; vouchers stay as the redemption mechanic |

---

## Recommended stack

Opinionated, chosen to spend engineering effort on the printer helper (the moat)
and buy everything else:

- **Auth**: a managed provider — **Supabase Auth**, Clerk, or Firebase Auth —
  for Google + email + Facebook in one integration. **Do not roll your own
  OAuth.**
- **Database**: managed **Postgres** — Supabase / Neon / RDS.
- **Object storage**: **Cloudflare R2** or S3, with presigned PUT for uploads and
  presigned GET (or a signed CDN) for reads.
- **Realtime**: **Supabase Realtime**, Ably, or Pusher — or WebSockets with a
  Redis backplane if self-hosting.
- **Payments**: **Stripe** Checkout + webhooks. A "session" is a Stripe product;
  a paid checkout writes an `entitlement` row.
- **App servers**: Node (reuse the `server/index.js` logic), stateless, on
  **Fly.io** / Railway / Fargate, autoscaled.
- **Printer helper**: `server/agent.js` rewrapped as a signed **Tauri** tray app
  that logs into the user's account.

**Fastest credible path: make Supabase the spine.** It gives Postgres + auth
(Google/email/FB) + realtime + storage in one product, collapsing four bullets
into one vendor. Graduate individual pieces to dedicated services if you outgrow
them. Spend the saved time on the helper.

---

## Data model

The schema is the decision that constrains everything else, so it's the first
thing to lock down. Full DDL lives in [`db/schema.sql`](../db/schema.sql).
Shape of it:

- **`users`** — one per person (from the auth provider). `auth_provider` +
  `auth_subject` identify them; email is a convenience copy.
- **`booths`** — a user owns many booths. Holds the booth name, guest token,
  layout/printing settings (the current `photobooth.config.json`, per booth).
- **`printers`** — a booth has many printers, each bound to one helper install
  (`agent_id`), with a label. Mirrors today's `config.printers`.
- **`sessions`** — **the purchasable unit.** A window of paid time / a print
  allowance for a booth. Created by a Stripe checkout.
- **`entitlements`** — the ledger linking a Stripe payment to what it granted
  (which session, how many prints, expiry). The webhook writes here.
- **`vouchers`** — unchanged in spirit; now scoped to a `session_id`. Redeeming
  one draws down that session's allowance.
- **`jobs`** — print jobs: metadata in Postgres, the image in object storage
  (`image_key`). Carries the full status machine you already have
  (`awaiting-approval → pending → printing/claimed → done|failed|…`), plus
  `booth_id`, `session_id`, `printer_id`, `voucher_id`.
- **`agents`** — helper installs / connections per booth, so the host screen can
  show "connected" and jobs route to a free printer.

Multi-tenancy rule: **every tenant-owned row carries `booth_id` (and through it
`user_id`)**, and every query filters on it. With Supabase, enforce this with
Row-Level Security so a tenant can never read another tenant's rows even if the
app has a bug.

---

## Migration path (evolve, don't rewrite)

Each step ships independently and leaves the single-tenant booth working:

1. **Extract state behind interfaces.** Replace direct `Map`/`fs` access in
   `server/index.js` with a storage layer (`jobsStore`, `voucherStore`,
   `agentRegistry`) — already begun with `VoucherStore`. Back it with Postgres +
   Redis. *This one refactor makes the server horizontally scalable* and is the
   highest-leverage move.
2. **Move photos to presigned object storage.** Guests upload directly to R2/S3;
   the server stores only the key.
3. **Add auth + the `users / booths / sessions / entitlements` schema.** One
   user → many booths → many purchased sessions.
4. **Add Stripe.** Gate booth creation / printing on a paid entitlement; the
   webhook writes entitlements.
5. **Rewrap the agent as an account-authenticated signed app** and move it (and
   the guest) onto the realtime channel. Now "open host from your account → it
   just works."

---

## Cost & scaling notes

- **Photos dominate storage and bandwidth.** Presigned direct upload/download
  keeps image bytes off your app servers entirely — do this early; it's the
  difference between scaling smoothly and paying for egress through your API.
- **Realtime connections, not CPU, are the limit** for many idle-but-connected
  booths. A managed realtime tier prices per concurrent connection — model that.
- **Postgres is fine into the thousands of booths** with the right indexes
  (`jobs(booth_id, status)`, `vouchers(session_id, code)`); shard or partition
  only when a single tenant's job volume proves it necessary.
- **Keep prints durable across replica restarts** — that's the whole reason jobs
  move to Postgres. A job accepted from a guest must survive any server dying.
