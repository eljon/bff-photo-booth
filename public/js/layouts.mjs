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

// ─── Guillotine layout optimiser ─────────────────────────────────────────────
// The cells ALWAYS partition the whole sheet — there is never an empty region. We
// recursively slice the sheet (a slice is side-by-side V or stacked H), dividing each
// cut in proportion to the target areas on each side, so the four photos fill 100% of
// the paper with the hero exactly 2× the others (rule 4) and nothing cropped. Every cell
// is a real rectangle of the sheet; a photo is shown "contain" inside its cell, so the
// only slack is a thin letterbox bar where a cell's shape differs from its photo — never
// a big margin. We enumerate every slicing arrangement × both sheets and keep the one
// that SHOWS the most photo (least letterbox), i.e. whose cell shapes best match the
// photos. The sticker is a small corner badge stamped on top (the photo under it is
// whole, so it is not a crop) and is never the hero.

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

// A subtree's effective aspect (w/h) when every leaf is shaped to its own photo: side by
// side the aspects add; stacked, the reciprocals add (parallel resistors). This lets each
// photo keep its exact shape — WHOLE PHOTO, no crop and no letterbox bar.
function combineAspect(op, a, b) {
  return op === 'V' ? a + b : 1 / (1 / a + 1 / b);
}

/** All slicing trees over a set of items, memoised by subset. A node is a leaf
 *  ({ leaf, aspect }) or a split ({ op:'V'|'H', a, b, aspect }). */
function slicingTrees(idxs, items, memo) {
  const key = idxs.join(',');
  const hit = memo.get(key);
  if (hit) return hit;
  let res;
  if (idxs.length === 1) {
    res = [{ leaf: idxs[0], aspect: items[idxs[0]].aspect }];
  } else {
    res = [];
    for (const [A, B] of bipartitions(idxs)) {
      const ta = slicingTrees(A, items, memo);
      const tb = slicingTrees(B, items, memo);
      for (const a of ta) for (const b of tb) {
        res.push({ op: 'V', a, b, aspect: combineAspect('V', a.aspect, b.aspect) });
        res.push({ op: 'H', a, b, aspect: combineAspect('H', a.aspect, b.aspect) });
      }
    }
  }
  memo.set(key, res);
  return res;
}

/** Lay a tree into a rectangle whose aspect equals the node's — the split lands exactly, so
 *  every leaf gets a rectangle matching its photo (WHOLE photo, no crop, no bars), the cells
 *  butting together with no gaps. Pushes leaf rects into `out`. */
function placeTree(node, x, y, w, h, out) {
  if (node.leaf != null) { out.push({ node: node.leaf, x, y, w, h }); return; }
  if (node.op === 'V') { // side by side, full height
    const wa = w * (node.a.aspect / (node.a.aspect + node.b.aspect));
    placeTree(node.a, x, y, wa, h, out);
    placeTree(node.b, x + wa, y, w - wa, h, out);
  } else { // stacked, full width
    const ha = h * ((1 / node.a.aspect) / (1 / node.a.aspect + 1 / node.b.aspect));
    placeTree(node.a, x, y, w, ha, out);
    placeTree(node.b, x, y + ha, w, h - ha, out);
  }
}

/**
 * Best full-sheet layout across both sheets. The five cells — four photos plus the sticker —
 * ALWAYS tile the whole sheet: there is never white background and the sticker never sits on
 * top of a photo, it gets its own cell. Photos are shown "cover" (they fill their cell edge
 * to edge; the small overflow is trimmed), so there are no letterbox bars either. `heroIndex`
 * names the photo whose cell is 2× the others (rule 4); the sticker cell is a small badge and
 * never the hero. We enumerate every arrangement × both sheets and pick the one that needs the
 * LEAST cropping — the worst-matched cell as good as possible (minimax), then the total — so
 * cell shapes hug the photos and the trim on each is as small as the sheet allows.
 */
