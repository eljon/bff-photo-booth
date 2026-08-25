# BFF Photo Booth

A self-shoot photo booth for a party. Guests use **their own phone**: they take
photos in their camera app, pick four, arrange them into a strip or grid, and
the print comes out of the printer attached to **your MacBook**.

Nothing to install on the phone. No account, no app store, no sign-in — a guest
scans a QR code, picks four photos, and hits print. **The phone does not need to
be on the same network as the printer**; guests can be on cellular, on the
venue's guest Wi-Fi, or anywhere else.

Zero npm dependencies.

**See the guest app without running anything:**
**<https://eljon.github.io/bff-photo-booth/>** — a live preview, rebuilt from the
latest code on every push. Pick 4 photos and try the design picker from any
phone. Printing is off in the preview (that needs the booth Mac); everything else
is the real thing.

## How the print reaches the printer

A browser cannot talk to a printer queue, and a phone on cellular cannot reach a
laptop behind NAT. So the MacBook is always the thing that prints, and there are
two ways for a print to get to it. Both give the guest the same experience.

**Relay mode — guests anywhere, stable link.** A small relay runs on any public
host. It serves the guest app and parks finished prints. The MacBook runs the
booth agent, which makes **outbound calls only**: long-poll for a job, download
the composed page, hand it to CUPS with `lp`, report the queue id back. The Mac
needs no inbound ports, no port forwarding, and no shared network with anyone.
It works from behind a captive portal or a phone hotspot.

```
guest's phone            relay (any public host)          your MacBook
┌────────────┐  https   ┌──────────────────────┐  https  ┌───────────────────┐
│ pick 4     │ ───────► │ POST /api/print      │ ◄─────  │ npm run agent     │
│ tap Print  │          │   parks the job      │ poll    │  downloads it     │
│            │ ◄─────── │ GET  /api/job        │ ───────►│  lp → CUPS queue  │
└────────────┘  status  └──────────────────────┘ result  └──────────┬────────┘
                                                                    ▼
                                                                 printer
```

**Tunnel mode — guests anywhere, nothing to deploy.** The Mac runs the booth
itself and opens an outbound tunnel; guests hit the public https URL and the Mac
prints locally. One command, but the URL changes every launch.

```bash
brew install cloudflared      # once, no account needed
npm run tunnel                # prints a https://…trycloudflare.com link
```

