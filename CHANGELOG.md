# Changelog

The running version is shown at the bottom of the guest page, in the top-right
of the host screen, and in the terminal banner when the booth starts.

**To update to the newest version**, on the MacBook:

```bash
cd ~/Downloads/bff-photo-booth
git pull            # stop the booth with Control-C first
```

Then start the booth again. Your settings, the guest key and everything in
`prints/` survive an update — they are not part of the repository.

---

## 1.10.0 — 2026-08-24

**No guest key. The link is just the link.**

- Guests print with nothing in the way: the QR carries a plain URL, no `?k=`
  tacked on, and anyone with the address can print. Existing booths pick this up
  automatically — a config still saying `auto` now counts as off.
- The restriction is still there if a night goes sideways: switch
  `guestKeyRequired` on and only phones that came in through the QR can print.
- Per-print privacy is unchanged: a print is still served under its own token,
  so a guest sees their own photo and nobody else's.

## 1.9.3 — 2026-08-24

- Finds the Tailscale CLI where a Mac actually puts it. Installing Tailscale
  from the website or the App Store leaves the binary inside
  `/Applications/Tailscale.app`, with nothing on `PATH`, so `--tunnel=tailscale`
  would have reported it missing on a Mac where it was plainly installed.
  Homebrew paths are checked for the other tunnels too.

## 1.9.2 — 2026-08-24

**Fixed: `--tunnel=tailscale` never actually selected Tailscale.**

- Only `ssh` was passed through to the tunnel picker; every other value was
  silently downgraded to "auto", so a documented option did nothing. All the
  kinds now work: `ssh`, `tailscale`, `ngrok`, `named`, `cloudflared`.
- A Tailscale funnel address is read out of the command's output rather than
  known up front, so the booth had been calling it temporary. It is tied to the
  machine and tailnet and does not change, and is now reported as persistent.
- Worth knowing when choosing: ngrok's free tier shows every new visitor a
  browser interstitial before your page. The documented ways around it are
  request headers, which a guest scanning a QR code cannot send. Tailscale
  Funnel and Cloudflare tunnels serve your page directly.

## 1.9.1 — 2026-08-24

- ngrok renamed its static-address flag (`--domain` on older agents, `--url` on
  current ones). The booth now asks the installed binary which it takes instead
  of guessing, so either version works.
- A tunnel that dies within seconds of starting now prints what it actually
  said — "requires a verified account and authtoken", say — instead of
  disappearing into the reconnect loop with no explanation.

## 1.9.0 — 2026-08-24

**A guest link that survives restarts and sleep.**

- The booth can now run on a **fixed address**: an ngrok static domain
  (`NGROK_DOMAIN=…`), a named Cloudflare tunnel (`CF_TUNNEL` +
  `TUNNEL_HOSTNAME`), or a Tailscale funnel (`--tunnel=tailscale`). The address
  is known before the tunnel even starts, so it is the same every night and a QR
  code printed last week still works.
- **The tunnel restarts itself when it drops.** macOS cuts network connections
  on sleep; on wake the booth brings the tunnel back on its own, with a backoff
  that resets after any healthy run so waking is quick. With a fixed address the
  link is unchanged; with the default quick tunnel the terminal says plainly
  that guests need the new one.
- A named Cloudflare tunnel without `TUNNEL_HOSTNAME` is refused rather than
  started — the booth will not print a QR code for an address it had to guess.
- `docs/PERSISTENT-LINK.md` lays out the options and is honest about the one
  thing only relay mode does: keep serving guests while the Mac is asleep.

## 1.8.1 — 2026-08-24

**Fixed: 1.7.1 made startup slow and stopped opening the browser at all.**

- The readiness check now blocks nothing. The banner appears and the host screen
  opens as soon as the tunnel reports its address — a second or two, as before.
- The host screen opens on `http://localhost:PORT/host` instead of through the
  tunnel. It is the screen for whoever is sitting at the Mac, and localhost never
  waits on DNS. The QR code on it still carries the public guest link.
- The guest link is still checked, but in the background and only to print a
  line about it. A Mac that cannot resolve its own fresh tunnel hostname — the
  resolver caches the failure for a while, even though phones resolve it fine —
  no longer holds up the booth or suppresses the browser.

## 1.8.0 — 2026-08-24

**Save goes to the Photos app, and the button sits on the print.**

- **Save** now hands the print to the phone's share sheet, where *Save Image*
  puts it straight in Photos. It used to download a file into Files, which is
  not where anyone looks for a photo. Desktop browsers, and anything without the
  share sheet, still get a download.
- The print is rendered in the background as soon as all four photos are in, so
  the share sheet opens on the tap that asked for it — iOS refuses a share that
  arrives after its gesture has expired.
- The one photo button now sits **on** the preview, over a translucent scrim,
  instead of below it. Once the print is full the scrim clears and the button
  shrinks to a quiet *Swap all 4* pill so it stops covering the photos.

## 1.7.1 — 2026-08-24

**Fixed: the browser opened before the tunnel link existed.**

- A quick tunnel prints its hostname the moment it is assigned, which is before
  DNS knows about it — so the browser opened on a link that answered
  `DNS_PROBE_FINISHED_NXDOMAIN`, and cached the failure. The booth now polls its
  own public link until it really answers, then opens the browser.
- If the link never comes up, the booth says so plainly instead of opening a
  broken page, and no longer tells you to run `npm run tunnel` when that is
  exactly what you just ran.
- `TUNNEL_WAIT_MS` sets how long to wait (default 60 seconds).

## 1.7.0 — 2026-08-24

**No host password, and the control screen opens itself.**

- The host screen is open by default. Setting `BOOTH_TOKEN` puts a password
  back; relay mode still requires one, because a permanent public address is a
  different proposition from a tunnel link that changes every launch.
- `npm run tunnel` now opens the host screen in your default browser once the
  link is up. `--open` does the same for a plain Wi-Fi start, `--no-open`
  suppresses it, and a relay never opens anything.

## 1.6.0 — 2026-08-24

**The guest screen is one button.**

- On load there is no empty photo grid to puzzle over — just **Pick your 4
  photos**, the live preview above it, and Save / Print at the bottom. The four
  slots appear only once there are photos in them.
- One add button. The per-slot "+" buttons are gone; empty slots are numbered
  placeholders, and tapping a filled photo still opens crop / rotate / reorder /
  swap.
- Layout, look, paper colour, caption and the copies stepper are all gone. Every
  print is the four-up grid on 4×6.
- The printer only speaks up when something would stop a print — offline booth,
  no printer, missing QR key — instead of showing a status pill nobody needed.

## 1.5.0 — 2026-08-24

Every release now has a number you can point at.

- The version is shown in three places: quietly at the foot of the guest page,
  as a pill on the host screen, and in the terminal banner at startup — with the
  git commit alongside it where one is available, so a bug report from a party
  is answerable.
- `npm run version:show` prints what is installed. (`npm run update` is a
  wrapper around `git pull`, but `git pull` is the one to document — a script
  cannot update a copy that does not have the script yet.)
- `/api/health` and `/api/session` report the version, so a monitoring check can
  see what is running without opening the host screen.
- This changelog. `bash scripts/tag-releases.sh --push` turns every release
  below into a git tag, so an older version can be checked out if a change ever
  goes the wrong way.

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