function tilingDesign(aspects, stickerAR, heroIndex) {
  const items = aspects.map((a, i) => ({ aspect: a, photo: i }));
  const idxs = items.map((_, i) => i);
  const memo = new Map();
  let best = null, bestAny = null;

  for (const page of SHEETS) {
    const sAR = page.w / page.h;
    for (const tree of slicingTrees(idxs, items, memo)) {
      const A = tree.aspect;
      let bw, bh; // largest rect of the block's aspect that fits the sheet
      if (A >= sAR) { bw = page.w; bh = page.w / A; } else { bh = page.h; bw = page.h * A; }
      const cov = (bw * bh) / (page.w * page.h);
      if (bestAny && best && cov <= bestAny.cov && cov <= best.cov) continue;

      const cells = [];
      placeTree(tree, (page.w - bw) / 2, (page.h - bh) / 2, bw, bh, cells); // centred block

      let minA = Infinity, maxA = -Infinity, maxPhoto = -1;
      for (const c of cells) {
        const a = c.w * c.h;
        if (a < minA) minA = a;
        if (a > maxA) { maxA = a; maxPhoto = items[c.node].photo; }
      }
      // Fallback pool: keep photos reasonably balanced (never a runaway hero) even when the
      // strict ≤2× rule can't be met for this photo mix.
      if (maxA <= 2.5 * minA + 1 && (!bestAny || cov > bestAny.cov)) bestAny = { cov, bw, bh, tree, page };

      if (maxA > 2 * minA + 1) continue;                         // rule 4: ≤ 2× the smallest
      if (heroIndex != null && maxPhoto !== heroIndex) continue; // hero card features its photo
      if (!best || cov > best.cov) best = { cov, bw, bh, tree, page };
    }
  }
  best = best || bestAny;

  const page = best.page, bw = best.bw, bh = best.bh;
  const hasSticker = stickerAR != null;

  // With a sticker, anchor the block so ALL the leftover forms ONE band (a footer, or a side
  // column) big enough to hold a clearly-visible badge — instead of a thin centred margin the
  // sticker gets lost in. Without a sticker, centre the block so the matting is even.
  const sideMargin = bw < page.w - 2;            // block fills height → leftover on the right
  const ox = hasSticker ? (sideMargin ? 0 : (page.w - bw) / 2) : (page.w - bw) / 2;
  const oy = hasSticker ? (sideMargin ? (page.h - bh) / 2 : 0) : (page.h - bh) / 2;
  const cells = [];
  placeTree(best.tree, ox, oy, bw, bh, cells);
  const out = cells.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, photo: items[c.node].photo, fit: 'contain' }));

  if (hasSticker) {
    const pad = Math.round(page.w * 0.02);
    const band = sideMargin
      ? { x: ox + bw, y: 0, w: page.w - bw, h: page.h }       // right column
      : { x: 0, y: oy + bh, w: page.w, h: page.h - bh };      // bottom footer
    // Fill most of the band with the badge (a clear, visible size), capped so it never rivals
    // a photo. Centre it in the band.
    let sw = Math.min((band.w - pad * 2), (band.h - pad * 2) * stickerAR, Math.min(page.w, page.h) * 0.34);
    let sh = sw / stickerAR;
    if (sh > band.h - pad * 2) { sh = band.h - pad * 2; sw = sh * stickerAR; }
    out.push({ x: band.x + (band.w - sw) / 2, y: band.y + (band.h - sh) / 2, w: sw, h: sh, extra: 'sticker', fit: 'contain' });
  }
  return { cells: out, page };
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
function heroDesignFixed(aspects, heroIndex, stickerAR) {
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
function evenDesignFixed(aspects, stickerAR) {
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

/** One hero design: prefer the zero-gap tiling that fills the sheet edge to edge; fall
 *  back to the fixed-area layout only when no tiling satisfies the rules. */
function heroDesign(aspects, heroIndex, stickerAR) {
  const d = tilingDesign(aspects, stickerAR, heroIndex) || heroDesignFixed(aspects, heroIndex, stickerAR);
  const cells = d.cells.slice().sort((a, b) => (a.photo === heroIndex ? -1 : b.photo === heroIndex ? 1 : 0));
  return { cells, page: d.page };
}

/** Four equal photos + sticker: prefer the zero-gap tiling, else the fixed-area layout. */
function evenDesign(aspects, stickerAR) {
  const d = tilingDesign(aspects, stickerAR, null) || evenDesignFixed(aspects, stickerAR);
  return { cells: d.cells, page: d.page };
}

const media = (page) => (page.w > page.h ? 'Custom.6x4in' : 'Custom.4x6in');
const paper = (page) => (page.w > page.h ? '6×4 landscape' : '4×6 portrait');

/** Fraction of the sheet the photos cover — how little paper margin a design leaves. */
function photoCoverage(d) {
  return d.cells.filter((c) => c.photo != null).reduce((s, c) => s + c.w * c.h, 0) / (d.page.w * d.page.h);
}

/**
 * The booth's own pick: of every arrangement (each photo as the hero, or four equal), the
 * one that FILLS THE MOST PAPER — the least matting — so a mixed set never defaults to a
 * narrow column with wide margins.
 */
export function resolveGrid(base, photos, heroIndex = null, sticker = null) {
  const aspects = photos.map(photoAspect);
  const ar = sticker && sticker.aspect;
  // Keep one hero (rule 3), but of the four possible heroes pick the one that fills the most
  // paper — so a mixed set never defaults to a narrow column with wide margins.
  const designs = heroIndex != null
    ? [heroDesign(aspects, heroIndex, ar)]
    : photos.map((_, h) => heroDesign(aspects, h, ar));
  const d = designs.reduce((bestD, cur) => (photoCoverage(cur) > photoCoverage(bestD) ? cur : bestD));
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
  const cand = photos.map((_, hero) => {
    const d = heroDesign(aspects, hero, ar);
    return { key: `hero:${hero}`, kind: 'hero', heroIndex: hero, title: `Big #${hero + 1}`, sub: 'featured', cells: d.cells, page: d.page };
  });
  const e = evenDesign(aspects, ar);
  cand.push({ key: 'even', kind: 'even', title: 'Four equal', sub: 'no big one', cells: e.cells, page: e.page });

  for (const c of cand) c.cov = photoCoverage(c);
  const bestCov = Math.max(...cand.map((c) => c.cov));
  cand.sort((a, b) => b.cov - a.cov);

  // Only offer well-filled layouts: drop the sparse ones (a mismatched hero stacked into a
  // narrow column with wide margins). Keep the best, plus any within ~12% of it, so guests
  // never swipe onto a mostly-empty sheet. Dedupe near-identical coverage on the same sheet.
  const out = [];
  const seen = new Set();
  for (const c of cand) {
    if (out.length >= 1 && c.cov < bestCov - 0.12) break;
    const sig = `${c.page.w > c.page.h ? 'L' : 'P'}:${Math.round(c.cov * 100)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ key: c.key, kind: c.kind, heroIndex: c.heroIndex, arrange: 'top', title: c.title, sub: c.sub, captions: [], cells: c.cells, page: c.page, media: media(c.page), paper: paper(c.page) });
  }
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
