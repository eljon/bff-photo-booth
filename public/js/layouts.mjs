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

// Nothing is cropped. The page is divided into SLOTS (a big hero slot, three rail
// slots, and a badge slot for the sticker); each photo is then shaped to its own real
// proportions and centred inside its slot, so the whole photo shows with no bars and no
// cropping. The hero's slot is about twice a rail slot, so the hero stands out — but
// never more than 2×. Whatever the shaped photos don't cover of their slots is the
// decorative watercolor paper showing through, which reads as matting around each photo.
//
// Everything is a 4×6 portrait sheet (the booth's paper). Two columns:
//   • the hero column (left): the big hero slot on top, one rail slot below;
//   • the rail column (right): two rail slots, and — when there's a sticker — the badge
//     slot at the bottom, shaped to the sticker's own aspect ratio.
// The sticker's slot is always smaller than a photo slot, so it can never be the hero.

/** The hero design's five slots (hero + three photos + optional sticker), filling the
 *  page. `stick` is the sticker's aspect ratio, or null for no sticker. */
function heroSlots(page, stick) {
  const g = GAP;
  // The hero column is wider than the rail, so the hero photo sits in a bigger slot and
  // clearly stands out (about 1.9× a rail photo for a portrait, always ≤ 2×).
  const heroW = Math.round((page.w - g) * 0.58);
  const railW = page.w - g - heroW;
  const railX = heroW + g;
  if (stick) {
    const stH = railW / stick;                     // badge-shaped cell (fills exactly)
    const rp = (page.h - stH - 2 * g) / 2;         // rail photo height
    const heroH = Math.round(page.h * 0.62);
    return {
      hero: { x: 0, y: 0, w: heroW, h: heroH },
      photos: [
        { x: 0, y: heroH + g, w: heroW, h: page.h - heroH - g }, // under the hero
        { x: railX, y: 0, w: railW, h: rp },                      // rail top
        { x: railX, y: rp + g, w: railW, h: rp },                 // rail middle
      ],
      sticker: { x: railX, y: 2 * rp + 2 * g, w: railW, h: stH },
    };
  }
  const railH = (page.h - g) / 2;
  const heroH = Math.round(page.h * 0.62);
  return {
    hero: { x: 0, y: 0, w: heroW, h: heroH },
    photos: [
      { x: 0, y: heroH + g, w: heroW, h: page.h - heroH - g },  // under the hero
      { x: railX, y: 0, w: railW, h: railH },                    // rail top
      { x: railX, y: railH + g, w: railW, h: page.h - railH - g }, // rail bottom
    ],
    sticker: null,
  };
}

/** The even design's slots (four ~equal photos + optional sticker), filling the page. */
function evenSlots(page, stick) {
  const g = GAP;
  const colW = (page.w - g) / 2;
  const railX = colW + g;
  const leftH = (page.h - g) / 2;
  if (stick) {
    const stH = colW / stick;
    const rp = (page.h - stH - 2 * g) / 2;
    return {
      photos: [
        { x: 0, y: 0, w: colW, h: leftH },
        { x: 0, y: leftH + g, w: colW, h: page.h - leftH - g },
        { x: railX, y: 0, w: colW, h: rp },
        { x: railX, y: rp + g, w: colW, h: rp },
      ],
      sticker: { x: railX, y: 2 * rp + 2 * g, w: colW, h: stH },
    };
  }
  return {
    photos: [
      { x: 0, y: 0, w: colW, h: leftH },
      { x: 0, y: leftH + g, w: colW, h: page.h - leftH - g },
      { x: railX, y: 0, w: colW, h: leftH },
      { x: railX, y: leftH + g, w: colW, h: page.h - leftH - g },
    ],
    sticker: null,
  };
}

const PAGE = PORTRAIT_4X6;
const stickerCell = (rect) => ({ ...rect, extra: 'sticker', fit: 'contain' });

