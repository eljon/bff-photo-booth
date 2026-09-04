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

## 1.74.1 — 2026-09-04

**Per-session booths — each session is its own isolated booth.** From the dashboard,
**Open host** now spins up that session's *own* booth: a separate relay process with its
own data directory, config, print queue, photos, printers, pairing code, and guest QR —
one session's prints/printers/settings never touch another's. The host screen is titled
with the session name and **auto-unlocks** (the dashboard passes the session token, which
is then scrubbed from the URL).

- `server/commercial/booths.js` — a `BoothManager` that spawns/reuses a booth per session
  on a loopback port (isolated `PRINTS_DIR`/config/token), waits for health, and stops
  idle booths. Reuses the whole single-tenant booth — guest app, host, agent, gallery,
  vouchers, reprint — with no duplication.
- `POST /api/sessions/:id/open` (owner-only) returns the session's host + guest URLs.
- Verified: two sessions → two booths on different ports with separate queues; a print in
  one is invisible to the other.

Local use reaches each booth directly at `127.0.0.1:<port>`; the cloud version fronts them
with per-session subdomains (same mechanism, different addressing). Next: OAuth redirects
and live Stripe.

## 1.74.0 — 2026-09-04

**Commercial track begins (branch `claude/photo-booth-commercial`).** A new, self-contained
multi-tenant web app — landing → sign up/in → dashboard → buy a session → open its host —
that does **not** touch the single-tenant booth (that stays on its own branch). Run it with
`npm run saas` (default port 8090).

- **Accounts** (`server/commercial/`): email + password today (scrypt-hashed, HMAC-signed
  session cookies); **Google / Apple / Facebook** buttons are shown and light up when their
  OAuth keys are set (the redirect flow lands next increment).
- **Dashboard**: lists the signed-in user's sessions (isolated per account) and buys new ones.
- **Payments**: **Stripe Checkout** when `STRIPE_SECRET_KEY` is set (no SDK dependency — REST
  + HMAC webhook verification); otherwise a dev "simulate purchase" grants a session so the
  whole flow is demoable now. `POST /api/sessions/buy`, `POST /api/stripe/webhook`.
- **Data**: a JSON-backed store (users / sessions / entitlements) behind an interface, ready
  to swap for Postgres (see `docs/ARCHITECTURE-SAAS.md`).
- A session's **Open host** links to `BOOTH_ORIGIN/host` when set; wiring each session to its
  own isolated booth/queue is the next increment.

Next: real OAuth redirects, live Stripe, and per-session booth isolation.

## 1.73.52 — 2026-09-04

**Longer job history — 1,500 prints.** The in-memory queue/history cap
(`MAX_JOB_HISTORY`) went from 500 to 1,500, so the rich status/printer/time detail is
kept for far more prints before the oldest fall back to filename-derived info. Photos on
disk were never capped; this only affects how far back live job metadata is retained.

## 1.73.51 — 2026-09-04

**Gallery: photo details, reprint, and multi-select.** Tapping a photo in `/gallery`
now opens a detail view with its number (P1, P2…), status (Queued / Printing / Printed
/ Failed / …), printer, and time — plus **Reprint now (front)**, **Reprint → queue**,
and **Download**. Reprint re-enqueues the saved image as a fresh job (a new number, no
voucher/approval); "front" jumps ahead of the queue, "queue" joins the back. Tiles show
a status badge and can be **multi-selected** (checkboxes) for **Download** (a zip of just
those) or **Reprint → queue** in bulk.

New host endpoints: `POST /api/prints/reprint` ({names, priority}); `/api/prints` now
enriches each photo with number/status/printer/time; `/api/prints/download.zip` accepts
`?names=` to zip a subset. Photos whose job has aged out of the queue still show their
number/printer parsed from the filename.

## 1.73.50 — 2026-09-04

**All-photos gallery with one-click download.** A new host-only page at **`/gallery`**
(linked from the host screen under "Screens") shows *every* saved photo, with a
**Download all (.zip)** button and per-photo download. The zip is built by the server
with no dependencies (store-only, streamed) and validated to open in Finder/`unzip`.
Individual photos download via `/prints/<name>?token=…`; the list comes from
`/api/prints` (host token required).

**Guests no longer see the computer's hostname.** The "printing now on …" message now
shows only the host-set printer name/number — the machine name (e.g.
"Eljons-MacBook-Pro.local (helper)") is gone from the guest view.

## 1.73.49 — 2026-09-04

**Guests see the printer name you set — never the raw driver name.** The guest app now
shows the host-typed name/number (e.g. "Front Desk" or "#1"); if a printer was chosen
but left unnamed, it shows a clean "#1" instead of a long CUPS string like
"CANON_G4010_series". The raw driver name is never shown to guests or on the queue board.

**Saved photos are tagged with the printer.** When a print lands on a printer, its stored
filename gets the printer's label folded in (e.g. `…_grid_ab12cd34__Front-Desk.png`), so
you can tell from the file which printer produced each photo.

**Where photos live (relay/cloud):** on the relay's persistent disk at `/data/prints`
(set by `PRINTS_DIR=/data/prints` in the Dockerfile; Render/Fly mount the volume at
`/data`). The durable queue (`queue.json`), print codes (`vouchers.json`), and settings
sit beside them under `/data`, so they survive redeploys.

## 1.73.48 — 2026-09-04

**Fix: helper app was rejected by macOS as "malware."** The build skipped code-signing
entirely, and an unsigned Apple-Silicon app gets macOS's harshest Gatekeeper verdict
(damaged/malware, moved to Trash). The helper now **ad-hoc signs** the macOS app after
packing (`helper/afterPack.js`) — free, no Apple account — which downgrades it to the
normal "unidentified developer" prompt the operator can allow once. (Paid notarization
later removes even that.)

## 1.73.47 — 2026-09-04

**Helper build can be kicked off by a branch push too.** The release workflow now
also runs on a push to the `release-helper` branch (publishing `helper-v1.0.0`), so
the build can be started through the API when neither a tag push nor a workflow
dispatch is available. Tag pushes and manual dispatch still work.

## 1.73.46 — 2026-09-04

**Helper build can be kicked off without pushing a tag.** The release workflow now
takes a `tag_name` input on manual (`workflow_dispatch`) runs and creates that
release itself, so the installer can be built via the GitHub API — no local tag push
needed. Tag-push builds still work as before.

## 1.73.45 — 2026-09-04

**Shorter pairing code — 4 characters.** The Connect-a-printer code is now 4 chars
(from the same unambiguous alphabet) instead of 8, so it's quicker to read and type.
It stays single-use and expiring; the per-IP claim lockout is what keeps a short code
safe from guessing, and a code is normally redeemed within seconds anyway.

## 1.73.44 — 2026-09-04

**The printer helper app (no terminal).** A desktop app under `helper/` that the
operator downloads from the host screen, opens, and pairs with the code — then it
prints the queue from the menu bar. It reuses `server/agent.js` verbatim (forked as
a Node child), so pairing, printing, and the long-poll have one source of truth; it
makes only outbound HTTPS calls.

- **Built by CI, no developer account needed.** `.github/workflows/helper-release.yml`
  builds **unsigned** installers on GitHub's macOS and Windows runners on a `helper-v*`
  tag and attaches them as `BFF-Booth-Helper.dmg` / `BFF-Booth-Helper-Setup.exe` — the
  exact names the host screen links to. First launch is a one-time right-click ▸ Open
  (macOS) / More info ▸ Run anyway (Windows); add signing certs later to remove it.
- **macOS-first.** Printing uses CUPS, so macOS prints out of the box; the Windows
  build connects but needs a Windows print backend before it prints.
- Updated `docs/SETUP.md` to lead with the helper app, terminal agent as the
  alternative.

_Note: the Electron app is built and tested by CI on real macOS/Windows runners; it
can't be exercised in this repo's Node test suite. The server/host pairing it relies
on is covered by tests (v1.73.43)._

## 1.73.43 — 2026-09-04

**Seamless printer pairing — "Connect a printer" on the host screen.** Groundwork
for the one-click helper app: the host screen now has a **Connect a printer** card
(shown in relay mode until a computer is connected) that offers a download and a
**pairing code**, then **auto-detects** the moment the helper connects — flipping to
"Printer connected 🎉" and revealing the printer picker, with no page reload.

- **Pairing, so no token is ever pasted.** The host mints a short-lived, single-use
  code (`POST /api/pair/new`); the helper redeems it for the booth token
  (`POST /api/pair/claim`). Codes are 8 chars from a 30-char unambiguous alphabet,
  expire in 10 minutes, and claim attempts are rate-limited against guessing.
- **The agent can pair with a code.** `PAIR_CODE=XXXXXXXX RELAY_URL=… npm run agent`
  now works with no `BOOTH_TOKEN` — it trades the code for the token on start-up. The
  coming helper app uses this same path.
