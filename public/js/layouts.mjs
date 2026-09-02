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
    blurb: 'Two 2×6 strips on one 4×6: keep one, give one away',
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
    blurb: 'One big hero photo with three beside it, nothing cropped',
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


// Target AREA ratios for a hero design (rule 3 + 4 + 5): the hero is exactly 2× every
// other photo — one unmistakable hero, and no photo more than 2× another — while the
// sticker is a small badge, clearly the smallest thing on the page (never the hero).
const HERO_RATIO = 2;
const PHOTO_RATIO = 1;
const STICKER_RATIO = 0.55;

/** Pack fixed-size items (each shaped to its aspect, sized by √ratio so areas match the
 *  ratios above) into stacked rows, top-to-bottom, each row centred. `asCols` transposes
 *  the whole thing into side-by-side columns. Returns the cells and the bounding box —
 *  the caller scales that box to the sheet, so we keep the exact area ratios (no crop,
 *  and the hero stays exactly 2× every photo). */
function packFixed(groups, items, asCols) {
  const K = 1000;
  // Build each line (a row, or a column when asCols). Along-axis = width for rows.
  const lines = groups.map((g) => {
    const cells = g.map((i) => {
      const side = Math.sqrt(items[i].ratio) * K;      // area = ratio·K²
      const w = side * Math.sqrt(items[i].aspect);
      const h = side / Math.sqrt(items[i].aspect);
      return { item: i, w, h };
    });
    const thick = asCols ? Math.max(...cells.map((c) => c.w)) : Math.max(...cells.map((c) => c.h));
    const along = cells.reduce((s, c) => s + (asCols ? c.h : c.w), 0) + GAP * (cells.length - 1);
    return { cells, thick, along };
  });
  const bboxAlong = Math.max(...lines.map((l) => l.along));
  const bboxThick = lines.reduce((s, l) => s + l.thick, 0) + GAP * (lines.length - 1);
  const out = [];
  let off = 0; // across-axis offset (y for rows, x for cols)
  for (const l of lines) {
    let pos = (bboxAlong - l.along) / 2; // centre the line
    for (const c of l.cells) {
      if (asCols) out.push({ item: c.item, x: off + (l.thick - c.w) / 2, y: pos, w: c.w, h: c.h });
      else out.push({ item: c.item, x: pos, y: off + (l.thick - c.h) / 2, w: c.w, h: c.h });
      pos += (asCols ? c.h : c.w) + GAP;
    }
    off += l.thick + GAP;
  }
  return { cells: out, bboxW: asCols ? bboxThick : bboxAlong, bboxH: asCols ? bboxAlong : bboxThick };
}

/** The sticker's placement spec for a frame: its aspect ratio, or null for none. */
export function stickerSpec(frame) {
  return frame && frame.sticker ? { aspect: frame.stickerAR || STICKER_AR } : null;
}

/** Build one hero design's cells. The five items carry fixed area ratios (hero 2×, each
 *  photo 1×, sticker 0.55×); we search both sheets and every row/column arrangement and
 *  keep the one whose block scales up the most — i.e. fills the most paper. Because the
 *  ratios are fixed, the hero is always exactly 2× every photo and the sticker is always
 *  the smallest cell, whatever the packing chooses. */
function heroDesign(aspects, heroIndex, stickerAR) {
  const items = aspects.map((a, i) => ({ aspect: a, photo: i, ratio: i === heroIndex ? HERO_RATIO : PHOTO_RATIO }));
  if (stickerAR) items.push({ aspect: stickerAR, sticker: true, ratio: STICKER_RATIO });
  const idx = items.map((_, i) => i);
  let best = null;
  for (const page of SHEETS) {
    for (const part of partitions(idx)) {
      for (const asCols of [false, true]) {
        const pk = packFixed(part, items, asCols);
        const sc = Math.min(page.w / pk.bboxW, page.h / pk.bboxH);
        const cov = pk.cells.reduce((s, c) => s + c.w * c.h, 0) * sc * sc / (page.w * page.h);
        if (!best || cov > best.cov) best = { cov, pk, sc, page };
      }
    }
  }
  const { pk, sc, page } = best;
  const x0 = (page.w - pk.bboxW * sc) / 2, y0 = (page.h - pk.bboxH * sc) / 2;
  const cells = pk.cells.map((c) => {
    const cell = { x: x0 + c.x * sc, y: y0 + c.y * sc, w: c.w * sc, h: c.h * sc, fit: 'contain' };
    return items[c.item].sticker ? { ...cell, extra: 'sticker' } : { ...cell, photo: items[c.item].photo };
  });
  cells.sort((a, b) => (a.photo === heroIndex ? -1 : b.photo === heroIndex ? 1 : 0)); // hero leads
  return { cells, page };
}

/** The no-hero design: four equal photos (all ratio 1) plus the small sticker, packed for
 *  the most paper — same machinery as a hero design but with no cell enlarged. */
function evenDesign(aspects, stickerAR) {
  const items = aspects.map((a, i) => ({ aspect: a, photo: i, ratio: PHOTO_RATIO }));
  if (stickerAR) items.push({ aspect: stickerAR, sticker: true, ratio: STICKER_RATIO });
  const idx = items.map((_, i) => i);
  let best = null;
  for (const page of SHEETS) {
    for (const part of partitions(idx)) {
      for (const asCols of [false, true]) {
        const pk = packFixed(part, items, asCols);
        const sc = Math.min(page.w / pk.bboxW, page.h / pk.bboxH);
        const cov = pk.cells.reduce((s, c) => s + c.w * c.h, 0) * sc * sc / (page.w * page.h);
        if (!best || cov > best.cov) best = { cov, pk, sc, page };
      }
    }
  }
  const { pk, sc, page } = best;
  const x0 = (page.w - pk.bboxW * sc) / 2, y0 = (page.h - pk.bboxH * sc) / 2;
  const cells = pk.cells.map((c) => {
    const cell = { x: x0 + c.x * sc, y: y0 + c.y * sc, w: c.w * sc, h: c.h * sc, fit: 'contain' };
    return items[c.item].sticker ? { ...cell, extra: 'sticker' } : { ...cell, photo: items[c.item].photo };
  });
  return { cells, page };
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
    insetX: 0.035, insetY: 0.03,
    cell: { radius: 0.07, borderW: 0.02, borders: ['#f5a623', '#4aa8c9', '#7cc04a', '#ef6f8a', '#5cc0be', '#f6c445'] },
  },
  white: { id: 'white', name: 'White', bg: '#ffffff', ink: '#101010', accent: '#9a9a9a' },
  black: { id: 'black', name: 'Black', bg: '#111111', ink: '#f5f5f5', accent: '#8a8a8a' },
  cream: { id: 'cream', name: 'Cream', bg: '#f4ece0', ink: '#4a3b2c', accent: '#b9a68e' },
  blush: { id: 'blush', name: 'Blush', bg: '#f7dfe4', ink: '#7a3b48', accent: '#c98d9c' },
};

export const DEFAULT_TRANSFORM = { zoom: 1, dx: 0, dy: 0, rot: 0 };
