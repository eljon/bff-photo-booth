# Changelog

The running version is shown at the bottom of the guest page, in the top-right
of the host screen, and in the terminal banner when the booth starts.

**To update to the newest version**, on the MacBook:

```bash
cd ~/Downloads/bff-photo-booth
npm run update      # stop the booth with Control-C first
```

Then start the booth again. Your settings, the guest key and everything in
`prints/` survive an update — they are not part of the repository.

---

## 1.5.0 — 2026-08-24

Every release now has a number you can point at.

- The version is shown in three places: quietly at the foot of the guest page,
  as a pill on the host screen, and in the terminal banner at startup — with the
  git commit alongside it where one is available, so a bug report from a party
  is answerable.
- `npm run update` pulls the newest version; `npm run version:show` prints what
  is installed.
- `/api/health` and `/api/session` report the version, so a monitoring check can
  see what is running without opening the host screen.
- This changelog, and git tags for every release below.

## 1.4.0 — 2026-08-24

**Pick all four photos in one tap.**

- The picker is now the main action on the page, above the slots and full width.
  It was previously below four "+" boxes, so guests tapped them one at a time —
  four separate trips through the camera roll.
- The button says what is left to do: *Pick your 4 photos* → *Add 2 more photos*
  → *Swap all 4 photos*.
- *Swap all 4 photos* clears the set first, so a second pick of four lands in
  order instead of overwriting slots one by one.
- Picking more than four keeps the first four and says so, instead of that
  notice being immediately overwritten by another message.
- The crop hint only appears once there is a photo to tap.

## 1.3.2 — 2026-08-24

**Fixed: the booth called a Wi-Fi-only address the guest link.**

- The startup banner printed `Guests scan or type: http://192.168.x.x:8080` in
  every mode — a promise it could not keep, since a phone on mobile data can
  never reach that address. Addresses are now labelled by how far they reach:
  *On this Wi-Fi only* versus *Guests scan or type … works on any network*.
- A Wi-Fi-only booth now says how to let guests join from anywhere.

## 1.3.1 — 2026-08-24

- `docs/START-HERE.md`: the whole setup written for someone who has never opened
  a terminal, with the exact output to expect at every step.
- Fixed the host sign-in box, which still asked for "the `BOOTH_TOKEN` you
  started it with" — wrong since 1.2.1, where a tunnelled booth generates its
  own password.

## 1.3.0 — 2026-08-24

**Tunnels on a Mac without Homebrew.**

- When no tunnel is installed, the error prints the direct `cloudflared`
  download instead of assuming `brew` exists.
- `--tunnel=ssh` uses the `ssh` already on macOS to reach localhost.run, so a
  public booth needs nothing installed at all. Opt-in on purpose: it relays
  guests' photos through a third party.
- Fixed flag parsing that read `--tunnel=<anything>` as `ssh`.

## 1.2.1 — 2026-08-24

**Fixed: `npm run tunnel` could lock you out of your own booth.**

- Going public switched on host authentication with no password to
  authenticate against, so the host screen could never be unlocked. A public
  booth without `BOOTH_TOKEN` now generates a host password and prints it at
  startup.

## 1.2.0 — 2026-08-24

**Deploying the relay.**

- `Dockerfile`, `fly.toml`, a Render blueprint and a compose file for the relay
  half.
- `ACCESS_KEY` pins the guest key from the environment — without it a redeploy
  mints a new key and every QR code already printed stops working.
- `GET /api/health` reports mode, uptime and whether the booth Mac is connected.
- `docs/RUNBOOK.md` for the night-of procedure, `docs/DEPLOY.md` for deploying.

## 1.1.0 — 2026-08-24

**Guests can be on any network.**

- Relay mode: the guest-facing half runs on a public host, and the MacBook runs
  an agent that only makes outbound calls — long-poll for a job, download it,
  print it, report back. No inbound ports, works behind a captive portal, and
  the guest link survives restarts.
- Tunnel mode: `npm run tunnel` opens an outbound cloudflared/ngrok tunnel for a
  zero-deploy public URL.
- Once public, the booth locks down: guests carry an access key in the QR link,
  host controls need `BOOTH_TOKEN`, and each print is served under a per-job
  token so a guest sees their own strip and no one else's.
- Guests see upload progress and live job status; pages over 3 MB upload as
  high-quality JPEG.

## 1.0.0 — 2026-08-24

**The booth.**

- Mobile-first guest app: pick four photos, crop, rotate, reorder, style, print.
- Three layouts, all 4×6 — classic double strip with a cut line, four-up grid,
  wide filmstrip — composed at a true 300 DPI on the phone.
- Prints through the Mac's own CUPS queue with `lp`, returning a real job id.
- Host screen with a locally generated QR code, printer and paper pickers,
  optional per-print approval, copy limits, live queue and a gallery.
- Download-only and dry-run modes for a booth with no printer attached.