- The download button points at wherever CI publishes the installer
  (`HELPER_DOWNLOAD_BASE`, default the repo's GitHub Releases); the app itself lands
  in the next version.

## 1.73.42 — 2026-09-04

**Removed the browser-printer page (`/print`).** It was added in v1.70.0 as a
zero-install way to print, but running it alongside the `npm run agent` printer
created two printing paths at once — and when no printer was explicitly chosen in
`/host`, the relay's "use whatever's available" fallback would pull the browser
printer in, so guests got auto-assigned to a printer the host never picked. The
printer computer now connects one way: the agent. `/print` returns 404, the
"Printer page" link is gone from the host screen, and the setup docs describe the
agent path only. No change to how guests print or to the queue.

## 1.73.41 — 2026-09-04

**Groundwork for the paid, multi-tenant service (docs only — no app change).**
Added `docs/ARCHITECTURE-SAAS.md`, the target design for turning the single
booth into an account-based service where users sign in (Google / email /
Facebook), buy a session, open the host from their account, and connect a
printer with no per-event server to stand up. It spells out the one hard
constraint (reaching a printer on a private network — the browser tab vs. a
signed native helper vs. a cloud-print API), the recommended stack, and a
migration path that evolves today's code instead of rewriting it. Added
`db/schema.sql`, the first-draft Postgres schema (users, booths, printers,
agents, sessions, entitlements, vouchers, jobs) that the migration builds on.
The single-tenant booth is unchanged.

## 1.73.40 — 2026-09-02

**The host can actually cancel a print now.** The Printer-queue panel only put a Cancel button
on raw system-queue entries (which don't exist in relay mode and don't map to a guest's print),
so the prints you could see had no working Cancel. Every in-flight print (waiting or printing)
now has a Cancel that: removes it from the queue, cancels it at the printer if it's already
there, refunds its print code, and releases the next print. Works in both booth and relay
setups. The guest is shown a "Print cancelled" message if their print is cancelled.

**Print-code polish.** Several fixes to the voucher flow:

- **Wrong code now says so.** It was reporting "lost connection" because the server rejected the
  code mid-upload, resetting the connection. The server now reads the whole upload first, so a
  bad code comes back as a clean "That print code is not valid" and the guest can retry.
- **Keyboard opens automatically.** When the code prompt appears, the field is focused right
  away (inside the tap), so the phone keyboard pops up with no extra tap.
- **No placeholder text** cluttering the code field.
- **No offensive codes.** Generation now skips any code that spells something rude in English,
  Tagalog, Bisaya or Ilocano (checked as a substring), and a batch made before this filter has
  its unused offensive codes retired automatically on the next start. Verified across 3,000
  generated codes.
- **Host queue Cancel** now shows what happened when tapped, instead of appearing to do nothing.

**Fix the wrong-code prompt, and harden guessing.** A rejected print code was being drawn
*behind* the "Sending…" screen, so a guest who typed a wrong code saw no error. The code prompt
now sits above everything: a wrong code shakes the field red, keeps what was typed (selected, so
a typo is one tap to fix), and shows a bold "That print code is not valid." The check also runs
before the photo is uploaded, so it's instant.

And to make guessing near-impossible: on top of the ~887-million code space (31^6, with only the
handed-out codes live), repeated wrong codes from one device now trip a cool-off (8 wrong tries
in 10 minutes → locked out), so a brute-force sweep is throttled to a standstill. Verified with a
new lockout test and the wrong-code flow.

**Print codes (vouchers).** A booth can now require a single-use code to print, so only guests
holding a voucher can use the printer.

- **Codes**: 6 characters from a 31-letter alphabet with the ambiguous glyphs removed (no
  I, L, O, 0, 1) — clear on a printed voucher, and ~887 million combinations, so a handful of
  live codes out of a batch is a one-in-a-million guess per try (and print attempts are rate
  limited). Codes are generated cryptographically at random, never sequential.
- **Host screen**: turn on "Require a print code", generate a batch (default 1000), see how
  many are unused/used, and download the unused codes as a CSV to print onto vouchers. Codes
  are stored on disk so they survive a restart.
- **Guest**: tapping Print asks for the code before anything is sent; a wrong or already-used
  code is refused and the guest can try another.
- **Single-use**: a code is spent the moment a print is accepted, and refunded automatically if
  that print fails or the host skips it — so a booth error never burns a guest's voucher.

Off by default (no code needed). Verified with tests for gating, single-use, and refunds.

**Collapse the printer list.** The settings screen no longer lists every printer on the machine
by default — it shows only the printers you've chosen (with their names/numbers) and a "Choose
printers" button. Tap it to open the full list, tick and name the printers to run, then close it
again (it also collapses after Save). A fresh booth starts with none chosen, printing to the
default printer until you pick.

**Printer list readability + clearer approval box.** Each printer in "Printers to use" is now
its own card with the full name on top (long CUPS names like "CANON_G4010_series" wrap instead
of being cut off), and its name/number field below. And the host's approval box is renamed
"Waiting for your OK" and now explains itself: with "Ask me before each print" off it says
prints go straight to the printer; with it on, prints wait there for approval.

**Multiple printers, and multiple computers, on one booth.** The host can now run several
printers at once and the server shares prints across them, sending each new print to whichever
printer is free first.

- **Host screen**: a "Printers to use" checklist — tick each printer to run and give it a
  name or number (e.g. "Front #1"). That name is what guests and the board see. In relay
  mode the list is grouped by computer.
- **More than one computer**: several Macs/PCs can each run `npm run agent` against the same
  cloud (or tunnelled) server; each reports its own printers and prints in parallel. Each
  computer carries a stable id (its hostname, or `AGENT_ID`), and the relay hands every job to
  a free printer on whichever computer is ready. A single agent with several printers also
  prints several at once.
- **Free-first assignment**: the scheduler fills every free printer, so N printers clear the
  queue about N× faster; ETAs now model the parallel printers.
- **Queue board (/view)**: "Now printing" shows a card per running printer — the print, its
  printer name, and the computer it's on.
- **Guest app**: while a print runs, the guest is told which printer (and computer) it's on,
  using the host-set name.

Backwards compatible: with no printers selected it behaves exactly as before (one printer,
serial). Verified with new tests for parallel booth printers and two connected computers.

**"Allow media" on Facebook / Messenger (Android) — fix the picker in place.** The earlier
banner (1.73.31) and browser-redirect (1.73.32) are both gone. The real trigger is the
`accept="image/*"` filter: on Facebook's Android WebView it launches the gallery intent, which
needs a media permission the Facebook app often does not hold — hence "allow media". The plain
document picker (Storage Access Framework) needs no such permission. So on the Facebook Android
WebView only, the picker drops the image filter (loadPhoto still rejects non-images); every
other browser, including Facebook on iOS, keeps `accept="image/*"` exactly as before. Verified
that only the FB-Android user-agent drops the filter and the picker still opens.

## 1.73.31 — 2026-09-02

**Fix "allow media" when opening from Facebook / Messenger.** Those apps open links in their
own in-app browser, an Android WebView that blocks the photo picker with an "allow media"
error the guest can't get past. The app now detects that in-app browser (Facebook, Messenger,
Instagram and similar) and shows a bright banner: tap it to reopen the page in Chrome (an
Android intent), or use the ⋮ menu's "Open in Chrome". On iOS in-app browsers the banner
copies the link to paste into Safari instead. The banner shows only inside those browsers and
disappears the moment the picker returns photos. Verified by loading the page under a Messenger
user-agent (banner shown) and normal Chrome (hidden).

---

## 1.73.30 — 2026-09-02

**Bring the coverflow deck up to the swipe cue.** The max-height cap rises to 1000px, but on a
phone the deck's size is bound by the card fit, not the cap — so the cards themselves are now
larger: the height budget above the glass line uses the real 84% baseline (the JS constant was
still 0.76), and the card fit box grows (height up to 50% of the viewport, width to 62%). The
deck's bottom still rests on the glass with the check button below it, while the top rises to
sit just under the swipe animation, closing most of the empty band. Verified with a phone-width
screenshot.

---

## 1.73.29 — 2026-09-02

**Check button off the photo, version by the title, taller coverflow cap.** The action block's
upward pull eases from -64px to -34px, so the check button sits below the card (still grounded on
the reflection) instead of touching the photo. The version stamp moves from the foot of the page
to a small tag beside the title; the wordmark shrinks to fit (clamp) so both stay on one line.
And the coverflow's max-height cap rises from 680px to 900px, so the deck can grow taller where
the screen allows. Verified with a phone-width screenshot of the swipe step.

---

## 1.73.28 — 2026-09-02

**Push the coverflow lower and overlap the reflection with the check.** The cards drop lower
in the deck (the glass baseline moves from 76% to 84% of the coverflow), so the cards render
larger and their reflection extends further down. The action block below now uses a negative
top margin (-64px) instead of a downward nudge, which both lets the coverflow grow taller and
rides the check button up over the faded tail of the reflection — the reflection grounds into
the button. Verified with a phone-width screenshot of the swipe step.

---

## 1.73.27 — 2026-09-02

**More room for the coverflow.** The design cards and their reflection now get more vertical
space: the action buttons below (the check, Save/Print, Replace) sit lower on the screen —
their upward lift changed from -34px to +6px — and the margins above the coverflow are tighter
(the header padding and the step-guide gap were trimmed). A small bottom safe-area pad keeps
the lowered buttons clear of the screen edge. Verified with a phone-width screenshot of the
swipe step.

---

## 1.73.26 — 2026-09-02

**Make the sticker pop.** The badge now gets a tight dark outline hugging its silhouette (an
offset-0 shadow built up over two passes) plus a stronger, softer drop shadow for lift, then
the crisp badge on top. It reads clearly against the busy watercolor paper instead of blending
into it. Verified by rendering the default layout.

---

## 1.73.25 — 2026-09-02

**Revert the 1.73.24 rewrite; just shrink the paper margin.** The 1.73.24 change rewrote the
layout optimiser and broke the layout rules — that is undone. The optimiser and all the rules
are back exactly as they were (whole photos, no cropping, one hero at most 2× the smallest, the
sticker its own 5th cell). The only change now is a smaller margin: the decorative paper border
around the photos (the frame inset) is cut from ~3.5% to ~1.5% per side, and the gutter between
photos from 26px to 14px, so the same layout sits larger on the sheet. Note the paper that
remains around whole photos is the cost of the no-crop rule, not margin — mixed-shape photos
cannot tile a rectangle without cropping.

---

## 1.73.24 — 2026-09-02

**Fill the entire paper — no margins.** The four photos now tile 100% of the sheet: a
weighted guillotine partition slices the whole page (hero exactly 2× every other photo,
the rest equal) and each photo is shown cover-fit, so it fills its cell edge to edge with
no blank border and no letterbox. The optimiser searches both sheet orientations and every
arrangement and keeps the one that trims the photos the least. The sticker is a small badge
on top in the lower-right corner, so it never carves out an empty cell. The watercolor frame
was also tightened (much smaller inset, thinner border and corner radius) so the photos reach
the paper edges instead of floating in a wide mat. Verified by rendering a portrait+landscape
mix at 100% coverage.

---

## 1.73.23 — 2026-09-02

**Revert the layout to the 1.73.14 version.** The 1.73.15–1.73.22 layout rework made the
picker grid worse, so `public/js/layouts.mjs` and its tests are restored exactly to the
1.73.14 state: whole photos (no crop), each cell shaped to its own photo, one hero within
2× the smallest, and the sticker as a small badge in the margin. All the non-layout fixes
since then (/view rotation, print serialization, tray-timing copy, em-dash removal, sRGB
print tagging) are untouched.

---

## 1.73.22 — 2026-09-02

**Tight layout, matching the guide.** Every photo is now snapped to a clean 4:3 (landscape)
or 3:4 (portrait) cell and shown cover-fit to fill it, so the four photos tile tightly instead
of leaving mismatched gaps — the small trim off each photo is the cost of the clean shape. The
sticker is now a small badge pinned to the lower-right corner, sized to sit under the smallest
photo so it is always the smallest element and never rivals a photo (rule 5), and it never
overlaps a photo. The auto pick and the lead coverflow card are now the same design (the
fullest-filling one), so a guest who never swipes prints exactly what the coverflow shows first.
Verified by rendering a portrait+landscape mix (78% coverage, hero within 2×, sticker lower-right).

---

## 1.73.21 — 2026-09-02

**Drop the sparse layouts and enlarge the sticker.** The coverflow no longer offers
the poorly-filled arrangements (a mismatched hero stacked into a narrow column with
wide margins) — it keeps only designs that fill close to the fullest, so guests never
swipe onto a mostly-empty sheet. And when a sticker is present the photo block is
anchored to leave ONE clean band (a side column or footer) for the badge, sized to
fill most of it — so the sticker is clearly visible instead of a speck in a thin
margin. Verified by rendering the coverflow for a portrait+landscape mix.

---

## 1.73.20 — 2026-09-02

**Default pick fills the most paper.** The booth was defaulting to photo 0 as the
hero, which on a mixed set could stack the photos into a narrow column with wide
margins. It now picks, among the four possible heroes, the one that fills the most
paper (keeps one hero per rule 3). On the tested portrait+landscape mix the default
went from ~44% of the sheet to ~83% — whole photos, tight, with the decorative paper
as even matting and the sticker in the margin.

---

## 1.73.19 — 2026-09-02

**Revert the cropping — whole photos again.** 1.73.18 filled the sheet by trimming
each photo's edges; that violated the "no cropping" rule and was the wrong call.
Photos are shown whole again (each cell shaped to its photo, no crop, no letterbox
bars), the block is centred, and the sticker sits in the paper margin, never on a
photo. The unavoidable consequence of no-crop for mixed-shape photos is that the
decorative paper shows as matting around the block — that is the trade the no-crop
rule chooses.

---

## 1.73.18 — 2026-09-02

**No white background, and the sticker gets its own cell.** Photos now fill their
cells edge to edge (cover-fit) instead of being letterboxed, so there is no white
around a photo — the small overflow is trimmed, and the optimiser keeps that trim
as small as possible (worst-matched cell first). The sticker is now a real cell in
the layout with its own space, never stamped on top of a photo. NOTE: this changes
the "no cropping" rule — filling the sheet edge-to-edge for mixed-shape photos is
only possible by trimming a little off each; that is the deliberate trade for zero
white. Verified by rendering the portrait+landscape mixes.

---

## 1.73.17 — 2026-09-02

**No photo swims in white any more (minimax fill).** The layout already fills the
whole sheet, but on a wide-vs-tall photo mix it could leave one cell showing a tiny
photo in a big cream frame. The optimiser now maximises the WORST cell's fill first
(then total), so every cell takes a shape close to its photo and the unavoidable
no-crop slack is spread thinly instead of dumped into one cell. On the tested
portrait+landscape mix the worst cell went from ~20% filled to ~56%.

---

## 1.73.16 — 2026-09-02

**Layouts now fill the whole sheet — no more empty regions.** The previous version
sized each cell to its photo and then centred/anchored the block, which left large
blank areas on the page. The optimiser now works the other way round: it partitions
the ENTIRE sheet into four cells (dividing each guillotine cut in proportion to the
target areas, hero 2× the rest) so the photos cover 100% of the paper, then fits each
photo inside its cell. It searches every arrangement × both sheet orientations and
keeps the one that shows the most photo — i.e. whose cell shapes best match the photos,
minimising letterbox. Nothing is cropped (a photo is shown whole inside its cell; any
slack is a thin matted bar, never a cut), and the sticker is a small corner badge on
top. Verified by rendering the real portrait+landscape mixes that were leaving big
margins.

---

## 1.73.15 — 2026-09-02

**Fill the sheet: a guillotine-slicing layout optimiser.** The layout used to fix
each photo's area and then scale the block to fit, which left wide borders. It now
searches every possible recursive split of the sheet (both orientations) and
chooses split ratios so each photo's rectangle exactly matches its aspect ratio —
a zero-gap tiling, computed from the identity that a slice's aspect combines as a
sum (side-by-side) or a reciprocal sum (stacked). It keeps the arrangement that
covers the most paper while obeying the rules (no cropping; one hero, never more
than 2× the smallest; the sticker a small corner badge, never the hero). Typical
prints now fill ~85–90% of the sheet edge to edge instead of sitting in a wide
margin. When no balanced gap-free tiling exists for a given photo mix, it falls
back to the previous layout (a residual border is then forced by "no crop + ≤2×").
Verified across many photo-aspect mixes: rules hold, no overlaps, and by rendering
real prints.

---

## 1.73.14 — 2026-09-02

**Tag prints as sRGB so they colour-manage like a real photo.** Prints from the
app came out darker, warmer and more washed out than ordinary photos on the same
printer. The cause: a browser canvas export carries no colour profile (a PNG has
no sRGB/iCCP chunk at all, and mobile Safari often omits the JPEG profile too), so
the print pipeline handles it with a wrong assumed profile. A real photo always
ships an ICC profile and gets managed correctly. Every export is now tagged sRGB
(an sRGB ICC segment on JPEG, an sRGB chunk on PNG) so the printer treats it the
same as a photo. Verified the tagged files still decode and carry the profile.

---

## 1.73.13 — 2026-09-02

**Remove the print colour correction — prints are now a faithful copy of the
screen.** The contrast/saturation boost added in 1.73.6 was darkening prints
(the contrast crushed midtones and shadows), and colour correction in the app
fights the printer's own colour management. The print bitmap is now plain sRGB,
matching what the guest sees. Brightness and colour balance belong in the
printer's settings, where they can be tuned to the actual printer.

---

## 1.73.12 — 2026-09-02

**Remove em dashes from all user-facing text.** Every em dash in text guests,
hosts, and viewers actually see is gone, restructured into separate sentences or
other punctuation (periods, commas, colons). Covers the guest app, host screen,
queue viewer, and the server error messages that surface in the browser.
Standalone "—" placeholders now show "…". Code comments are left as they were.

---

## 1.73.11 — 2026-09-02

**Only send guests to the tray once the print is actually done.** While a job
was still `printing`, the guest screen said "coming out now — grab it from the
tray", telling people to collect a print that wasn't out yet. The printing state
now says "printing now — hang tight, we'll tell you the moment it's ready", and
the tray/collect instruction appears only on the `done` state (which, since
1.73.10, lands when the sheet has really finished).

---

## 1.73.10 — 2026-09-02

**Stop flooding the printer's own queue — send one sheet at a time for real.**
Regression from 1.72.2: completion switched to "CUPS says done", but CUPS reports
a job done the moment it finishes *sending* it to the printer, which on any
printer with a page buffer is well before the sheet is out. The booth then
released the next `lp` too early and pages piled up in the printer's hardware
queue. Now a print holds the printer until it has BOTH cleared CUPS **and** been
printing for at least one physical interval (`PRINT_MS`, env-tunable, default
30s) — so at most one sheet is ever in front of the printer. Same floor applied
to the relay agent's completion wait. Set `PRINT_MS` to your printer's real
per-sheet time (in ms) for tight pacing. Verified with a simulated buffered
printer: max one concurrent print, one sheet released per interval.

---

## 1.73.9 — 2026-09-02

**Actually fix landscape prints shown sideways in /view.** The 1.73.5 viewer
rotation was correct but never triggered: the guest app derived each job's
`orient` from the *already-rotated* print bitmap (always portrait), so every job
was tagged `portrait` and the counter-rotation was skipped. `exportPrint` now
reports whether it rotated the design, and the guest tags the job from that — so
landscape prints report `landscape` and the queue board spins them upright.
Verified by rendering /view with a real landscape job.

---

## 1.73.8 — 2026-09-02

**Revert the v1.73.7 Tailscale tunnel change.** `server/tunnel.js` and its test
are restored to exactly the 1.73.0 behavior, undoing the one-shot funnel rework.

---

## 1.73.7 — 2026-09-02

**Fix Tailscale funnel serving nothing (guest link timed out on phones).**
Regression from 1.11.1: the booth ran `tailscale funnel <port>` as if it were a
long-lived process and respawned it when it exited — but on current Tailscale
that command configures funnel and returns immediately, so the respawn collided
with its own listener (`listener already exists for port 443`) and left funnel
"on" with an empty serve config. The `.ts.net` address then resolved publicly but
forwarded to nothing, so phones timed out while the Mac (on the tailnet) still
worked.

The Tailscale path is now a verified one-shot: it reads the fixed `.ts.net`
address from `tailscale status`, brings funnel up with `tailscale funnel --bg`
(persisting in tailscaled, surviving booth restarts and sleep), and confirms it
is actually proxying the port — clearing stale state and retrying once if not,
and reporting the real reason instead of a silent dead link.

---

## 1.73.6 — 2026-09-02

**Print colour correction.** Prints now get a subtle contrast and saturation
boost (+9% contrast, +16% saturation) so photos come out punchier on paper,
which reads flatter than a phone screen. Applied to the print bitmap only — the
photo saved to the guest's phone keeps its true on-screen look. Tunable via
`PRINT_CONTRAST` / `PRINT_SATURATION` in `public/js/render.mjs`.

---

## 1.73.5 — 2026-09-02

**Landscape prints no longer sideways in the queue viewer.** A landscape
design is stored rotated 90° to feed the portrait 4×6 paper, which made those
photos show on their side in `/view`. Each job now carries its design
orientation, and the viewer counter-rotates landscape prints so every photo —
now printing, up next, and recent — displays upright.

---

## 1.73.4 — 2026-09-02

**Widget glow moved outside.** The queue widget's colour halo now reads as an
outer glow around the bubble instead of a ring tinting the inside of the white
circle. The colour band is pushed past the bubble's edge so only its soft spill
shows all around the outside.

---

## 1.73.3 — 2026-09-02

**Playful print-status widget.**

- The little status widget now shows a printer icon and a colorful glow halo that gently
  spins and breathes around it, while the print number, place in line, and ETA stay crisp on
  the white bubble. (The glow holds still under reduced-motion.)

## 1.73.2 — 2026-09-02

**The status widget shows the ETA again.**

- When the print number was added to the little status widget it accidentally dropped the
  ETA. The waiting widget now shows all three: the print number (P5), place in line, and the
  ETA (e.g. `P5` · `#2 · 2 min`).

## 1.73.1 — 2026-09-02

**The version is shown on the guest page again.**

- Brought back a quiet version stamp (e.g. `v1.73.1`) at the foot of the guest page.

## 1.73.0 — 2026-09-02

**Every print gets a number — P1, P2, P3…**

- Each print is stamped with a running number as it's submitted. It shows in the host queue
  and the `/view` board (in place of a guest name), on the guest's own screen (a badge in
  the print modal and the little status widget), and it's baked into the saved filename
  (`P7_…png`) so a print is easy to match to its ticket. The counter continues across a
  relay restart.

