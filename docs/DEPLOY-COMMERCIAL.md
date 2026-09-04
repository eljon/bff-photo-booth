# Deploying Hawak Mo ang Booth (temporary name)

The commercial app (`npm run saas`) is the landing page + accounts + dashboard + payments,
and it runs each purchased session's booth as its own process, reachable at a per-session
subdomain. Deploy it as its **own** service, separate from the single-tenant booth relay.

**This guide uses the real target:** app at **`boothless.alphanauts.net`**, session booths at
**`<slug>.boothless.alphanauts.net`**, domain `alphanauts.net` registered at **Squarespace**.

## What it needs

- **One web service** running `npm run saas` (dependency-free Node — no build step).
- **A persistent disk** at `/data` (`SAAS_DATA=/data`) for accounts + each session's booth data.
- **DNS with wildcard + the records Render lists**: `boothless.alphanauts.net` → the service, a
  wildcard `*.boothless.alphanauts.net` → the service, and the `_acme-challenge` /
  `_cf-custom-hostname` CNAMEs Render shows (these let Render issue the certificate). The domain
  is at Squarespace, which *does* accept wildcard and these records — add them there directly.
  Only if Squarespace rejects a record (e.g. an underscore-prefixed name) fall back to
  **Cloudflare** — see Stage 2.
- Optional: Stripe + OAuth keys (see `docs/COMMERCIAL-SETUP.md`). Without them the app still
  runs with email login and a dev "simulate purchase."

---

## Stage 1 — the web service (Render)

The repo has **two** Dockerfiles: `./Dockerfile` (the booth relay) and `./Dockerfile.saas`
(this commercial app). Render auto-detects a Dockerfile, so the two things that MUST be set
correctly are the **branch** and the **Dockerfile path** — Render's create flow defaults the
branch to the repo's default (which is the booth) and won't always prompt you.

Create it by hand:

1. Render → **New ▸ Web Service** → repo `eljon/bff-photo-booth`.
2. **Branch:** `claude/photo-booth-commercial`  ← change it from the default; this is the fix
   for "it deployed the wrong thing."
