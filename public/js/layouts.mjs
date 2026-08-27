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

const GAP = 26; // uniform gutter between photos, in print pixels

/**
 * Lay groups of photos out as justified ROWS. Every cell is shaped to its own
 * photo's aspect ratio, so a contain-fit fills it exactly — no matting inside a
 * frame, no skew, and every photo keeps its true orientation. Each row is scaled
 * so the photos in it span the full width edge to edge (they touch, save for the
 * gutter). The stack of rows is scaled to fit the sheet and centred, so the only
 * whitespace is one thin, even margin on the axis the shapes could not fill.
 */
function justifyRows(page, groups, aspects) {
  const W = page.w;
  const H = page.h;
  const rows = groups.map((g) => {
    const sumA = g.reduce((s, i) => s + aspects[i], 0);
    return { g, h: (W - GAP * (g.length - 1)) / sumA };
  });
  const naturalH = rows.reduce((s, r) => s + r.h, 0) + GAP * (rows.length - 1);
  const scale = naturalH > H ? H / naturalH : 1;
  const finalW = W * scale;
  const finalH = naturalH * scale;
  const x0 = (W - finalW) / 2;
  let y = (H - finalH) / 2;

  const cells = [];
  for (const r of rows) {
    const h = r.h * scale;
    let x = x0;
    for (const i of r.g) {
      const w = aspects[i] * h;
      cells.push({ x, y, w, h, photo: i, fit: 'contain' });
      x += w + GAP * scale;
    }
    y += h + GAP * scale;
  }
  const area = cells.reduce((s, c) => s + c.w * c.h, 0);
  return { cells, coverage: area / (W * H) };
}

/** As justifyRows, but as COLUMNS: each group fills the full height, side by side. */
function justifyCols(page, groups, aspects) {
  const W = page.w;
  const H = page.h;
  const cols = groups.map((g) => {
    const sumInv = g.reduce((s, i) => s + 1 / aspects[i], 0);
    return { g, w: (H - GAP * (g.length - 1)) / sumInv };
  });
  const naturalW = cols.reduce((s, c) => s + c.w, 0) + GAP * (cols.length - 1);
  const scale = naturalW > W ? W / naturalW : 1;
  const finalW = naturalW * scale;
  const finalH = H * scale;
  const y0 = (H - finalH) / 2;
  let x = (W - finalW) / 2;

  const cells = [];
  for (const c of cols) {
    const w = c.w * scale;
    let y = y0;
    for (const i of c.g) {
      const h = w / aspects[i];
      cells.push({ x, y, w, h, photo: i, fit: 'contain' });
      y += h + GAP * scale;
    }
    x += w + GAP * scale;
  }
  const area = cells.reduce((s, c) => s + c.w * c.h, 0);
  return { cells, coverage: area / (W * H) };
}

/**
 * The best hero design for one photo: try the hero along the top, the bottom,
 * the left and the right, on both sheets, and keep whichever fills the most
 * paper. Because cells are shaped to their photos, "most paper filled" is the
 * layout with the least whitespace — nothing is cropped and nothing is skewed.
 */
function heroDesign(aspects, heroIndex) {
  const others = aspects.map((_, i) => i).filter((i) => i !== heroIndex);
  const plans = [
    { arrange: 'top', fn: justifyRows, groups: [[heroIndex], others] },
    { arrange: 'bottom', fn: justifyRows, groups: [others, [heroIndex]] },
    { arrange: 'left', fn: justifyCols, groups: [[heroIndex], others] },
    { arrange: 'right', fn: justifyCols, groups: [others, [heroIndex]] },
  ];
  let best = null;
  for (const paper of [PORTRAIT_4X6, LANDSCAPE_6X4]) {
    const page = { w: paper.w, h: paper.h };
    for (const plan of plans) {
      const laid = plan.fn(page, plan.groups, aspects);
      if (!best || laid.coverage > best.coverage) {
        best = { ...laid, page, media: paper.media, paper: paper.paper, arrange: plan.arrange };
      }
    }
  }
  // Hero cell first, whatever the placement — downstream code reads cells[0] as
  // the hero (the crop editor, the "biggest photo" checks).
  best.cells.sort((a, b) => (a.photo === heroIndex ? -1 : b.photo === heroIndex ? 1 : a.photo - b.photo));
  return best;
}

