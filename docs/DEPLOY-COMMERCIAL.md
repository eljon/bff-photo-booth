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

Do **not** use Blueprint (the repo's `render.yaml` is the *booth* config). Create it by hand:

1. Render → **New ▸ Web Service** → repo `eljon/bff-photo-booth`, **branch
   `claude/photo-booth-commercial`**.
2. **Runtime** Node · **Build Command** blank · **Start Command** `npm run saas` · **Plan** Starter.
3. **Advanced ▸ Add Disk:** name `saas-data`, mount `/data`, 1 GB.
4. **Environment:** `SAAS_DATA=/data`.
5. Create. You'll get `https://hawak-mo-ang-booth.onrender.com` — the landing page works now
   (email login + dev purchase). Everything except *opening* a session's host works already.

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
