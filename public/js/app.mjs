import { LAYOUTS, LAYOUT_ORDER, FRAMES, designVariants, stickerSpec } from './layouts.mjs';
import { FILTERS, FILTER_ORDER } from './filters.mjs';
import { composePage, exportPrint, drawSinglePhoto, clampTransform, resolveLayout, preloadArt, SAVE_SCALE } from './render.mjs';

const $ = (id) => document.getElementById(id);
const MAX_SOURCE_DIM = 3600; // fills a full-page cell at the 600 DPI print scale, still gentle on memory

// One layout, one look, one paper. The guest picks photos and prints — that is
// the whole app.
const state = {
  layoutId: 'grid',
  frameId: 'watercolor',
  filterId: 'none',
  caption: '',
  subtitle: '',
  copies: 1,
  designKey: null, // which coverflow design is chosen; null = the booth's auto-best
  photos: [null, null, null, null],
};

const session = {
  boothName: 'Photo Booth',
  maxCopies: 3,
  printingEnabled: true,
  requireApproval: false,
  keyRequired: false,
  remote: false,
  dryRun: false,
  online: false,
  previewNoPrint: false, // true only in the hosted preview: Print shows but is a no-op
};

const KEY_STORAGE = 'booth.key';

/**
 * A public booth carries its access key in the QR link (?k=…). Stash it and
 * tidy the address bar, so the guest never types anything and a shared
 * screenshot of the URL bar does not hand out printing rights.
 */
function claimAccessKey() {
  const url = new URL(location.href);
  const fromLink = url.searchParams.get('k');
  if (fromLink) {
    try {
      localStorage.setItem(KEY_STORAGE, fromLink);
    } catch {
      /* private mode — the key still works for this page load */
    }
    url.searchParams.delete('k');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return fromLink;
  }
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

let accessKey = claimAccessKey();

let editorIndex = null;
let pendingSlot = null;
let replaceAllNext = false;
let lastPrintBlob = null;
let printGeneration = 0; // bumped whenever the page changes, so stale renders are dropped
let warmTimer = null;
let gooTimer = null;  // keeps the heavy goo filter on only during the check split
let queuePoll = null; // re-fetches queue standing from the booth
let queueTick = null; // ticks the countdown down between fetches
let currentJob = null; // the print the result modal / queue pill is showing
let queueMinimized = false; // the modal is collapsed to the small queue pill

// ---------------------------------------------------------------- utilities

function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('hidden'), ms);
}

function todayStamp() {
  return new Date()
    .toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
    .toUpperCase();
}

/** Decode a picked file, honouring EXIF rotation, and shrink it for memory. */
async function loadPhoto(file) {
  let source = null;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await loadViaImgElement(file);
  }
  if (!source || !source.width) throw new Error('That file is not a photo this browser can read.');
  return downscale(source, MAX_SOURCE_DIM);
}

function loadViaImgElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not open that photo. Try a different one.'));
    };
    img.src = url;
  });
}

function downscale(source, maxDim) {
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const longest = Math.max(w, h);
  if (longest <= maxDim) return source;
  const ratio = maxDim / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (source.close) source.close();
  return canvas;
}

function filledCount() {
  return state.photos.filter(Boolean).length;
}

// ---------------------------------------------------------------- rendering

let frameRequested = false;

function scheduleRender() {
  lastPrintBlob = null; // anything that redraws invalidates the exported page
  printGeneration += 1;
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    renderAll();
  });
}

// Warm the watercolor papers up front so the coverflow and preview show them with no
// flash of blank paper; each one re-renders as it arrives.
preloadArt([...FRAMES.watercolor.art.portrait, ...FRAMES.watercolor.art.land, FRAMES.watercolor.sticker], scheduleRender);

function previewScale(layout) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const cssWidth = Math.min(300, window.innerWidth * 0.78);
  return Math.min(1, (cssWidth * dpr) / layout.page.w);
}

function renderAll() {
  const full = filledCount() === 4;
  const justCompleted = full && !wasComplete; // the set went from incomplete → full
  wasComplete = full;
  // A fresh set starts collapsed to the check button again.
  if (justCompleted) { clearTimeout(gooTimer); $('commit').classList.remove('open', 'animating'); }
  state.subtitle = `${session.boothName} · ${todayStamp()}`;
  updatePickButton();
  if (full) {
    // The coverflow of designs is the preview now — it draws the selected print.
    // Never rebuild mid-gesture (a stray resize must not reset an active swipe).
    // Play the intro sweep whenever the photos were just completed.
    if (!cfBusy) rebuildCoverflow(justCompleted);
  } else {
    const layout = resolveLayout(state);
    composePage($('preview'), state, previewScale(layout));
  }
  $('printBtn').disabled = !full || !session.printingEnabled;
  $('saveBtn').disabled = !full;
  warmPrint();
}

/**
 * Render the page ahead of time once all four photos are in. iOS only lets
 * navigator.share run inside the tap that asked for it, and rendering a 300 DPI
 * page takes long enough to lose that permission — so have it ready first.
 * Debounced, because a resize can fire renders in a burst.
 */
function warmPrint() {
  clearTimeout(warmTimer);
  if (filledCount() < 4 || lastPrintBlob) return;
  // exportPrint is a heavy 600 DPI render that blocks the main thread. Never start
  // it while the coverflow is animating (the intro sweep or a swipe/glide) — that
  // was the freeze right before the centre card snapped into place. Each settle
  // point re-calls warmPrint, so it still runs the moment things are still.
  if (cfBusy) return;

  warmTimer = setTimeout(() => {
    if (cfBusy) return; // a gesture began during the wait — the next settle re-warms
    const generation = printGeneration;
    exportPrint(state, { scale: SAVE_SCALE })
      .then((result) => {
        if (generation === printGeneration) lastPrintBlob = result.blob;
      })
      .catch(() => {
        /* a real Save or Print will surface the failure */
      });
  }, 700);
}

/** Reverse the check split: if Save/Print are open, gooey-merge them back into the
 *  check circle. Called when the guest swipes to a different design, so the new
 *  choice has to be confirmed again. */
// The metaball blur is what makes the split look liquid — but it also rounds the
// rounded-rect buttons into capsules while it's on. Rather than snap the filter off
// (which pops the shape from capsule to rounded-rect), we RAMP the blur down to ~0 as
// the split settles, so the buttons resolve smoothly into their crisp rounded-rect
// shape; only then do we drop to the plain drop-shadow. The reverse ramps it back up.
let gooRaf = null;
function setGooBlur(v) { $('gooBlur').setAttribute('stdDeviation', v.toFixed(2)); }
function rampGooBlur(from, to, holdMs, rampMs, onDone) {
  if (gooRaf) cancelAnimationFrame(gooRaf);
  setGooBlur(from);
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = () => {
    const dt = performance.now() - t0;
    if (dt < holdMs) { gooRaf = requestAnimationFrame(step); return; }
    const e = Math.min(1, (dt - holdMs) / rampMs);
    setGooBlur(from + (to - from) * ease(e));
    if (e < 1) { gooRaf = requestAnimationFrame(step); return; }
    gooRaf = null;
    if (onDone) onDone();
  };
  gooRaf = requestAnimationFrame(step);
}

const GOO_MAX = 18;   // full metaball blur — liquid neck
const GOO_MIN = 0.3;  // effectively crisp — the settled rounded-rect edge
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function collapseCommit() {
  const commit = $('commit');
  if (!commit.classList.contains('open') || commit.classList.contains('closing')) return;
  clearTimeout(gooTimer);
  if (reduceMotion()) { commit.classList.remove('open'); return; }
  commit.classList.add('closing', 'animating');
  rampGooBlur(GOO_MIN, GOO_MAX, 0, 220);  // crisp pills → liquid as they fuse back
  gooTimer = setTimeout(() => commit.classList.remove('open', 'closing', 'animating'), 700);
}

/** The picker is the main event: one tap should get all four photos. */
function updatePickButton() {
  const missing = 4 - filledCount();
  const full = missing === 0;
  const empty = missing === 4; // nothing picked yet — the clean opening screen
  const button = $('addAll');
  const label = $('pickLabel');

  if (empty) label.textContent = 'Take or Choose 4 Photos';
  else if (missing > 0) label.textContent = `Add ${missing} more`;

  button.classList.toggle('btn-primary', missing > 0);
  button.classList.toggle('btn-ghost', missing === 0);

  // The opening screen is just the one button — no placeholder grid, no action
  // bar. (`is-empty` on <body> hides those and centres the button.) Once a photo
  // is in, the preview grid returns; once all four are in, the coverflow takes
  // over the stage.
  document.body.classList.toggle('is-empty', empty);
  $('singleWrap').classList.toggle('hidden', full);
  $('coverflow').classList.toggle('hidden', !full);
  $('swapAll').classList.toggle('hidden', !full);

  // Friendly step-by-step guide. Choosing photos is step 1; once all four are in
  // and the layouts appear, the top line advances to step 2 (swipe) and the
  // print step (3) surfaces above the action bar.
  const step = full ? 2 : 1;
  $('stepKicker').textContent = `Step ${step} of 3`;
  $('stepText').textContent = full ? 'Swipe to find your fave!' : 'Pick your 4 best shots!';
  $('stepHint').textContent = full
    ? 'then tap the check when you love it'
    : 'tap the button to add or snap them';
  $('commit').classList.toggle('hidden', !full);
  $('swipeHint').classList.toggle('hidden', !full); // swipe cue only over the coverflow
  if (full) layoutGoo();
}

/** Size and place the three goo <rect>s in px so they line up with the (responsive)
 *  Save/Print labels on top. The svg has no viewBox — 1 user unit is 1 CSS px — so
 *  these are plain pixel coordinates in the svg's own frame. The pill band sits
 *  vertically centred in the tall, overflow:visible svg (top:-64 → the pill's centre
 *  lands on the control's centre). Called whenever the control is shown or resized. */