/** The largest rectangle of the given aspect that fits inside a slot, centred in it.
 *  The cell then has the SAME aspect as the photo, so it shows whole — no crop, no bars —
 *  and whatever slack is left around it is the paper showing through (matting). */
function shapeToSlot(slot, aspect, photo) {
  let w = slot.w;
  let h = w / aspect;
  if (h > slot.h) { h = slot.h; w = h * aspect; }
  return { x: slot.x + (slot.w - w) / 2, y: slot.y + (slot.h - h) / 2, w, h, photo, fit: 'contain' };
}

/** Shrink a cell about its centre to `factor` of its linear size. */
function scaleCell(cell, factor) {
  const w = cell.w * factor, h = cell.h * factor;
  return { ...cell, x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

/** Build the cells for one hero design: the hero photo shaped into the big slot, the
 *  rest into the rail slots, the sticker (if any) into its badge slot. The hero is held
 *  to at most 2× the smallest photo — if the shapes push it over (e.g. a wide hero beside
 *  a tall rail photo), it's scaled down so the cap always holds. */
function heroCells(aspects, heroIndex, stick) {
  const s = heroSlots(PAGE, stick);
  const others = aspects.map((_, i) => i).filter((i) => i !== heroIndex);
  const hero = shapeToSlot(s.hero, aspects[heroIndex], heroIndex);
  const rail = s.photos.map((slot, k) => shapeToSlot(slot, aspects[others[k]], others[k]));
  const minPhoto = Math.min(...rail.map((c) => c.w * c.h));
  const heroArea = hero.w * hero.h;
  const cells = [heroArea > minPhoto * 2 ? scaleCell(hero, Math.sqrt((minPhoto * 2) / heroArea)) : hero, ...rail];
  if (s.sticker) cells.push(stickerCell(s.sticker));
  return cells;
}

function evenCells(aspects, stick) {
  const s = evenSlots(PAGE, stick);
  const cells = s.photos.map((slot, k) => shapeToSlot(slot, aspects[k], k));
  if (s.sticker) cells.push(stickerCell(s.sticker));
  return cells;
}

/** The sticker's placement spec for a frame: its aspect ratio, or null for none. The
 *  sticker is a real cell in the layout — never packed with the photos so it can't grow
 *  to hero size, and never omitted so its slot is always filled. */
export function stickerSpec(frame) {
  return frame && frame.sticker ? { aspect: frame.stickerAR || STICKER_AR } : null;
}

/**
 * The booth's own pick: photo 0 as the hero (unless told otherwise), filling a 4×6
 * portrait sheet edge to edge.
 */
export function resolveGrid(base, photos, heroIndex = 0, sticker = null) {
  const cells = heroCells(photos.map(photoAspect), heroIndex, sticker && sticker.aspect);
  return { cells, captions: [], page: PAGE, media: PAGE.media, paper: PAGE.paper };
}

/**
 * The designs offered as cards in the picker: each photo as the hero (big, but never
 * more than 2× the smallest photo), plus an even layout with no hero. Every design fills
 * the paper, and the sticker is a small badge cell that is always the smallest — never
 * the hero.
 */
export function designVariants(base, photos, sticker = null) {
  const aspects = photos.map(photoAspect);
  const ar = sticker && sticker.aspect;
  const out = photos.map((_, hero) => ({
    key: `hero:${hero}`,
    kind: 'hero',
    heroIndex: hero,
    arrange: 'top',
    title: `Big #${hero + 1}`,
    sub: 'featured',
    captions: [],
    cells: heroCells(aspects, hero, ar),
    page: PAGE,
    media: PAGE.media,
    paper: PAGE.paper,
  }));
  out.push({
    key: 'even', kind: 'even', title: 'Four equal', sub: 'no big one', captions: [],
    cells: evenCells(aspects, ar), page: PAGE, media: PAGE.media, paper: PAGE.paper,
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
