# BFF Photo Booth

A self-shoot photo booth for a party. Guests use **their own phone**: they take
photos in their camera app, pick four, arrange them into a strip or grid, and
the print comes out of the printer attached to **your MacBook**.

Nothing to install on the phone. No account, no app store, no sign-in — a guest
scans a QR code, picks four photos, and hits print. **The phone does not need to
be on the same network as the printer**; guests can be on cellular, on the
venue's guest Wi-Fi, or anywhere else.

Zero npm dependencies.

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

## Who is allowed to do what

Once the booth is reachable from outside your own Wi-Fi it locks itself down.
On a plain LAN booth none of this is enforced, so nothing gets in the way.

- **Guests** print with an access key that rides along in the QR link
  (`/?k=…`). The app stores it and wipes it from the address bar, so a guest
  still types nothing. Rotate it from the host screen (*New guest link*) if a
  screenshot escapes into the wild.
- **You** unlock the host screen with a password — config, approvals, cancels,
  the queue and the gallery all require it. Set `BOOTH_TOKEN` to choose it; a
  tunnelled booth without one generates a password and prints it at startup, so
  going public can never lock you out of your own booth. The booth agent signs
  in with the same token (relay mode requires you to set it explicitly).
- **Prints** are served with a per-job token, so a guest can fetch their own
  strip and nobody else's. The host sees everything.

Also: bodies are capped at 32 MB and magic-byte checked, printer names must come
back from CUPS before being used, job ids are pattern-checked before `cancel`,
every external command runs through `execFile` with an argument array (never a
shell), and each phone is limited to 30 prints per 10 minutes.

## The guest experience

1. Scan the QR code. The page is mobile-first and installs to the home screen if
   they want it.
2. **Add photos from your phone** — up to four at once, or tap an empty slot.
3. Tap any photo to **crop** (drag to move, pinch or slide to zoom), **rotate**,
   **replace**, **remove** or reorder.
4. Pick a layout, a look, a paper colour, a caption. The preview is the real
   print, just smaller.
5. **Print my strip** → an upload bar, then live status until the printer takes
   it. **Save** keeps a copy on the phone.

### Layouts

| Layout | Sheet | What comes out |
| --- | --- | --- |
| Classic strip | 4 × 6 portrait | Two identical 2 × 6 strips with a cut line — keep one, give one away |
| Four-up grid | 4 × 6 portrait | Four big frames in a 2 × 2 |
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
| `TUNNEL` | — | `1` is the same as `--tunnel` |
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

## Requirements

Node 18+ and macOS for the printing half (any CUPS machine works — Linux too).
The relay half runs anywhere Node runs.