## 1.72.2 — 2026-09-02

**The Mac now reports real print completion — no more guessing.**

- The booth agent on the Mac watches its own CUPS queue and tells the relay "done" only
  once the sheet has actually left the printer (it reports "started" first, so the guest
  sees "Printing now" immediately). This replaces the time estimate, and the relay even
  learns the true print duration from it, so ETAs get more accurate.
- The browser `/print` page can't see the OS print queue, so that path still estimates
  completion from the learned print time — it's the best a web page can do.

## 1.72.1 — 2026-09-02

**Fixed "all done!" showing the instant a print started (relay/cloud mode).**

- On a cloud relay, the printer reports back the moment it *starts* a sheet, and the booth
  was treating that as finished — so guests saw "All done!" while the print was just
  beginning. Now the relay keeps it as "Printing now" for the real print time and only flips
  to done afterward. (LAN booths already tracked real completion via CUPS.)

## 1.72.0 — 2026-09-02

**New: a live queue board at `/view` for a TV or spare screen.**

- Shows what's **printing now** (with a countdown and progress bar), the **up-next** line
  with a per-photo ETA each, an **overall "time to clear"**, a **just-printed** gallery, and
  a **"scan to join" QR** so onlookers can jump in.
- Themed with the booth's chosen sticker and watercolor paper, and built for a big screen
  (auto-scaling text, a fullscreen button, live updates) — it also stacks nicely on a phone.
- Opens straight up on a LAN booth; a cloud relay asks for the booth token once (and honours
  a token already saved from the host screen). Links to it (and the printer page) are on the
  host screen under "Guests join here".

## 1.71.2 — 2026-09-02

**Gallery photos from Samsung/iPhone (HEIC) now work.**

- Picking a photo from the gallery could fail with "could not use this photo" on Android
  (Samsung), because the file was HEIC/HEIF — a format Chrome can't decode (the camera hands
  over a JPEG, which is why "Take photo" always worked). The app now converts HEIC to JPEG on
  the fly, and tries several decode paths (bitmap → object URL → data URL) for stubborn
  files. If a photo still can't open, the message points to "Take photo" instead.

## 1.71.1 — 2026-09-02

**Added the Manila Temple sticker.**

- Placed the temple sticker in `public/backgrounds/` (where the booth scans for stickers) so
  it shows up in the host's sticker picker. It had been uploaded to the built output folder,
  which the app doesn't read.

## 1.71.0 — 2026-09-02

**Switch the strip's sticker from the host screen.**

- Any `.png` you drop into `public/backgrounds/` now shows up as a sticker choice on the
  host screen (**Settings ▸ Sticker on every strip**). Pick one, Save, and every new strip
  stamps that badge. (The papers are `.jpg`, so backgrounds and stickers stay separate.)
- The picker shows a thumbnail of each sticker with the current one highlighted; the guest
  app shapes the badge cell to whatever sticker you choose, so a taller or wider sticker
  isn't stretched or cropped.

## 1.70.2 — 2026-08-29

**Full setup guide.**

- Added `docs/SETUP.md`: a start-to-finish walkthrough — deploy the relay from the browser
  on Render, connect the printer computer at `/print`, show the guest QR, and test it end
  to end — including the branch/merge step, kiosk-printing, borderless, and costs.

## 1.70.1 — 2026-08-29

**One-click browser deploy; the QR figures out its own address.**

- Added a `render.yaml` blueprint so the cloud relay can be stood up entirely from a web
  browser — connect the repo on Render, Apply, done. No local CLI, nothing installed on any
  machine (the printer computer still just opens `<url>/print`).
- In relay mode the guest QR now derives the public address from the request itself, so it
  points at the real URL on any host with no `PUBLIC_URL` to set.

## 1.70.0 — 2026-08-29

**A durable server queue, and a printer that's just a URL.**

- **The queue lives on the server now, not in memory.** In relay mode every submitted
  print is written to disk (`queue.json` on the data volume) the moment it arrives, so a
  relay restart, crash, or redeploy no longer loses queued prints — they're still there and
  drain when the booth is ready. A job that was mid-print when the server stopped is
  automatically re-queued.
