# Deploying the relay

The relay is the public half of the booth: it serves the guest app and parks
prints until your MacBook's agent collects them. It never touches a printer, so
it can run on the smallest instance anywhere. The printer stays on your Mac.

You need two secrets. Generate them once and keep them:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"      # BOOTH_TOKEN
node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))" # ACCESS_KEY
```

- **`BOOTH_TOKEN`** unlocks the host screen and signs the agent in. Required.
- **`ACCESS_KEY`** is the guest key carried in the QR link. Optional, but pin it:
  without it the relay mints a new key on first boot, and a redeploy would
  invalidate every QR code you have already printed.

## Fly.io

```bash
fly launch --no-deploy --copy-config
fly secrets set BOOTH_TOKEN=… ACCESS_KEY=…
fly volumes create booth_data --size 1
fly deploy
```

`fly.toml` already sets `MODE=relay`, mounts `/data`, and health-checks
`/api/health`. It also disables `auto_stop_machines`: a sleeping relay would cut
the agent's long-poll and delay prints.

## Render

Push the repo, then **New ▸ Blueprint** and pick it. `render.yaml` builds the
Dockerfile, mounts a disk at `/data`, health-checks `/api/health`, and generates
`BOOTH_TOKEN` and `ACCESS_KEY` for you — copy them out of the dashboard, since
the agent needs the token. Avoid free instances that sleep.

## Docker anywhere (VPS, Raspberry Pi, homelab)

```bash
BOOTH_TOKEN=… ACCESS_KEY=… docker compose up -d
```

Put it behind a TLS terminator (Caddy, nginx, Cloudflare) and set `PUBLIC_URL`
to the address guests actually see, so the QR code points at the right place.
Plain `docker run` works too:

```bash
docker build -t booth-relay .
docker run -d -p 8080:8080 -v booth-data:/data \
  -e BOOTH_TOKEN=… -e ACCESS_KEY=… -e PUBLIC_URL=https://booth.example.com \
  booth-relay
```

## Then, on the MacBook

```bash
RELAY_URL=https://your-booth.example.com BOOTH_TOKEN=… npm run agent
```

Confirm the host screen shows **booth mac: connected** before the first guest
arrives.

## Notes

- **HTTPS is not optional in practice.** iOS will not treat a plain-http site as
  a trustworthy web app, and you are shipping photos over it. Every platform
  above terminates TLS for you.
- **The volume is only for continuity** — the gallery of the night's strips and
  host settings. Lose it and the booth still works; it just starts fresh.
- **Health check:** `GET /api/health` returns `{ ok, mode, agentOnline, … }`
  unauthenticated. `agentOnline` is the one worth alerting on — it means the Mac
  is connected and prints will actually come out.
