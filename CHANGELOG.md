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