- **The printing computer can just open a URL — no npm, no tunnel.** Open
  `https://your-booth/print` in Chrome, paste the booth token once, and leave the tab open;
  it pulls jobs from the relay and prints them (silently with Chrome's `--kiosk-printing`).
  The Node agent still works for driver-level control, but it's now optional.

*(Relay/cloud mode; a plain LAN booth still prints straight to its own printer.)*

## 1.69.0 — 2026-08-29

**Prints keep flowing even when the booth loses internet.**

- The cloud relay now owns the print queue. When you run the booth in relay mode
  (`MODE=relay` on a public host, with the Mac running `npm run agent`), a guest can submit
  a print even while the booth Mac is offline: the relay accepts it and holds it in the
  queue, and the Mac drains everything waiting the moment it reconnects.
- Guests get honest wording for this — "Saved to the print queue… it'll come out once the
  booth's back online" — instead of being turned away with an error.

*(This is relay/cloud mode only; a plain LAN booth still prints straight to its own printer
as before.)*

## 1.68.3 — 2026-08-29

**Solid-orange wordmark; no more title flash.**

- Reworked the title into a solid bright-orange, chunky rounded sticker wordmark that
  matches the event logo (dropped the rainbow gradient).
- The hosted preview now shows the real booth name from the very first paint, so the title
  no longer flickers from "Photo Booth" to "BFF Photo Booth" on load.

## 1.68.2 — 2026-08-29

**Playful new wordmark; version tag hidden.**

- Restyled the "BFF Photo Booth" title with a chunky, rounded, friendly font and a bright
  orange→green→blue gradient, echoing the event logo.
- Hid the little version tag next to the title. (The version is still tracked and shown on
  the versions page and the host screen.)

## 1.68.1 — 2026-08-29

**Swipe cue clears on commit; coverflow cards no longer clip at the top.**

- Tapping the check now also clears the swipe cue if you hadn't swiped yet.
- Fixed the layout cards getting their tops sliced off on shorter screens — the card size
  is now capped to the room actually above the glass line, so a short screen shrinks the
  cards a touch instead of clipping them. Tall screens are unchanged.

## 1.68.0 — 2026-08-29

**Borderless prints no longer crop the photos.**

- A borderless 4×6 printer enlarges the image slightly to bleed off the edges, which was
  eating into the photos near the border. The print now pulls the photos in by a small
  safe margin (5% per side) so that edge overscan trims the decorative watercolor border
  instead of the pictures. The on-screen preview and the saved-to-phone image are unchanged
  — they keep the full, maximized look.

## 1.67.9 — 2026-08-29

**Print status bubble moved to the top.**

- The little print-queue widget ("Printing now") now floats in the upper-right, just below
  the app title, instead of the bottom-right corner.

## 1.67.8 — 2026-08-29

**The step guide truly appears only once, and the swipe cue no longer nudges the pictures.**

- Once the "Step 2 of 3" guide has shrunk away, it stays gone for the rest of the session —
  it won't come back even if you pick a fresh set of four photos.
- Fixed the swipe cue: when it pops away it now keeps its space reserved, so the coverflow
  and layout pictures no longer jump up.

## 1.67.7 — 2026-08-29

**Step text stays gone once committed; Replace photos sits lower.**

- Once the "Step 2 of 3" instruction shrinks away (you tapped the check), it no longer comes
  back when you swipe to another design. It still returns for a fresh set of four photos.
- Gave the Replace photos button more top spacing so it isn't crowded against the
  Save/Print (or check) buttons above it.

## 1.67.6 — 2026-08-29

**The pictures no longer jump up when the step text disappears.**

- The shrinking step instruction now keeps its space reserved, so the coverflow and layout
  pictures stay put instead of sliding up to fill the gap.

## 1.67.5 — 2026-08-29

**The step instructions shrink away instead of popping.**

- Reverted the confetti pop: when you tap the check, the "Step 2 of 3" instruction now
  simply shrinks into nothing (same duration as the pop). It still comes back if you swipe
  to a different design.

## 1.67.4 — 2026-08-29

**Tapping the check pops the step instructions away.**

- When you tap the check to commit a layout, the "Step 2 of 3" instruction now bursts away —
  its three lines pop out and confetti bits scatter — clearing the stage for Save/Print. It
  comes back if you swipe to a different design.

## 1.67.3 — 2026-08-29

**The check's pop now scatters confetti.**

- When the check button pops away on a swipe it now bursts into several colored confetti
  bits, matching the swipe cue's pop, then springs back when the deck settles.

## 1.67.2 — 2026-08-29

**The check button pops while you swipe.**

- While you're swiping through the layouts, the check button now pops away with a little
  burst, then pops back in with a springy bounce the moment the deck settles — replacing the
  old slide-out tick.

## 1.67.1 — 2026-08-29

**Step 2 polish: the swipe cue pops away, and "the check" is the real button.**

- The swipe cue now bursts away with a little confetti pop the moment you make your first
  swipe, instead of lingering.
- "then tap the check" now shows the actual check button inline in the sentence, so it's
  clear exactly what to tap.
- Moved the check and Replace-photos controls down so they no longer overlap the layout
  pictures above them.

## 1.67.0 — 2026-08-29

**A swipe cue on step 2, and a Print button in the hosted preview.**

- Replaced the arrow above the check on step 2 with a hand-drawn double-headed arrow and a
  gradient "fingertip" that glides left↔right, sitting between the instruction and the
  layouts — so it reads as "swipe to browse".
- The GitHub Pages preview now shows the Print button alongside Save/Share, exactly like the
  real guest app. There's no printer behind it, so tapping Print does nothing.

## 1.66.3 — 2026-08-29

**Step counter picks up the button's moving gradient.**

- "Step X of 3" now shifts through the same animated purple→pink→orange gradient as the
  primary button, instead of plain grey.
- Moved the step instructions up so they clear the bobbing hand-drawn arrow on the welcome
  screen.

## 1.66.2 — 2026-08-29

**Cleaner step instructions.**

- The "Step X of 3" line now uses the same handwriting font as the instruction, just a
  little smaller, so the whole guide reads as one voice.
- Removed the little segmented progress bar under the step text.
- Removed the emojis from the step instructions.

## 1.66.1 — 2026-08-29

**Removed the placeholder demo photos from the GitHub Pages preview.**

- The hosted preview used to auto-drop four coloured placeholder photos on load so it
  landed straight on the coverflow. Removed for now — the preview opens on the real empty
  welcome screen, and you add your own photos with the pick button. (Older version
  snapshots keep their old behaviour; only the current build changed.)

## 1.66.0 — 2026-08-29

**Whimsical, hand-drawn step instructions.**

- The step-by-step guide is now big, playful handwriting (Caveat) in white with a gentle
  floating bob, plus a friendlier helper line under each step ("Pick your 4 best shots!" →
  "tap the button to add or snap them ✨"; "Swipe to find your fave!" → "then tap the ✓
  when you love it 💫").
- Added **hand-drawn arrows** (roughened with an SVG sketch filter, softly bobbing) that
  point right at the button for the current step — at the "add photos" button on step 1 and
  the ✓ button on step 2.

## 1.65.0 — 2026-08-28

**Shaved the fat decorative border — the photos are bigger now.**

- The watercolor frame was insetting the whole photo block by 7.5%/6.5% on each side — a
  sizeable even band of paper around all four edges that was just being wasted. Cut it to
  3.5%/3%, so the photos scale up ~8–9% in each dimension and nearly reach the printable
  edge, keeping only a thin watercolor rim. This is the "shave the 4 sides" fix.

## 1.64.1 — 2026-08-28

**Restored the layout rules in CLAUDE.md to the user's exact wording.**

- I had rewritten the rules with constraints and excuses the user never gave: "no letterbox
  bars / cells must match the photo's aspect" (added to "no cropping"), and a whole
  "unavoidable trade-off" section claiming the rules conflict. Removed both — the rules are
  now the user's five, verbatim. No layout-behaviour change (the current optimizer already
  satisfies all five).

## 1.64.0 — 2026-08-28

**One unmistakable hero again — fixes the tied-hero / bloated-sticker bug.**

- 1.63.0 broke rule 3 ("exactly one hero"): it capped the other photos right up to the
  hero, so a second photo could tie the hero and the sticker grew to nearly hero size.
- Now the five cells carry fixed area ratios — the hero is **exactly 2× every other
  photo** (the other three are equal), and the sticker is a small badge at ~0.55× a photo,
  always the smallest cell. The optimizer searches both sheets and every row/column
  arrangement and keeps the packing that fills the most paper, so coverage went up too
  (~71–79% vs ~59%). Nothing is cropped.
- "Four equal" is now actually four equal photos plus the small sticker (it used to let one
  photo balloon).

## 1.63.0 — 2026-08-28

**Layouts are now computed by an optimizer, and the sheet flips to fit the photos.**

- The grid is chosen by search, not a fixed template: for each design it tries both sheet
  orientations (4×6 portrait and 6×4 landscape) and every row arrangement, and keeps the
  one that fills the most paper. This is the big fix for **landscape group photos**, which
  the old portrait-only template squeezed into tiny cells with huge gaps.
- Every rule holds together now: **nothing is cropped** (each cell has its photo's aspect),
  there is **one hero** featured on top at **exactly 2× the smallest photo** (never more),
  and the **sticker is a real 5th cell** that is capped so it can never be the hero.
- The **"Four equal"** card is the no-hero option and packs densest (often ~95%), for when
  filling the paper matters more than featuring one photo.
- Recorded the layout rules in `CLAUDE.md` so they stop getting lost.

Note: with whole photos and the 2× cap, the featured-hero cards can't fill 100% — the
leftover watercolor paper is the matting, and it's the mathematical cost of "no crop +
2× cap", not wasted space. The "Four equal" card is there when you want maximum fill.

## 1.62.0 — 2026-08-28

**No cropping — whole photos, a hero that stands out, the sticker as a real 5th cell.**

- Reverted the cropping from 1.61.0. **Nothing is cropped**: the page is divided into
  slots (a big hero slot, three rail slots, a badge slot) and each photo is shown whole,
  shaped to its own proportions and centred in its slot. The watercolor paper showing
  around the photos is the matting — by design, since whole photos can't tile a sheet
  without either cropping or some paper showing.
- The **hero clearly stands out** — it sits in a wider slot, ~1.9× a rail photo for a
  portrait — but is held to **at most 2×** the smallest photo (scaled down if the shapes
  would push it over).
- The **sticker is a real 5th cell** in the layout, shaped to its own aspect so the badge
  fills it, and always the smallest cell — it can never be the hero.
- Each **"Big #N"** features photo N in the big slot. Everything is a 4×6 portrait sheet.

## 1.61.0 — 2026-08-28

**The paper is filled, and the sticker is a true 5th cell that can never be the hero.**

- Layouts now **tile the sheet edge to edge** and cover-fit each photo (crop to fill),
  the way a real collage does, instead of shaping every cell to its photo (which always
  left gaps). The photos fill the paper — only the thin gutters and the decorative
  watercolor border remain.
- The **sticker is a real 5th cell** in the layout — not an overlay badge. It sits in its
  own slot, shaped to the sticker's aspect ratio so the art fills it exactly, and it is
  always the **smallest** cell, so it can never become the hero.
- Each **"Big #N"** features photo N as the hero at ~1.7× a rail photo (a clear hero,
  never more than 2×). "Four equal" gives four ~equal photos plus the sticker.
- Everything prints on the booth's **4×6 portrait** sheet; wide photos crop to fill their
  cell (adjust the framing in the photo editor).

## 1.60.0 — 2026-08-28

**Denser layouts, and the sticker is a small corner badge again.**

- The sticker is no longer packed as a full cell (which had let it grow as large as a
  photo — a second hero). It's back to a **small badge (20% of the page width) tucked into
  a corner**, off the hero, covering at most ~8% of any photo. It can never be the biggest
  thing on the page.
- **Filling the paper is now the priority.** Layouts are chosen for maximum fill first, so
  a set of same-shaped phone photos packs into a dense grid (~85% of the paper) instead of
  the sparse corner-and-strips arrangement. The 2× cap still holds — no photo runs more
  than twice another when the shapes allow it, and a wide-vs-tall mix is kept as close to
  the cap as cropping-free tiling permits (never the old 15–45× runaway).
- Each **"Big #N"** now leads with photo N in the top-left, so the picker cards stay
  distinct even when every photo is the same shape. Nothing is cropped.

## 1.59.0 — 2026-08-28

**The hero photo is capped — never more than twice the smallest photo.**

- A full-strip hero used to run **15–45× the area** of the smallest photo, burying the
  others. The hero now takes a corner at a bounded size while the remaining photos and the
  sticker fill the strips beside and below it, and the engine searches the corner, how the
  items split between the strips, the hero's size, and both sheets to keep the hero the
  largest photo but **at most 2× the smallest** ("100% bigger" and no more).
- Space is still maximized under that cap: the layout is chosen for the best fill (and a
  hero that clearly stands out from the next-biggest photo). Because a capped hero can't
  fill quite as much as a runaway one, the extra room is simply the decorative watercolor
  border showing through — which reads as intentional on this paper.
- Nothing is cropped: every cell, hero included, is still shaped to its own photo.

## 1.58.2 — 2026-08-28

**The sticker is now a 5th cell in the layout — never on top of a photo.**

- Instead of dropping the sticker onto the finished arrangement, the layout engine now
  packs it as one more item, so it gets its own slot beside the photos. The packer shapes
  every cell to its aspect ratio with a gutter between them, so the sticker covers **0% of
  any photo** in every design — no overlap math, no reserved band, nothing to tune.
- The sticker is **never the hero**: the "Big #N" designs only ever promote one of the four
  photos, and the sticker rides along as a small badge in whichever slot the packing gives
  it. The "Four equal" design lays all five out together.

## 1.58.1 — 2026-08-27

**The sticker no longer buries a small photo.**

- The watercolor layout now *reserves* a corner for the sticker instead of dropping it
  on top of the finished arrangement. The photos are fitted into a clear content rect
  that clears a band on the cheaper axis (a short strip on a tall page, a narrow one on
  a wide page), shrinking them only as far as it takes to keep the sticker over **no more
  than 10% of any single photo** — verified across every design (Big #1–4, Four equal)
  and every photo mix. Big photos already under the cap keep their full size; the sticker
  just kisses a corner.
- The sticker is a touch smaller (26% of the page width, was 32%), so it needs less room
  and the photos stay larger.

## 1.58.0 — 2026-08-27

**Event sticker on every print.**

- The "Building Forever Families 2026" sticker is now dropped onto each watercolor print
  — one per page, automatically placed in whichever corner overlaps the photos the
  least, so it sits mostly on the decorative border and only kisses a photo edge.

## 1.57.1 — 2026-08-27

**Fixed the coverflow jank the watercolor paper introduced.**

- The full-bleed paper made the speculative "warm" print render a heavy job that blocked
  the main thread ~350ms and stuttered the swipe. Two measured fixes: the warm render
  (only ever used for Save/Share to the phone) now runs at 300 DPI instead of 600 — the
  actual printer render stays full 600 DPI — and photographic pages encode straight to
  JPEG instead of first making a ~6.6MB PNG they threw away. The block dropped from
  ~350ms to ~60ms.

## 1.57.0 — 2026-08-27

**Watercolor photo frames.**

- New "Watercolor" look: the prints now sit on decorative watercolor paper (six hand-
  painted sheets — three portrait, three landscape), with the photos matted into the
  clear centre — rounded corners, a soft drop shadow and a bright colored border on
  each, like the layout mockups. It's the default look; swipe the coverflow to pick the
  hero arrangement and each card shows the paper behind it.
- Backgrounds live in `public/backgrounds/` and are drawn full-bleed behind the photos,
  crisp at print resolution.

## 1.56.7 — 2026-08-27

**The tick now flies out opposite the swipe.**

- Flipped the fly direction: swipe left and the tick shoots out the right of the button,
  swipe right and it goes left — then flies back when the deck settles.

## 1.56.6 — 2026-08-27

**The tick flies fully out on any swipe, and back when the coverflow finishes.**

- No longer proportional to speed: even a slight swipe latches the direction and shoots
  the tick all the way out of the button (clipped away), where it stays for the whole
  coverflow move — then it flies back to centre once the deck settles.

## 1.56.5 — 2026-08-27

**Only the tick flies now — and it's clipped to the button.**

- The gradient circle stays put; just the ✓ glyph flies in the swipe direction. The
  button is now a circular clip, so the tick slides out past its edge and vanishes
  (never shown outside the button), then flies back to centre as the deck settles.

## 1.56.4 — 2026-08-27

**The check button flies with the swipe, then flies home.**

- Reverted the colour fade — the gradient stays. Now as you swipe or fling the coverflow,
  the whole check button flies off in the direction of travel (further the faster you
  swipe, up to a limit), then springs back to centre as the deck settles.

## 1.56.3 — 2026-08-27

**While you swipe, the check goes bare; the colour eases back when you stop.**

- Dropped the stretch effect. Now while the coverflow is being swiped or gliding, the
  check's coloured gradient fades away, leaving just the plain tick — then the colour
  eases back in once the deck settles. Quick out, gradual in.

## 1.56.2 — 2026-08-27

**The stretch now follows the swipe direction.**

- It was leaning the wrong way (and just widening symmetrically). Now the check's trailing
  edge is pinned and the leading edge shoots out the way the deck is travelling — swipe
  left and the liquid streak reaches left, swipe right and it reaches right — so it clearly
  trails the swipe instead of stretching at random.

## 1.56.1 — 2026-08-27

**The fluid check stretches way further — into a thin liquid line at speed.**

- Cranked the swipe stretch: a moderate swipe flattens the check into a wide ellipse, a
  fast one pulls it into a thin liquid streak nearly the width of the screen, then it
  relaxes back through those shapes as the deck settles. The tick fades out as it thins
  so a squashed glyph never shows.

## 1.56.0 — 2026-08-27

**The check button is fluid — it leans and stretches with the deck.**

- As you swipe or fling the coverflow, the check/commit control now leans and stretches
  like jelly in the direction of travel — the metaball switches on so its edges go
  liquid — then springs back to rest once the deck settles. The lean tracks the deck's
  actual speed (finger drag and momentum glide alike), so a gentle swipe barely tilts it
  and a hard fling pulls it right over. Respects reduced-motion.

## 1.55.5 — 2026-08-27

**The split now settles smoothly into the rounded rectangle — no more snap.**

- Previously the goo filter switched off the instant the split ended, popping the
  buttons from the blobby capsule straight to the crisp rounded rect. Now the metaball
  blur is held full while the pills separate, then ramped down to ~0 as they settle, so
  the corners sharpen gradually into the rounded rectangle. The plain drop-shadow only
  takes over once the blur is already gone, so there's no visible jump. The reverse
  (merge) ramps the blur back up.

## 1.55.4 — 2026-08-27

**Rounded-rectangle buttons, and a gradient that actually drifts on iPhone.**

- The open Save/Print buttons are now rounded rectangles (corner radius 20), not full
  capsules. The closed check stays a true circle; the gooey morph in between is
  unchanged.
- The gradient drift is now driven by a `requestAnimationFrame` loop instead of SMIL.
  SMIL animation of a gradient inside a zero-size `<svg>` does not run in Safari, which
  is why it looked frozen on the phone; a JS loop updates it directly and works
  everywhere. It's throttled to ~20fps so the constant repaint stays light.

## 1.55.3 — 2026-08-27

**The goo gradient drifts again — like the primary CTA.**

- Kept the exact CSS colours, 115° angle, shape and black shadow from the last build,
  but the fill is living once more: each blob's gradient is drawn ~2.2× the box (like
  the CTA's `background-size: 220%`) and an `animateTransform` slowly pans it back and
  forth over 9s, so the violet→fuchsia→coral colours drift across the buttons the way
  the primary buttons do.

## 1.55.2 — 2026-08-27

**Goo buttons now match the old CSS version exactly — just without the cutoff.**

- Reverted the look changes from the SVG port: the drifting animation and the coloured
  glow are gone. The fill is the static `--grad` (115deg violet→fuchsia→coral) and the
  shadow is the plain `drop-shadow(0 8px 16px #0006)` again — pixel-for-pixel the CSS.
- To get the 115deg angle exactly right in SVG (a bounding-box gradient skews the angle
  by each shape's aspect ratio), the gradient endpoints are computed per shape, so the
  angle reads true on the wide pills and the square check circle alike.
- The split/merge animation and metaball are untouched, so it feels identical. Only the
  rendering path is SVG now, which is what keeps the top/bottom from being clipped.

## 1.55.1 — 2026-08-27

**Gave the goo buttons their life back.**

- Moving the goo to SVG (last build) fixed the cutoff but left the pills with a flat,
  static fill and a plain dark shadow — dull. Now the SVG gradient is animated: it
  slowly pans back and forth (via `animateTransform`), so the violet→fuchsia→coral
  colours drift across the buttons the way the original CTA gradient did.
- The shadow is now a tinted violet + coral glow instead of flat black, matching the
  CTA's coloured glow, so the buttons read vibrant and premium rather than muddy.

## 1.55.0 — 2026-08-27

**The gooey split's top/bottom cutoff is gone for good — rebuilt as native SVG.**

- The real cause was never the box size: Safari clips a CSS `url(#goo)` filter to the
  HTML element's own bounds and ignores the filter region, so the metaball was always
  sliced flat — no amount of head-room on the box or the blob layers could beat it.
- The goo is now a native inline `<svg>` with `overflow: visible`, and the metaball
  filter rides an SVG `<g>`. SVG filters honour their region and paint freely *outside*
  the element — so the liquid neck and the pills' rounded ends can spill past the box
  exactly as they need to. No more cutoff, on any browser.
- The blobs are `<rect>`s laid out in pixels to line up with the Save/Print labels; the
  split, merge, squash-and-stretch and save-only behaviours are all unchanged.

## 1.54.2 — 2026-08-27

**Actually fixed the gooey split's flat top and bottom (for real, on Safari).**

- The earlier "give the goo box more headroom" fixes couldn't work: the clip isn't at
  the goo box at all. When a blob animates, Safari puts it on its own layer and
  rasterises that layer to the *blob's own box* (72px) before the parent goo filter
  blurs it — so the blur was pre-sliced flat at the pill's edges no matter how big the
  surrounding box was.
- Each blob now fills the full-height goo box, with its visible pill drawn by a centred
  inner element. That gives the blob's layer ~60px of clear space above and below the
  pill, so the blur and the metaball's rounded ends render in full. No more flat tops
  and bottoms.

## 1.54.1 — 2026-08-27

**Fixed the pinch freezing for seconds.**

- Lifting the print to a full-screen layer (last build) left it painting a big soft
  drop-shadow *filter* over an unbounded, unclipped area every frame — and a
  `drop-shadow` filter re-traces and re-blurs the whole picture each time, which is
  brutally slow on iOS. Zooming in stalled for seconds.
- The shadow is now a plain `box-shadow` on the (rectangular) print — visually the
  same, but a cheap, GPU-composited primitive instead of a per-frame filter — and the
  float layer is clipped to the screen so a big zoom never paints off-screen. Pinch is
  smooth again.

## 1.54.0 — 2026-08-27

**Pinch-to-zoom now floats the photo above everything.**

- When you pinch a design in the coverflow, the print now lifts ABOVE all the app's
  UI — the check button, Replace, the queue widget — instead of being clipped by the
  coverflow's edges and slipping behind the controls. Zoom in as far as you like and
  the whole picture stays on top and fully visible.
- Under the hood, only the print itself is momentarily floated to a top-most,
  unclipped layer for the duration of the pinch; the frosted reflection stays put in
  its original spot on the glass, unchanged, and everything drops neatly back into
  place the instant you let go.

## 1.53.3 — 2026-08-26

**Really fixed the gooey cutoff (this time for Safari).**

- Safari clips an SVG filter's output to the filtered element's own box and ignores
  the filter-region attribute — so widening the region (last build) fixed Chrome
  but not the phone. Now the goo layer itself is 60px taller than the control at
  top and bottom, so the blur and squash-and-stretch always render inside its box.
  No more flat cutoff on iOS.

## 1.53.2 — 2026-08-26

**Fixed the flat cutoff on the gooey split.**

- The metaball goo was being clipped at the top and bottom by the SVG filter's
  default render region, flattening the blobs. Widened the filter region so the
  blur and squash-and-stretch have room — the blobs now stay fully rounded
  throughout the split.

## 1.53.1 — 2026-08-26

**Smaller check, queue widget in the corner.**

- Shrank the check button (and the Save/Print pills) by 10%.
- The minimized queue widget now floats in the lower-right corner of the screen
  instead of over the coverflow.

## 1.53.0 — 2026-08-26

**Save/Share opens the share sheet directly.**

- Tapping Save/Share now hands the photo straight to the OS share sheet (Save to
  Photos, Messages, Facebook, AirDrop… all live there). Removed the old
  "touch and hold to save" interstitial that used to appear first on phones.

## 1.52.0 — 2026-08-26

**Bigger check button, lifted over the coverflow reflection.**

- The check button (and the Save/Print pills it splits into) are larger, and the
  whole control now sits up over the coverflow's reflection instead of below it —
  a more prominent, thumb-friendly target.

## 1.51.2 — 2026-08-26

**Removed the header filmstrip.**

- Took out the little filmstrip under the title; the header is just the booth name
  and version now.

## 1.51.1 — 2026-08-26

**Labels ride with the buttons; Replace moved below.**

- The Save and Print labels no longer pop in at a fixed spot while the blobs move
  — each label now carries the exact same horizontal travel as its blob, fading in
  as the pill widens and fading out as it deflates, so it rides in and out with the
  button.
- Swapped the vertical order: the check / Save / Print control now sits above the
  Replace photos button.

## 1.51.0 — 2026-08-26

**Swiping to a new design gooey-merges Save/Print back into the check.**

- After you've split the check into Save and Print, swiping the coverflow to a
  different layout now plays the split in reverse: the two pills deflate to
  circles, slide together, the goo fuses them, and the check (✓) reappears — so
  you re-confirm the new design. (The earlier build just left the buttons open;
  now the reverse is a proper animation, and the open pose is still held by a
  plain rule so nothing snaps unexpectedly.)

## 1.50.5 — 2026-08-26

**Round check button, snappier split.**

- The resting check button is now a true circle (it was a squished-pill squircle).
- The gooey split no longer dawdles at the start — it kicks off promptly and runs
  a bit quicker, while still stretching the liquid neck and bouncing open.

## 1.50.4 — 2026-08-26

**The real cause of the intro freeze.**

- When the fourth photo landed, the booth kicked off a background full-quality
  (600 DPI) render of the print to have it ready for Save/Print — but it did so
  ~half a second in, right in the middle of the coverflow's intro sweep, so the
  heavy render blocked the screen just before the centre card snapped into place.
  That pre-render now waits until the coverflow is completely still (intro done,
  no swipe in progress), so the intro plays smoothly and the render happens only
  when you're idle.

## 1.50.3 — 2026-08-26

**Fixed the stutter when photos come in.**

- The gooey check button's metaball filter (a heavy full-screen blur) was left
  switched on the whole time — including the moment the four photos land and the
  design coverflow plays its intro sweep, which is exactly when the phone is
  busiest. It now switches on only for the ~1.2s of the actual split and drops to
  a cheap drop-shadow at rest, so selecting photos and the intro animation are
  smooth again. The split itself looks identical.

## 1.50.2 — 2026-08-26

**Rebuilt the gooey split so it reads as real slime.**

- The previous version squished the centre into a flat lens — not liquid. Now two
  round blobs pull apart as *round* blobs, and a strong metaball filter draws a
  genuine liquid neck between them that stretches thin and pinches off (slow ease-in
  so it lingers). The two halves then inflate from small round blobs into the full
  pills with an elastic squash-and-stretch bounce. Both halves share the gradient
  so the slime reads as one colour splitting in two.

## 1.50.1 — 2026-08-26

**A properly gooey split.**

- Reworked the check → Save/Print animation so it actually behaves like slime: the
  check blob stretches wide and thins into a liquid bar, a thread pinches off in
  the middle, and the two halves grow out of it from tiny droplets — overshooting
  and jiggling (squash-and-stretch) as they settle. Stronger metaball filter and
  a slower, keyframed sequence so the deformation reads.

## 1.50.0 — 2026-08-26

**The check button splits like gooey slime.**

- Tapping the check no longer just slides Save and Print apart — the button now
  swells into a fat blob and pulls into two, stretching a liquid neck that
  pinches off, like splitting slime. It's an SVG metaball (goo) filter behind the
  controls; the crisp check icon and the Save/Print labels ride on top, unblurred.
  Reduced-motion users get the buttons without the goo animation.

## 1.49.1 — 2026-08-26

**Quieter — no more pop-up chatter.**

- Removed the unsolicited toast pop-ups that appeared during the normal flow: the
  "Looking good — print it, or save it to your phone." message and the generic
  "Loading…" notice. Photos just appear. Genuine feedback stays — errors, the
  "a print holds 4" notice, and save confirmations only show when you act.

## 1.49.0 — 2026-08-26

**A check button that splits into Save and Print.**

- Save and Print no longer sit in a bar at the bottom. Instead, once your layout
  is chosen, a single gradient **check (✓) button** appears below the photo. Tap
  it and it splits open — **Save/Share** slides out to the left and **Print** to
  the right, both emerging from where the check was. Choosing a fresh set of
  photos resets it back to the check. (Save-only booths reveal just Save.)

## 1.48.0 — 2026-08-26

**Simpler action bar.**

- Removed the Facebook button. The action bar is now just Save and Print, and
  the Save button is relabeled **Save/Share** (the OS share sheet, reachable from
  the save screen, already covers Facebook and everywhere else). Print gets the
  freed width.

## 1.47.0 — 2026-08-26

**Less bottom-heavy — the design coverflow sits lower, in easy thumb reach.**

- Step 3 is now a single slim line ("Step 3 · Print or save your photo") instead
  of a tall stacked block, and the version number moved up next to the title,
  freeing space at the bottom.
- The layout now flexes to fill the screen, and the design cards drop into the
  lower-middle of the viewport (a comfortable swipe zone) instead of being pinned
  high — with a shorter reflection below. It adapts to both tall and short
  screens without the steps ever colliding with the action bar.

## 1.46.1 — 2026-08-26

**The filmstrip stays throughout.**

- The header filmstrip now stays on every screen instead of only the welcome
  screen. On the busier picking/arranging screens it shrinks to a slimmer band
  so the steps still clear the action bar. (Placeholder for now — easy to swap
  for real content later.)

## 1.46.0 — 2026-08-26

**A little filmstrip in the header, and clearer step progress.**

- Added a small decorative filmstrip under the title on the welcome screen — a
  wink at what the booth makes, filling the space the tagline left. It shows only
  on the opening screen (the rest of the flow already fills the header).
- The three step "dots" now read as a segmented progress bar that fills
  left→right as you advance (step 1 → one bar, step 2 → two, step 3 → all three),
  instead of looking like swipeable page dots.

## 1.45.2 — 2026-08-26

**Removed the header tagline.**

- Deleted the subtitle line under the title entirely — the Step 1 guide already
  tells the guest what to do, so the header is just the booth name now.

## 1.45.1 — 2026-08-26

**Tagline tweak.**

- The header line changed from "Pick 4 photos. Take it home." (now redundant
  with Step 1) to **"Make a strip. Take it home."**

## 1.45.0 — 2026-08-26

**Friendly step-by-step guidance.**

- A little "Step N of 3" guide now follows the guest through the flow:
  **Step 1 — Choose or take your 4 photos** on the welcome screen beside the
  button; **Step 2 — Swipe to choose your favourite layout** above the design
  coverflow; **Step 3 — Print or save your photo** just above the action bar.
  Each shows a three-dot progress indicator. The coverflow was trimmed a touch
  so all three fit comfortably above the sticky buttons.

## 1.44.0 — 2026-08-26

**A clean opening screen — just one button.**

- On load the app now shows only the pick button, centred. The placeholder
  photo grid (the numbered 1–4 cells) and the bottom action bar (Save / Facebook
  / Print) are hidden until there's something to act on — they return the moment
  a photo is added. The button reads **"Take or Choose 4 Photos"**.

## 1.43.1 — 2026-08-26

**A darker, more neutral app background.**

- Swapped the dark-violet background (and its violet top glow) for a deep,
  near-black neutral. The cards, reflections, and the new gradient Print button
  stand out more against it. Panels, borders, overlays, the PWA theme colour and
  the status-bar tint were all shifted to match.

## 1.43.0 — 2026-08-26

**A modern gradient on the primary buttons.**

- The flat pink Print / Pick button is now a living multi-colour gradient —
  violet → fuchsia → coral — that slowly drifts, with white text and a colour-
  matched glow. (Reduced-motion users get the same gradient, held still.)

## 1.42.0 — 2026-08-26

**Cleaner design-picker screen and a clearer "Replace photos" button.**

- Removed the design-name line under the coverflow (e.g. "Big #3 · on top") — it
  overlapped the "Looking good" toast and added noise.
- Renamed "Swap all 4 photos" to **Replace photos**, and redesigned it: it's now
  a bright, frosted centred pill (with a ↻ icon) that clearly stands out from the
  dark stage instead of blending in, and it sits well clear of the sticky action
  bar so the Print button never crowds or covers it. The coverflow is slightly
  shorter to guarantee that spacing on smaller screens.

## 1.41.1 — 2026-08-26

**The floating queue widget is now a round, light bubble.**

- Reshaped from a dark card to a bright circular badge that stands out against
  the stage instead of blending in. It shows an icon, your place in line
  ("#2 in line"), and the ETA below it ("2 min"), and now sits in the coverflow
  reflection area on the right rather than centred over the action bar. Still
  bobs gently and reopens the full status when tapped.

## 1.41.0 — 2026-08-26

**The minimized queue is now a floating widget.**

- Tapping Done while your print is still in line no longer collapses it to a
  small pill. Instead it becomes a larger floating card — a receipt icon, your
  place in line ("#2 in line" / "You're next"), and the ETA ("Ready in about
  1 min") on its own line — that gently bobs above the action bar so it's easy
  to spot. It still updates live and reopens the full status when tapped.
  (Reduced-motion users get the same card without the bob.)

## 1.40.3 — 2026-08-26

**Fix: the Print button no longer stretches tall.**

- The v1.40.0 rewrite set the Save button's label to "Save to phone"
  unconditionally. Beside Print it lives in a narrow fixed-width slot, so that
  label wrapped onto three lines — and because the action bar is a flex row that
  stretches its buttons to match the tallest one, the Print button grew tall to
  match. The label beside Print is now just "Save" (the full "Save to phone" is
  only used when it's the sole, full-width button), and the action-bar buttons no
  longer wrap. All three buttons are back to equal height.

## 1.40.2 — 2026-08-26

**The whole post-print flow is one continuous popup.**

- The queue screen ("You're number X in the queue") now shares the same canvas as
  the sending and printing animations — no jump when you go from "Sending" to
  waiting in line. Your print is shown held above the printer with a faint stack
  behind it for the number of prints ahead of you; when it's your turn it feeds
  straight out. Sending → in-queue → printing → done all flow in one modal, only
  the wording changing.

## 1.40.1 — 2026-08-26

**One continuous animation from "Sending" through "Printing".**

- The transmit animation and the "Printing now" screen are now one unbroken beat in
  the same popup — no flicker where one screen vanished before the next appeared.
  The bits finish streaming in, then the printer glides to the centre and feeds the
  actual print out (with a green print-head edge); only the wording changes from
  "Sending…" to "Printing now!" to "All done!".

## 1.40.0 — 2026-08-26

**Self-healing booth, and a Matrix-style transmit animation.**

- **The booth restarts itself.** `npm start` now runs a small supervisor that
  relaunches the server if it ever exits, so an unattended party booth comes back
  on its own instead of sitting dead. (`npm start -- --tunnel=tailscale` works
  exactly as before; args pass straight through. `npm run start:once` runs it
  unsupervised.)
- **No more "running but serving nothing."** A fatal error used to be swallowed,
  leaving a process that looked alive but served a blank page. It now logs the
  error and exits so the supervisor brings up a clean one immediately. (Isolated
  promise rejections are still shrugged off, as before.)
- **The guest page reconnects on its own.** If it can't reach the booth (a
  restart, a dropped tunnel) it shows "Reconnecting to the booth…" and keeps
  retrying, then turns printing back on the moment the booth answers — no manual
  refresh.
- **Transmit animation:** the photo now disintegrates from the **bottom up**, and
  the bits are **Matrix green** streaming into the printer's green-lit slot.

## 1.39.1 — 2026-08-25

**Show the actual photo disintegrating, top to bottom.**

- The transmit animation now draws your real print and sweeps a glowing scan line
  down it: above the line the photo has turned into streaming 1s and 0s heading
  for the printer, below the line it's still the photo. So you watch the picture
  itself dissolve into data from the top down, rather than just seeing loose bits.

## 1.39.0 — 2026-08-25

**A "transmitting" animation while your photo is sent.**

- Tap Print and, while the photo uploads to the booth, it now dissolves into a
  stream of glowing 1s and 0s that fly down into a little printer — which lights
  up green and feeds paper as it receives them. A playful "beaming it over" beat
  that fills the send. It ends the moment the booth has the print and hands off to
  the live queue / "Printing now" screen.
- Respects reduced-motion (stays still, with the upload % as text), and is drawn
  on a canvas so it costs nothing when not sending.

## 1.38.1 — 2026-08-25

**Fix: landscape prints came out sideways.**

- The printer's only borderless size is portrait 4×6 (`4x6.Fullbleed`; there's no
  landscape variant), so a landscape design was being placed upright on a portrait
  sheet and printed sideways. The print now rotates a landscape composition 90° to
  fill the portrait sheet — so it comes out correctly (turn the print to view it
  landscape). The saved-to-phone image is untouched and keeps its true landscape
  orientation.

## 1.38.0 — 2026-08-25

**Done keeps your photos, and minimises the queue instead of closing it.**

- Tapping Done after a finished print no longer wipes the screen — your photos and
  chosen design stay put, so you can print again or tweak without starting over.
  (Use "Swap all 4 photos" for a fresh set.)
- While a print is still in the queue or printing, Done now collapses the modal to
  a small status pill ("🧾 #2 in line · about a minute") pinned above the bottom
  bar, so you can keep browsing and still watch your place. Tap the pill to reopen
  the full view; it updates live and turns into "🎉 Printed!" when it's ready.

## 1.37.0 — 2026-08-25

**Borderless that actually works — plus photo-paper mode.**

- The booth now auto-selects the printer's own borderless page size. When
  borderless is on, it reads the printer's sizes and maps the 4×6 you're printing
  to its full-bleed variant (e.g. Canon's `4x6.Fullbleed`), matched by dimensions
  regardless of orientation. No dropdown fiddling — the default config prints
  borderless 4×6 on its own.
- Prints now go out in **photo-paper mode** (`MediaType=photographic`) at **High**
  quality. Without this a photo prints in plain-paper mode, which is a big part of
  the grainy/washed look — this is a quality fix as much as a borderless one.
- Still sends the zero-margin borderless request too, so driverless/AirPrint
  queues are covered as well as PPD drivers.

## 1.36.1 — 2026-08-25

**Borderless via zero media margins (works on AirPrint/driverless queues).**

- `print-scaling=fill` alone doesn't drop a printer's hardware margins. Borderless
  now also sends zero IPP media margins (`media-left/right/top/bottom-margin=0`),
  which is how driverless / AirPrint queues — the usual setup for a Canon on
  macOS — are told to print edge-to-edge. Classic PPD drivers ignore the margins
  and use the borderless page size instead, so both kinds of queue are covered.

## 1.36.0 — 2026-08-25

**Sharper prints: render at 600 DPI, not 300.**

- Prints and phone-saves are now composed at 600 DPI (2400×3600 for a 4×6)
  instead of 300 (1200×1800) — four times the pixels. At 300 DPI a capable photo
  printer has to upscale a single hero photo, which reads soft and grainy on
  paper; 600 DPI hands it real detail. (The on-screen preview is unaffected — it
  renders at its own smaller size, so the app doesn't get heavier.)
- Raised the imported-photo ceiling to 3600 px so a full-page photo actually has
  the detail to fill a cell at the higher resolution, and nudged the print JPEG
  fallback to 0.95. A 600 DPI 4×6 lands around 1.5 MB — still a quick upload.
- The Facebook share stays web-sized (1200 px) on purpose — small and fast for
  posting.

## 1.35.2 — 2026-08-25

**Borderless for real: pick the printer's own borderless size.**

- `print-scaling=fill` alone doesn't drop a printer's hardware margins — borderless
  needs a full-bleed *page size*, and its name differs by driver. The host's Paper
  dropdown now lists the sizes the selected printer actually reports (read from
  `lpoptions`), with borderless variants flagged " — borderless". Pick the
  borderless 4×6 your printer offers (e.g. `4x6.FullBleed`) and, with the
  Borderless toggle on, prints go edge-to-edge.
- When a saved size is no longer offered, the host auto-selects a borderless 4×6
  if the driver has one. Dry-run/relay booths keep the built-in size list.

## 1.35.1 — 2026-08-25

**Keep the booth up: a stray error can't take the guest app offline.**

- The queue's "release the next print" step was fire-and-forget; if it ever
  rejected (a flaky `lpstat`, a printer vanishing mid-job), Node's default is to
  crash the process — which would take the whole guest app offline until someone
  restarted the booth. It's now caught and logged.
- Added process-level guards (`unhandledRejection` / `uncaughtException`) so any
  stray error is logged and the booth keeps serving, rather than exiting
  mid-party.

## 1.35.0 — 2026-08-25

**Borderless 4×6 — on by default.**

- Prints now go out borderless: the sheet is filled edge-to-edge with no white
  margin, using CUPS' standard `print-scaling=fill`. It's the default, and there's
  a **Borderless** toggle on the host screen to turn it off.
- When borderless is off, the old "scale to fit" behaviour (shrink into the
  printable area, leaving a border) applies as before. Borderless takes
  precedence over fit-to-page when both are on.
- Applies in both booth and relay (agent) printing.

## 1.34.0 — 2026-08-25

**A real print queue, held by the server — one job at a time.**

- The booth no longer dumps every print straight into CUPS. Jobs now wait in the
  server as `pending` and are dispatched to the printer **one at a time**; the
  next is released only once the printer reports the current job actually
  finished. So a guest's "You're number X in the queue" is now the *real*
  position — the job at #1 is genuinely on the printer — not an estimate from the
  time since the last print.
- The server detects completion for real by polling CUPS (`lpstat -o`): when the
  current job leaves the active list, it's done and the next goes out. A stuck job
  is force-completed after 5 minutes so the line never wedges.
- ETAs are learned: the booth measures how long real prints take and averages
  them, so the "ready in about Y" estimate tracks this printer's actual speed
  (seeded at 30s). The guest screen updates live — position from the real queue,
  countdown every second — and flips to "Printing now!" the moment the job
  reaches the printer, then "All done!" when it finishes.
- Only ever one job sits in CUPS, so a paper jam or pause no longer strands a
  pile of jobs in the printer's own spool — and the "couldn't queue while busy"
  class of failure is gone entirely.

## 1.33.2 — 2026-08-25

**Fix: couldn't queue a job while the printer was busy ("unknown printer").**

- The booth reads the printer list from `lpstat -p`, but its parser only matched
  the idle form (`printer X is idle.`). While a job was printing, CUPS reports
  `printer X now printing X-42.` — which didn't match, so the printer vanished
  from the list and the next print was rejected as `Unknown printer "…"`. That
  made it impossible to line a job up behind one already printing.
- The parser now recognises the printer name in every state — idle, now printing,
  processing, disabled, stopped — so prints queue normally while another is in
  progress (which is exactly what the queue-position display expects).

## 1.33.1 — 2026-08-25

**Don't cry "failed" on a slow printer that actually took the job.**

- A print was marked failed whenever `lp` didn't return within 10 seconds. On the
  first job after a photo printer wakes from idle, `lp` can block longer than that
  while the USB backend spins the printer up — so the booth reported a failure for
  a job CUPS had already queued (and often printed). Printing now gets its own 60s
  window, separate from the quick status queries, so a slow-but-successful submit
  isn't killed early.
- If a submit really does time out, the guest is told it may still print ("check
  the tray") instead of a flat failure, and the booth now logs every print
  outcome (queued with its CUPS id, or the real error) so failures are
  diagnosable on the host.

## 1.33.0 — 2026-08-25

**Live queue position after you print.**

- Tap Print and the booth now tells you where you stand: "You're number X in the
  queue. Your print will be ready in about Y." Both the position and the ETA
  update live — the countdown ticks down every second, and the position refreshes
  from the booth as prints ahead of you finish — until it's your turn, when it
  hands off to the usual "Printing now!" screen.
- The booth models the printer as one print at a time, ~30 seconds each (a single
  `PRINT_MS` knob), and reports each job's place in line and finish time on
  `/api/job` and `/api/queue` — so the number you see reflects the real queue on
  the host, not a guess on the phone.

## 1.32.11 — 2026-08-25

**Simpler intro: one swipe to the centre.**

- The intro no longer sweeps all the way to the rightmost design and bounces
  back. It now does a single coverflow swipe in from the right and eases to a
  settle on the middle design — shorter and calmer.

## 1.32.10 — 2026-08-25

**Tap a side picture to bring it to the centre.**

- Tapping a side design now swipes it into the centre, not just dragging does.
  The tap already tried to, but it resolved the target from `event.target` —
  which the container's pointer-capture retargets away from the card, so it
  always fell back to the current centre and nothing moved. It now finds the
  tapped picture geometrically (the same hit-test the swipe uses), so any
  visible card centres on tap.

## 1.32.9 — 2026-08-25

**Render the frosted reflection at half resolution — pay for the retina bump.**

- The full-resolution retina render (v1.32.8) doubled canvas memory. The
  reflection, though, is blurred and faded to 22%, so it never needed the face's
  resolution — it now renders at half density, invisible behind the blur. That
  more than offsets the sharpness bump: canvas memory on a 3× phone drops from
  ~13 MB back to ~8 MB (the old soft version was ~6 MB), and the card-build stays
  a quick one-off. The animation and pinch were never affected — they only move
  CSS transforms, they don't repaint the canvases.

## 1.32.8 — 2026-08-25

**Sharp coverflow on retina phones — no more soft preview.**

- The on-screen canvases (coverflow cards, the single preview, the crop editor)
  were rendered at a fixed 2× pixel density, but modern phones are 3×. On those
  screens the browser was upscaling a 2×-density bitmap to fill a 3× display, so
  the picture looked soft the moment the photos were chosen — before any pinch.
  Raised the render density cap to the screen's true value (up to 3×), so the
  deck is crisp at rest. Measured: the centre card now renders at 100% of screen
  resolution instead of 67%.
- **Print output was never affected** by this — the print is a separate
  full-resolution 300 DPI render, independent of the on-screen density. This
  change is display-only.

## 1.32.7 — 2026-08-25

**Killed the pause at the far end of the intro.**

- The sweep used an ease-out into the rightmost, which decelerated to a near
  standstill at the edge — a visible hang before the slingshot back. The sweep
  now keeps its momentum all the way to the edge (a power ease that's still
  moving at the end) and reverses on contact, so it flows straight back to the
  middle with no dwell.

## 1.32.6 — 2026-08-25

**Removed the "Pinch to zoom" hint line under the coverflow.**

- Dropped the instructional caption ("Pinch to zoom in on the print · drag to
  move · twist to rotate") from beneath the design picker, along with its markup
  and styles.

## 1.32.5 — 2026-08-25

**Pinch zooms out, too — not just in.**

- The pinch peek used to clamp at the print's resting size, so you could only
  make it bigger. It now lets you pinch down to half size as well, then springs
  back to rest on release like always. (No lift shadow when shrunk — a print
  smaller than its resting size sits flat, so the shadow stays at rest.)

## 1.32.4 — 2026-08-25

**The intro bounces off the end instead of pausing there.**

- The intro no longer holds a beat at the rightmost design. It now overshoots
  the edge with the same iOS-style elastic give as an end-of-list bounce and
  slingshots straight back to the middle in one continuous motion — no stop at
  the end.

## 1.32.3 — 2026-08-25

**The intro is a real coverflow swipe, not a flat slide.**

- The entrance animation now drives the coverflow position itself, so every card
  rotates and scales as it passes through the centre — exactly as if a user
  swiped the deck hard — instead of the whole strip sliding across as one flat
  block. It still starts off the right edge, whips through to the rightmost
  design, holds a beat, then swings back to settle on the middle.

## 1.32.2 — 2026-08-25

**Swipe only from the pictures — never from the reflection or the margins.**

- Removing the earlier target guard (to fix side-swipe) had let a swipe start
  anywhere, including the reflection. Replaced it with a geometric hit-test: a
  swipe engages only when the touch lands inside a visible card's box (any
  picture, centre or side), so touches on the reflection (below the box) or the
  empty margins fall through to the page and scroll. A second finger may still
  land anywhere, so a pinch that began on a picture keeps working.

## 1.32.1 — 2026-08-25

**Intro plays on every completion and slides in from off-screen.**

- The intro sweep now runs every time the photos are completed (initial pick and
  "Swap all 4 photos"), not just the first time.
- The deck now starts fully off the right edge of the screen and slides in until
  the rightmost design is centred, holds a beat, then settles on the middle — so
  the cards visibly enter from outside the viewport.

## 1.32.0 — 2026-08-25

**Intro sweep when the designs first appear.**

- The first time the coverflow shows, it now animates: the deck slides
  right-to-left until the rightmost design is centred, holds a beat, then slides
  back to settle on the middle design — a quick showcase of the picker. It plays
  once, and any touch cancels it and hands control straight to you.

## 1.31.7 — 2026-08-25

**Reflection sits behind the print, never over it.**

- When a pinch made the print and its reflection overlap, the reflection painted
  on top of the picture. Gave the reflection a negative z-index within the card,
  so it always renders behind the print — the picture cleanly covers it in the
  overlap.

## 1.31.6 — 2026-08-25

**Preview auto-loads test photos; punchier shadow; side-swipe really fixed.**

- The GitHub Pages preview now drops four placeholder photos (varied aspect
  ratios) into the picker on load, so testing lands straight on the coverflow —
  no picking each launch. "Swap all 4 photos" still lets you choose your own. The
  shareable claude.ai artifact does not do this.
- The pinch shadow is now two stacked layers — a tight near-black core for a hard
  edge plus a big soft halo — so it reads much more dramatically (still zero at
  rest, still size-tracked and fading on release).
- Side-swipe fix, take two: the deck now engages for any touch and lets
  `touch-action` alone decide scroll vs. gesture (cards are locked, the container
  is pan-y). So a swipe starting on any picture works, while a vertical drag over
  the reflection or margins still scrolls the page.

## 1.31.5 — 2026-08-25

**Bolder lift shadow; swipe works from the side pictures again.**

- The size-relative shadow now ramps up fast off zero (a sqrt curve) so it is
  already bold at a small pinch — much more visible — while still vanishing at
  rest and fading with the print on release. Screen-space: 0→92 px offset,
  0→120 px blur, 0→0.95 opacity, front-loaded across the zoom.
- Fixed a swipe regression from the scroll change: a swipe that started on a side
  picture did nothing, because cards past the nearest neighbour had
  pointer-events off. Every VISIBLE card now takes touches, so a swipe can start
  on any side picture; only the hidden off-stage cards ignore them, leaving the
  empty margins and the reflection free to scroll.

## 1.31.4 — 2026-08-25

**The lift shadow tracks the print's size and fades out smoothly.**

- The pinch shadow is now zero at rest and grows straight from the print's size,
  so it no longer popped off when the print snapped back. On release the paper,
  its reflection, and the shadow spring back together in one JS animation, with
  the shadow tracking the actual size the whole way down and reaching nothing
  exactly as the print lands. Screen-space values scale 0→96 px offset, 0→166 px
  blur, 0→0.90 opacity across the zoom range.

## 1.31.3 — 2026-08-25

**A bigger, darker lift shadow on the pinched print.**

- Increased the pinch-zoom shadow's offset, blur, and opacity so it reads much
  more clearly. Screen-space values (in `paperShadow()`): offset 12→96 px, blur
  26→166 px, opacity 0.55→0.90 from rest to full zoom.

## 1.31.2 — 2026-08-25

**Vertical scroll is only blocked over the pictures.**

- The coverflow used to swallow vertical page scroll across its whole area. Now
  only the picture cards lock scrolling (so a swipe or pinch on a print still
  works); touching the reflection area or the empty margins scrolls the page as
  normal. The gesture handler ignores touches that don't start on a picture, and
  `touch-action` is `pan-y` on the container, `none` on the cards.

## 1.31.1 — 2026-08-25

**Pinch: the reflection now behaves like a real mirror on the glass.**

- Zooming the print no longer drags its reflection along rigidly. The reflection
  stays on the glass and shows the mirror image of the transformed print — same
  horizontal move and scale, but the vertical move and rotation are negated. So
  lifting the print makes its reflection recede (a gap opens), and tilting it
  tilts the reflection the opposite way, exactly as glass would. Verified the
  reflection transform is the mirror of the paper's (tx same, ty negated, rot
  negated, scale same).

## 1.31.0 — 2026-08-25

**Roll back to any version by putting it in the URL.**

- The GitHub Pages preview now publishes a self-contained snapshot of every
  release under its own slug — open `…/bff-photo-booth/1.29.0/` (or any version)
  to preview that exact build, with the root staying the latest. A versions index
  at `/versions.html` lists them all.
- `npm run preview` now builds the whole site: the latest at the root, a snapshot
  per version (backfilled once from each release's commit — 57 versions back to
  1.0.0), and the index. The build core moved to `scripts/lib-build.mjs`, shared
  by `build-preview.mjs` (working tree, artifact `--body`) and the new
  `scripts/build-site.mjs`. Any static host of the repo gets the same versioned
  URLs; the claude.ai artifact stays a single latest page.

## 1.30.4 — 2026-08-25

**Fix: pinch-zoom no longer drops the reflection or the deck's edges.**

- While pinching, the reflection now stays and zooms with the print (the mirror
  moved inside the zoomed "paper"), instead of vanishing. And the coverflow keeps
  its overflow clipping, so the clean left/right edges of the deck no longer
  disappear during a pinch. The lift shadow now rides the print face alone, so it
  never darkens the reflection.

## 1.30.3 — 2026-08-25

**Pinch-zoom the print and it casts a lifting shadow.**

- As you pinch the paper larger, it now drops a shadow that grows, softens, and
  fades the further it rises from its resting spot in the deck — the way a real
  object's shadow spreads as it moves off the surface. At rest the shadow is
  small and tight; zoomed in it is large and diffuse. It eases away when the
  paper springs back.

## 1.30.2 — 2026-08-25

**Coverflow bounces at the ends, like an iOS list.**

- Dragging past the first or last design now rubber-bands — it follows your
  finger with easing resistance that gives less the further you pull — and
  springs back to the edge when you let go. A hard flick into an end bounces off
  it instead of dead-stopping. The settle between cards is unchanged (still no
  bounce there).

## 1.30.1 — 2026-08-25

**The Pages preview shows the real version number.**

- The preview footer read "vpreview"; the build now injects the actual
  `package.json` version into the offline session shim, so the live preview
  shows the version it was built from (e.g. `v1.30.1`).

## 1.30.0 — 2026-08-25

**Pinch zooms the whole print, to look at it up close.**

- Put two fingers on the centred design and pinch to zoom in on the print (the
  "paper"), drag to move it, twist to rotate — so you can inspect the finished
  result. It is a view only: the print itself is unchanged, and it springs back
  to size when you lift your fingers. One finger still swipes to browse designs.
- This replaces the earlier per-photo pinch (which cropped an individual photo);
  the gesture now acts on the whole paper, as intended.

## 1.29.1 — 2026-08-25

**Fix: the Pages preview showed the README, not the app.**

- GitHub Pages was set to "Deploy from a branch", so its built-in Jekyll build
  rendered README.md as the site and raced (and beat) the custom deploy workflow.
  Fixed by serving the built app as a committed `index.html` at the repo root
  with a `.nojekyll` marker — an index page always wins over the README, and
  `.nojekyll` stops Jekyll from touching anything. Retired the custom Pages
  workflow so there is one deterministic deployer. Regenerate the page with
  `npm run preview` when the guest app changes.

## 1.29.0 — 2026-08-25

**Pinch, drag, and twist a photo to adjust it — right on the design.**

- Put two fingers on any photo in the centred design and manipulate it directly:
  pinch to zoom, drag to move, twist to rotate. It updates live, and because a
  photo is shared across the designs, the change follows it everywhere. One
  finger still swipes to browse designs, so the two gestures never clash, and it
  only ever moves the photo — never the page.
- The renderer now keeps a photo covering its cell at *any* rotation, so a tilted
  crop never leaves a blank corner. Pan is clamped in the photo's own rotated
  frame, so the reachable range is correct at every angle. Verified across
  thousands of angle/zoom/pan combinations. At the default (no zoom, no rotate) a
  photo still fills its aspect-shaped cell exactly — nothing crops until you ask.

## 1.28.0 — 2026-08-25

**Live guest-app preview on GitHub Pages — see the latest, no terminal.**

- A GitHub Actions workflow builds a single self-contained HTML preview of the
  guest app from the latest source on every push and publishes it to GitHub
  Pages. Open the newest guest experience — pick photos, the coverflow of
  designs, the reflections, save/share — from any phone at a stable URL, with no
  `npm start`, no booth, and nothing to install.

      https://eljon.github.io/bff-photo-booth/

- `scripts/build-preview.mjs` inlines the guest CSS and the four ES modules into
  one page and shims `/api/*` so it runs offline in save/share mode (printing
  needs the booth Mac). `npm run preview` builds it locally into `_site/`.
  Pass `--body` for the claude.ai artifact variant.

## 1.27.0 — 2026-08-25

**Guest-only booth: `npm run guest`, self-updating, optional host printing.**

- New `npm run guest` runs just the guest app on a machine that is not the
  printer, and updates to the latest code first — so you launch the newest guest
  app without running `git pull` yourself. The update is best-effort: offline, a
  dirty tree, or no upstream just starts what is on disk (a party is never
  blocked). `GUEST_NO_UPDATE=1` skips it.

  ```bash
  caffeinate -dims npm run guest -- --tunnel=tailscale
  ```

- Guest-only mode (`--guest-only` / `GUEST_ONLY=1`) serves the guest app only:
  no host screen (`/host` is gone), host-control APIs return 404, and it never
  opens a control window. Extra flags like `--tunnel=tailscale` pass through.

- By itself a guest-only booth has no printer, so guests save/share to their
  phones. Point it at a real booth with `--print-host=<url>` and it transparently
  forwards the print, the printer list, the job status, and the finished image to
  that booth — guests print for real, no CORS and nothing extra to deploy. If the
  host is unreachable, guests just save to their phones and nothing errors out.

## 1.26.5 — 2026-08-25

**Coverflow reflections now read as frosted glass, not a glossy mirror.**

- The reflection was a crisp mirror (`-webkit-box-reflect`), which can't be
  blurred — so it always looked glossy. Replaced it with a real reflection
  element: a vertically-flipped copy of each card sitting just below it, blurred
  (3.5px), faint (22% opacity), and masked to fade out within ~38% of the card
  height. The result is a soft, short, diffused haze — a frosted-glass surface
  instead of a hard mirror. It is a child of the card, so it still tilts and
  recedes in 3D, and it never intercepts taps.

## 1.26.4 — 2026-08-25

**Bring back the welcome line and the design label.**

- Restored the welcome tagline under the booth name ("Pick 4 photos. Take it
  home.", or the booth's configured message) and the "Big #x · … · n / 5" label
  under the coverflow, both dropped in 1.25.0/1.25.1. The label updates as you
  swipe between designs.

## 1.26.3 — 2026-08-25

**Coverflow: every card sits on the same glass line, whatever its shape.**

- A landscape card is shorter than a portrait one, and each card was anchored by
  a fraction of its own height around its centre — so a landscape card's bottom
  edge landed higher than a portrait card's, and its reflection floated up with
  it, breaking the "all resting on one sheet of glass" illusion. Now every card
  is anchored by its bottom edge to a single baseline (`top: 68%` +
  `translateY(-100%)`), and scale/rotate pivot about that bottom edge
  (`transform-origin: 50% 100%`), so a card's bottom stays pinned to the glass as
  it shrinks and tilts. The centred card's bottom is identical whether it is
  portrait or landscape; reflections all begin from the same line.

## 1.26.2 — 2026-08-25

**Coverflow: the reflection now touches the card — cards sit on the glass.**

- The mirror had a gap under each card, so the cards looked to float above the
  glass instead of resting on it. Two causes, both fixed: the card's drop shadow
  sat under the card and darkened the top of the mirror into a fake gap (removed
  it — the reflection itself grounds the card), and the `-webkit-box-reflect`
  fade gradient was mapping upside-down, pushing its opaque part away from the
  card and leaving the near edge transparent. Flipped the gradient (opaque at the
  bottom) and set the reflection offset to 0 so the mirror meets the card's bottom
  edge exactly. Verified in both portrait and landscape.

## 1.26.1 — 2026-08-25

**Coverflow: narrower landscape card so its side photos show.**

- A landscape (6×4) centre card was wide enough to hide its neighbours. Tightened
  the width cap (boxW 0.66→0.55 of the screen, cap 340→300) so a landscape design
  is narrower and the cards beside it are clearly visible. Portrait is unchanged
  (it is limited by height, not width).

## 1.26.0 — 2026-08-25

**Coverflow reflections — the cards slide on dark glossy glass.**

- Each card now casts a faded mirror reflection below it (`-webkit-box-reflect`),
  so the deck looks like it glides across a glossy black surface — the classic
  Cover Flow look. The reflection tilts and recedes in 3D along with its card.
- Made room for the mirror: the cards sit a little higher and a touch smaller so
  the reflections aren't clipped, and the deck is taller to hold them.

## 1.25.2 — 2026-08-25

**Coverflow: scale the centre card back so the side photos show.**

- The enlarged centre card had grown wide enough to hide its neighbours. Trimmed
  the fit box (0.56h/0.88w → 0.46h/0.72w) and pushed the neighbours further out
  (spacing 0.34→0.42 of the deck width), so the side designs clearly peek beside
  the centre one again while it stays the focus.

## 1.25.1 — 2026-08-25

**Remove the design label line; photos a touch bigger.**

- Removed the "Big #x · … · n / 5" label under the deck. The coverflow grew into
  the reclaimed space, so portrait and landscape designs render a little larger still.

## 1.25.0 — 2026-08-25

**Bigger photos: stripped the chrome around the coverflow.**

- Removed the welcome tagline, the paper-size line ("4×6 portrait"), the
  "one tap opens your camera roll" hint, and the thumbnail editor row at the
  bottom — clearing the space around the photo.
- Enlarged the coverflow with that space so portrait and landscape designs both
  render noticeably bigger. "Swap all 4 photos" re-picks the set.

## 1.24.0 — 2026-08-25

**Coverflow: a smooth, cover-flow-style hand-off — no more pop.**

- Replaced the hard z-index swap (which flipped the front card in a single frame,
  a visible pop) with continuous 3D depth. As a card nears the centre it rises to
  the front gradually, and the two centre cards meet at a clean vertical spine
  where the hand-off happens edge-to-edge, like turning a page. The current photo
  leads until the spine; then the incoming one takes over smoothly.
- Trade-off worth knowing: a smooth hand-off happens where the cards meet (about
  mid-swipe), not at dead-centre — holding strictly until dead-centre is exactly
  what forced the hard pop.

## 1.23.2 — 2026-08-25

**Coverflow layering, actually fixed (the real cause).**

- The deck used a shared 3D context (`transform-style: preserve-3d` + a `translateZ`
  depth per card), and in that mode the browser stacks cards by 3D depth and
  **ignores z-index** — so the incoming card came forward at the halfway crossover
  no matter what, and every z-index tweak was cosmetic. Each card now carries its
  own `perspective()` (same tilt, no shared 3D space), so cards are flat layers and
  z-index alone decides what's in front. The current photo now genuinely stays on
  top until the incoming reaches the centre.

## 1.23.1 — 2026-08-25

**Coverflow: the front photo holds until the next is dead-centre.**

- Tightened the layer hand-off. The incoming card used to take the top layer at
  ~88% of the way in; now the current photo stays in front until the incoming is
  right at the centre (where the glide settles), so nothing pops forward early.

## 1.23.0 — 2026-08-25

**Facebook share goes to the Facebook app, not facebook.com.**

- The button now hands the photo to the installed Facebook app (where the guest
  is already signed in) through the phone's share sheet — tapping Facebook there
  opens the app's own post screen with the photo attached and `#bff2026`
  pre-filled. A website has no way to jump *straight* into the app's composer
  (Apple/Facebook don't expose one), so the share sheet is the door to the app.
- Reverted the previous facebook.com/sharer flow and removed the public share
  links it needed (`/api/share`, `/s/<id>`). Nothing is hosted publicly anymore.
- Desktop, where there's no app to share to, still falls back to Facebook's web
  share for the booth link.

## 1.22.1 — 2026-08-25

**Coverflow layering, properly fixed.**

- Cards are now fully opaque — no see-through — so the top card cleanly covers
  the ones behind it and it is obvious which photo is in front.
- The top layer is derived from position (the last card to reach the centre) and
  held until the next card is almost centred, so it can't be knocked to the wrong
  card. A stray `resize` mid-swipe no longer rebuilds the deck and reshuffles the
  layering — rebuilds are skipped while a swipe or glide is in flight.

## 1.22.0 — 2026-08-25

**Facebook: straight to the share dialog, no OS share sheet.**

- The Facebook button now goes directly to Facebook's share dialog — no native
  share sheet to open and no "select Facebook" step. The photo appears in the
  post preview and the caption is pre-filled to `#bff2026`; the guest can type
  their own words in front of the hashtag before posting.
- How it works: the booth briefly hosts the photo at a short-lived public link
  (`/s/<id>`, an Open Graph page so Facebook can render the preview; it expires
  after two hours and is capped in memory) and hands that link to Facebook. This
  is the only way to skip the OS share sheet and still keep the photo in the post
  — so Facebook sharing needs the booth reachable from the internet (the tunnel/
  public link, which is already how guests connect).

## 1.21.1 — 2026-08-25

**Coverflow: the centre photo stays on top through the swipe.**

- The card at centre keeps the top layer for the whole swipe and only hands it
  off once the next card snaps to centre. Previously the incoming card jumped in
  front at the halfway point — a visible pop mid-swipe.

## 1.21.0 — 2026-08-25

**Share on Facebook.**

- New Facebook button in the action bar. On a phone it opens the share sheet with
  the photo attached and the caption pre-filled to `#bff2026` — the guest can type
  their own words in front of the hashtag before posting.
- On desktop (no file sharing) it falls back to Facebook's web share dialog for
  the booth link with the `#bff2026` hashtag, and copies the caption to paste in.
- The hashtag defaults to `#bff2026` and can be overridden per booth with
  `shareHashtag` in the session config.

## 1.20.3 — 2026-08-25

**Fix: no more stutter mid-swipe on the coverflow.**

- The print was being pre-rendered (a heavy 300 DPI pass) as the centred design
  changed during a swipe, which briefly froze the main thread and made the deck
  hitch. That render is now held until the swipe settles, so swiping stays smooth.

## 1.20.2 — 2026-08-25

**Coverflow: small flicks are responsive now.**

- A flick is detected by release speed, not by how far the finger travelled, so a
  quick little flick reliably moves and snaps to the next design. A slow drag
  still settles to the nearest card, and pausing before lifting cancels the flick.

## 1.20.1 — 2026-08-25

**Coverflow polish: subtler settle, no card border.**

- Reduced the bounce — the glide now eases to its card monotonically (decelerates
  in, never overshoots), so it settles cleanly instead of springing back.
- Removed the card border entirely (the dark hairline ring and the matte frame).
  Each design is now just the photo with a soft drop shadow for depth.

## 1.20.0 — 2026-08-25

**Coverflow now flicks and glides like an iOS picker.**

- Removed the ‹ › arrows — the deck is driven entirely by touch now.
- Rewrote the motion as continuous, spring-based inertial scrolling. A release
  carries its momentum and settles onto a card, so even a light flick slides to
  the next design; a firmer flick carries up to two, with acceleration.
- Removed the pink outline on the centred card — the front-and-centre card (plus
  its label) is the selection.

## 1.19.2 — 2026-08-24

**Fix: swiping the coverflow no longer scrolls the page.**

- The coverflow now claims the whole touch gesture (`touch-action: none`), so a
  swipe to change designs never drags the page up or down underneath it.

## 1.19.1 — 2026-08-24

**Fix: preview cards now show the true 4×6 / 6×4 shape.**

- A `max-width` rule on the card canvas was clamping its width while leaving the
  height — squishing every preview toward square (a landscape 6×4 showed nearly
  square, a portrait 4×6 too narrow). Cards are now sized from a single scale
  that fits the stage while keeping the exact paper aspect, so a 4×6 looks 4×6
  and a 6×4 looks 6×4, and the centred card always fits on screen.

## 1.19.0 — 2026-08-24

**Every photo fills its own frame — no skew, no floating, true orientation.**

- Rewrote the layout engine. Instead of fitting photos into fixed cells (which
  left a landscape photo floating in a tall white cell), every cell is now shaped
  to its own photo's aspect ratio, so each photo fills its frame exactly — nothing
  is skewed, nothing floats in bars, and each photo keeps its real orientation.
- Photos are packed so they touch (just a uniform gutter between them), and the
  layout that fills the most paper wins — so the booth genuinely picks the best,
  least-empty design rather than one with scattered whitespace.
- Card previews now show the true sheet shape: a landscape design looks
  landscape, a portrait one portrait.
- Because photos are never cropped, the leftover slack is one thin, even border
  around the packed block (centred), not gaps between the photos. Filling that
  last border completely is only possible by cropping, which the booth doesn't do.

## 1.18.0 — 2026-08-24

**Swipe to choose your design — a coverflow of layouts.**

- Once all four photos are in, the preview becomes a swipeable coverflow of
  designs. Each photo can be the big hero (shown in the placement that fits it
  best — on top or on the side), and there is an even 2×2 with no hero at all.
- Swipe left/right, tap a side card, or use the ‹ › arrows. The chosen design is
  what saves and prints; the label shows which one you're on (e.g. "Big #2 · on
  top · 2 / 5") and the paper size for that design.
- Every design still fills the sheet edge to edge and crops nothing. Cards are
  only ever shown in their best arrangement, so none come out half-empty.
- "Swap all 4 photos" moved to its own button under the designs.

## 1.17.0 — 2026-08-24

**Uniform gutters, and the grid runs edge to edge.**

- The four photos now form one block that is flush to all four edges of the
  paper — no outer border — with an even gutter between every photo. The hero
  (photo 0) spans a full edge; the other three line up along the opposite side.
- Nothing is cropped: each photo fits inside its space, so a shape that doesn't
  match its cell gets a little matting rather than being cut. The booth tries
  hero-on-top vs hero-on-left across both sheet orientations and prints the one
  with the least matting.
- Still a hero, still no caption.

## 1.16.1 — 2026-08-24

**Fill as much as possible — without ever cropping.**

- 1.16.0 filled the sheet by cropping. Reverted: nothing is cropped, full stop.
  Each cell is shaped to its photo so a contain-fit fills it with no crop and no
  bars, and the layout — hero placement plus sheet orientation — is chosen to
  cover the most paper. In practice ~78–82% of the sheet, up from the ~50–65%
  the earlier no-crop grid managed, and the rest is unavoidable: photo shapes
  cannot tile a rectangle exactly without cutting them.
- Still a hero (photo 0, big), still no caption.

## 1.16.0 — 2026-08-24

**The photos fill the whole sheet, edge to edge.** *(Superseded by 1.16.1 —
this filled by cropping, which was not wanted.)*

- The four photos cover every pixel of the paper — no white margins, no caption
  band, but photos crop to fill.

## 1.15.0 — 2026-08-24

**A hero layout, like a real event photo booth.**

- The print is now one big hero photo with a row of three smaller ones beneath —
  the classic wedding/party booth look. The first photo picked is the hero by
  default; it spans the full width and dwarfs the other three (well over 4× their
  area).
- Any photo can be promoted: open it and tap **★ Make this the big one**, or use
  Move back/forward. The hint on the page says the first photo is the big one.
- Still no cropping — the hero fills its cell exactly (its cell takes the hero's
  shape) and the three supporting photos contain-fit into equal tiles. The sheet
  still rotates to landscape when a wide hero fills it better.

## 1.14.0 — 2026-08-24

**The sheet rotates to fill the paper.**

- The print now chooses its own orientation: photos that pack tighter on a
  landscape 6×4 sheet get one, portrait-friendly sets stay on 4×6. Four
  landscapes used to sit as a thin stack on a portrait page with big margins —
  now they fill a landscape sheet as a 2×2.
- Whichever orientation wastes less paper wins (portrait breaks ties). The
  printer is told the matching paper size — Custom.6x4in for a rotated print,
  Custom.4x6in otherwise — unless the host chose non-photo paper, which is kept
  as-is.

## 1.13.0 — 2026-08-24

**The grid fits portrait and landscape photos without cropping.**

- Every photo now gets a cell shaped to its own aspect ratio, so a landscape
  shot is shown wide and a portrait one tall — the whole frame, nothing cut off.
  Before, all four were force-cropped into fixed portrait squares.
- The photos are packed into rows and the arrangement that gives the fairest
  spread wins: four portraits become a 2×2, four landscapes a stack, one
  portrait among three landscapes lands beside a wide one with the rest below,
  and so on. No photo is shrunk to a stamp to make another huge.
- The crop editor follows suit — its frame matches each photo's shape, and a
  guest can still zoom in to crop deliberately if they want.

## 1.12.0 — 2026-08-24

**Save to Photos with no share sheet.**

- On a phone, **Save** now shows the finished photo full size with "touch and
  hold, then Save to Photos". Press-and-hold on the image goes straight to the
  camera roll — no share sheet, no icon-picking. This is the most direct path a
  web page has to Photos; the one action left is the OS "Save to Photos" tap,
  which Apple requires of every website and no web API can remove.
- A **Share instead** button keeps the old share-sheet route for anyone who
  prefers it, and desktop browsers still download directly.

## 1.11.1 — 2026-08-24

**Fixed: a Tailscale link that resolved but served nothing.**

- Tailscale's funnel config is persistent — a funnel started by hand and stopped
  with Ctrl-C stays advertised, and collides with the one the booth starts, so
  the `.ts.net` address answered with nothing useful. The booth now clears
  funnel/serve state before advertising its own, and clears it again on exit so
  it cannot leave a stale entry behind.

## 1.11.0 — 2026-08-24

**The booth remembers which tunnel you chose.**

- Pick a tunnel once with `--tunnel=…` and it is stored. Every start after that
  is the same two words — `npm start` — whether you settled on Tailscale, ngrok
  or a quick tunnel. `--no-tunnel` forgets it and goes back to Wi-Fi only.
- This also makes updating one fixed recipe: stop, `git pull`, start. Nothing to
  remember about how you set the booth up weeks ago.

## 1.10.1 — 2026-08-24

**Fixed: Save told you what to do after you had already done it.**

- `navigator.share()` resolves only once the share sheet is finished with, so
  "Choose Save Image" was appearing *after* the photo was saved, and nothing ever
  confirmed it. It now says **Saved to your phone** at that point, and the
  instruction moved to where it belongs — a line on the page, before you tap.
- The share sheet itself cannot be skipped: no web page on iOS can write to the
  Photos library directly, and the sheet is the only route there. A download
  link would put the print in Files instead, which is worse.

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