No Homebrew? Grab the binary from Cloudflare's releases, or install nothing at
all and use the `ssh` already on your Mac with `npm start -- --tunnel=ssh`
(which relays through localhost.run — opt-in on purpose, since a third party
carries your guests' photos).

**That address changes every launch.** For one that survives restarts and sleep —
an ngrok static domain, a Tailscale funnel, a named Cloudflare tunnel — see
**[docs/PERSISTENT-LINK.md](docs/PERSISTENT-LINK.md)**. Whichever you use, the
booth restarts its own tunnel when it drops, so waking the Mac brings the booth
back on its own.

**LAN mode** (plain `npm start`) is still there for when everyone is on the same
Wi-Fi as the Mac.

| | LAN | Tunnel | Relay |
| --- | --- | --- | --- |
| Guests on another network | no | **yes** | **yes** |
| Anything to deploy | no | no | a relay, once |
| Link survives a restart | yes | no, it changes | **yes** |
| Works behind a captive portal | — | often not | **yes** |
| Mac needs inbound ports | no | no | no |

Whichever shape you run, the actual printing is the same call the Mac would make
for any document:

```
lp -d <printer> -n <copies> -o media=Custom.4x6in -o fit-to-page -o print-quality=5 <file>
```

`lp` returns a job id (`request id is Canon_SELPHY-42`), shown to the guest and
on the host screen. Any printer that works in **System Settings ▸ Printers &
Scanners** works here, because the Mac's own driver does the talking.

**Why not the obvious alternatives:** `window.print()` prints from the *phone*,
not your Mac. Letting phones AirPrint the printer directly needs everyone on the
printer's network — exactly what we are trying to avoid — and gives you no
queue, no approval, no copy limits. A cloud print service uploads every guest's
photos to a third party.

**Never used a terminal?** Read **[docs/START-HERE.md](docs/START-HERE.md)** —
the same setup, explained step by step with nothing assumed.

## Quick start

```bash
git clone https://github.com/eljon/bff-photo-booth.git
cd bff-photo-booth
npm run dev      # DRY_RUN — builds real strips into ./prints, never prints
```

Then pick your shape:

```bash
npm start                     # same Wi-Fi as the Mac
npm run tunnel                # guests anywhere, temporary link
npm run guest                 # guest app only, self-updating (see below)
BOOTH_TOKEN=… npm run relay   # on the public host  ─┐ guests anywhere,
RELAY_URL=… BOOTH_TOKEN=… npm run agent   # on the Mac ┘ permanent link
```

Open the **host screen** (`/host`) on the MacBook and leave it up: QR code for
guests, printer and paper pickers, live queue, approvals.

See **[docs/RUNBOOK.md](docs/RUNBOOK.md)** for the party-night procedure and
**[docs/DEPLOY.md](docs/DEPLOY.md)** for deploying the relay to Fly, Render or
your own Docker host.

### Running the relay

The relay is the same codebase with `MODE=relay`. It needs no printer, holds no
state you care about, and is happy on the smallest box anywhere.

```bash
# on the public host (Fly, Render, a VPS, a Raspberry Pi with a tunnel…)
BOOTH_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
MODE=relay BOOTH_TOKEN=$BOOTH_TOKEN PORT=8080 npm run relay

# on the MacBook with the printer
RELAY_URL=https://booth.example.com BOOTH_TOKEN=<same token> npm run agent
```

The agent prints what it can reach and nothing else: a printer name coming back
from the relay is checked against the Mac's own live printer list before it is
ever passed to `lp`.

### Guest-only booth

`npm run guest` runs **just the guest app**, and updates itself to the latest
code first — so you launch the newest guest experience without running `git
pull` yourself. It is meant for a machine that is **not** the printer: a spare
laptop, an always-on mini PC, whatever you want serving guests.

```bash
caffeinate -dims npm run guest -- --tunnel=tailscale
```

What it does, in order:

1. **Updates first (best-effort).** Fast-forwards to the latest commit; if that
   is not possible — offline, local changes, no upstream — it says so and starts
   what is on disk. A party is never blocked on a fetch. (`GUEST_NO_UPDATE=1`
   skips the update.)
2. **Serves the guest app only.** No host screen (`/host` is gone), no host
   controls, and it never opens a control window. Extra flags such as
   `--tunnel=tailscale` pass straight through.

By itself a guest-only booth has **no printer**, so guests save/share to their
phones — exactly the download-only experience. To let it **print through a real
booth**, point it at one with `--print-host`:

```bash
# the printing Mac, reachable at its own tunnel/relay URL:
caffeinate -dims npm start -- --tunnel=tailscale        # note its https URL

# the guest-only machine forwards prints to that booth:
caffeinate -dims npm run guest -- --tunnel=tailscale \
  --print-host=https://booth-mac.tailXXXX.ts.net
```

With `--print-host` set, the guest-only booth transparently forwards the print
(and the printer list, the job status, and the finished image) to that booth, so
guests print for real. No CORS, no extra deploy — the booth Mac keeps doing the
printing exactly as it does for its own guests. If it is unreachable, guests just
save to their phones and nothing errors out.

## Who is allowed to do what

Once the booth is reachable from outside your own Wi-Fi it locks itself down.
On a plain LAN booth none of this is enforced, so nothing gets in the way.

- **Guests** just print. The QR is a plain link and anyone holding it can use
  the booth. If that stops being what you want, turn on `guestKeyRequired` and
  the QR starts carrying a key that only phones which scanned it will have —
  rotate it from the host screen with *New guest link*.
- **You** get the host screen — config, approvals, cancels, the queue and the
  gallery. It is open by default: a tunnel link changes every launch and is
  unguessable, so a party booth does not need a second password. Set
  `BOOTH_TOKEN` to require one. Relay mode always does, since its address is
  permanent, and the agent signs in with the same token.
- **Prints** are served with a per-job token, so a guest can fetch their own
  strip and nobody else's. The host sees everything.

Also: bodies are capped at 32 MB and magic-byte checked, printer names must come
back from CUPS before being used, job ids are pattern-checked before `cancel`,
every external command runs through `execFile` with an argument array (never a
shell), and each phone is limited to 30 prints per 10 minutes.

## The guest experience

1. Scan the QR code. The page is mobile-first and installs to the home screen if
   they want it.
2. **Pick 4 photos** — the button sits on the preview itself. One tap opens the
   camera roll and takes all four in a single selection.
3. **Swipe to choose a design.** Once all four are in, the preview becomes a
   large coverflow: each photo can be the big hero (placed on top or on the side,
   whichever fits it), plus an even 2 × 2 with no hero. Flick or tap a side card
   — the centred design is what saves, prints, and shares. **Swap all 4 photos**
   re-picks the set.
4. **Print** → an upload bar, then live status until the printer takes it.
   **Save** opens the share sheet, where *Save Image* puts it in the Photos app.
5. **Facebook** hands the photo to the installed Facebook app (where the guest is
   already signed in) via the phone's share sheet — tapping Facebook there opens
   the app's post screen with the photo attached and `#bff2026` pre-filled, and
   the guest types their own words first. (A website can't jump straight into the
   app's composer; the share sheet is the only door to the app.) Desktop, with no
   app to share to, falls back to Facebook's web share for the booth link.

No filters, no caption box — just the design coverflow, Save and Print. Every
design fills the 4 × 6 (or 6 × 4) sheet edge to edge and crops nothing.

### Layouts

The guest app is locked to `grid`, whose dynamic engine builds the coverflow of
designs from the real photos (`designVariants` in `public/js/layouts.mjs`). The
renderer also still knows two fixed layouts, and the print pipeline handles any
of them — change `state.layoutId` in `public/js/app.mjs` to print a different one.

| Layout | Sheet | What comes out |
| --- | --- | --- |
| Auto grid *(in use)* | 4 × 6 or 6 × 4 | A coverflow of designs: any photo as the big hero (placed top/bottom/side) or an even layout with no hero. Every cell is shaped to its own photo so each fills its frame exactly — nothing is cropped, skewed, or floating in bars — and the placement and sheet that fill the most paper win. The photos touch (uniform gutter); the only whitespace is one thin, even, centred border |
| Classic strip | 4 × 6 portrait | Two identical 2 × 6 strips with a cut line |
| Wide filmstrip | 6 × 4 landscape | Four tall frames in a row |

Pages are composed on the phone at true print size (1200 × 1800 px = 4 × 6 in at
300 DPI). Crops are stored as scale-independent transforms, so switching layouts
re-fits everything without losing a guest's framing, and a photo can never be
panned far enough to leave blank paper in a frame. Anything over 3 MB is sent as
a high-quality JPEG instead of PNG so it still uploads fast on cellular.

## Setting up the booth

1. **Add the printer** on the Mac: System Settings ▸ Printers & Scanners, and
   print a test page from Preview. `npm run printers` lists what CUPS sees.
2. **Pick a shape** from the table above.
3. **LAN or tunnel mode:** the first run may raise a macOS firewall prompt —
   allow it. (Relay mode never needs this; the Mac only makes outbound calls.)
4. **Keep the Mac awake:** `caffeinate -dims npm start`.
5. Open `/host`, choose printer and paper, set the booth name, hit Save.

Every strip is saved to `./prints/`, so you have the whole night's output
afterwards — the host screen's *Recent strips* gallery links straight to them.

## Configuration

Host-screen settings live in `photobooth.config.json` (git ignored).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port to serve on |
| `HOST` | `0.0.0.0` | Bind address |
| `MODE` | `booth` | `relay` to run the public half instead |
| `BOOTH_TOKEN` | — | Host + agent password. Required in relay mode |
| `RELAY_URL` | — | Agent only: where the relay lives |
| `PUBLIC_URL` | — | Force the address shown in the QR (behind your own proxy) |
| `TUNNEL` | — | `1` is the same as `--tunnel`, `ssh` picks localhost.run |
| `NGROK_DOMAIN` | — | ngrok static domain: a guest link that never changes |
| `CF_TUNNEL` / `TUNNEL_HOSTNAME` | — | Named Cloudflare tunnel and its hostname |
| `DRY_RUN` | — | `1` saves prints but never calls `lp` |
| `PRINTS_DIR` | `./prints` | Where composed prints are written |
| `PHOTOBOOTH_CONFIG` | `./photobooth.config.json` | Settings file location |
| `AGENT_NAME` | hostname | Label shown on the host screen |
| `ACCESS_KEY` | generated | Pins the guest QR key across restarts |
| `BOOTH_NAME` | config | Booth name, pinned from the environment |

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Unauthenticated probe: mode, agent connectivity, uptime |
| `GET /api/session` | Booth name, copy limits, whether a key is needed |
| `GET /api/printers` | Printers — local, or the ones the agent reported |
| `GET /api/queue` | Live queue, job history, agent health *(host)* |
| `POST /api/print` | Body is the page; query: `layout`, `copies`, `guest`, `k` |
| `GET /api/job?id=` | Status of one job, for the guest's progress screen |
| `POST /api/approve` · `/api/reject` · `/api/cancel` | Host decisions *(host)* |
| `GET`/`POST /api/config` | Read/update settings, rotate the guest key *(host)* |
| `POST /api/agent/hello` | Agent announces itself and its printers *(relay)* |
| `GET /api/agent/jobs?wait=` | Long-poll for the next job *(relay)* |
| `POST /api/agent/result` | Agent reports the CUPS job id or the failure *(relay)* |

A job an agent claims but never reports is handed back to the queue after two
minutes, so a Mac that goes to sleep mid-print does not swallow a guest's strip.

## Tests

```bash
npm test
```

32 tests: the print endpoint end to end (real PNG bytes in, file on disk out),
the full relay round trip with the real agent process (guest → relay → agent →
`lp` → status back to the guest), approval holding a job away from the agent,
guest-key and host-token enforcement, per-job print privacy, copy clamping, rate
limiting, path traversal, command-injection guards, layout geometry, tunnel URL
parsing, and the QR encoder — verified module-for-module against the `qrcode`
reference implementation across versions 1–10 at EC levels L and M, then frozen
as golden hashes.

## Versions

The running version appears at the foot of the guest page, on the host screen,
and in the startup banner (with the git commit where one is available).
`CHANGELOG.md` lists what changed in each. `bash scripts/tag-releases.sh --push`
turns those into git tags, so you can check out an older one if a change ever
goes the wrong way.

```bash
npm run version:show   # what is installed
git pull               # get the newest, then restart the booth
```

## Requirements

Node 18+ and macOS for the printing half (any CUPS machine works — Linux too).
The relay half runs anywhere Node runs.
