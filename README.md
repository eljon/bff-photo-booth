# BFF Photo Booth

A self-shoot photo booth for a party. Guests use **their own phone**: they take
photos in their camera app, pick four, arrange them into a strip or grid, and
the print comes out of the printer attached to **your MacBook**.

No app to install, no internet needed, no dependencies to `npm install`.

```
guest's phone                      the MacBook running this
┌──────────────┐   Wi-Fi (LAN)    ┌────────────────────────────────────┐
│ pick 4 photos│ ───────────────► │ node server/index.js               │
│ crop / style │  POST /api/print │   saves ./prints/<timestamp>.png   │
│ tap Print    │   (a 300 DPI     │   lp -d <printer> -n <copies> …    │
└──────────────┘    PNG)          │            │                       │
                                  │            ▼                       │
                                  │      CUPS print queue ──► printer  │
                                  └────────────────────────────────────┘
```

## Quick start

```bash
git clone <this repo> && cd bff-photo-booth
npm start                 # or: PORT=3000 npm start
```

The terminal prints the address guests should use:

```
  BFF Photo Booth
  ---------------
  Guests scan or type:  http://192.168.1.42:8080
  Host screen:          http://192.168.1.42:8080/host
```

Open the **host screen** on the MacBook and leave it up: it shows a QR code for
guests to scan, lets you pick the printer and paper, and shows the live queue.

Try it without a printer first:

```bash
npm run dev      # DRY_RUN=1 — strips are saved to ./prints, nothing is printed
```

## Getting the print into the Mac's printer queue

This is the part with real choices in it, so here is the reasoning.

**What this does.** The phone composes the finished page on a `<canvas>` at the
real print size (1200 × 1800 px = 4 × 6 in at 300 DPI) and POSTs those bytes to
the Mac. The Mac writes the file to `./prints/` and hands it to CUPS — the print
system already built into macOS — with the `lp` command:

```
lp -d <printer> -n <copies> -o media=Custom.4x6in -o fit-to-page -o print-quality=5 <file>
```

`lp` returns a job id (`request id is Canon_SELPHY-42`), which is shown to the
guest and on the host screen. `lpstat -o` reads the live queue back; `cancel`
kills a job. Any printer that works in **System Settings ▸ Printers & Scanners**
works here — AirPrint, USB, dye-sub, whatever — because the Mac's own driver
does the talking.

**Why not the alternatives:**

| Approach | Why not |
| --- | --- |
| `window.print()` in the guest's browser | Prints from the *phone*, not your Mac. iOS then needs its own AirPrint connection to your printer, guests get the system print dialog, and page scaling is out of your hands. |
| Let phones AirPrint the printer directly | Only works for AirPrint-capable network printers, exposes the printer to every guest, gives you no queue control, no approval, no copy limits — and no record of what was printed. |
| A cloud print service | Needs internet at the venue, uploads everyone's photos to a third party, and adds latency to something that should feel instant. |
| Native Mac app / Automator watch folder | A watch folder is actually a fine trick, but you still need something to accept uploads from phones, and you lose the job id, the queue view, and per-print options. |

**Practical details that matter on the night:**

- **Paper size.** Pick it once on the host screen. `Custom.4x6in` suits photo
  printers; strip stock is `Custom.2x6in`; plain paper is `Letter`/`A4`.
  The layout tells you which sheet it expects (all three layouts are 4 × 6).
- **Scale to fill the sheet** maps to `-o fit-to-page`. Turn it off if your
  printer already handles borderless sizing and you see a thin white margin.
- **Ask me before each print** holds every job on the host screen until you tap
  Print. Worth switching on once the queue gets busy — or once the wine does.
- **Max copies per guest** caps the copy stepper; the server clamps it too, so
  a clever guest cannot ask for 99 by editing the URL.
- **Printing is on** — switch it off and the app becomes download-only: guests
  still build strips and save them to their phones.

## The guest experience

1. Scan the QR code (or type the address). The page is mobile-first and works
   as a home-screen web app.
2. **Add photos from your phone** — the picker takes up to four at once, or tap
   an empty slot to fill it. Photos come from the camera roll, so guests shoot
   with their own camera app and get the shots they actually like.
3. Tap any photo to **crop** (drag to move, pinch or slide to zoom), **rotate**,
   **replace**, **remove**, or reorder it.
4. Choose a layout, a look, a paper colour, and a caption. The preview is the
   real print, just smaller.
5. **Print my strip** → it goes to the tray. **Save** keeps a copy on the phone.

### Layouts

| Layout | Sheet | What comes out |
| --- | --- | --- |
| Classic strip | 4 × 6 portrait | Two identical 2 × 6 strips with a cut line — keep one, give one away |
| Four-up grid | 4 × 6 portrait | Four big frames in a 2 × 2 |
| Wide filmstrip | 6 × 4 landscape | Four tall frames in a row |

Crops are stored per photo as a scale-independent transform, so switching
layouts re-fits everything without a guest losing their framing, and a photo can
never be panned far enough to leave blank paper in the frame.

## Setting up the booth

1. **Add the printer** on the Mac: System Settings ▸ Printers & Scanners. Print
   a test page from Preview first — if that works, this will.
2. **Same network.** Guests must be on the same Wi-Fi as the Mac. No router?
   Turn on the Mac's Internet Sharing, or use a phone hotspot that both the Mac
   and the guests join. The booth needs no internet at all.
3. **Let node accept connections.** The first run may raise a macOS firewall
   prompt — allow it, or the phones will not reach the server.
4. **Keep the Mac awake:** `caffeinate -dims npm start` is the easy way.
5. Open `/host`, choose printer and paper, set the booth name, hit Save.

Every strip is also saved to `./prints/`, so you have the whole night's output
afterwards — the host screen's *Recent strips* gallery links straight to them.

## Configuration

Settings from the host screen are stored in `photobooth.config.json` (git
ignored). Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port to serve on |
| `HOST` | `0.0.0.0` | Bind address — leave it, guests need LAN access |
| `DRY_RUN` | unset | `1` saves prints but never calls `lp` |
| `PRINTS_DIR` | `./prints` | Where composed prints are written |
| `PHOTOBOOTH_CONFIG` | `./photobooth.config.json` | Settings file location |

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/session` | Booth name, message, copy limits, mode |
| `GET /api/printers` | CUPS destinations and their state |
| `GET /api/queue` | Live CUPS jobs plus this booth's job history |
| `POST /api/print` | Body is the PNG/JPEG page; query: `layout`, `copies`, `guest` |
| `POST /api/approve` · `/api/reject` | Host decisions in approval mode |
| `POST /api/cancel` | Cancel a CUPS job by id |
| `GET`/`POST /api/config` | Read/update host settings |

Guest-facing safety: bodies are capped at 32 MB and must actually be a PNG or
JPEG; printer names are only ever passed to `lp` after CUPS itself has listed
them; job ids are pattern-checked before `cancel`; every external command runs
through `execFile` with an argument array, never a shell; and each phone is
limited to 30 prints per 10 minutes.

## Tests

```bash
npm test
```

Covers the print endpoint end to end (real PNG bytes in, file on disk out),
approval mode, copy clamping, rate limiting, path traversal, command-injection
guards, layout geometry (nothing overlaps or runs off the paper), and the QR
encoder — whose output was verified module-for-module against the `qrcode`
reference implementation across versions 1–10 at EC levels L and M, then frozen
as golden hashes.

## Requirements

Node 18+ and macOS (or any machine with CUPS — Linux works too). No npm
dependencies, at runtime or otherwise.