function layoutGoo() {
  const commit = $('commit');
  const W = commit.clientWidth;
  if (!W) return;
  const GAP = 24;      // half-gap between the two pills (matches the labels' 48px gap)
  const H = 72;        // pill height
  const TOP = 64;      // must equal the svg's -64px top inset, so the pill centres on the control
  const PILL_RX = 20;  // the open buttons are ROUNDED RECTANGLES, not capsules
  const CIRCLE_RX = 36; // the closed check is a true circle (rx = half of 72)
  const saveOnly = commit.classList.contains('save-only');
  const half = W / 2 - GAP;
  const setRect = (el, x, w, rx) => {
    el.setAttribute('x', x); el.setAttribute('y', TOP);
    el.setAttribute('width', Math.max(0, w)); el.setAttribute('height', H);
    el.setAttribute('rx', rx); el.setAttribute('ry', rx);
  };
  const [save, print, center] = $('gooG').children;
  const saveW = saveOnly ? W : half;
  setRect(save, 0, saveW, PILL_RX);              // save-only: one full-width rounded rect
  setRect(print, W / 2 + GAP, half, PILL_RX);
  setRect(center, W / 2 - 36, 72, CIRCLE_RX);    // 72×72 rx36 → the closed check circle
  // Each blob's gradient is 115° (the CSS --grad angle). objectBoundingBox skews an
  // angle by the shape's aspect ratio, so the endpoints are computed per shape from
  // the true 115° direction — giving the same visual angle on the wide pills and the
  // square circle alike (and, being objectBoundingBox, it rides each blob's transform
  // exactly as the CSS background did).
  gradAngle($('gradSave'), saveW, H);
  gradAngle($('gradPrint'), half, H);
  gradAngle($('gradCenter'), 72, H);
  startGradDrift();
}

/** Pan the goo gradients back and forth (a JS-driven version of the CTA's btnGrad
 *  drift). SMIL on a gradient inside a zero-size <svg> does not run in Safari, so we
 *  animate gradientTransform from a rAF loop — reliable in every browser. Slow 9s
 *  oscillation; the loop parks itself whenever the control is hidden. */
let gradRaf = null;
let gradLast = 0;
function startGradDrift() {
  if (gradRaf !== null) return;
  const grads = [$('gradSave'), $('gradPrint'), $('gradCenter')];
  const step = () => {
    if ($('commit').classList.contains('hidden')) { gradRaf = null; return; } // parked
    const now = performance.now();
    // Repaint at ~20fps, not every frame — the drift is slow (9s), and each update
    // re-runs the goo layer's shadow, so throttling keeps it light on the phone.
    if (now - gradLast >= 50) {
      gradLast = now;
      const phase = Math.sin((now / 9000) * Math.PI * 2); // [-1,1] over 9s
      const t = `translate(${(phase * 0.55).toFixed(4)} ${(phase * 0.26).toFixed(4)})`;
      for (const g of grads) g.setAttribute('gradientTransform', t);
    }
    gradRaf = requestAnimationFrame(step);
  };
  gradRaf = requestAnimationFrame(step);
}

/** Set a linearGradient's endpoints so it renders at 115° (CSS --grad) on a w×h box.
 *  objectBoundingBox coords: map the CSS gradient line (through the centre, length
 *  |w·sinθ|+|h·cosθ|) into the unit square by dividing the px vector by w and h. The
 *  axis is drawn GRAD_ZOOM× longer than the box (like the CTA's background-size:220%)
 *  so the box shows a slice; an animateTransform pans that slice back and forth (in
 *  the markup) to give the same living, drifting gradient as the primary buttons. */
const GRAD_ZOOM = 2.2;
function gradAngle(grad, w, h) {
  const th = (115 * Math.PI) / 180;
  const dx = Math.sin(th), dy = -Math.cos(th);   // 115° direction (right, slightly down)
  const L = Math.abs(w * dx) + Math.abs(h * dy); // CSS gradient-line length in px
  const hx = (GRAD_ZOOM * L * dx) / (2 * w);     // half-vector in objectBoundingBox units
  const hy = (GRAD_ZOOM * L * dy) / (2 * h);
  grad.setAttribute('x1', 0.5 - hx); grad.setAttribute('y1', 0.5 - hy);
  grad.setAttribute('x2', 0.5 + hx); grad.setAttribute('y2', 0.5 + hy);
}

// ---------------------------------------------------------------- coverflow

// The coverflow scrolls on a continuous position (cfPos, in card units). A flick
// picks a target card from the release speed, then cfPos eases to it — a smooth,
// decelerating glide with no overshoot, so it settles without bouncing. cfIndex
// is the settled selection that Save/Print use.
let cfDesigns = [];
let cfPos = 0;      // continuous centre position
let cfIndex = -1;   // the design currently under the centre (drives label + print)
let cfTarget = 0;   // the card the glide is easing to
let cfRaf = null;
let cfBusy = false; // a swipe or glide is in flight — hold off the heavy print warm
let manip = null;   // a two-finger direct-manipulation of one photo in flight
let peekRaf = null; // the spring-back animation after a pinch is released
let liftedPaper = null; // the paper currently re-parented to #pinchLayer during a pinch
let introRaf = null; // the intro sweep played each time the photos are completed
let wasComplete = false; // were all 4 photos filled on the previous render?

// Render display canvases at the screen's true pixel density (phones are 3×), so
// the coverflow is crisp at rest. Capped at 3 to bound memory on any extreme DPR.
const DPR = Math.min(3, window.devicePixelRatio || 1);
const clampPos = (p) => Math.max(0, Math.min(cfDesigns.length - 1, p));

/** Paint a card's face (the design) and its frosted mirror from current state. */
function paintCard(card, design) {
  const face = card.querySelector('canvas.cf-face');
  const mirror = card.querySelector('canvas.cf-mirror');
  const dispScale = Number(card.dataset.scale);
  composePage(face, state, dispScale * DPR, design);
  // The reflection is blurred (blur 3.5px) and faded to 22%, so it needs nowhere
  // near the face's resolution — render it at half density. Invisible behind the
  // blur, and it keeps this the cheap half of the paint even at full retina DPR.
  mirror.width = Math.max(1, Math.round(face.width / 2));
  mirror.height = Math.max(1, Math.round(face.height / 2));
  const mctx = mirror.getContext('2d');
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, mirror.width, mirror.height);
  mctx.translate(0, mirror.height);
  mctx.scale(1, -1);
  mctx.drawImage(face, 0, 0, mirror.width, mirror.height);
}

/** Horizontal distance between neighbouring cards, in CSS px. Kept wide relative
 *  to the card so the side photos always peek out beside the centre one. */
function cfSpacing() {
  const cf = $('coverflow');
  return Math.min(180, (cf.clientWidth || 320) * 0.42);
}

/** Lay the cards out in a coverflow fan around the continuous position cfPos. */
function positionCards() {
  const cards = [...$('cfTrack').children];
  const spacing = cfSpacing();
  cards.forEach((card, i) => {
    const offset = i - cfPos;
    const abs = Math.abs(offset);
    // First neighbour sits a full step out; the rest compress into a stacked deck.
    const mag = Math.min(abs, 1) * spacing + Math.max(0, abs - 1) * spacing * 0.34;
    const x = Math.sign(offset) * mag;
    const ry = Math.max(-58, Math.min(58, -offset * 50));
    const scale = Math.max(0.62, 1 - abs * 0.10);
    // Real 3D depth (translateZ) does the stacking: the closer a card is to the
    // centre, the further forward it sits, so it rises to the front smoothly as it
    // reaches the middle instead of popping via a z-index swap.
    const depth = -abs * 130;
    // translateY(-100%) lifts the card fully above its `top` anchor, so its
    // bottom edge sits exactly on the baseline (the glass line) — the same line
    // for every card regardless of height, so landscape and portrait bottoms
    // align and the reflection reads as a single sheet of glass. The reflection
    // falls into the space below the baseline.
    card.style.transform =
      `translate(-50%, -100%) translateX(${x}px) translateZ(${depth}px) rotateY(${ry}deg) scale(${scale})`;
    // Fully opaque — no see-through — so the front card cleanly covers the rest.
    // Cards well off the stage are hidden outright. Every VISIBLE card takes
    // touches, so a swipe can start on any side picture (only the hidden,
    // off-stage cards ignore them, leaving the empty margins free to scroll).
    card.style.opacity = abs > 2.6 ? '0' : '1';
    card.style.pointerEvents = abs > 2.6 ? 'none' : 'auto';
  });
}

/** The centred card changed — update the label and the warmed print. */
function setCurrent(index) {
  const i = clampPos(index);
  if (i === cfIndex || !cfDesigns[i]) return;
  cfIndex = i;
  collapseCommit(); // swiped to a new design — merge Save/Print back into the check
  const d = cfDesigns[i];
  state.designKey = d.key;
  lastPrintBlob = null; // the chosen design changed — re-warm the print for Save/Print
  printGeneration += 1;
  // Never warm mid-gesture: exportPrint is a heavy 300 DPI render that would
  // block the main thread and make the swipe stutter. It runs once we settle.
  if (!cfBusy) warmPrint();
}

// When a glide should bounce off an end, it first eases to a point just past the
// edge (cfTarget), then — because cfBounceBack is set — eases back to the edge.
let cfBounceBack = null;

/** Ease one frame toward cfTarget. Monotonic between cards; the only overshoot
 *  is a deliberate end-of-list bounce, driven by cfBounceBack. */
function glideStep() {
  const EASE = 0.28; // fraction of the remaining gap closed per frame
  cfPos += (cfTarget - cfPos) * EASE;
  setCurrent(Math.round(cfPos));
  positionCards();
  if (Math.abs(cfTarget - cfPos) < 0.003) {
    cfPos = cfTarget;
    if (cfBounceBack !== null) {
      // Reached the overshoot point — now spring back to the edge.
      cfTarget = cfBounceBack;
      cfBounceBack = null;
      cfRaf = requestAnimationFrame(glideStep);
      return;
    }
    positionCards();
    setCurrent(cfPos);
    cfRaf = null;
    cfBusy = false;
    warmPrint(); // settled — now it is safe to render the print ahead of time
    return;
  }
  cfRaf = requestAnimationFrame(glideStep);
}

