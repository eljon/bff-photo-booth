# Deploying the commercial app

The commercial app (`npm run saas`) is landing + accounts + dashboard + payments, and it
runs each purchased session's booth as its own process, reachable at a per-session
subdomain. Deploy it as its **own** service, separate from the single-tenant booth relay.

## What it needs

- **One web service** running `npm run saas` (dependency-free Node — no build step).
- **A persistent disk** at `/data` (set `SAAS_DATA=/data`) for accounts and each session's
  booth data.
- **A wildcard domain** pointed at the service, e.g. `*.booth.example.com`, with wildcard
  TLS. Set `SAAS_BASE_DOMAIN=booth.example.com`. Session booths are served at
  `<slug>.booth.example.com` and proxied by the app to that session's process.
- Optional: Stripe + OAuth keys (see `docs/COMMERCIAL-SETUP.md`). Without them, the app
  still runs with email login and a dev "simulate purchase."

## Render (blueprint)

1. On the `claude/photo-booth-commercial` branch, rename `render-saas.yaml` → `render.yaml`
   (or create a Web Service by hand with start command `npm run saas`, a 1 GB disk at
   `/data`, and `SAAS_DATA=/data`).
2. **New ▸ Blueprint** → pick the repo/branch → Apply. You get a URL like
   `https://bff-booth-accounts.onrender.com` — that's the landing page.
3. Add env vars (Environment tab): `SAAS_BASE_DOMAIN`, and any Stripe/OAuth keys.

## The wildcard domain (the one infra step)

Session booths live at subdomains, so the app needs `*.<domain>` to resolve to it with TLS:

- **Custom domain**: add both `booth.example.com` and `*.booth.example.com` as custom
  domains on the service (wildcard custom domains need a plan that supports them), and point
  the DNS `CNAME *` at the Render host.
- **Or put Cloudflare in front**: proxy `*.booth.example.com` to the Render service — this
  also gives you wildcard TLS for free.

Set `SAAS_BASE_DOMAIN` to the base (e.g. `booth.example.com`). Then the dashboard's
**Open host** links to `https://<slug>.booth.example.com/host…`, and guest QR codes point at
the same subdomain automatically (the app forwards host + scheme to the booth).

Without a wildcard domain (e.g. a first quick deploy), leave `SAAS_BASE_DOMAIN` unset — but
note that per-session booths then bind to loopback ports that remote browsers can't reach,
so that mode is only useful locally.

## Scale note

This runs one process per active session — fine for early scale. The path to large scale
is the shared-Postgres, object-storage design in `docs/ARCHITECTURE-SAAS.md`, where sessions
no longer each need a process. The account/dashboard/payments layer built here carries over
unchanged.

## Redirect URIs and webhook

When you set OAuth/Stripe keys, register these against the **commercial app's** public URL
(not a booth subdomain):

- Google/Facebook/Apple redirect: `https://<app-host>/api/auth/oauth/<provider>/callback`
- Stripe webhook: `https://<app-host>/api/stripe/webhook` (event `checkout.session.completed`)
