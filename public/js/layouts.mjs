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

// The sticker asset's own aspect ratio (w/h) — the small corner badge is shaped to
// this so the art fills it exactly.
const STICKER_AR = 1448 / 1086;

// The picker grid is computed by OPTIMIZATION, not a fixed template (see CLAUDE.md).
// Nothing is cropped: every cell has its photo's exact aspect ratio, so the whole photo
// shows. We search sheet orientation × arrangements and keep the one with the greatest
// coverage, subject to the rules: one hero, hero ≤ 2× the smallest photo, and the sticker
// a real 5th cell that is never the hero. Whole photos can't tile a rectangle, so the
// leftover is the decorative paper (matting) — that slack is the cost of "no crop", and
// holding the hero to 2× keeps every photo near-equal, which also can't tile perfectly.

const SHEETS = [PORTRAIT_4X6, LANDSCAPE_6X4];

/** Every ordered partition of a list into non-empty groups. */
function partitions(arr) {
  if (arr.length === 0) return [[]];
  const [first, ...rest] = arr;
  const out = [];
  for (const p of partitions(rest)) {
    for (let i = 0; i < p.length; i++) out.push(p.map((g, j) => (j === i ? [first, ...g] : g)));
    out.push([[first], ...p]);
  }
  return out;
}

/** Lay items out as ROWS that each fill width W at a common (per-row) height — no crop.
 *  Returns the placed cells (top-left origin) and the natural block height. */
function rowsBlock(W, rowGroups, aspects) {
  let y = 0;
  const cells = [];
  for (const row of rowGroups) {
    const h = (W - GAP * (row.length - 1)) / row.reduce((s, i) => s + aspects[i], 0);
    let x = 0;
    for (const i of row) { const w = aspects[i] * h; cells.push({ x, y, w, h, item: i }); x += w + GAP; }
    y += h + GAP;
  }
  return { cells, width: W, height: y - GAP };
}

/** Shrink a cell about its centre so its area is at most `maxArea` (keeps its aspect —
 *  the whole photo still shows, just smaller, with more paper around it). */