/** Best no-hero layout: the four photos packed to fill the sheet as fully as they can. */
function evenGrid(aspects) {
  const plans = [
    (p) => justifyRows(p, [[0, 1], [2, 3]], aspects),
    (p) => justifyCols(p, [[0, 2], [1, 3]], aspects),
    (p) => justifyRows(p, [[0, 1, 2, 3]], aspects),
    (p) => justifyCols(p, [[0], [1], [2], [3]], aspects),
  ];
  let best = null;
  for (const paper of [PORTRAIT_4X6, LANDSCAPE_6X4]) {
    const page = { w: paper.w, h: paper.h };
    for (const fn of plans) {
      const laid = fn(page);
      if (!best || laid.coverage > best.coverage) {
        best = { ...laid, page, media: paper.media, paper: paper.paper };
      }
    }
  }
  return best;
}

const ARRANGE_SUB = { top: 'on top', bottom: 'on the bottom', left: 'on the left', right: 'on the right' };

/**
 * The booth's own pick: photo 0 as the hero (unless told otherwise), in the
 * placement and on the sheet that fill the most paper without cropping.
 */
export function resolveGrid(base, photos, heroIndex = 0) {
  const d = heroDesign(photos.map(photoAspect), heroIndex);
  return { cells: d.cells, captions: [], page: d.page, media: d.media, paper: d.paper };
}

/**
 * The designs offered as cards in the picker: each photo as the big hero (placed
 * and sized to fill the most paper), plus an even layout with no hero. Photo 0
 * leads, so the default card matches resolveGrid. Every design shapes its cells
 * to the real photos, so nothing is cropped, nothing is skewed, and the only
 * whitespace is one thin even margin.
 */
export function designVariants(base, photos) {
  const aspects = photos.map(photoAspect);

  const out = photos.map((_, hero) => {
    const d = heroDesign(aspects, hero);
    return {
      key: `hero:${hero}`,
      kind: 'hero',
      heroIndex: hero,
      arrange: d.arrange,
      title: `Big #${hero + 1}`,
      sub: ARRANGE_SUB[d.arrange],
      captions: [],
      cells: d.cells,
      page: d.page,
      media: d.media,
      paper: d.paper,
    };
  });

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

// Every watercolor paper the app ships with — served from /backgrounds. Listed by
// orientation; a design picks one so cards don't all repeat the same sheet.
export const WATERCOLOR_ART = {
  portrait: ['backgrounds/paper-portrait-1.jpg', 'backgrounds/paper-portrait-2.jpg', 'backgrounds/paper-portrait-3.jpg'],
  land: ['backgrounds/paper-land-1.jpg', 'backgrounds/paper-land-2.jpg', 'backgrounds/paper-land-3.jpg'],
};

export const FRAMES = {
  // Watercolor "kids" paper: a decorative full-bleed background with the photos matted
  // into the clear centre — rounded, shadowed, bright-bordered (see the mockups).
  watercolor: {
    id: 'watercolor', name: 'Watercolor', bg: '#f7f3ea', ink: '#4a3b2c', accent: '#c98d9c',
    art: WATERCOLOR_ART,
    sticker: 'backgrounds/sticker.png', // one per page, auto-placed in the least-covering corner
    stickerW: 0.32,                     // sticker width as a fraction of the page width
    insetX: 0.075, insetY: 0.065,
    cell: { radius: 0.07, borderW: 0.02, borders: ['#f5a623', '#4aa8c9', '#7cc04a', '#ef6f8a', '#5cc0be', '#f6c445'] },
  },
  white: { id: 'white', name: 'White', bg: '#ffffff', ink: '#101010', accent: '#9a9a9a' },
  black: { id: 'black', name: 'Black', bg: '#111111', ink: '#f5f5f5', accent: '#8a8a8a' },
  cream: { id: 'cream', name: 'Cream', bg: '#f4ece0', ink: '#4a3b2c', accent: '#b9a68e' },
  blush: { id: 'blush', name: 'Blush', bg: '#f7dfe4', ink: '#7a3b48', accent: '#c98d9c' },
};

export const DEFAULT_TRANSFORM = { zoom: 1, dx: 0, dy: 0, rot: 0 };
