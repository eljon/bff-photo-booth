# Deploying the relay

The relay is the public, always-on half of the booth: it serves the guest app and
holds the print queue on disk until a printer collects it. It never touches a printer
itself. **Nothing is installed on the machine that prints** — that computer just opens
`<your-url>/print` in a browser (see the bottom of this doc). The one-time job below is
standing up the relay in the cloud.

## The easy way: deploy from the browser (no CLI, nothing installed locally)

The relay only has to be *created* once. You can do the whole thing in a web browser by
pointing a host at this GitHub repo — no terminal, no `npm`, no CLI:

1. Push this repo to your own GitHub (already done if you're reading it there).
2. On **[Render](https://render.com)**: sign in with GitHub → **New ▸ Blueprint** →
   pick this repo → **Apply**. `render.yaml` tells Render everything: build the
   Dockerfile, mount a 1 GB disk at `/data` for the durable queue, health-check
   `/api/health`, and generate `BOOTH_TOKEN` + `ACCESS_KEY`.
3. When it's live you get a URL like `https://bff-photo-booth.onrender.com`. Open the
   service's **Environment** tab and copy the generated **`BOOTH_TOKEN`** — that's the
   printer/host password.

That's the entire setup. Guests use the URL; the printer computer opens `<url>/print`
and pastes the token once. (Railway works the same way — New Project → Deploy from repo
→ it reads the Dockerfile → add a volume at `/data` and the two env vars.)

A note on cost: the durable queue and an always-awake connection need a small **paid**
instance (Render's Starter, ~US$7/mo). Free tiers sleep and have no disk, which drops
the printer's connection and loses queued prints.

## If you prefer a CLI

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

## Then, on the printing computer

Pick **one** of these — both just pull jobs from the relay and print them. Guests
submit to the relay either way, so a print is safe on the server even if this
computer is asleep or offline; it drains the queue when it comes back.

**A. Just open a URL (no install, no tunnel).** On the computer with the printer,
open **`https://your-booth.example.com/print`** in Chrome, paste the `BOOTH_TOKEN`
once, and leave the tab open. For hands-free printing, launch Chrome with
`--kiosk-printing` and set the photo printer as the default — prints then come out
with no dialog. This is the simplest setup.

**B. Run the agent (prints through CUPS/`lp`).** If you want driver-level control
of media, borderless, and copies:

```bash
RELAY_URL=https://your-booth.example.com BOOTH_TOKEN=… npm run agent
```

Either way, confirm the host screen shows **booth mac: connected** (or the `/print`
tab shows **Ready**) before the first guest arrives.

## Notes

- **HTTPS is not optional in practice.** iOS will not treat a plain-http site as
  a trustworthy web app, and you are shipping photos over it. Every platform
  above terminates TLS for you.
- **The volume holds the queue** — the relay persists every job to `queue.json`
  beside the strip images, so a redeploy or crash doesn't drop prints that haven't
  come out yet. Mount `/data` on a real disk (already set in `fly.toml`) and point
  `PRINTS_DIR` at it. Lose the volume and only un-printed jobs and the gallery are
  lost; the booth still works.
- **Health check:** `GET /api/health` returns `{ ok, mode, agentOnline, … }`
  unauthenticated. `agentOnline` is the one worth alerting on — it means the Mac
  is connected and prints will actually come out.
