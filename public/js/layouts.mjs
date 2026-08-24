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
  // Cells are computed per print from the real photos (see autoLayout), so a
  // mix of portrait and landscape shots each get a cell shaped to fit them
  // without cropping. The static values here are the frame around that.
  const page = { w: inches(4), h: inches(6) };
  return {
    id: 'grid',
    name: 'Auto grid',
    blurb: 'One big hero photo with three beneath — nothing cropped',
    paper: '4×6 portrait',
    media: 'Custom.4x6in',
    page,
    dynamic: true,
    pad: 56,
    gap: 26,
    footer: 150,
    cells: [], // filled in by autoLayout at render time
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

/** Every way to split n items into consecutive rows (order preserved). */
function compositions(n) {
  const out = [];
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    const rows = [];
    let row = [0];
    for (let i = 1; i < n; i++) {
      if (mask & (1 << (i - 1))) {
        rows.push(row);
        row = [];
      }
      row.push(i);
    }
    rows.push(row);
    out.push(rows);
  }
  return out;
}

/** Lay a row of photos out at the height that fills the content width. */
function measure(rows, aspects, W, gap) {
  return rows.map((row) => {
    const aspectSum = row.reduce((s, i) => s + aspects[i], 0);
    const height = (W - gap * (row.length - 1)) / aspectSum;
    return { row, height };
  });
}

/**
 * Give every photo a cell shaped to its own aspect ratio, packed into rows and
 * scaled to fill the sheet. Because each cell matches its photo, a contain-fit
 * fills the cell with no crop and no letterbox bars. The row grouping that
 * covers the most paper wins, so 4 portraits land as a 2×2, 4 landscapes as a
 * stack, and any mix arranges itself sensibly.
 */
export function autoLayout(spec, photos) {
  const { page, pad, gap, footer } = spec;
  const W = page.w - pad * 2;
  const availH = page.h - pad * 2 - footer;
  const aspects = photos.map(photoAspect);

  let best = null;
  for (const rows of compositions(photos.length)) {
    const measured = measure(rows, aspects, W, gap);
    const totalH = measured.reduce((s, m) => s + m.height, 0) + gap * (rows.length - 1);
    const scale = Math.min(1, availH / totalH);

    // Fair share, not raw coverage: maximise the *smallest* photo so no one's
    // shot ends up tiny. Total area is only the tiebreak. (Maximising coverage
    // instead makes one photo huge and the rest postage stamps.)
    let minArea = Infinity;
    let totalArea = 0;
    for (const m of measured) {
      for (const i of m.row) {
        const a = aspects[i] * (m.height * scale) * (m.height * scale);
        minArea = Math.min(minArea, a);
        totalArea += a;
      }
    }
    if (!best || minArea > best.minArea + 1 || (Math.abs(minArea - best.minArea) <= 1 && totalArea > best.totalArea)) {
      best = { measured, totalH, scale, minArea, totalArea };
    }
  }

  const { measured, totalH, scale } = best;
  const blockH = totalH * scale;
  let y = pad + (availH - blockH) / 2;
  const cells = [];

  for (const m of measured) {
    const h = m.height * scale;
    const widths = m.row.map((i) => aspects[i] * h);
    const rowW = widths.reduce((s, w) => s + w, 0) + gap * scale * (m.row.length - 1);
    let x = pad + (W - rowW) / 2;
    m.row.forEach((photoIndex, k) => {
      cells.push({ x, y, w: widths[k], h, photo: photoIndex, fit: 'contain' });
      x += widths[k] + gap * scale;
    });
    y += h + gap * scale;
  }

  const usedArea = cells.reduce((sum, c) => sum + c.w * c.h, 0);
  return {
    cells,
    captions: [{ x: pad, y: pad + availH, w: W, h: footer }],
    page,
    coverage: usedArea / (page.w * page.h),
  };
}

/**
 * Full-bleed collage templates. Each tiles the whole sheet edge to edge with no
 * gaps or margins, so the four photos cover every bit of paper. Photos cover-fit
 * (crop to fill) — that is the price of filling a rectangle with mixed shapes,
 * and filling the paper is the priority. Cells are fractions of the page.
 * Photo 0 leads (the hero, where a template has one).
 */
const TEMPLATES = [
  // one big hero on top, three across the bottom
  { id: 'hero-top', cells: [
    { x: 0, y: 0, w: 1, h: 0.64, p: 0 },
    { x: 0, y: 0.64, w: 1 / 3, h: 0.36, p: 1 },
    { x: 1 / 3, y: 0.64, w: 1 / 3, h: 0.36, p: 2 },
    { x: 2 / 3, y: 0.64, w: 1 / 3, h: 0.36, p: 3 },
  ] },
  // one big hero on the left, three stacked on the right
  { id: 'hero-left', cells: [
    { x: 0, y: 0, w: 0.64, h: 1, p: 0 },
    { x: 0.64, y: 0, w: 0.36, h: 1 / 3, p: 1 },
    { x: 0.64, y: 1 / 3, w: 0.36, h: 1 / 3, p: 2 },
    { x: 0.64, y: 2 / 3, w: 0.36, h: 1 / 3, p: 3 },
  ] },
];

/** How much of a photo survives a cover-fit into a cell (1 = no crop). */
function keptFraction(photoAspect, cellAspect) {
  return Math.min(photoAspect, cellAspect) / Math.max(photoAspect, cellAspect);
}

/** Lay a template onto a sheet, returning real cells and how well it fits. */
function placeTemplate(template, page, aspects, heroIndex) {
  // photo 0 in the template maps to the chosen hero; the rest keep their order.
  const order = [heroIndex, ...aspects.map((_, i) => i).filter((i) => i !== heroIndex)];
  const cells = template.cells.map((c) => {
    const photo = order[c.p];
    const cell = { x: c.x * page.w, y: c.y * page.h, w: c.w * page.w, h: c.h * page.h, photo, fit: 'cover' };
    cell.kept = keptFraction(aspects[photo], cell.w / cell.h);
    // Weight the hero: keeping the star intact matters more than a corner tile.
    cell.weight = photo === heroIndex ? 2 : 1;
    return cell;
  });
  const score = cells.reduce((s, c) => s + c.kept * c.weight, 0) / cells.reduce((s, c) => s + c.weight, 0);
  return { cells: cells.map(({ kept, weight, ...c }) => c), score };
}

const PORTRAIT_4X6 = { w: inches(4), h: inches(6), media: 'Custom.4x6in', paper: '4×6 portrait' };
const LANDSCAPE_6X4 = { w: inches(6), h: inches(4), media: 'Custom.6x4in', paper: '6×4 landscape' };

/**
 * Choose the template and sheet orientation that fill the paper with the least
 * cropping. Every option already covers 100% of the sheet; the winner is the one
 * that keeps the most of the photos (the hero counted double).
 */
export function resolveGrid(base, photos, heroIndex = 0) {
  const aspects = photos.map(photoAspect);
  let best = null;
  for (const paper of [PORTRAIT_4X6, LANDSCAPE_6X4]) {
    const page = { w: paper.w, h: paper.h };
    for (const template of TEMPLATES) {
      const placed = placeTemplate(template, page, aspects, heroIndex);
      if (!best || placed.score > best.score) {
        best = { ...placed, page, media: paper.media, paper: paper.paper };
      }
    }
  }
  return { cells: best.cells, captions: [], page: best.page, media: best.media, paper: best.paper };
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