/** Glide to a card index with a smooth, settling ease. */
function glideTo(index) {
  cfBounceBack = null;
  cfTarget = clampPos(Math.round(index));
  if (cfRaf == null) cfRaf = requestAnimationFrame(glideStep);
  startFly(); // keep it flying through the momentum glide, home when it settles
}

/** Bounce off an end: overshoot a touch past the edge, then spring back to it —
 *  the iOS "you've hit the end of the list" feel. */
function bounceEdge(edge) {
  cfBounceBack = edge;
  cfTarget = edge + (edge === 0 ? -0.3 : 0.3);
  if (cfRaf == null) cfRaf = requestAnimationFrame(glideStep);
  startFly();
}

/** Rubber-band resistance for dragging past an end: the further past, the less
 *  it gives, asymptoting to MAX_OVER cards — so the end feels elastic, not walled. */
const MAX_OVER = 0.55;
const rubber = (over) => over / (1 + over / MAX_OVER);

function stopSpring() {
  cfBounceBack = null;
  if (cfRaf != null) {
    cancelAnimationFrame(cfRaf);
    cfRaf = null;
  }
}

// Just the TICK (the ✓ glyph) flies fully OUT of the button, OPPOSITE the swipe
// direction, the moment the deck starts moving — even a slight swipe sends it all the
// way out (the button's circular clip hides it past the edge) — and it stays out for
// the whole coverflow, then flies back to centre once the deck settles. It's not
// proportional to speed: any swipe latches a direction and drives it to a fixed offset.
let flyRaf = null;
let flyLast = 0;
let flyX = 0;    // current x offset (px), eased toward the target
let flyDir = 0;  // latched swipe direction (-1 left, +1 right, 0 none yet)
const FLY_OUT = 70; // past the circle's edge → the tick is fully clipped away
function startFly() {
  if (flyRaf !== null || reduceMotion()) return;
  flyLast = cfPos;
  const tick = $('checkBtn').querySelector('svg');
  const loop = () => {
    const vel = cfPos - flyLast; // deck speed, card-units per frame
    flyLast = cfPos;
    if (Math.abs(vel) > 0.002) flyDir = Math.sign(vel); // latch OPPOSITE the swipe direction
    // Fully out while the deck is in motion; home once it has settled.
    const target = cfBusy ? FLY_OUT * flyDir : 0;
    flyX += (target - flyX) * 0.4;
    tick.style.transform = Math.abs(flyX) < 0.15 ? '' : `translateX(${flyX.toFixed(1)}px)`;
    if (!cfBusy && Math.abs(flyX) < 0.4) {
      tick.style.transform = '';
      flyDir = 0;
      flyRaf = null;
      return;
    }
    flyRaf = requestAnimationFrame(loop);
  };
  flyRaf = requestAnimationFrame(loop);
}

function stopIntro() {
  if (introRaf != null) {
    cancelAnimationFrame(introRaf);
    introRaf = null;
    cfBusy = false;
    positionCards();
  }
}

const easeOutCubic2 = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Intro sweep, played whenever the photos are freshly completed. It is a real
 * coverflow scroll — driven by cfPos, so every card rotates and scales through
 * the centre as if a user swiped. The deck starts off the right edge (cfPos a few
 * slots before the first design, cards edge-on) and swipes right-to-left, easing
 * to a settle on the middle design. Interruptible: any touch on a picture cancels it.
 */
function runIntro() {
  const middle = Math.floor(cfDesigns.length / 2);
  const startPos = -Math.min(3, cfDesigns.length - 1); // off to the right, edge-on
  cfBusy = true;
  clearTimeout(warmTimer);
  cfPos = startPos;
  setCurrent(clampPos(Math.round(cfPos)));
  positionCards();

  // One swipe in from the right, easing to rest on the middle design.
  const legs = [
    { to: middle, dur: 950, ease: easeOutCubic2 },
  ];
  let li = 0;
  let legFrom = startPos;
  let t0 = null;
  const step = (ts) => {
    if (t0 === null) t0 = ts;
    const leg = legs[li];
    const k = leg.dur > 0 ? Math.min(1, (ts - t0) / leg.dur) : 1;
    cfPos = legFrom + (leg.to - legFrom) * leg.ease(k);
    setCurrent(clampPos(Math.round(cfPos)));
    positionCards();
    if (k < 1) { introRaf = requestAnimationFrame(step); return; }
    li += 1;
    if (li < legs.length) { legFrom = leg.to; t0 = null; introRaf = requestAnimationFrame(step); return; }
    cfPos = middle;
    setCurrent(middle);
    positionCards();
    introRaf = null;
    cfBusy = false;
    warmPrint();
  };
  introRaf = requestAnimationFrame(step);
}

/** Rebuild the cards from the current photos, keeping the guest's chosen design.
 *  When playIntro is true (the photos were just completed) it runs the intro sweep. */
function rebuildCoverflow(playIntro = false) {
  stopSpring();
  stopIntro();
  cfBusy = false; // a rebuild is not a gesture — let it warm the print normally
  const base = LAYOUTS[state.layoutId];
  cfDesigns = designVariants(base, state.photos, stickerSpec(FRAMES[state.frameId]));
  let idx = cfDesigns.findIndex((d) => d.key === state.designKey);
  if (idx < 0) idx = 0;

  const track = $('cfTrack');
  track.innerHTML = '';
  // Fit each card inside a box while keeping its true paper aspect: the display
  // size comes from ONE scale for both axes, so nothing is squished. A landscape
  // sheet fits by width, a portrait sheet by height. Big box → big photos.
  const boxH = Math.min(window.innerHeight * 0.37, 350);
  // boxW caps a landscape card's width — keep it tighter so its side photos show.
  const boxW = Math.min(window.innerWidth * 0.55, 300);

  cfDesigns.forEach((design) => {
    const card = document.createElement('div');
    card.className = 'cf-card';
    const dispScale = Math.min(boxH / design.page.h, boxW / design.page.w);
    const w = Math.round(design.page.w * dispScale);
    const h = Math.round(design.page.h * dispScale);
    card.dataset.scale = String(dispScale);

    // The design itself (the "face"), wrapped in a paper element that a pinch
    // zooms (a view transform, independent of the card's coverflow position)…
    const paper = document.createElement('div');
    paper.className = 'cf-paper';
    const face = document.createElement('canvas');
    face.className = 'cf-face';
    face.style.width = `${w}px`;
    face.style.height = `${h}px`;
    paper.appendChild(face);
    card.appendChild(paper);

    // …and its frosted-glass reflection: a vertically-flipped copy on the glass
    // just below, blurred and faded by CSS so it reads as a soft, hazy reflection.
    // It is a sibling of the paper (it lives on the glass, not on the paper), so a
    // pinch does not drag it along — instead it takes the MIRROR of the paper's
    // transform, receding and tilting the way a real reflection does.
    const mirror = document.createElement('canvas');
    mirror.className = 'cf-mirror';
    mirror.style.width = `${w}px`;
    mirror.style.height = `${h}px`;
    card.appendChild(mirror);

    paintCard(card, design);
    track.appendChild(card);
  });

  cfPos = idx;
  cfIndex = -1; // force the label to refresh

  // Whenever the photos are freshly completed, sweep the deck in from off the
  // right until the rightmost design is centred, then settle on the middle.
  if (playIntro && cfDesigns.length > 1) {
    runIntro();
  } else {
    setCurrent(idx);
    positionCards();
  }
}

// -------------------------------------------------- pinch-to-zoom the paper

/** The `.cf-paper` wrapper of the centred card — the thing a pinch zooms. */
function centrePaper() {
  const card = $('cfTrack').children[clampPos(Math.round(cfPos))];
  return card ? card.querySelector('.cf-paper') : null;
}

/** Float the pinched paper above ALL page UI. The coverflow clips (overflow) and
 *  sits below the controls, so a zoomed print would be cut off and painted under
 *  the buttons. We lift ONLY the `.cf-paper` (the print face) out to #pinchLayer —
 *  a full-screen, unclipped, top-most layer — pinning it to the exact screen box
 *  it occupied, so it appears not to move; the pinch transform then rides on top.
 *  The reflection (`.cf-mirror`) stays behind in the card, its original layer,
 *  untouched. Called at the moment of a pinch, when the centre card is settled
 *  dead-centre (offset 0 → no coverflow rotate/scale/depth), so its box is
 *  axis-aligned and the lift is pixel-exact. */
function liftPaper(paper) {
  if (liftedPaper) putPaperBack(); // never lift twice — restore any prior lift first
  const card = paper.parentElement;
  const w = paper.offsetWidth;   // layout size (no ancestor transform) — the card is
  const h = paper.offsetHeight;  // settled at offset 0, so this equals the on-screen box
  const r = paper.getBoundingClientRect();
  liftedPaper = {
    el: paper, parent: card, next: paper.nextSibling, cssText: paper.style.cssText,
    card, cardW: card.style.width, cardH: card.style.height,
  };
  // Pin the card's box so it doesn't collapse when the paper leaves the flow: the
  // reflection sits at the card's bottom (top:100%) and would otherwise jump up.
  card.style.width = `${w}px`;
  card.style.height = `${h}px`;
  // ABSOLUTE (not fixed) inside #pinchLayer, which is a full-viewport fixed layer
  // pinned at 0,0 — so these viewport coordinates still land exactly right, AND the
  // layer's overflow:hidden clips the print (and its shadow) to the screen so a big
  // zoom never paints an unbounded area off-screen (which is what froze the pinch).
  paper.style.position = 'absolute';
  paper.style.left = `${r.left}px`;
  paper.style.top = `${r.top}px`;
  paper.style.width = `${r.width}px`;
  paper.style.height = `${r.height}px`;
  paper.style.margin = '0';
  paper.style.borderRadius = '6px'; // match the canvas so the box-shadow's corners align
  paper.style.zIndex = '1';
  $('pinchLayer').appendChild(paper);
}

