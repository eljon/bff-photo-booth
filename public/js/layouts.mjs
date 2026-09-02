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

// The sticker asset's own aspect ratio (w/h) — the small corner badge is shaped to
// this so the art fills it exactly.
const STICKER_AR = 1448 / 1086;

// The picker grid is computed by OPTIMIZATION, not a fixed template (see CLAUDE.md).
// The five cells (four photos + the sticker) ALWAYS tile the WHOLE sheet edge to edge —
// the paper margin is disregarded, so there is never any blank border. Cells are sized by
// exact area weight (hero 2×, each photo 1×, sticker 0.55×) so the rules hold — one hero,
// hero exactly 2× every other photo, sticker the smallest — and photos are shown "cover"
// so each fills its cell with no letterbox. We search both sheet orientations and every
// guillotine arrangement and keep the one that crops the photos the least (their cell
// shapes hug the photos best), so filling the whole page trims as little as possible.

const SHEETS = [PORTRAIT_4X6, LANDSCAPE_6X4];

// Target AREA weights (rule 3 + 4 + 5): the hero is exactly 2× every other photo — one
// unmistakable hero, none more than 2× another — while the sticker is a small badge, clearly
// the smallest thing on the page (never the hero).
const HERO_RATIO = 2;
const PHOTO_RATIO = 1;

// ─── Weighted guillotine tiler ───────────────────────────────────────────────
// Recursively slice the sheet: each cut is side-by-side (V) or stacked (H) and divides the
// rectangle in proportion to the total area weight on each side. So every leaf cell ends up
// with EXACTLY (its weight / total weight) of the sheet, and together the cells fill 100% of
// the paper — no margins, no gaps.

/** Every unordered split of a set of indices into two non-empty groups (each once). */
function bipartitions(idxs) {
  const out = [];
  for (let mask = 1; mask < (1 << idxs.length) - 1; mask++) {
    if (!(mask & 1)) continue; // keep idxs[0] in A, so complements aren't repeated
    const A = [], B = [];
    for (let i = 0; i < idxs.length; i++) (mask & (1 << i) ? A : B).push(idxs[i]);
    out.push([A, B]);
  }
  return out;
}

/** All slicing trees over a set of items, memoised by subset. A node is a leaf
 *  ({ leaf }) or a split ({ op:'V'|'H', a, b }). */
function slicingTrees(idxs, memo) {
  const key = idxs.join(',');
  const hit = memo.get(key);
  if (hit) return hit;
  let res;
  if (idxs.length === 1) {
    res = [{ leaf: idxs[0] }];
  } else {
    res = [];
    for (const [A, B] of bipartitions(idxs)) {
      const ta = slicingTrees(A, memo);
      const tb = slicingTrees(B, memo);
      for (const a of ta) for (const b of tb) {
        res.push({ op: 'V', a, b });
        res.push({ op: 'H', a, b });
      }
    }
  }
  memo.set(key, res);
  return res;
}

/** Total area weight of a subtree. */
function treeWeight(node, W) {
  return node.leaf != null ? W[node.leaf] : treeWeight(node.a, W) + treeWeight(node.b, W);
}

/** Lay a tree into a rectangle, splitting each cut by area weight so the cells tile the whole
 *  rectangle with no gaps. Pushes leaf rects into `out`. */
function placeTree(node, x, y, w, h, W, out) {
  if (node.leaf != null) { out.push({ item: node.leaf, x, y, w, h }); return; }
  const wa = treeWeight(node.a, W), f = wa / (wa + treeWeight(node.b, W));
  if (node.op === 'V') { // side by side, full height
    placeTree(node.a, x, y, w * f, h, W, out);
    placeTree(node.b, x + w * f, y, w * (1 - f), h, W, out);
  } else {               // stacked, full width
    placeTree(node.a, x, y, w, h * f, W, out);
    placeTree(node.b, x, y + h * f, w, h * (1 - f), W, out);
  }
}

/** How much a cell of aspect `cellAR` must trim (cover) or leave blank (contain) to hold a
 *  photo/badge of aspect `ar` — 0 when the shapes match, approaching 1 as they diverge. */
