import { LAYOUTS, LAYOUT_ORDER, FRAMES, designVariants } from './layouts.mjs';
import { FILTERS, FILTER_ORDER } from './filters.mjs';
import { composePage, exportPrint, drawSinglePhoto, clampTransform, resolveLayout } from './render.mjs';

const $ = (id) => document.getElementById(id);
const MAX_SOURCE_DIM = 2400; // plenty for a 300 DPI cell, gentle on phone memory

// One layout, one look, one paper. The guest picks photos and prints — that is
// the whole app.
const state = {
  layoutId: 'grid',
  frameId: 'white',
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

function previewScale(layout) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const cssWidth = Math.min(300, window.innerWidth * 0.78);
  return Math.min(1, (cssWidth * dpr) / layout.page.w);
}

function renderAll() {
  const full = filledCount() === 4;
  const justCompleted = full && !wasComplete; // the set went from incomplete → full
  wasComplete = full;
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
  $('fbBtn').disabled = !full;
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

  warmTimer = setTimeout(() => {
    const generation = printGeneration;
    exportPrint(state)
      .then((result) => {
        if (generation === printGeneration) lastPrintBlob = result.blob;
      })
      .catch(() => {
        /* a real Save or Print will surface the failure */
      });
  }, 500);
}

/** The picker is the main event: one tap should get all four photos. */
function updatePickButton() {
  const missing = 4 - filledCount();
  const full = missing === 0;
  const button = $('addAll');
  const label = $('pickLabel');

  if (missing === 4) label.textContent = 'Pick 4 photos';
  else if (missing > 0) label.textContent = `Add ${missing} more`;

  button.classList.toggle('btn-primary', missing > 0);
  button.classList.toggle('btn-ghost', missing === 0);

  // Before the print is full: the single preview and the pick button. Once it is
  // full: the coverflow of designs takes over the stage.
  $('singleWrap').classList.toggle('hidden', full);
  $('coverflow').classList.toggle('hidden', !full);
  $('cfLabel').classList.toggle('hidden', !full);
  $('swapAll').classList.toggle('hidden', !full);
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
  const d = cfDesigns[i];
  state.designKey = d.key;
  $('cfTitle').textContent = d.sub ? `${d.title} · ${d.sub}` : d.title;
  $('cfCount').textContent = `${i + 1} / ${cfDesigns.length}`;
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
}

/** Bounce off an end: overshoot a touch past the edge, then spring back to it —
 *  the iOS "you've hit the end of the list" feel. */
