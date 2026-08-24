// Print layouts. Every page is described in real pixels at 300 DPI, so the
// canvas we compose on the phone is literally the file that goes to the tray.

const DPI = 300;
const inches = (n) => Math.round(n * DPI);

function stripLayout() {
  // Two identical 2x6 strips on one 4x6 sheet — cut down the middle.
  const page = { w: inches(4), h: inches(6) };
  const stripW = page.w / 2;
  const pad = 44;
  const gap = 22;
  const footer = 150;
  const cellW = stripW - pad * 2;
  const cellH = Math.floor((page.h - pad * 2 - footer - gap * 3) / 4);
  const cells = [];
  for (let copy = 0; copy < 2; copy++) {
    for (let i = 0; i < 4; i++) {
      cells.push({
        x: copy * stripW + pad,
        y: pad + i * (cellH + gap),
        w: cellW,
        h: cellH,
        photo: i,
      });
    }
  }
  const captionY = pad + 4 * cellH + 3 * gap;
  return {
    id: 'strip',
    name: 'Classic strip',
    blurb: 'Two 2×6 strips on one 4×6 — keep one, give one away',
    paper: '4×6 portrait',
    media: 'Custom.4x6in',
    page,
    cells,
    captions: [
      { x: pad, y: captionY, w: cellW, h: page.h - pad - captionY },
      { x: stripW + pad, y: captionY, w: cellW, h: page.h - pad - captionY },
    ],
    cutLine: { x: stripW, y1: 0, y2: page.h },
  };
}

function gridLayout() {
  // Cells are computed per print from the real photos (see resolveGrid), so a
  // mix of portrait and landscape shots each fit without cropping. The static
  // values here are just the defaults; resolveGrid fills the sheet edge to edge.
  const page = { w: inches(4), h: inches(6) };
  return {
    id: 'grid',
    name: 'Auto grid',
    blurb: 'One big hero photo with three beside it — nothing cropped',
    paper: '4×6 portrait',
    media: 'Custom.4x6in',
    page,
    dynamic: true,
    cells: [], // filled in by resolveGrid at render time
    captions: [],
    cutLine: null,
  };
}

/** Aspect ratio (w/h) a photo occupies, honouring a 90° rotation. */
function photoAspect(photo) {
  if (!photo || !photo.bitmap) return 3 / 4; // an empty slot stands in as portrait
  const t = photo.transform || {};
  const swap = Math.abs((t.rot || 0) % 180) === 90;
  const w = swap ? photo.bitmap.height : photo.bitmap.width;
  const h = swap ? photo.bitmap.width : photo.bitmap.height;
  return w / h || 3 / 4;
}

const PORTRAIT_4X6 = { w: inches(4), h: inches(6), media: 'Custom.4x6in', paper: '4×6 portrait' };
const LANDSCAPE_6X4 = { w: inches(6), h: inches(4), media: 'Custom.6x4in', paper: '6×4 landscape' };

const GAP = 26;         // uniform gutter between photos, in print pixels
const HERO_FRAC = 0.64; // the hero's share of the long axis

/** How much of a photo survives a contain-fit into a cell (1 = it matches exactly). */
function kept(photoAspect, cellAspect) {
  return Math.min(photoAspect, cellAspect) / Math.max(photoAspect, cellAspect);
}

/**
 * A hero grid that reaches all four paper edges with a uniform gutter between
 * the photos and NO outer margin. Photos contain-fit inside their cells, so
 * nothing is ever cropped; where a photo's shape differs from its cell it gets a
 * little matting, but the grid itself is flush to the paper on every side.
 *
 * arrange 'top' = hero across the top, three along the bottom;
 * arrange 'left' = hero down the left, three stacked on the right.
 */
function heroGrid(page, aspects, heroIndex, arrange) {
  const W = page.w;
  const H = page.h;
  const others = aspects.map((_, i) => i).filter((i) => i !== heroIndex);
  const cells = [];

  if (arrange === 'top') {
    const heroH = (H - GAP) * HERO_FRAC;
    const thumbH = H - GAP - heroH;
    const tw = (W - GAP * 2) / 3;
    cells.push({ x: 0, y: 0, w: W, h: heroH, photo: heroIndex, fit: 'contain' });
    others.forEach((idx, k) => {
      cells.push({ x: k * (tw + GAP), y: heroH + GAP, w: tw, h: thumbH, photo: idx, fit: 'contain' });
    });
  } else {
    const heroW = (W - GAP) * HERO_FRAC;
    const thumbW = W - GAP - heroW;
    const th = (H - GAP * 2) / 3;
    cells.push({ x: 0, y: 0, w: heroW, h: H, photo: heroIndex, fit: 'contain' });
    others.forEach((idx, k) => {
      cells.push({ x: heroW + GAP, y: k * (th + GAP), w: thumbW, h: th, photo: idx, fit: 'contain' });
    });
  }

  // Prefer the arrangement whose cells best match the photos, so the matting is
  // as small as possible. The hero counts double — keeping the star clean matters.
  const score = cells.reduce((acc, c) => {
    const weight = c.photo === heroIndex ? 2 : 1;
    return acc + kept(aspects[c.photo], c.w / c.h) * weight;
  }, 0) / (others.length + 2);
  return { cells, score };
}

/**
 * The best sheet orientation for one hero placement — the arrangement is fixed,
 * only the paper is chosen, so both 'top' and 'left' can be offered side by side.
 */