/** Return the lifted paper to its card, restoring its original inline styles (which
 *  clears the fixed position, box, and any transform in one shot) and the card's
 *  own auto sizing. Safe to call when nothing is lifted. */
function putPaperBack() {
  if (!liftedPaper) return;
  const { el, parent, next, cssText, card, cardW, cardH } = liftedPaper;
  el.style.cssText = cssText;
  card.style.width = cardW;
  card.style.height = cardH;
  parent.insertBefore(el, next);
  liftedPaper = null;
}

/** The drop shadow for a paper lifted to `scale` off its resting spot, as a
 *  BOX-shadow on the (rectangular) paper — not a `drop-shadow` filter. The print is
 *  a rectangle, so the two look identical, but a box-shadow is a cheap, composited
 *  primitive whereas a `drop-shadow` filter alpha-traces and re-blurs the whole
 *  element every frame — pathologically slow on iOS, and it froze the pinch once
 *  the paper was lifted to an unclipped full-screen layer. It is tied DIRECTLY to
 *  size: zero at rest (the paper is on the glass), growing bigger, softer and
 *  darker as it rises; because it is zero at scale 1 it fades to nothing exactly as
 *  the paper returns to size — no pop. Screen-space values are divided by scale
 *  since the shadow rides the same transform that enlarges the paper. */