3. **Language/Runtime:** Docker. **Dockerfile Path:** `./Dockerfile.saas`.
4. **Plan:** Starter.
5. **Advanced ▸ Add Disk:** name `saas-data`, mount `/data`, 1 GB.
6. **Environment:** `SAAS_DATA=/data`.
7. Create. You'll get `https://hawak-mo-ang-booth.onrender.com` — landing + email login + dev
   purchase work now. (Opening a session's host needs Stage 2.)

### Already created a service that failed?

If you have the `hawak-mo-ang-booth` service that failed (it built the booth relay from the
default branch and crashed — the relay exits without `BOOTH_TOKEN`), just fix it in place:

1. **Settings ▸ Build & Deploy ▸ Branch** → `claude/photo-booth-commercial`.
2. **Settings ▸ Build & Deploy ▸ Dockerfile Path** → `./Dockerfile.saas`
   (or, if you can't change the Dockerfile path, set **Docker Command** to `node server/saas.js`).
3. **Settings ▸ Disks** → add a 1 GB disk mounted at `/data` (if not already).
4. **Environment** → `SAAS_DATA=/data`.
5. **Manual Deploy ▸ Deploy latest commit.**

> Blueprint alternative: `render-saas.yaml` now pins both the branch and `Dockerfile.saas`.
> Rename it to `render.yaml` on the commercial branch and apply it as a Blueprint if you
> prefer that over the manual service.

---

## Stage 2 — connect boothless.alphanauts.net so sessions are reachable

### Why this stage exists

Each session's booth runs as its own process **inside** the Render container, on a private
`127.0.0.1:<port>` address. That address is unreachable from the internet, so every session is
published at its own subdomain — `<slug>.boothless.alphanauts.net` — that your Render service
answers and routes to the correct internal booth. Until DNS + `SAAS_BASE_DOMAIN` are set,
**Open host** has no public address to hand out. This stage sets that up.

### Step 2.1 — add the two domains in Render

1. Go to the Render dashboard and open your **`hawak-mo-ang-booth`** service.
2. In the left menu click **Settings**, then scroll to **Custom Domains**.
3. Click **Add Custom Domain**, type `boothless.alphanauts.net`, and confirm.
4. Click **Add Custom Domain** again, type `*.boothless.alphanauts.net` (the wildcard — the
   `*` is literal), and confirm.
5. Render now lists both domains as **unverified** and shows, for each, the DNS record it wants
   — usually a **CNAME** pointing at a host like `hawak-mo-ang-booth.onrender.com`. **Leave this
   Render tab open**; you'll copy those exact values next. (If Render shows a different target
   host than `hawak-mo-ang-booth.onrender.com`, use whatever it shows.)

### Step 2.2 — add the records at Squarespace

Squarespace **does** accept the wildcard and the underscore-prefixed records, so add everything
Render lists directly in Squarespace DNS — no Cloudflare needed. Render asks for a set of
**CNAME** records **per domain**; add every one it shows for BOTH `boothless.alphanauts.net`
and `*.boothless.alphanauts.net`. There is no "proxy"/cloud setting in Squarespace — it's plain
DNS, which is exactly what Render wants.

In Squarespace: **Domains → alphanauts.net → DNS → Add record**, once per row Render shows. For
each, **Type = CNAME**, **Name = the Hostname Render shows** (e.g. `boothless`, `*.boothless`,
`_acme-challenge.boothless`, `_cf-custom-hostname.boothless`), **Data = the Target** — use
Render's **copy button** for the target, since the value is truncated on screen.

Typical records (yours may differ slightly — always match Render's screen exactly):

| Type  | Name (Hostname)                 | Data (Target — copy from Render)          |
|-------|---------------------------------|-------------------------------------------|
| CNAME | `boothless`                     | `hawak-mo-ang-booth.onrender.com`         |
| CNAME | `*.boothless`                   | `hawak-mo-ang-booth.onrender.com`         |
| CNAME | `_acme-challenge.boothless`     | `hawak-mo-ang-booth.verify.render.com…`   |
| CNAME | `_cf-custom-hostname.boothless` | `hawak-mo-ang-booth.hostname…`            |

The **`_acme-challenge` and `_cf-custom-hostname` records are what let Render issue the HTTPS
certificate** — without them the domains resolve but never go secure. Add the base domain's own
set too (click `boothless.alphanauts.net` in Render to see its records).

**Only if Squarespace rejects a record** (some editors block underscore-prefixed names) move DNS
to **Cloudflare** (free) instead — see the fallback at the end of this stage.

### Step 2.3 — wait for Render to verify and issue TLS

1. Return to the Render **Custom Domains** screen and give it a few minutes (DNS can take
   5–30 min to propagate; wildcard certificates a little longer).
2. Click **Verify** / **Refresh** if there's a button. Both `boothless.alphanauts.net` and
   `*.boothless.alphanauts.net` should turn **green / Verified**, and Render should show a
   **certificate issued**. Don't continue until the wildcard shows a certificate — that's what
   secures the session subdomains.

### Step 2.4 — tell the app its domain

1. In Render → your service → **Environment**.
2. Click **Add Environment Variable**:
   - **Key:** `SAAS_BASE_DOMAIN`
   - **Value:** `boothless.alphanauts.net`  *(base only — no `https://`, no `*`)*
3. **Save Changes.** Render redeploys automatically (~1–2 min).

### Step 2.5 — check it works

1. Open **`https://boothless.alphanauts.net`** → the landing page loads over HTTPS.
2. Sign in → dashboard → open a session → **Open host**. It should now open
   **`https://<slug>.boothless.alphanauts.net/host`** — the session's own host screen with its
   own QR, auto-unlocked.
3. Scan that QR on your phone (on cellular, to prove it's public), build a strip, tap Print —
   it queues on that session's booth. Connect a printer to it with the helper app / `npm run
   agent`, using the pairing code shown on that session's host screen.

### If a certificate won't issue

- Make sure you added **all** the records Render lists for **both** domains — especially the
  `_acme-challenge.boothless` and `_cf-custom-hostname.boothless` CNAMEs. Missing either is the
  usual reason a domain resolves but never goes secure.
- Match Render's **Target** values exactly (use its copy button — they're truncated on screen).
- DNS changes take time (Squarespace TTL here is 4 hrs); give it a while, then re-check in Render.

### Fallback — Cloudflare (only if Squarespace refuses a record)

If Squarespace won't accept one of the records (some editors block underscore names), move DNS
to Cloudflare — the domain stays registered at Squarespace:

1. **cloudflare.com** → **Add a site** → `alphanauts.net` → Free plan. Let it import your records.
2. Copy Cloudflare's **two nameservers**; in **Squarespace → Domains → alphanauts.net →
   Nameservers**, choose **Use custom nameservers** and paste them.
3. When Cloudflare shows the domain **Active**, add the same records (all of Render's) in
   **DNS ▸ Records**, each **Proxy status: DNS only (grey cloud)** — proxying hides Render's
   certificate challenge and Cloudflare's free cert doesn't cover the two-level wildcard.

> Note on scale: each active session is its own process, so a Render **Starter** (512 MB)
> comfortably runs a handful of simultaneous live sessions — enough for launch. Many concurrent
> booths need a larger instance or the Postgres refactor in `docs/ARCHITECTURE-SAAS.md`.

---

## Stage 3 — payments (Stripe), optional

Add on the service's **Environment**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
(and optionally `SESSION_PRICE_CENTS`). Register the Stripe webhook at:

```
https://boothless.alphanauts.net/api/stripe/webhook   (event: checkout.session.completed)
```

Without keys, "New session" uses the dev simulate-purchase. Full steps: `docs/COMMERCIAL-SETUP.md`.

---

## Stage 4 — social sign-in, optional

Add the provider keys on the service's Environment. Register each redirect URI against the
**app domain** (not a session subdomain):

```
https://boothless.alphanauts.net/api/auth/oauth/google/callback
https://boothless.alphanauts.net/api/auth/oauth/facebook/callback
https://boothless.alphanauts.net/api/auth/oauth/apple/callback
```

Details (Google/Facebook/Apple, incl. Apple's .p8 key): `docs/COMMERCIAL-SETUP.md`.

---

## Scale note

One process per active session — fine for launch (a Starter instance handles a handful of
concurrent live sessions). The path to large scale is the shared-Postgres / object-storage
design in `docs/ARCHITECTURE-SAAS.md`; the accounts/dashboard/payments layer here carries over.