function heroDesign(aspects, heroIndex, arrange) {
  let best = null;
  for (const paper of [PORTRAIT_4X6, LANDSCAPE_6X4]) {
    const page = { w: paper.w, h: paper.h };
    const laid = heroGrid(page, aspects, heroIndex, arrange);
    if (!best || laid.score > best.score) {
      best = { cells: laid.cells, score: laid.score, page, media: paper.media, paper: paper.paper };
    }
  }
  return best;
}

/**
 * Four equal cells in a 2×2, flush to every edge with uniform gutters and no
 * hero. Whichever sheet mats the photos least wins. Nothing is cropped.
 */
function evenGrid(aspects) {
  let best = null;
  for (const paper of [PORTRAIT_4X6, LANDSCAPE_6X4]) {
    const W = paper.w;
    const H = paper.h;
    const cw = (W - GAP) / 2;
    const ch = (H - GAP) / 2;
    const cells = [
      { x: 0, y: 0, w: cw, h: ch, photo: 0, fit: 'contain' },
      { x: cw + GAP, y: 0, w: cw, h: ch, photo: 1, fit: 'contain' },
      { x: 0, y: ch + GAP, w: cw, h: ch, photo: 2, fit: 'contain' },
      { x: cw + GAP, y: ch + GAP, w: cw, h: ch, photo: 3, fit: 'contain' },
    ];
    const score = aspects.reduce((s, a) => s + kept(a, cw / ch), 0) / aspects.length;
    if (!best || score > best.score) {
      best = { cells, score, page: { w: W, h: H }, media: paper.media, paper: paper.paper };
    }
  }
  return best;
}

/**
 * Pick the hero placement and sheet orientation with the least matting, while
 * always filling the paper edge to edge. Photo 0 is the hero unless told otherwise.
 */
export function resolveGrid(base, photos, heroIndex = 0) {
  const aspects = photos.map(photoAspect);
  let best = null;
  for (const arrange of ['top', 'left']) {
    const d = heroDesign(aspects, heroIndex, arrange);
    if (!best || d.score > best.score) best = d;
  }
  return { cells: best.cells, captions: [], page: best.page, media: best.media, paper: best.paper };
}

/**
 * The designs worth offering the guest as cards in the picker: each photo as the
 * hero — placed the way that fits it best (top vs side, portrait vs landscape) —
 * plus an even 2×2 with no hero. The auto-best design leads, so the default card
 * prints exactly as the booth would on its own. Every design fills the sheet edge
 * to edge and crops nothing; a card is only offered in its best arrangement, so
 * none of them come out looking half-empty.
 */
export function designVariants(base, photos) {
  const aspects = photos.map(photoAspect);

  // For each hero, keep only its best placement — the arrangement plus sheet
  // orientation that leaves the least matting. Photo 0 leads, so the default
  // card heroes the first photo picked, exactly as resolveGrid does.
  const heroes = photos.map((_, hero) => {
    let best = null;
    for (const arrange of ['top', 'left']) {
      const d = heroDesign(aspects, hero, arrange);
      if (!best || d.score > best.score) best = { ...d, heroIndex: hero, arrange };
    }
    return best;
  });

  const out = heroes.map((d) => ({
    key: `hero:${d.heroIndex}`,
    kind: 'hero',
    heroIndex: d.heroIndex,
    arrange: d.arrange,
    title: `Big #${d.heroIndex + 1}`,
    sub: d.arrange === 'top' ? 'on top' : 'on the side',
    captions: [],
    cells: d.cells,
    page: d.page,
    media: d.media,
    paper: d.paper,
  }));

  out.push({ key: 'even', kind: 'even', title: 'Four equal', sub: 'no big one', captions: [], ...evenGrid(aspects) });
  return out;
}

function filmstripLayout() {
  // Four tall frames across a 6x4 landscape sheet.
  const page = { w: inches(6), h: inches(4) };
  const pad = 56;
  const gap = 24;
  const footer = 132;
  const cellW = Math.floor((page.w - pad * 2 - gap * 3) / 4);
  const cellH = page.h - pad * 2 - footer;
  const cells = [];
  for (let i = 0; i < 4; i++) {
    cells.push({ x: pad + i * (cellW + gap), y: pad, w: cellW, h: cellH, photo: i });
  }
  const captionY = pad + cellH;
  return {
    id: 'filmstrip',
    name: 'Wide filmstrip',
    blurb: 'Four tall frames on a 6×4 landscape print',
    paper: '6×4 landscape',
    media: 'Custom.6x4in',
    page,
    cells,
    captions: [{ x: pad, y: captionY, w: page.w - pad * 2, h: page.h - pad - captionY }],
    cutLine: null,
  };
}

export const LAYOUTS = {
  strip: stripLayout(),
  grid: gridLayout(),
  filmstrip: filmstripLayout(),
};

export const LAYOUT_ORDER = ['strip', 'grid', 'filmstrip'];

export const FRAMES = {
  white: { id: 'white', name: 'White', bg: '#ffffff', ink: '#101010', accent: '#9a9a9a' },
  black: { id: 'black', name: 'Black', bg: '#111111', ink: '#f5f5f5', accent: '#8a8a8a' },
  cream: { id: 'cream', name: 'Cream', bg: '#f4ece0', ink: '#4a3b2c', accent: '#b9a68e' },
  blush: { id: 'blush', name: 'Blush', bg: '#f7dfe4', ink: '#7a3b48', accent: '#c98d9c' },
};

export const DEFAULT_TRANSFORM = { zoom: 1, dx: 0, dy: 0, rot: 0 };