function paperShadow(scale) {
  const lift = Math.min(1, Math.max(0, (scale - 1) / 2)); // 0 at rest → 1 at max zoom (scale 3)
  if (lift <= 0.001) return 'none';
  // sqrt ramps the shadow up fast off zero — bold even at a small pinch, yet
  // still nothing at rest. Two stacked layers make it dramatic: a tight, near-
  // black CORE right under the print for a hard, defined edge, plus a big soft
  // HALO for spread. All screen-space, divided by scale (the shadow rides the
  // paper's transform). Tunable:  value = t * growth.
  const t = Math.sqrt(lift);
  const core = `0 ${(t * 44) / scale}px ${(t * 34) / scale}px rgba(0, 0, 0, ${t * 1.0})`;
  const halo = `0 ${(t * 120) / scale}px ${(t * 150) / scale}px rgba(0, 0, 0, ${t * 0.7})`;
  return `${core}, ${halo}`;
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Drop the peek: spring the paper, its reflection, AND the shadow back to rest
 *  together, in one JS animation, so the shadow tracks the paper's actual size
 *  the whole way down and shrinks to nothing as it lands — never snapping off. */
function endPeek(state) {
  const { paper, mirror, tx, ty, rot, scale } = state;
  const DUR = 300;
  let start = null;
  const step = (ts) => {
    if (start === null) start = ts;
    const e = easeOutCubic(Math.min(1, (ts - start) / DUR));
    const s = scale + (1 - scale) * e;
    const cx = tx * (1 - e);
    const cy = ty * (1 - e);
    const cr = rot * (1 - e);
    paper.style.transform = `translate(${cx}px, ${cy}px) rotate(${cr}deg) scale(${s})`;
    mirror.style.transform = `translate(${cx}px, ${-cy}px) rotate(${-cr}deg) scale(${s})`;
    paper.style.boxShadow = paperShadow(s);
    if (e < 1) { peekRaf = requestAnimationFrame(step); return; }
    paper.style.transform = '';
    mirror.style.transform = '';
    paper.style.boxShadow = '';
    peekRaf = null;
    putPaperBack(); // print settled — drop it back into its card, out of #pinchLayer
  };
  peekRaf = requestAnimationFrame(step);
}

/** The index of the visible card whose picture (face box) is under a point, or
 *  -1 if none. When cards overlap in the fan, the one whose centre is nearest the
 *  point wins — the picture the tap is most squarely on. Geometric, not
 *  event.target: the 3D stack and the container's pointer-capture both make the
 *  DOM target unreliable, so we test the on-screen face rectangles directly. */
function cardIndexAt(px, py) {
  let best = -1;
  let bestDist = Infinity;
  [...$('cfTrack').children].forEach((card, i) => {
    if (card.style.opacity === '0') return; // an off-stage, hidden card
    const faceEl = card.querySelector('canvas.cf-face');
    if (!faceEl) return; // its paper is lifted into #pinchLayer (a pinch in flight)
    const r = faceEl.getBoundingClientRect();
    if (px < r.left || px > r.right || py < r.top || py > r.bottom) return;
    const d = Math.abs(px - (r.left + r.right) / 2);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

function bindCoverflow() {
  const cf = $('coverflow');
  const pointers = new Map();
  let swipeId = null;    // the pointer driving a one-finger browse
  let dragging = false;
  let startX = 0;
  let startPos = 0;
  let moved = 0;
  let lastT = 0;
  let velMs = 0; // smoothed velocity in card-units per millisecond

  // Two fingers on the centred card zoom the whole print (the "paper") so you can
  // look at it up close — pinch to zoom, drag to move, twist to rotate. It is a
  // view only: the print itself never changes, and it springs back on release.
  // One finger still browses the deck, so there is no gesture clash.
  const beginManip = () => {
    dragging = false; // a browse never becomes a peek half-way
    swipeId = null;
    stopSpring();
    if (peekRaf) { cancelAnimationFrame(peekRaf); peekRaf = null; } // grab a springing paper
    putPaperBack(); // if a prior spring was interrupted mid-lift, re-home the paper first
    cfPos = clampPos(Math.round(cfPos)); // settle dead-centre before zooming
    positionCards();
    const paper = centrePaper();
    if (!paper) return;
    const face = paper.querySelector('canvas.cf-face');
    const mirror = paper.parentElement.querySelector('canvas.cf-mirror');
    liftPaper(paper); // float the print above all UI (mirror captured first, stays put)
    const [a, b] = [...pointers.values()];
    manip = {
      paper,
      face,
      mirror,
      baseDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
      baseAng: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX),
      baseMidX: (a.clientX + b.clientX) / 2,
      baseMidY: (a.clientY + b.clientY) / 2,
      tx: 0, ty: 0, rot: 0, scale: 1, // the live transform, tracked for spring-back
    };
    cfBusy = true;
    clearTimeout(warmTimer);
  };

  const updateManip = () => {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const ang = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
    const midX = (a.clientX + b.clientX) / 2;
    const midY = (a.clientY + b.clientY) / 2;
    const scale = Math.min(3, Math.max(0.5, dist / manip.baseDist));
    const rot = ((ang - manip.baseAng) * 180) / Math.PI;
    const tx = midX - manip.baseMidX;
    const ty = midY - manip.baseMidY;
    manip.tx = tx; manip.ty = ty; manip.rot = rot; manip.scale = scale;
    manip.paper.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg) scale(${scale})`;
    manip.paper.style.boxShadow = paperShadow(scale); // shadow grows directly with the size
    // The reflection lives on the glass and shows the MIRROR of the paper's move:
    // same horizontal shift and scale, but the vertical shift and the rotation are
    // negated (a mirror across the glass), pivoting about the reflection's centre.
    // So lifting the paper makes the reflection recede, opening a gap — as on glass.
    manip.mirror.style.transform = `translate(${tx}px, ${-ty}px) rotate(${-rot}deg) scale(${scale})`;
  };

  const endManip = () => {
    endPeek(manip); // manip carries paper/face/mirror and the live tx/ty/rot/scale
    manip = null;
    cfBusy = false;
  };

  cf.addEventListener('pointerdown', (event) => {
    if (!cfDesigns.length) return;

    // Engage only when the touch lands ON a picture — any visible card, centre or
    // side. This is a geometric hit-test against the card boxes, so it excludes
    // the reflection (which sits below the box) and the empty margins: touches
    // there fall through to the browser and scroll the page. A second finger may
    // land anywhere (so a pinch that started on a picture still works).
    if (pointers.size === 0 && cardIndexAt(event.clientX, event.clientY) < 0) {
      return; // outside every picture — leave it to the page to scroll
    }

    stopIntro(); // a touch on a picture takes over from the intro sweep
    pointers.set(event.pointerId, event);
    try { cf.setPointerCapture(event.pointerId); } catch { /* fine */ }

    if (pointers.size >= 2) { beginManip(); return; }

    // First finger: a possible browse (or a tap).
    swipeId = event.pointerId;
    dragging = true;
    startX = event.clientX;
    startPos = cfPos;
    moved = 0;
    lastT = event.timeStamp;
    velMs = 0;
    cfBusy = true;
    clearTimeout(warmTimer); // cancel any warm queued before the gesture began
    stopSpring(); // grab it wherever it is — like catching a spinning wheel
    startFly(); // the check button starts flying with the drag
  });

  cf.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, event);

    if (manip) { if (pointers.size >= 2) updateManip(); return; }
    if (!dragging || event.pointerId !== swipeId) return;

    const dx = event.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    // Rubber-band past the ends instead of hard-stopping: drag beyond the first
    // or last design and it follows with easing resistance (iOS end-of-list feel).
    const raw = startPos - dx / cfSpacing();
    const max = cfDesigns.length - 1;
    const newPos = raw < 0 ? -rubber(-raw) : raw > max ? max + rubber(raw - max) : raw;
    const dt = Math.max(1, event.timeStamp - lastT);
    velMs = 0.7 * ((newPos - cfPos) / dt) + 0.3 * velMs; // smooth, so a flick reads clean
    cfPos = newPos;
    lastT = event.timeStamp;
    setCurrent(Math.round(cfPos));
    positionCards();
  });

  const end = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);

    if (manip) {
      if (pointers.size < 2) endManip();
      return;
    }
    if (!dragging || event.pointerId !== swipeId) return;
    dragging = false;
    swipeId = null;

    // Release speed in card-units per frame. If the finger paused before lifting,
    // it is not a flick — ignore the now-stale speed.
    const idle = event.timeStamp - lastT;
    const v = idle > 60 ? 0 : velMs * 16;
    const from = Math.round(cfPos);
    // A quick flick counts even when the finger barely travelled — that is what
    // makes a small flick feel responsive.
    const isFlick = Math.abs(v) > 0.012;

    if (!isFlick && moved < 6) {
      // A tap: swipe the tapped picture — centre or side — to the middle. Found
      // geometrically (pointer-capture retargets event.target to the container,
      // so it can't tell us which card); falls back to the current centre.
      const i = cardIndexAt(event.clientX, event.clientY);
      glideTo(i >= 0 ? i : from);
      return;
    }

    if (isFlick) {
      // The release speed picks the target (faster → further); a small flick still
      // always advances one, a hard one at most two, so it never flies across.
      const capped = Math.max(-0.9, Math.min(0.9, v));
      let rawTarget = Math.round(cfPos + capped * 5);
      if (v > 0 && rawTarget <= from) rawTarget = from + 1;
      if (v < 0 && rawTarget >= from) rawTarget = from - 1;
      const max = cfDesigns.length - 1;
      const target = Math.max(from - 2, Math.min(from + 2, rawTarget));
      // Flicking past an end (there was momentum beyond it) bounces off it.
      if (target <= 0 && rawTarget < 0) bounceEdge(0);
      else if (target >= max && rawTarget > max) bounceEdge(max);
      else glideTo(target);
    } else {
      // A slow drag: settle to the nearest card — springs back if past an end.
      glideTo(from);
    }
  };
  cf.addEventListener('pointerup', end);
  cf.addEventListener('pointercancel', end);
}

function renderSlots() {
  const container = $('slots');
  if (!container.childElementCount) {
    for (let i = 0; i < 4; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot';
      btn.dataset.index = String(i);
      btn.addEventListener('click', () => onSlotTap(i));
      container.appendChild(btn);
    }
  }

  [...container.children].forEach((btn, i) => {
    const photo = state.photos[i];
    btn.classList.toggle('filled', Boolean(photo));
    btn.innerHTML = '';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    if (!photo) {
      btn.textContent = String(i + 1);
      btn.disabled = true;
      btn.setAttribute('aria-label', `Photo ${i + 1}, empty`);
      return;
    }
    btn.disabled = false;
    const thumb = document.createElement('canvas');
    thumb.width = 120;
    thumb.height = 160;
    drawSinglePhoto(thumb, photo, state.filterId);
    btn.appendChild(thumb);
    btn.appendChild(num);
    btn.setAttribute('aria-label', `Adjust photo ${i + 1}`);
  });
}

// ---------------------------------------------------------------- controls

// ---------------------------------------------------------------- picking

function onSlotTap(index) {
  // Empty slots are placeholders now — the one button above fills them.
  if (state.photos[index]) openEditor(index);
}

function pickInto(index) {
  pendingSlot = index;
  $('fileOne').value = '';
  $('fileOne').click();
}

async function acceptFiles(files, startIndex = null) {
  const chosen = [...files];
  const list = chosen.slice(0, 4);
  if (!list.length) return;

  if (startIndex === null && replaceAllNext) {
    state.photos = [null, null, null, null];
    overflowCursor = 0;
  }
  replaceAllNext = false;

  const tooMany = chosen.length > 4;
  // Only speak up when there's real news (more than four picked); the photos
  // appear on their own, so no "Loading…" chatter.
  if (tooMany) toast('A print holds 4 — using the first four you picked.', 3200);

  let cursor = startIndex;
  for (const file of list) {
    try {
      const bitmap = await loadPhoto(file);
      const slot = cursor !== null ? cursor : nextOpenSlot();
      state.photos[slot] = { bitmap, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } };
      cursor = null; // an explicit slot only claims the first file
      scheduleRender();
    } catch (err) {
      toast(err.message);
    }
  }
}

let overflowCursor = 0;

function nextOpenSlot() {
  const open = state.photos.findIndex((p) => !p);
  if (open !== -1) return open;
  const slot = overflowCursor % 4;
  overflowCursor += 1;
  return slot;
}

// ---------------------------------------------------------------- editor

const crop = { dragging: false, startX: 0, startY: 0, baseDx: 0, baseDy: 0, pinchDist: 0, baseZoom: 1 };

function cellFor(index) {
  const layout = resolveLayout(state);
  return layout.cells.find((c) => c.photo === index) || layout.cells[0];
}

function openEditor(index) {
  editorIndex = index;
  $('editorIndex').textContent = String(index + 1);
  updateHeroButton();
  $('editor').classList.remove('hidden');
  sizeCropCanvas();
  $('zoom').value = String(state.photos[index].transform.zoom);
  drawCrop();
}

function closeEditor() {
  editorIndex = null;
  $('editor').classList.add('hidden');
  scheduleRender();
}

function sizeCropCanvas() {
  const cell = cellFor(editorIndex);
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const cssWidth = Math.min(320, window.innerWidth * 0.74);
  const canvas = $('cropCanvas');
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${Math.round((cssWidth * cell.h) / cell.w)}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(((cssWidth * cell.h) / cell.w) * dpr);
}

function drawCrop() {
  if (editorIndex === null) return;
  const photo = state.photos[editorIndex];
  if (!photo) return;
  const canvas = $('cropCanvas');
  photo.transform = clampTransform(photo.transform, canvas.width, canvas.height, photo.bitmap);
  drawSinglePhoto(canvas, photo, state.filterId);
}

function bindCropGestures() {
  const canvas = $('cropCanvas');
  const pointers = new Map();

  canvas.addEventListener('pointerdown', (event) => {
    if (editorIndex === null) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, event);
    const t = state.photos[editorIndex].transform;
    if (pointers.size === 1) {
      crop.dragging = true;
      crop.startX = event.clientX;
      crop.startY = event.clientY;
      crop.baseDx = t.dx;
      crop.baseDy = t.dy;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      crop.pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      crop.baseZoom = t.zoom;
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (editorIndex === null || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, event);
    const photo = state.photos[editorIndex];
    const rect = canvas.getBoundingClientRect();

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (crop.pinchDist > 0) {
        photo.transform.zoom = Math.min(4, Math.max(1, (crop.baseZoom * dist) / crop.pinchDist));
        $('zoom').value = String(Math.min(3, photo.transform.zoom));
      }
    } else if (crop.dragging) {
      photo.transform.dx = crop.baseDx + (event.clientX - crop.startX) / rect.width;
      photo.transform.dy = crop.baseDy + (event.clientY - crop.startY) / rect.height;
    }
    drawCrop();
  });

  const release = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) crop.pinchDist = 0;
    if (pointers.size === 0) crop.dragging = false;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
}

// ---------------------------------------------------------------- printing

/** POST the page with a progress bar — uploads matter on a cellular booth. */
function uploadPrint(path, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', path);
    request.timeout = 120_000;
    request.setRequestHeader('content-type', blob.type || 'image/png');
    if (accessKey) request.setRequestHeader('x-booth-key', accessKey);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    request.addEventListener('load', () => {
      try {
        resolve({ status: request.status, data: JSON.parse(request.responseText) });
      } catch {
        reject(new Error('The booth sent back something unreadable.'));
      }
    });
    request.addEventListener('error', () => reject(new Error('network')));
    request.addEventListener('timeout', () => reject(new Error('network')));
    request.send(blob);
  });
}

/** Turn a job record into what the guest sees. */
function showJob(job) {
  if (job.status === 'awaiting-approval') {
    return showResult({
      emoji: '👀',
      title: 'Waiting for the host',
      body: 'Your print is in the queue — the booth host taps print. Stay close to the tray.',
      image: job.image,
      busy: true,
    });
  }
  if (job.status === 'pending') {
    return showResult({
      emoji: '⏳',
      title: 'In the queue',
      body: 'Your print is lined up — hang tight.',
      image: job.image,
      busy: true,
    });
  }
  if (job.status === 'printing' || job.status === 'claimed') {
    return showResult({
      emoji: '🖨️',
      title: session.dryRun ? 'Printing (dry run)' : 'Printing now!',
      body: session.dryRun
        ? 'Dry-run mode — nothing is sent to a real printer.'
        : `Your ${job.copies === 1 ? 'copy is' : `${job.copies} copies are`} coming out now. ${session.remote ? 'Collect it from the booth.' : 'Grab it from the tray.'}`,
      image: job.image,
      busy: true,
    });
  }
  if (job.status === 'failed') {
    return showResult({
      emoji: '🙃',
      title: 'The printer said no',
      body: `${job.error || 'Printing failed.'} You can still save the photo to your phone.`,
      image: job.image,
    });
  }
  if (job.status === 'rejected') {
    return showResult({
      emoji: '🤷',
      title: 'The host skipped this one',
      body: 'Ask them why. You can still save it to your phone.',
      image: job.image,
    });
  }
  // 'done' (or the legacy 'queued'): the print has finished.
  return showResult({
    emoji: '🎉',
    title: session.dryRun ? 'Saved (dry run)' : 'All done!',
    body: session.dryRun
      ? 'The booth is in dry-run mode, so nothing was sent to a real printer.'
      : `Your ${job.copies === 1 ? 'print is' : 'prints are'} ready — ${session.remote ? 'collect it from the booth.' : 'grab it from the tray.'}`,
    image: job.image,
  });
}

function clearQueueTimers() {
  if (queuePoll) { clearInterval(queuePoll); queuePoll = null; }
  if (queueTick) { clearInterval(queueTick); queueTick = null; }
}

/** Human ETA from a live remaining-seconds count. Coarse on purpose. */
function etaText(seconds) {
  if (seconds <= 5) return 'any moment now';
  if (seconds < 60) return 'in less than a minute';
  const mins = Math.round(seconds / 60);
  return `in about ${mins} minute${mins === 1 ? '' : 's'}`;
}

/** A print still on its way to / through the printer (not finished/failed). */
function isActiveJob(job) {
  return Boolean(job) && ['awaiting-approval', 'pending', 'printing', 'claimed'].includes(job.status);
}

/** True while the job is waiting behind others (worth the numbered queue screen).
 *  Once it reaches the printer ('printing'), we switch to the "Printing now" flow. */
function stillWaiting(job) {
  return job.status === 'pending' && Boolean(job.queue);
}

/** "You're number X in the queue. Ready in about Y." — recomputed live from
 *  readyAt so the countdown ticks without hammering the booth. */
function showQueue(job) {
  const q = job.queue;
  const seconds = Math.max(0, Math.round((q.readyAt - Date.now()) / 1000));
  showResult({
    emoji: '🧾',
    title: q.position <= 1 ? "You're next in line" : `You're number ${q.position} in the queue`,
    body: `Your print will be ready ${etaText(seconds)}. Tap Done to keep browsing — we'll keep your place.`,
    image: job.image,
  });
}

/** Compact ETA for the small round widget: "2 min", "<1 min", or "now". */
function compactEta(seconds) {
  if (seconds <= 5) return 'now';
  if (seconds < 60) return '<1 min';
  return `${Math.round(seconds / 60)} min`;
}

/** Fill the collapsed round queue widget (icon + place + ETA). */
function updateQueuePill(job) {
  let icon = '🧾', title = '', sub = '';
  if (stillWaiting(job)) {
    const seconds = Math.max(0, Math.round((job.queue.readyAt - Date.now()) / 1000));
    icon = '🧾';
    title = `#${job.queue.position} in line`;
    sub = compactEta(seconds);
  } else if (isActiveJob(job)) {
    icon = '🖨️';
    title = 'Printing';
    sub = 'now';
  } else if (job && (job.status === 'failed' || job.status === 'rejected')) {
    icon = '⚠️';
    title = 'Issue';
    sub = 'tap';
  } else {
    icon = '🎉';
    title = 'Printed';
    sub = 'tap';
  }
  $('qwIcon').textContent = icon;
  $('qwTitle').textContent = title;
  $('qwSub').textContent = sub;
}

/** Render the current job either as the full modal or, if collapsed, the pill. */
function renderJob(job) {
  currentJob = job;
  if (queueMinimized) {
    updateQueuePill(job);
    return;
  }
  const copies = (n) => (job.copies === 1 ? n[0] : n[1]);
  // If the transmit animation is still on screen, carry it straight through the
  // printing and done states — same canvas, only the words change — so there's no
  // flicker between "Sending" and "Printing now".
  if (sendRaf != null && (job.status === 'printing' || job.status === 'claimed')) {
    setAnimPhase('printing');
    setResultText('🖨️', session.dryRun ? 'Printing (dry run)' : 'Printing now!',
      session.dryRun
        ? 'Dry-run mode — nothing goes to a real printer.'
        : `${copies(['Your copy is', `Your ${job.copies} copies are`])} coming out now. ${session.remote ? 'Collect it from the booth.' : 'Grab it from the tray.'}`);
    $('resultDone').disabled = false;
    return;
  }
  if (sendRaf != null && (job.status === 'done' || job.status === 'queued')) {
    setAnimPhase('done');
    setResultText('🎉', session.dryRun ? 'Saved (dry run)' : 'All done!',
      session.dryRun
        ? 'The booth is in dry-run mode, so nothing was sent to a real printer.'
        : `${copies(['Your print is', 'Your prints are'])} ready — ${session.remote ? 'collect it from the booth.' : 'grab it from the tray.'}`);
    $('resultDone').disabled = false;
    return;
  }
  if (sendRaf != null && stillWaiting(job)) {
    // Waiting behind other prints — same canvas, the print held in line.
    setAnimPhase('queue');
    const seconds = Math.max(0, Math.round((job.queue.readyAt - Date.now()) / 1000));
    setResultText('🧾',
      job.queue.position <= 1 ? "You're next in line" : `You're number ${job.queue.position} in the queue`,
      `Your print will be ready ${etaText(seconds)}. Tap Done to keep browsing — we'll keep your place.`);
    $('resultDone').disabled = false;
    return;
  }
  // Fallbacks (reduced-motion, or the animation already stopped): the plain screens.
  if (stillWaiting(job)) showQueue(job);
  else showJob(job);
  // Done is always live on a real job: it minimises an active one, or closes a
  // finished one. (The transient "Building…/Sending…" screens keep it disabled.)
  $('resultDone').disabled = false;
}

/** Collapse the modal to the small queue pill, leaving tracking running. */
function minimizeQueue() {
  queueMinimized = true;
  $('result').classList.add('hidden');
  $('queuePill').classList.remove('hidden');
  updateQueuePill(currentJob);
}

/** Re-open the full modal from the pill. */
function restoreQueue() {
  queueMinimized = false;
  $('queuePill').classList.add('hidden');
  if (currentJob) renderJob(currentJob);
}

/** Dismiss the result entirely, KEEPING the current photos/design on screen. */
function closeResult() {
  clearQueueTimers();
  stopSendAnim();
  queueMinimized = false;
  currentJob = null;
  $('result').classList.add('hidden');
  $('queuePill').classList.add('hidden');
}

/** The result modal's Done button. */
function onResultDone() {
  if (isActiveJob(currentJob)) minimizeQueue(); // still printing → minimise, don't lose it
  else closeResult(); // finished/failed → close, but keep the photos as they are
}

/** Track a print through the queue and printer, updating the modal (or the pill,
 *  if collapsed) live, until it finishes. Never resets the guest's photos. */
function trackQueue(job) {
  clearQueueTimers();
  queueMinimized = false;
  $('queuePill').classList.add('hidden');
  renderJob(job);

  // A 1s ticker keeps the countdown smooth between booth polls.
  queueTick = setInterval(() => { if (currentJob) renderJob(currentJob); }, 1000);

  const deadline = Date.now() + 15 * 60_000;
  queuePoll = setInterval(async () => {
    let next;
    try {
      const response = await fetch(`/api/job?id=${encodeURIComponent(currentJob.id)}`);
      if (!response.ok) return;
      next = (await response.json()).job;
    } catch {
      return; // a blip — keep the last standing on screen and try again
    }
    renderJob(next);
    if (!isActiveJob(next) || Date.now() >= deadline) {
      // Finished (printed/failed/rejected): stop polling and the countdown, but
      // leave the final state on screen — modal if open, pill if collapsed.
      clearQueueTimers();
    }
  }, 2500);
}

function showResult({ emoji, title, body, image, busy }) {
  stopSendAnim(); // any non-sending result screen ends the transmit animation
  $('resultEmoji').textContent = emoji;
  $('resultTitle').textContent = title;
  $('resultBody').textContent = body;
  $('result').classList.remove('hidden');
  $('resultDone').disabled = Boolean(busy);
  const img = $('resultImage');
  if (image) {
    img.src = image;
    img.classList.remove('hidden');
  } else {
    img.classList.add('hidden');
  }
}

// ---- "sending to the printer" animation: the print dissolves into streaming
// 1/0 bits that fly into a little printer, which glows as it receives them.
let sendRaf = null;
let sendUrl = null;
let animPhase = 'sending'; // sending → queue → printing → done, all in one canvas

/** Update just the modal's text, leaving the live canvas in place (no swap). */
function setResultText(emoji, title, body) {
  $('resultEmoji').textContent = emoji;
  $('resultTitle').textContent = title;
  $('resultBody').textContent = body;
  $('result').classList.remove('hidden');
  $('resultImage').classList.add('hidden');
}

/** Move the running transmit animation to its next phase (no restart, no swap). */
function setAnimPhase(phase) {
  if (sendRaf == null || phase === animPhase) return;
  animPhase = phase;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawPrinter(ctx, cx, top, w, glow) {
  const bodyH = 62;
  const bx = cx - w / 2;
  const by = top;
  if (glow > 0.03) {
    ctx.save();
    ctx.shadowColor = `rgba(60,255,110,${glow})`;
    ctx.shadowBlur = 22;
    ctx.fillStyle = `rgba(60,255,110,${glow * 0.35})`;
    roundRect(ctx, bx, by + 4, w, bodyH, 12); ctx.fill();
    ctx.restore();
  }
  // intake slot (bits land here)
  ctx.fillStyle = '#0d0a12';
  roundRect(ctx, cx - w * 0.4, by - 2, w * 0.8, 7, 3); ctx.fill();
  // body
  ctx.fillStyle = '#2c2438';
  roundRect(ctx, bx, by + 4, w, bodyH, 12); ctx.fill();
  ctx.strokeStyle = '#4a3d5e'; ctx.lineWidth = 1;
  roundRect(ctx, bx, by + 4, w, bodyH, 12); ctx.stroke();
  // status light — green once bits are arriving
  ctx.fillStyle = glow > 0.25 ? '#5ad1a5' : '#4a3d5e';
  ctx.beginPath(); ctx.arc(bx + w - 15, by + bodyH - 12, 3.5, 0, Math.PI * 2); ctx.fill();
  // emerging print, nudged out as it receives
  const pw = w * 0.6;
  ctx.fillStyle = '#f6f1ef';
  roundRect(ctx, cx - pw / 2, by + bodyH - 2, pw, 15 + glow * 7, 3); ctx.fill();
}

/** The printer, now feeding the ACTUAL print out of its slot (printing phase). */
function drawPrinterPrinting(ctx, img, cx, top, w, pk, H) {
  drawPrinter(ctx, cx, top, w, 0.55); // active printer: body + green status light + glow
  const iw = img.naturalWidth || 3, ih = img.naturalHeight || 4, ar = iw / ih;
  const bodyH = 62, slotY = top + bodyH - 2;
  const availH = H - slotY - 6;
  let paperW = w * 0.62, paperH = paperW / ar;
  if (paperH > availH) { paperH = availH; paperW = paperH * ar; }
  const eh = Math.max(0, pk * paperH); // how far the print has emerged
  if (eh < 1) return;
  const x0 = cx - paperW / 2;
  ctx.fillStyle = '#f6f1ef';
  roundRect(ctx, x0 - 2, slotY, paperW + 4, eh + 2, 3); ctx.fill();
  // the photo on the paper — revealed top-first as it feeds out
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, slotY, paperW, eh); ctx.clip();
  ctx.drawImage(img, 0, 0, iw, Math.max(1, ih * (eh / paperH)), x0, slotY, paperW, eh);
  ctx.restore();
  // glowing print-head line at the leading edge
  ctx.save();
  ctx.strokeStyle = 'rgba(60,255,110,0.9)';
  ctx.shadowColor = 'rgba(60,255,110,0.9)';
  ctx.shadowBlur = 6; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x0, slotY + eh); ctx.lineTo(x0 + paperW, slotY + eh); ctx.stroke();
  ctx.restore();
}