function mismatch(cellAR, ar) {
  return 1 - Math.min(cellAR, ar) / Math.max(cellAR, ar);
}

/** Tile the WHOLE sheet with the photos (each { aspect, weight, photo }). Search both sheets
 *  and every guillotine arrangement; keep the one that crops the photos the least. Every photo
 *  fills its cell (cover), and the cells cover 100% of the paper — no margin anywhere. */
function fillSheet(items) {
  const idxs = items.map((_, i) => i);
  const W = items.map((it) => it.weight);
  const memo = new Map();
  const trees = slicingTrees(idxs, memo);
  let best = null;
  for (const page of SHEETS) {
    for (const tree of trees) {
      const cells = [];
      placeTree(tree, 0, 0, page.w, page.h, W, cells);
      let worst = 0, total = 0;
      for (const c of cells) {
        const m = mismatch(c.w / c.h, items[c.item].aspect);
        total += m; if (m > worst) worst = m;
      }
      const score = worst * 8 + total; // minimise cropping (worst cell first)
      if (!best || score < best.score) best = { score, cells, page };
    }
  }
  const cells = best.cells.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, photo: items[c.item].photo, fit: 'cover' }));
  return { cells, page: best.page };
}

/** Add the sticker as a small badge in the lower-right corner, drawn ON TOP of the photos so
 *  the photos still fill the whole paper (no blank cell for it). It is always the smallest
 *  element on the page (rule 5) and never a hero. */
function withSticker(design, stickerAR) {
  if (stickerAR == null) return design;
  const { page } = design;
  const pad = Math.round(Math.min(page.w, page.h) * 0.02);
  const sw = Math.min(page.w, page.h) * 0.2;   // a small corner badge
  const sh = sw / stickerAR;
  design.cells.push({ x: page.w - pad - sw, y: page.h - pad - sh, w: sw, h: sh, extra: 'sticker', fit: 'contain' });
  return design;
}

/** The sticker's placement spec for a frame: its aspect ratio, or null for none. */
export function stickerSpec(frame) {
  return frame && frame.sticker ? { aspect: frame.stickerAR || STICKER_AR } : null;
}

/** One hero design that fills the whole sheet: the hero cell is exactly 2× every other photo,
 *  the sticker (if any) is the smallest cell, and together they tile 100% of the paper. */
function heroDesign(aspects, heroIndex, stickerAR) {
  const items = aspects.map((a, i) => ({ aspect: a, photo: i, weight: i === heroIndex ? HERO_RATIO : PHOTO_RATIO }));
  const d = fillSheet(items);
  d.cells.sort((a, b) => (a.photo === heroIndex ? -1 : b.photo === heroIndex ? 1 : 0)); // hero leads
  return withSticker(d, stickerAR);
}

/** The no-hero design: four equal photos tiling the whole sheet, plus the small corner badge. */
function evenDesign(aspects, stickerAR) {
  const items = aspects.map((a, i) => ({ aspect: a, photo: i, weight: PHOTO_RATIO }));
  return withSticker(fillSheet(items), stickerAR);
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
    insetX: 0.012, insetY: 0.01,
    cell: { radius: 0.03, borderW: 0.014, borders: ['#f5a623', '#4aa8c9', '#7cc04a', '#ef6f8a', '#5cc0be', '#f6c445'] },
  },
  white: { id: 'white', name: 'White', bg: '#ffffff', ink: '#101010', accent: '#9a9a9a' },
  black: { id: 'black', name: 'Black', bg: '#111111', ink: '#f5f5f5', accent: '#8a8a8a' },
  cream: { id: 'cream', name: 'Cream', bg: '#f4ece0', ink: '#4a3b2c', accent: '#b9a68e' },
  blush: { id: 'blush', name: 'Blush', bg: '#f7dfe4', ink: '#7a3b48', accent: '#c98d9c' },
};

export const DEFAULT_TRANSFORM = { zoom: 1, dx: 0, dy: 0, rot: 0 };
