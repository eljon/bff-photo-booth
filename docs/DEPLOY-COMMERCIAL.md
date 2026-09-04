# Deploying Hawak Mo ang Booth (temporary name)

The commercial app (`npm run saas`) is the landing page + accounts + dashboard + payments,
and it runs each purchased session's booth as its own process, reachable at a per-session
subdomain. Deploy it as its **own** service, separate from the single-tenant booth relay.

**This guide uses the real target:** app at **`boothless.alphanauts.net`**, session booths at
**`<slug>.boothless.alphanauts.net`**, domain `alphanauts.net` managed at **HostGator**.

## What it needs

- **One web service** running `npm run saas` (dependency-free Node — no build step).
- **A persistent disk** at `/data` (`SAAS_DATA=/data`) for accounts + each session's booth data.
- **DNS** at HostGator: `boothless.alphanauts.net` → the service, and a wildcard
  `*.boothless.alphanauts.net` → the service (so each session's booth is reachable).
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

## Stage 2 — point boothless.alphanauts.net at it (HostGator DNS)

1. In Render → your service → **Settings ▸ Custom Domains** → **Add** `boothless.alphanauts.net`,
   then **Add** `*.boothless.alphanauts.net`. Render shows the target host (an `onrender.com`
   hostname) and any verification record it needs.
2. In **HostGator** (cPanel → **Zone Editor** for `alphanauts.net`), add **CNAME** records:
   - Name `boothless` → value `hawak-mo-ang-booth.onrender.com`
   - Name `*.boothless` → value `hawak-mo-ang-booth.onrender.com`  *(wildcard — this is what
     makes every session's subdomain resolve)*
   - Plus any **verification CNAME/TXT** Render told you to add (paste it exactly).
3. Back in Render, wait for the domains to verify (green) and TLS to issue. Wildcard TLS can
   take a few minutes.
4. Render → **Environment** → add `SAAS_BASE_DOMAIN=boothless.alphanauts.net` → save (redeploys).

**Now:** the app is at `https://boothless.alphanauts.net`, and **Open host** on a session opens
`https://<slug>.boothless.alphanauts.net/host` — that session's real booth with its own QR that
guests can scan from anywhere.

> **If HostGator won't issue/verify wildcard TLS smoothly** (some shared plans are fussy about
> wildcard records or ACME): put **Cloudflare** in front — add `alphanauts.net` to a free
> Cloudflare account, switch the domain's nameservers to Cloudflare, add the two CNAMEs above
> as **Proxied**, and Cloudflare provides the wildcard TLS. Point Render's custom domain at the
> same host. This is the most reliable wildcard path.

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