/** The printer with the guest's print WAITING in line above it, a faint stack
 *  behind for the number of jobs ahead — the queue phase. */
function drawPrinterQueue(ctx, img, cx, top, w, H, ts) {
  drawPrinter(ctx, cx, top, w, 0.28); // idle-but-connected: dim green light
  const iw = img.naturalWidth || 3, ih = img.naturalHeight || 4, ar = iw / ih;
  let sw = w * 0.52, sh = sw / ar;
  const room = top - 8; // space above the printer's intake
  if (sh > room) { sh = room; sw = sh * ar; }
  const bob = Math.sin(ts / 520) * 2.5; // gentle "waiting" bob
  const sx = cx - sw / 2, sy = top - sh - 7 + bob;
  const pos = (currentJob && currentJob.queue && currentJob.queue.position) || 1;
  const ahead = Math.min(3, Math.max(0, pos - 1));
  // faint sheets behind = jobs ahead of you
  for (let i = ahead; i >= 1; i--) {
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#f6f1ef';
    roundRect(ctx, sx - i * 4, sy - i * 4, sw, sh, 3); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // your print, waiting
  ctx.fillStyle = '#f6f1ef';
  roundRect(ctx, sx - 2, sy - 2, sw + 4, sh + 4, 4); ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip();
  ctx.drawImage(img, sx, sy, sw, sh);
  ctx.restore();
}

function stopSendAnim() {
  if (sendRaf != null) { cancelAnimationFrame(sendRaf); sendRaf = null; }
  if (sendUrl) { URL.revokeObjectURL(sendUrl); sendUrl = null; }
  $('sendAnim').classList.add('hidden');
}

/** Show the transmit animation for the just-built print `img` (an <img>). */
function startSendAnim(img) {
  stopSendAnim();
  const canvas = $('sendAnim');
  canvas.classList.remove('hidden');
  $('resultImage').classList.add('hidden');

  const W = 190, H = 240;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Fit the photo into the top ~55% of the canvas.
  const pad = 8;
  const ar = (img.naturalWidth || 3) / (img.naturalHeight || 4);
  let pw = W - pad * 2, ph = pw / ar;
  const maxH = H * 0.5;
  if (ph > maxH) { ph = maxH; pw = ph * ar; }
  const px0 = (W - pw) / 2, py0 = pad;

  // Sample the photo into a small grid of colour cells.
  const cols = 20;
  const rows = Math.max(6, Math.round(cols / ar));
  const off = document.createElement('canvas'); off.width = cols; off.height = rows;
  const octx = off.getContext('2d'); octx.drawImage(img, 0, 0, cols, rows);
  const px = octx.getImageData(0, 0, cols, rows).data;
  const cw = pw / cols, ch = ph / rows;

  const mouthX = W / 2, mouthY = H * 0.66, printerW = 116;
  // One bit per grid cell, carrying that pixel's colour. Each cell converts when
  // the dissolve line reaches its row, then streams down to the printer.
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 4;
      cells.push({
        hx: px0 + c * cw + cw / 2,
        hy: py0 + r * ch + ch / 2,
        rowFrac: (r + 0.5) / rows, // where down the photo this cell sits (0 top → 1 bottom)
        col: `rgb(${px[i]},${px[i + 1]},${px[i + 2]})`,
        char: ((c + r) & 1) ? '1' : '0',
        wob: ((c * 5 + r * 3) % 11) / 11,
        tx: mouthX + ((((c * 5 + r * 3) % 11) / 11) - 0.5) * printerW * 0.7,
      });
    }
  }

  const T = 3200;      // full cycle (ms)
  const DISS = 0.62;   // the dissolve sweeps bottom→top over this fraction of the cycle
  const TRAVEL = 0.33; // a bit takes this fraction of the cycle to reach the printer
  let t0 = null, glow = 0;
  animPhase = 'sending';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.max(8, ch * 0.95)}px ui-monospace, "SF Mono", monospace`;

  // The photo + streaming bits (everything above the printer). `mult` fades the
  // whole scene, used to cross-fade cleanly into the printing phase.
  const drawUpper = (now, mult) => {
    const t = (now / T) % 1;
    const diss = Math.min(1, t / DISS);
    const yLine = py0 + (1 - diss) * ph; // line starts at the bottom, sweeps up
    if (diss < 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(px0, py0, pw, yLine - py0); // intact photo is ABOVE the line
      ctx.clip();
      ctx.globalAlpha = mult;
      ctx.drawImage(img, px0, py0, pw, ph);
      ctx.restore();
      if (diss > 0.002) {
        ctx.save();
        ctx.globalAlpha = mult;
        ctx.strokeStyle = 'rgba(60,255,120,0.9)';
        ctx.shadowColor = 'rgba(60,255,120,0.9)';
        ctx.shadowBlur = 8; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px0, yLine); ctx.lineTo(px0 + pw, yLine); ctx.stroke();
        ctx.restore();
      }
    }
    ctx.shadowColor = 'rgba(60,255,110,0.9)';
    for (const cell of cells) {
      const tm = (1 - cell.rowFrac) * DISS; // bottom rows dissolve first
      if (t <= tm) continue;
      const k = (t - tm) / TRAVEL;
      if (k >= 1) continue;
      const e = k * k * (3 - 2 * k);
      const x = cell.hx + (cell.tx - cell.hx) * e + Math.sin(k * 7 + cell.wob * 9) * 3.5 * (1 - e);
      const y = cell.hy + (mouthY - cell.hy) * e;
      ctx.globalAlpha = Math.min(1, (1 - k) * 1.6) * mult;
      ctx.fillStyle = k < 0.12 ? '#d8ffe4' : '#38ff74'; // white flare → matrix green
      ctx.shadowBlur = 7;
      ctx.fillText(cell.char, x, y);
      if (k > 0.9) glow = 1;
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  };

  // Timers/positions that carry across phases — the whole post-tap flow is one
  // continuous scene: sending → queue (waiting) → printing → done.
  let prevPhase = 'sending';
  let leftSending = 0; // ts we left 'sending' (fades the last bits in)
  let printAt = 0;     // ts the print started emerging
  let printerTop = mouthY; // eased each frame toward the phase's target position

  const step = (ts) => {
    if (t0 == null) t0 = ts;
    if (animPhase !== prevPhase) {
      if (prevPhase === 'sending') leftSending = ts;
      if ((animPhase === 'printing' || animPhase === 'done') && printAt === 0) printAt = ts;
      prevPhase = animPhase;
    }
    ctx.clearRect(0, 0, W, H);
    glow *= 0.9;

    // The printer sits low while receiving, then glides to centre to present the
    // print / hold the queue — one smooth move, no matter which phase is next.
    const targetTop = animPhase === 'sending' ? mouthY : H * 0.28;
    printerTop += (targetTop - printerTop) * 0.12;

    if (animPhase === 'sending') {
      drawUpper(ts - t0, 1);
      drawPrinter(ctx, mouthX, printerTop, printerW, glow);
      sendRaf = requestAnimationFrame(step);
      return;
    }

    // Fade out the last streaming bits as we leave sending.
    const cf = leftSending ? Math.min(1, (ts - leftSending) / 320) : 1;
    if (cf < 1) drawUpper(ts - t0, 1 - cf);

    if (animPhase === 'queue') {
      drawPrinterQueue(ctx, img, mouthX, printerTop, printerW, H, ts);
    } else {
      const pk = printAt ? Math.min(1, Math.max(0, (ts - printAt) / 800)) : 0;
      drawPrinterPrinting(ctx, img, mouthX, printerTop, printerW, pk, H);
    }
    sendRaf = requestAnimationFrame(step);
  };
  sendRaf = requestAnimationFrame(step);
}

/** Enter the "sending" screen with the transmit animation (or a static image if
 *  the guest prefers reduced motion). */
function beginSending(blob) {
  $('resultEmoji').textContent = '📡';
  $('resultTitle').textContent = 'Sending to the booth…';
  $('resultBody').textContent = 'Beaming your photo over.';
  $('result').classList.remove('hidden');
  $('resultDone').disabled = true;

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return; // keep it still for reduced-motion; the % text carries the progress
  }
  sendUrl = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => { if (sendUrl) startSendAnim(img); }; // still sending?
  img.src = sendUrl;
}

async function doPrint() {
  // The hosted (GitHub Pages) preview shows the Print button exactly like the
  // real booth, but there is no printer behind it — tapping it does nothing.
  if (session.previewNoPrint) return;
  if (filledCount() < 4) {
    toast('Four photos first.');
    return;
  }
  // A fresh print supersedes any queue standing (and its collapsed pill) on screen.
  clearQueueTimers();
  currentJob = null;
  queueMinimized = false;
  $('queuePill').classList.add('hidden');
  showResult({ emoji: '🖨️', title: 'Building your print…', body: 'Rendering at 600 DPI.', busy: true });

  let result;
  try {
    // Rotate a landscape design onto portrait 4×6 paper so it never prints
    // sideways. (Save-to-phone keeps the true orientation — it uses lastPrintBlob,
    // warmed separately, which we deliberately don't overwrite here.)
    result = await exportPrint(state, { rotateForPaper: true });
  } catch (err) {
    showResult({ emoji: '😵', title: 'Could not build the print', body: err.message });
    return;
  }

  const params = new URLSearchParams({
    layout: state.layoutId,
    copies: String(state.copies),
    guest: '',
    // The uploaded print is always portrait now (landscape gets rotated above).
    orient: result.width > result.height ? 'landscape' : 'portrait',
  });

  beginSending(result.blob); // the photo dissolves into bits streaming to the printer

  try {
    const { status, data } = await uploadPrint(`/api/print?${params}`, result.blob, (fraction) => {
      // Update just the progress line so the animation keeps running underneath.
      $('resultBody').textContent = `Beaming your photo over — ${Math.round(fraction * 100)}%`;
    });

    if (status === 401) {
      accessKey = '';
      try {
        localStorage.removeItem(KEY_STORAGE);
      } catch {
        /* nothing to clear */
      }
      showResult({
        emoji: '🔑',
        title: 'Scan the booth QR code',
        body: 'This booth only prints for guests who came in through its QR code. Scan it and try again — your photos stay put.',
      });
      return;
    }

    if (status < 200 || status >= 300 || !data.ok) {
      showResult({
        emoji: '🙃',
        title: 'The printer said no',
        body: `${data.error || 'Printing failed.'} You can still save the photo to your phone.`,
      });
      return;
    }

    trackQueue(data.job);
  } catch (err) {
    showResult({
      emoji: '📶',
      title: err.message === 'network' ? 'Lost the connection' : 'Something went wrong',
      body: 'Check your signal and try again — or save the photo to your phone.',
    });
  }
}

function printFile(blob) {
  const extension = blob.type === 'image/png' ? 'png' : 'jpg';
  return new File([blob], `photobooth-${Date.now()}.${extension}`, { type: blob.type || 'image/png' });
}

/** Last resort on desktop, or anywhere the share sheet is not offered. */
function downloadBlob(blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = printFile(blob).name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

/**
 * Hand the print to the phone's share sheet, where "Save Image" puts it in the
 * Photos app. A download link would only drop it in Files, which is not where
 * anyone looks for a photo.
 */
/** The share sheet's "Save Image" also lands in Photos — kept as the fallback. */
async function shareToPhotos(blob) {
  const file = printFile(blob);
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      toast('Saved to your phone.', 2400);
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return true; // guest closed the sheet
      if (err && err.name === 'NotAllowedError') {
        toast('Tap Share once more.', 2600);
        return true;
      }
    }
  }
  downloadBlob(blob);
  toast('Saved to your downloads.');
  return true;
}

async function buildPrintBlob() {
  if (lastPrintBlob) return lastPrintBlob;
  toast('Getting your photo ready…', 1200);
  try {
    // Save-to-phone quality (matches the warm render); the printer path renders fresh
    // at full PRINT_SCALE.
    lastPrintBlob = (await exportPrint(state, { scale: SAVE_SCALE })).blob;
    return lastPrintBlob;
  } catch (err) {
    toast(err.message || 'Could not build the photo.');
    return null;
  }
}


/** Save/Share hands the photo straight to the OS share sheet (Save to Photos,
 *  Messages, Facebook, etc. all live there) — no interstitial in the way. */
async function savePhoto() {
  if (filledCount() < 4) {
    toast('Four photos first.');
    return;
  }
  const blob = await buildPrintBlob();
  if (!blob) return;
  await shareToPhotos(blob);
}

// ---------------------------------------------------------------- session

let reconnectTimer = null;

async function loadSession() {
  let ok = false;
  try {
    const response = await fetch('/api/session', { cache: 'no-store' });
    if (response.ok) { Object.assign(session, await response.json(), { online: true }); ok = true; }
  } catch { /* booth unreachable — handled below */ }
  if (!ok) session.online = false;

  $('boothName').textContent = session.boothName;
  document.title = session.boothName;
  const msgEl = $('boothMessage');
  if (msgEl && session.message) msgEl.textContent = session.message;
  $('version').textContent = session.version ? `v${session.version}` : '';
  state.copies = Math.min(session.defaultCopies || 1, session.maxCopies || 3);

  // Print vs save-only — toggled BOTH ways, so when the booth comes back after a
  // restart or a dropped tunnel, printing turns itself back on with no refresh.
  const canPrint = session.online && session.printingEnabled;
  // No printer → the check reveals just Save (full width), no Print half.
  $('commit').classList.toggle('save-only', !canPrint);
  $('saveBtn').textContent = canPrint ? 'Save/Share' : 'Save / Share to phone';
  if (!$('commit').classList.contains('hidden')) layoutGoo(); // widen/normalise the save pill

  if (!session.online) {
    showProblem('Reconnecting to the booth… you can still save the photo to your phone.');
  } else if (session.keyRequired && !accessKey) {
    showProblem('Scan the booth QR code to unlock printing — you can still save to your phone.');
  } else {
    showProblem('');
  }

  scheduleRender();
  if (canPrint) refreshPrinter();

  // Keep trying while the booth is unreachable, so the page heals on its own.
  clearTimeout(reconnectTimer);
  if (!session.online) reconnectTimer = setTimeout(loadSession, 5000);
}

/** A one-line warning, shown only when something would stop a print. */
function showProblem(message) {
  const el = $('printProblem');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

/** No status chatter — the guest only hears about the printer when it matters. */
async function refreshPrinter() {
  try {
    const data = await (await fetch('/api/printers')).json();
    if (data.remote && !data.agentOnline) {
      showProblem('The booth printer is offline right now. You can still save to your phone.');
      return;
    }
    if (!data.printers.length) {
      showProblem('No printer is set up at the booth yet. You can still save to your phone.');
      return;
    }
    showProblem('');
  } catch {
    showProblem('Cannot reach the booth right now. You can still save to your phone.');
  }
}

// ---------------------------------------------------------------- wiring

function openPicker(replaceAll) {
  replaceAllNext = replaceAll;
  $('filePicker').value = '';
  $('filePicker').click();
}

function bind() {
  $('addAll').addEventListener('click', () => openPicker(filledCount() === 4));
  $('swapAll').addEventListener('click', () => openPicker(true)); // starts a fresh set of 4
  $('filePicker').addEventListener('change', (event) => acceptFiles(event.target.files));
  $('fileOne').addEventListener('change', (event) => {
    const slot = pendingSlot;
    pendingSlot = null;
    acceptFiles(event.target.files, slot);
  });

  $('checkBtn').addEventListener('click', () => {
    const commit = $('commit');
    commit.classList.add('open');
    clearTimeout(gooTimer);
    if (reduceMotion()) { setGooBlur(GOO_MIN); return; } // no goo pulse, just show the pair
    commit.classList.add('animating');
    // Hold the full blur while the pills split and the neck stretches, then ramp it to
    // ~0 so they resolve smoothly into crisp rounded rects; drop to the plain
    // drop-shadow only once the blur is already gone, so there's no shape pop.
    rampGooBlur(GOO_MAX, GOO_MIN, 470, 340, () => commit.classList.remove('animating'));
  });
  $('printBtn').addEventListener('click', doPrint);
  $('saveBtn').addEventListener('click', savePhoto);
  $('resultSave').addEventListener('click', savePhoto);
  $('resultDone').addEventListener('click', onResultDone);
  $('queuePill').addEventListener('click', restoreQueue);

  $('editorClose').addEventListener('click', closeEditor);
  $('editorDone').addEventListener('click', closeEditor);
  $('editor').addEventListener('click', (event) => {
    if (event.target === $('editor')) closeEditor();
  });
  $('zoom').addEventListener('input', (event) => {
    if (editorIndex === null) return;
    state.photos[editorIndex].transform.zoom = Number(event.target.value);
    drawCrop();
  });
  $('rotateBtn').addEventListener('click', () => {
    if (editorIndex === null) return;
    const t = state.photos[editorIndex].transform;
    t.rot = (t.rot + 90) % 360;
    drawCrop();
  });
  $('resetBtn').addEventListener('click', () => {
    if (editorIndex === null) return;
    state.photos[editorIndex].transform = { zoom: 1, dx: 0, dy: 0, rot: 0 };
    $('zoom').value = '1';
    drawCrop();
  });
  $('replaceBtn').addEventListener('click', () => {
    const index = editorIndex;
    closeEditor();
    pickInto(index);
  });
  $('removeBtn').addEventListener('click', () => {
    if (editorIndex === null) return;
    state.photos[editorIndex] = null;
    closeEditor();
  });
  $('moveLeft').addEventListener('click', () => swapEditor(-1));
  $('moveRight').addEventListener('click', () => swapEditor(1));
  $('makeHero').addEventListener('click', makeHero);

  bindCropGestures();
  bindCoverflow();
  window.addEventListener('resize', scheduleRender);
}

/** Move the photo being edited to the front, so it becomes the big hero. */
function makeHero() {
  if (editorIndex === null || editorIndex === 0) return;
  const [moved] = state.photos.splice(editorIndex, 1);
  state.photos.unshift(moved);
  editorIndex = 0;
  $('editorIndex').textContent = '1';
  updateHeroButton();
  sizeCropCanvas();
  drawCrop();
  scheduleRender();
}

/** The front photo is already the hero — hide the button there. */
function updateHeroButton() {
  const btn = document.getElementById('makeHero');
  if (btn) btn.classList.toggle('hidden', editorIndex === 0);
}

function swapEditor(direction) {
  if (editorIndex === null) return;
  const target = (editorIndex + direction + 4) % 4;
  const photos = state.photos;
  [photos[editorIndex], photos[target]] = [photos[target], photos[editorIndex]];
  editorIndex = target;
  $('editorIndex').textContent = String(target + 1);
  updateHeroButton();
  if (!photos[target]) {
    closeEditor();
    return;
  }
  sizeCropCanvas();
  drawCrop();
  scheduleRender();
}

bind();
loadSession();
scheduleRender();