function bounceEdge(edge) {
  cfBounceBack = edge;
  cfTarget = edge + (edge === 0 ? -0.3 : 0.3);
  if (cfRaf == null) cfRaf = requestAnimationFrame(glideStep);
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

function stopIntro() {
  if (introRaf != null) {
    cancelAnimationFrame(introRaf);
    introRaf = null;
    cfBusy = false;
    positionCards();
  }
}

const easeOutCubic2 = (t) => 1 - Math.pow(1 - t, 3);
// Whips in fast and is STILL MOVING at the end (velocity ~0.85 at t=1, not 0),
// so the sweep reaches the far edge with momentum and reverses on contact —
// no decelerating crawl, hence no pause, before the slingshot back.
const easeSwipeIn = (t) => Math.pow(t, 0.85);

/**
 * Intro sweep, played whenever the photos are freshly completed. It is a real
 * coverflow scroll — driven by cfPos, so every card rotates and scales through
 * the centre as if a user swiped hard. The deck starts off the right edge (cfPos
 * a few slots before the first design, cards edge-on), whips right-to-left, and
 * when it hits the rightmost design it doesn't stop — it reaches the edge still
 * moving (easeSwipeIn keeps momentum to the end) and reverses on contact,
 * slingshotting straight back to the middle with no dwell at the far end.
 * Interruptible: any touch on a picture cancels it.
 */
function runIntro() {
  const last = cfDesigns.length - 1;
  const middle = Math.floor(cfDesigns.length / 2);
  const startPos = -Math.min(3, last); // begin off to the right, cards edge-on
  const over = last + rubber(0.9); // overshoot the edge with the same elastic give
  cfBusy = true;
  clearTimeout(warmTimer);
  cfPos = startPos;
  setCurrent(clampPos(Math.round(cfPos)));
  positionCards();

  // Swipe hard through the deck to just past the rightmost (arriving with
  // momentum, so it turns on contact — no pause), then slingshot back to middle.
  const legs = [
    { to: over, dur: 900, ease: easeSwipeIn },
    { to: middle, dur: 720, ease: easeOutCubic2 },
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
  cfDesigns = designVariants(base, state.photos);
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

/** The drop shadow for a paper lifted to `scale` off its resting spot. It is tied
 *  DIRECTLY to size: zero at rest (the paper is on the glass), growing bigger,
 *  softer and darker as it rises. Because it is zero at scale 1, it fades to
 *  nothing exactly as the paper returns to size — no pop. Screen-space values are
 *  divided by scale since the shadow rides the same transform that enlarges the
 *  paper. Tunable: base(at rest) + lift*growth → value fully lifted. */
function paperShadow(scale) {
  const lift = Math.min(1, Math.max(0, (scale - 1) / 2)); // 0 at rest → 1 at max zoom (scale 3)
  if (lift <= 0.001) return 'none';
  // sqrt ramps the shadow up fast off zero — bold even at a small pinch, yet
  // still nothing at rest. Two stacked layers make it dramatic: a tight, near-
  // black CORE right under the print for a hard, defined edge, plus a big soft
  // HALO for spread. All screen-space, divided by scale (the shadow rides the
  // paper's transform). Tunable:  value = t * growth.
  const t = Math.sqrt(lift);
  const core = `drop-shadow(0 ${(t * 44) / scale}px ${(t * 34) / scale}px rgba(0, 0, 0, ${t * 1.0}))`;
  const halo = `drop-shadow(0 ${(t * 120) / scale}px ${(t * 150) / scale}px rgba(0, 0, 0, ${t * 0.7}))`;
  return `${core} ${halo}`;
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Drop the peek: spring the paper, its reflection, AND the shadow back to rest
 *  together, in one JS animation, so the shadow tracks the paper's actual size
 *  the whole way down and shrinks to nothing as it lands — never snapping off. */
function endPeek(state) {
  const { paper, face, mirror, tx, ty, rot, scale } = state;
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
    face.style.filter = paperShadow(s);
    if (e < 1) { peekRaf = requestAnimationFrame(step); return; }
    paper.style.transform = '';
    mirror.style.transform = '';
    face.style.filter = '';
    peekRaf = null;
  };
  peekRaf = requestAnimationFrame(step);
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
    cfPos = clampPos(Math.round(cfPos)); // settle dead-centre before zooming
    positionCards();
    const paper = centrePaper();
    if (!paper) return;
    const face = paper.querySelector('canvas.cf-face');
    const mirror = paper.parentElement.querySelector('canvas.cf-mirror');
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
    manip.face.style.filter = paperShadow(scale); // shadow grows directly with the size
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
    if (pointers.size === 0) {
      const px = event.clientX;
      const py = event.clientY;
      const onPicture = [...$('cfTrack').children].some((card) => {
        if (card.style.opacity === '0') return false; // an off-stage, hidden card
        const r = card.querySelector('canvas.cf-face').getBoundingClientRect();
        return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
      });
      if (!onPicture) return; // outside every picture — leave it to the page
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
      // A tap: jump to the card under the finger, or settle to the nearest.
      const card = event.target.closest('.cf-card');
      const i = card ? [...$('cfTrack').children].indexOf(card) : -1;
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
  toast(tooMany ? 'A print holds 4 — using the first four you picked.' : list.length > 1 ? 'Loading your photos…' : 'Loading…', tooMany ? 3200 : 1400);

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

  // Do not talk over the "only four fit" notice — that one is news.
  if (filledCount() === 4 && !tooMany) toast('Looking good — print it, or save it to your phone.', 2400);
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

const WAITING = ['awaiting-approval', 'pending', 'claimed', 'printing'];

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
  if (WAITING.includes(job.status)) {
    return showResult({
      emoji: '📡',
      title: 'Sending it to the booth',
      body: 'The printer is picking up your photos now.',
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
  return showResult({
    emoji: '🎉',
    title: session.dryRun ? 'Saved (dry run)' : 'Printing now!',
    body: session.dryRun
      ? 'The booth is in dry-run mode, so nothing was sent to a real printer.'
      : `${job.copies} ${job.copies === 1 ? 'copy' : 'copies'} on the way${job.cupsJobId ? ` · job ${job.cupsJobId}` : ''}. ${session.remote ? 'Collect it from the booth.' : 'Grab it from the tray.'}`,
    image: job.image,
  });
}

/** Follow a job until the printer has actually taken it. */
async function trackJob(job) {
  const deadline = Date.now() + 120_000;
  let current = job;
  while (WAITING.includes(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const response = await fetch(`/api/job?id=${encodeURIComponent(current.id)}`);
      if (!response.ok) return;
      const data = await response.json();
      current = data.job;
    } catch {
      return;
    }
    showJob(current);
  }
}

function showResult({ emoji, title, body, image, busy }) {
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

async function doPrint() {
  if (filledCount() < 4) {
    toast('Four photos first.');
    return;
  }
  showResult({ emoji: '🖨️', title: 'Building your print…', body: 'Rendering at 300 DPI.', busy: true });

  let result;
  try {
    result = await exportPrint(state);
  } catch (err) {
    showResult({ emoji: '😵', title: 'Could not build the print', body: err.message });
    return;
  }
  lastPrintBlob = result.blob;

  const params = new URLSearchParams({
    layout: state.layoutId,
    copies: String(state.copies),
    guest: '',
    orient: resolveLayout(state).page.w > resolveLayout(state).page.h ? 'landscape' : 'portrait',
  });

  try {
    const { status, data } = await uploadPrint(`/api/print?${params}`, result.blob, (fraction) => {
      showResult({
        emoji: '📤',
        title: 'Sending to the booth…',
        body: `${Math.round(fraction * 100)}% uploaded`,
        busy: true,
      });
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

    showJob(data.job);
    trackJob(data.job);
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
let saveObjectUrl = null;

function isTouchDevice() {
  return 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
}

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
    lastPrintBlob = (await exportPrint(state)).blob;
    return lastPrintBlob;
  } catch (err) {
    toast(err.message || 'Could not build the photo.');
    return null;
  }
}

const DEFAULT_HASHTAG = '#bff2026';

/** A web-sized JPEG of the print — small and quick to hand off to the app. */
async function buildShareBlob() {
  const layout = resolveLayout(state);
  const scale = Math.min(1, 1200 / Math.max(layout.page.w, layout.page.h));
  const canvas = document.createElement('canvas');
  composePage(canvas, state, scale);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
}

/**
 * Hand the photo to the Facebook app, where the guest is already signed in. The
 * share sheet is the only door a website has to the installed app — Apple and
 * Facebook don't expose a link that jumps straight into the app's composer — so
 * tapping Facebook there opens the app's own post screen with the photo attached
 * and #bff2026 pre-filled (the guest types their own words in front). On a desktop
 * with no app to share to, it falls back to Facebook's web share for the link.
 */
async function shareToFacebook() {
  if (filledCount() < 4) {
    toast('Four photos first.');
    return;
  }
  const caption = session.shareHashtag || DEFAULT_HASHTAG;
  const blob = await buildShareBlob();
  if (!blob) return;
  const file = new File([blob], `photobooth-${Date.now()}.jpg`, { type: 'image/jpeg' });

  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: caption });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return; // guest backed out — leave it
      // any other error → fall through to the desktop link share
    }
  }

  // Desktop / no app share available: open Facebook's web share for the booth link.
  const url = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(location.origin)}&hashtag=${encodeURIComponent(caption)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * On a phone, show the finished photo big and let the guest press-and-hold it —
 * iOS and Android both offer "Save to Photos" / "Download image" from that, and
 * it goes straight to the camera roll with no share sheet in the way. On a
 * desktop, where there is no long-press, go straight to share/download.
 */
async function savePhoto() {
  if (filledCount() < 4) {
    toast('Four photos first.');
    return;
  }
  const blob = await buildPrintBlob();
  if (!blob) return;

  if (!isTouchDevice()) {
    await shareToPhotos(blob);
    return;
  }

  if (saveObjectUrl) URL.revokeObjectURL(saveObjectUrl);
  saveObjectUrl = URL.createObjectURL(blob);
  $('saveImage').src = saveObjectUrl;
  $('saveSheet').classList.remove('hidden');
}

function closeSaveSheet() {
  $('saveSheet').classList.add('hidden');
  if (saveObjectUrl) {
    URL.revokeObjectURL(saveObjectUrl);
    saveObjectUrl = null;
  }
}

function resetBooth() {
  state.photos = [null, null, null, null];
  lastPrintBlob = null;
  overflowCursor = 0;
  replaceAllNext = false;
  $('result').classList.add('hidden');
  scheduleRender();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------- session

async function loadSession() {
  try {
    const response = await fetch('/api/session');
    const data = await response.json();
    Object.assign(session, data, { online: true });
  } catch {
    session.online = false;
  }

  $('boothName').textContent = session.boothName;
  document.title = session.boothName;
  if (session.message) $('boothMessage').textContent = session.message;
  $('version').textContent = session.version ? `v${session.version}` : '';
  state.copies = Math.min(session.defaultCopies || 1, session.maxCopies || 3);

  if (session.keyRequired && !accessKey) {
    showProblem('Scan the booth QR code to unlock printing — you can still save to your phone.');
  }

  if (!session.printingEnabled || !session.online) {
    $('printBtn').classList.add('hidden');
    $('saveBtn').classList.remove('btn-ghost');
    $('saveBtn').classList.add('btn-primary');
    $('saveBtn').textContent = 'Save to phone';
    $('saveBtn').style.flex = '1';
  }
  scheduleRender();
  if (session.online && session.printingEnabled) refreshPrinter();
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

  $('printBtn').addEventListener('click', doPrint);
  $('saveBtn').addEventListener('click', savePhoto);
  $('fbBtn').addEventListener('click', shareToFacebook);
  $('resultSave').addEventListener('click', savePhoto);
  $('saveClose').addEventListener('click', closeSaveSheet);
  $('saveShare').addEventListener('click', async () => {
    const blob = await buildPrintBlob();
    if (blob) await shareToPhotos(blob);
  });
  $('resultDone').addEventListener('click', resetBooth);

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