function capCell(cell, maxArea) {
  const area = cell.w * cell.h;
  if (area <= maxArea) return cell;
  const f = Math.sqrt(maxArea / area);
  const w = cell.w * f, h = cell.h * f;
  return { ...cell, x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

/** One hero-on-top candidate on a given sheet: the rail (the non-hero items) is justified
 *  into rows filling the width; the hero is centred above it at exactly 2× the smallest
 *  rail photo — the biggest the cap allows. Any rail cell that would out-size the hero (a
 *  wide photo among tall ones) is capped down, so the hero is always the biggest and the
 *  2× rule always holds. */
function heroTopCandidate(page, heroAspect, rail) {
  // rail: [{aspect, photo?|sticker:true}] — the three other photos plus the sticker.
  const aspects = rail.map((r) => r.aspect);
  let best = null;
  for (const part of partitions(rail.map((_, i) => i))) {
    const rl = rowsBlock(page.w, part, aspects);
    const photoAreas = rl.cells.filter((c) => !rail[c.item].sticker).map((c) => c.w * c.h);
    const minPhoto = Math.min(...photoAreas);
    const heroArea = 2 * minPhoto;                       // hero at the cap: 2× smallest photo
    const hH = Math.sqrt(heroArea / heroAspect);
    const hW = heroAspect * hH;
    if (hW > page.w + 1) continue;                        // hero too wide for this sheet
    // Cap every rail cell to the hero (sticker a hair under), so the hero stays the biggest.
    const railCells = rl.cells.map((c) => capCell(c, heroArea * (rail[c.item].sticker ? 0.9 : 1)));
    const blockH = hH + GAP + rl.height;
    const sc = Math.min(1, page.h / blockH);              // scale to fit the sheet height
    const cov = (heroArea + railCells.reduce((s, c) => s + c.w * c.h, 0)) * sc * sc / (page.w * page.h);
    if (!best || cov > best.cov) best = { cov, railCells, rl, hW, hH, sc };
  }
  if (!best) return null;
  return {
    cov: best.cov,
    page,
    build(heroIndex) {
      const { railCells, rl, hW, hH, sc } = best;
      const blockH = (hH + GAP + rl.height) * sc;
      const y0 = (page.h - blockH) / 2;
      const railX = (page.w - rl.width * sc) / 2;
      const railY0 = y0 + hH * sc + GAP * sc;
      const cells = [{ x: (page.w - hW * sc) / 2, y: y0, w: hW * sc, h: hH * sc, photo: heroIndex, fit: 'contain' }];
      for (const c of railCells) {
        const cell = { x: railX + c.x * sc, y: railY0 + c.y * sc, w: c.w * sc, h: c.h * sc, fit: 'contain' };
        if (rail[c.item].sticker) cells.push({ ...cell, extra: 'sticker' });
        else cells.push({ ...cell, photo: rail[c.item].photo });
      }
      return cells;
    },
  };
}

/** Best no-hero layout: all five items justified to fill as much paper as possible. */
function evenCandidate(page, items) {
  const aspects = items.map((it) => it.aspect);
  let best = null;
  for (const part of partitions(items.map((_, i) => i))) {
    for (const asCols of [false, true]) {
      const rl = asCols ? colsBlock(page.h, part, aspects) : rowsBlock(page.w, part, aspects);
      const span = asCols ? page.w / rl.width : page.h / rl.height;
      const sc = Math.min(1, span);
      const areas = rl.cells.map((c) => c.w * c.h);
      const stick = rl.cells.find((c) => items[c.item].sticker);
      if (stick && stick.w * stick.h >= Math.max(...areas) - 1) continue; // sticker never biggest
      const cov = areas.reduce((s, a) => s + a, 0) * sc * sc / (page.w * page.h);
      if (!best || cov > best.cov) best = { cov, rl, sc, asCols };
    }
  }
  if (!best) return null;
  return {
    cov: best.cov,
    page,
    build() {
      const { rl, sc, asCols } = best;
      const usedW = (asCols ? rl.width : page.w) * sc;
      const usedH = (asCols ? page.h : rl.height) * sc;
      const x0 = (page.w - usedW) / 2, y0 = (page.h - usedH) / 2;
      return rl.cells.map((c) => {
        const cell = { x: x0 + c.x * sc, y: y0 + c.y * sc, w: c.w * sc, h: c.h * sc, fit: 'contain' };
        return items[c.item].sticker ? { ...cell, extra: 'sticker' } : { ...cell, photo: items[c.item].photo };
      });
    },
  };
}

/** Lay items out as COLUMNS that each fill height H at a common (per-column) width. */
function colsBlock(H, colGroups, aspects) {
  let x = 0;
  const cells = [];
  for (const col of colGroups) {
    const w = (H - GAP * (col.length - 1)) / col.reduce((s, i) => s + 1 / aspects[i], 0);
    let y = 0;
    for (const i of col) { const h = w / aspects[i]; cells.push({ x, y, w, h, item: i }); y += h + GAP; }
    x += w + GAP;
  }
  return { cells, width: x - GAP, height: H };
}

/** The sticker's placement spec for a frame: its aspect ratio, or null for none. */
export function stickerSpec(frame) {
  return frame && frame.sticker ? { aspect: frame.stickerAR || STICKER_AR } : null;
}

/** Build one hero design's cells: search both sheets, keep the highest-coverage valid one. */
function heroDesign(aspects, heroIndex, stickerAR) {
  const rail = aspects.map((a, i) => ({ aspect: a, photo: i })).filter((_, i) => i !== heroIndex);
  if (stickerAR) rail.push({ aspect: stickerAR, sticker: true });
  let best = null;
  for (const page of SHEETS) {
    const c = heroTopCandidate(page, aspects[heroIndex], rail);
    if (c && (!best || c.cov > best.cov)) best = c;
  }
  if (!best) { // degenerate fallback: even layout
    const items = aspects.map((a, i) => ({ aspect: a, photo: i }));
    if (stickerAR) items.push({ aspect: stickerAR, sticker: true });
    let ev = null;
    for (const page of SHEETS) { const c = evenCandidate(page, items); if (c && (!ev || c.cov > ev.cov)) ev = c; }
    return { cells: ev.build(), page: ev.page };
  }
  return { cells: best.build(heroIndex), page: best.page };
}

function evenDesign(aspects, stickerAR) {
  const items = aspects.map((a, i) => ({ aspect: a, photo: i }));
  if (stickerAR) items.push({ aspect: stickerAR, sticker: true });
  let best = null;
  for (const page of SHEETS) { const c = evenCandidate(page, items); if (c && (!best || c.cov > best.cov)) best = c; }
  return { cells: best.build(), page: best.page };
}

const media = (page) => (page.w > page.h ? 'Custom.6x4in' : 'Custom.4x6in');
const paper = (page) => (page.w > page.h ? '6×4 landscape' : '4×6 portrait');

/**
 * The booth's own pick: photo 0 as the hero, on whichever sheet fills the most paper.
 */
export function resolveGrid(base, photos, heroIndex = 0, sticker = null) {
  const d = heroDesign(photos.map(photoAspect), heroIndex, sticker && sticker.aspect);
  return { cells: d.cells, captions: [], page: d.page, media: media(d.page), paper: paper(d.page) };
}

/**
 * The designs offered as cards in the picker: each photo as the hero (featured, ≤ 2× the
 * smallest), plus an even layout with no hero. Every design is optimised for coverage, keeps
 * whole photos (no crop), and carries the sticker as a real 5th cell that is never the hero.
 */
export function designVariants(base, photos, sticker = null) {
  const aspects = photos.map(photoAspect);
  const ar = sticker && sticker.aspect;
  const out = photos.map((_, hero) => {
    const d = heroDesign(aspects, hero, ar);
    return {
      key: `hero:${hero}`, kind: 'hero', heroIndex: hero, arrange: 'top',
      title: `Big #${hero + 1}`, sub: 'featured', captions: [],
      cells: d.cells, page: d.page, media: media(d.page), paper: paper(d.page),
    };
  });
  const e = evenDesign(aspects, ar);
  out.push({
    key: 'even', kind: 'even', title: 'Four equal', sub: 'no big one', captions: [],
    cells: e.cells, page: e.page, media: media(e.page), paper: paper(e.page),
  });
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
    sticker: 'backgrounds/sticker.png', // one per page; a small corner badge, never a hero
    stickerAR: STICKER_AR,              // the sticker's own aspect ratio
    stickerW: 0.2,                      // badge width as a fraction of the page — kept small
    insetX: 0.075, insetY: 0.065,
    cell: { radius: 0.07, borderW: 0.02, borders: ['#f5a623', '#4aa8c9', '#7cc04a', '#ef6f8a', '#5cc0be', '#f6c445'] },
  },
  white: { id: 'white', name: 'White', bg: '#ffffff', ink: '#101010', accent: '#9a9a9a' },
  black: { id: 'black', name: 'Black', bg: '#111111', ink: '#f5f5f5', accent: '#8a8a8a' },
  cream: { id: 'cream', name: 'Cream', bg: '#f4ece0', ink: '#4a3b2c', accent: '#b9a68e' },
  blush: { id: 'blush', name: 'Blush', bg: '#f7dfe4', ink: '#7a3b48', accent: '#c98d9c' },
};

export const DEFAULT_TRANSFORM = { zoom: 1, dx: 0, dy: 0, rot: 0 };
