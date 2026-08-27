import { LAYOUTS, FRAMES, resolveGrid, designVariants } from './layouts.mjs';
import { FILTERS, supportsCtxFilter, applyPixelFilter } from './filters.mjs';

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

// --- watercolor background art -------------------------------------------------
// Decorative full-bleed background images (the guest's uploaded PNGs). They load
// async; composePage draws whichever is ready and falls back to the paper colour
// until then. app.mjs calls preloadArt() at boot and re-renders on ready.
const artCache = new Map(); // src -> HTMLImageElement | 'pending' | 'error'
export function preloadArt(srcs, onReady) {
  for (const src of srcs) {
    if (artCache.has(src)) continue;
    artCache.set(src, 'pending');
    const img = new Image();
    img.onload = () => { artCache.set(src, img); if (onReady) onReady(); };
    img.onerror = () => { artCache.set(src, 'error'); };
    img.src = src;
  }
}
function artImage(src) {
  const v = artCache.get(src);
  return v && v !== 'pending' && v !== 'error' ? v : null;
}
/** Pick a background for this page from the frame's list — by orientation, varied
 *  per design so neighbouring cards in the picker don't all look identical. */
function artSrcFor(frame, layout) {
  const list = layout.page.w >= layout.page.h ? frame.art.land : frame.art.portrait;
  let hash = 0;
  const key = String(layout.key || layout.id || '');
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return list[hash % list.length];
}
function drawCover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * The smallest scale at which the photo, rotated by `rot`, still fully covers
 * the cell — so a rotated crop never leaves a blank corner. A rotated rectangle
 * of source size (W×H)·scale covers a cell (cellW×cellH) when, along each of the
 * photo's own axes, its half-extent clears the cell's rotated footprint:
 *   W·scale/2 ≥ (cellW·|cos| + cellH·|sin|)/2, and the same for H with axes swapped.
 * For an unrotated `contain` cell (the layout shapes each cell to its photo) that
 * reduces to the exact fit, so nothing crops until the guest zooms or rotates.
 */
function coverBase(cellW, cellH, W, H, rot, fit) {
  if (fit === 'contain' && rot % 360 === 0) return Math.min(cellW / W, cellH / H);
  const rad = (rot * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return Math.max((cellW * c + cellH * s) / W, (cellW * s + cellH * c) / H);
}

/**
 * Keep a crop inside its cell: however the guest zooms, pans, or rotates, the
 * photo still covers the frame, so a print can never come out with a sliver of
 * blank paper. Pan is clamped in the photo's own (rotated) frame, then mapped
 * back to page axes, so the reachable range is correct at any angle.
 */
export function clampTransform(transform, cellW, cellH, bitmap, fit = 'cover') {
  const t = { zoom: 1, dx: 0, dy: 0, rot: 0, ...transform };
  t.zoom = Math.min(4, Math.max(1, t.zoom));
  const rad = (t.rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const scale = coverBase(cellW, cellH, bitmap.width, bitmap.height, t.rot, fit) * t.zoom;

  // Half the cell's footprint measured along the photo's own axes.
  const needX = (cellW * Math.abs(cos) + cellH * Math.abs(sin)) / 2;
  const needY = (cellW * Math.abs(sin) + cellH * Math.abs(cos)) / 2;
  const slackX = Math.max(0, (bitmap.width * scale) / 2 - needX);
  const slackY = Math.max(0, (bitmap.height * scale) / 2 - needY);

  // Pan is stored as page-frame fractions of the cell. Rotate it into the photo
  // frame to clamp against the slack, then rotate it back.
  const px = t.dx * cellW;
  const py = t.dy * cellH;
  let lx = px * cos + py * sin;
  let ly = -px * sin + py * cos;
  lx = Math.min(slackX, Math.max(-slackX, lx));
  ly = Math.min(slackY, Math.max(-slackY, ly));
  t.dx = cellW ? (lx * cos - ly * sin) / cellW : 0;
  t.dy = cellH ? (lx * sin + ly * cos) / cellH : 0;
  return t;
}

/** Draw one photo, cover-fitted into a cell and honouring the guest's crop. */
function drawPhoto(ctx, cell, photo, filterId) {
  const { bitmap } = photo;
  const fit = cell.fit || 'cover';
  const t = clampTransform(photo.transform, cell.w, cell.h, bitmap, fit);
  const nw = bitmap.width;
  const nh = bitmap.height;
  const scale = coverBase(cell.w, cell.h, nw, nh, t.rot, fit) * t.zoom;

  ctx.save();
  if (cell.radius) roundRectPath(ctx, cell.x, cell.y, cell.w, cell.h, cell.radius);
  else { ctx.beginPath(); ctx.rect(cell.x, cell.y, cell.w, cell.h); }
  ctx.clip();

  const useCtxFilter = filterId !== 'none' && supportsCtxFilter();
  if (useCtxFilter) ctx.filter = FILTERS[filterId].css;

  ctx.translate(cell.x + cell.w / 2 + t.dx * cell.w, cell.y + cell.h / 2 + t.dy * cell.h);
  ctx.rotate((t.rot * Math.PI) / 180);
  ctx.drawImage(bitmap, (-nw * scale) / 2, (-nh * scale) / 2, nw * scale, nh * scale);
  ctx.restore();

  if (filterId !== 'none' && !useCtxFilter) {
    // Older Safari: redo this cell through the pixel path.
    const tile = document.createElement('canvas');
    tile.width = Math.max(1, Math.round(cell.w));
    tile.height = Math.max(1, Math.round(cell.h));
    const tctx = tile.getContext('2d', { willReadFrequently: true });
    tctx.translate(tile.width / 2 + t.dx * cell.w, tile.height / 2 + t.dy * cell.h);
    tctx.rotate((t.rot * Math.PI) / 180);
    tctx.drawImage(bitmap, (-nw * scale) / 2, (-nh * scale) / 2, nw * scale, nh * scale);
    applyPixelFilter(tile, filterId);
    ctx.drawImage(tile, cell.x, cell.y, cell.w, cell.h);
  }
}

function drawPlaceholder(ctx, cell, index, frame) {
  ctx.save();
  ctx.strokeStyle = frame.accent;
  ctx.fillStyle = frame.accent;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = Math.max(2, cell.w * 0.012);
  ctx.setLineDash([cell.w * 0.06, cell.w * 0.04]);
  ctx.strokeRect(cell.x + 4, cell.y + 4, cell.w - 8, cell.h - 8);
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.55;
  ctx.font = `600 ${Math.round(Math.min(cell.w, cell.h) * 0.3)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(index + 1), cell.x + cell.w / 2, cell.y + cell.h / 2);
  ctx.restore();
}

/**
 * Shrink text until it fits its block. Letter spacing has to be applied before
 * measuring, or a tracked-out footer runs off the edge of the paper.
 */
function fitText(ctx, text, maxWidth, startSize, weight, spacingRatio = 0) {
  let size = startSize;
  const apply = () => {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.letterSpacing = `${Math.round(size * spacingRatio)}px`;
  };
  apply();
  while (size > 10 && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    apply();
  }
  return size;
}

function drawCaption(ctx, box, frame, caption, subtitle) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.letterSpacing = '0px';
  const cx = box.x + box.w / 2;
  const hasCaption = Boolean(caption);
  const captionSize = Math.round(box.h * (hasCaption ? 0.42 : 0));
  const subSize = Math.round(box.h * (hasCaption ? 0.2 : 0.28));

  ctx.textBaseline = 'alphabetic';

  if (hasCaption) {
    ctx.fillStyle = frame.ink;
    fitText(ctx, caption, box.w, captionSize, '700');
    ctx.fillText(caption, cx, box.y + box.h * 0.52);
  }
  if (subtitle) {
    ctx.fillStyle = frame.accent;
    fitText(ctx, subtitle, box.w, subSize, '500', 0.12);
    ctx.fillText(subtitle, cx, box.y + box.h * (hasCaption ? 0.88 : 0.62));
  }
  ctx.restore();
}

function drawCutLine(ctx, layout, frame) {
  if (!layout.cutLine) return;
  ctx.save();
  ctx.strokeStyle = frame.accent;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 12]);
  ctx.beginPath();
  ctx.moveTo(layout.cutLine.x, layout.cutLine.y1 + 20);
  ctx.lineTo(layout.cutLine.x, layout.cutLine.y2 - 20);
  ctx.stroke();
  ctx.restore();
}

/**
 * Compose the whole page.
 * `scale` of 1 renders the real 300 DPI print; the preview uses a fraction.
 */
/** The layout to print for this state — resolving a dynamic grid to real cells,
 *  the chosen sheet orientation, and its paper size. When the guest has picked a
 *  design from the coverflow (state.designKey), that one is used; otherwise the
 *  booth's own auto-best grid. */
export function resolveLayout(state) {
  const base = LAYOUTS[state.layoutId];
  if (!base.dynamic) return base;
  if (state.designKey) {
    const chosen = designVariants(base, state.photos).find((d) => d.key === state.designKey);
    if (chosen) return { ...base, ...chosen };
  }
  return { ...base, ...resolveGrid(base, state.photos) };
}

export function composePage(canvas, state, scale = 1, layoutOverride = null) {
  const layout = layoutOverride || resolveLayout(state);
  const frame = FRAMES[state.frameId] || FRAMES.white;
  const w = Math.round(layout.page.w * scale);
  const h = Math.round(layout.page.h * scale);

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = frame.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.scale(scale, scale);
  ctx.imageSmoothingQuality = 'high';

  const P = layout.page;

  // A decorative "art" frame (the watercolor papers): a full-bleed background image
  // with the photos matted into the clear centre — rounded, shadowed and edged with a
  // bright border, like the layout mockups.
  const art = frame.art ? artImage(artSrcFor(frame, layout)) : null;
  if (frame.art && art) {
    // The paper is soft — resampling it at 'high' is pure cost, so drop to 'low' for
    // this one draw and restore for the photos (which need the quality).
    const q = ctx.imageSmoothingQuality;
    ctx.imageSmoothingQuality = 'low';
    drawCover(ctx, art, 0, 0, P.w, P.h);
    ctx.imageSmoothingQuality = q;
  }

  const cells = frame.art ? insetCells(layout.cells, P, frame) : layout.cells;

  cells.forEach((cell, i) => {
    const photo = state.photos[cell.photo];
    if (frame.art) {
      // White mat + soft drop shadow behind each photo. shadowBlur is very expensive
      // at print resolution, so it's capped to a small absolute radius — plenty for a
      // subtle lift, cheap enough not to hitch the coverflow.
      ctx.save();
      ctx.shadowColor = 'rgba(60,45,30,0.28)';
      ctx.shadowBlur = Math.min(cell.w * 0.045, 9);
      ctx.shadowOffsetY = Math.min(cell.h * 0.012, 4);
      ctx.fillStyle = '#fffdf9';
      roundRectPath(ctx, cell.x, cell.y, cell.w, cell.h, cell.radius);
      ctx.fill();
      ctx.restore();
    }
    if (photo && photo.bitmap) drawPhoto(ctx, cell, photo, state.filterId);
    else drawPlaceholder(ctx, cell, cell.photo, frame);
    if (frame.art) {
      // Bright rounded border in a rotating palette (like the mockups).
      const colors = frame.cell.borders;
      const bw = Math.min(cell.w, cell.h) * frame.cell.borderW;
      ctx.save();
      ctx.lineWidth = bw;
      ctx.strokeStyle = colors[i % colors.length];
      roundRectPath(ctx, cell.x + bw / 2, cell.y + bw / 2, cell.w - bw, cell.h - bw, Math.max(0, cell.radius - bw / 2));
      ctx.stroke();
      ctx.restore();
    }
  });

  // One sticker per page, dropped into whichever corner covers the photos the least.
  if (frame.art && frame.sticker) {
    const st = artImage(frame.sticker);
    if (st) {
      const s = placeSticker(st, cells, P, frame.stickerW || 0.32);
      ctx.save();
      ctx.shadowColor = 'rgba(40,30,20,0.3)';
      ctx.shadowBlur = Math.min(s.w * 0.03, 8);
      ctx.shadowOffsetY = 3;
      ctx.drawImage(st, s.x, s.y, s.w, s.h);
      ctx.restore();
    }
  }

  drawCutLine(ctx, layout, frame);
  for (const box of layout.captions) drawCaption(ctx, box, frame, state.caption, state.subtitle);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

function rectOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  return ix * iy;
}
/** Place the sticker in the page corner whose rectangle overlaps the photo cells the
 *  least — so it lands mostly on the decorative border and only kisses a photo edge. */
function placeSticker(img, cells, page, widthFrac) {
  const w = page.w * widthFrac;
  const h = w * (img.height / img.width);
  const m = page.w * 0.012; // a hair in from the paper edge
  const corners = [
    { x: m, y: m },
    { x: page.w - w - m, y: m },
    { x: m, y: page.h - h - m },
    { x: page.w - w - m, y: page.h - h - m },
  ];
  let best = corners[0];
  let least = Infinity;
  for (const c of corners) {
    let ov = 0;
    for (const cell of cells) ov += rectOverlap(c.x, c.y, w, h, cell.x, cell.y, cell.w, cell.h);
    if (ov < least) { least = ov; best = c; }
  }
  return { x: best.x, y: best.y, w, h };
}

/** Squeeze the layout's edge-to-edge cells into the paper's clear centre, and give
 *  each a corner radius, so the decorative border shows all around. */
function insetCells(cells, page, frame) {
  const ix = frame.insetX * page.w;
  const iy = frame.insetY * page.h;
  const cw = page.w - 2 * ix;
  const ch = page.h - 2 * iy;
  return cells.map((c) => {
    const nw = (c.w / page.w) * cw;
    const nh = (c.h / page.h) * ch;
    return {
      ...c,
      x: ix + (c.x / page.w) * cw,
      y: iy + (c.y / page.h) * ch,
      w: nw,
      h: nh,
      radius: Math.min(nw, nh) * frame.cell.radius,
    };
  });
}

// Layouts are described at 300 DPI. We render the PRINT at PRINT_SCALE× that
// (600 DPI) so a capable photo printer gets real detail instead of upscaling a
// 300 DPI image — the difference between a crisp print and a soft, grainy one.
// The on-screen preview stays at its own (smaller) scale, so this costs nothing
// there. Source photos are kept large enough (MAX_SOURCE_DIM) to fill a full-page
// cell at this resolution.
export const PRINT_SCALE = 2;

// The speculative "warm" render (only ever used for Save/Share to the phone) is done at
// this lower scale — 300 DPI is ample for a phone photo, and rendering the full-bleed
// watercolor page at 600 DPI blocked the main thread ~260ms, hitching the coverflow.
// The actual PRINT still uses PRINT_SCALE for full detail on paper.
export const SAVE_SCALE = 1;

/** Render the print-resolution page and hand back a file ready for the queue.
 *  `rotateForPaper` turns a landscape composition 90° into a portrait bitmap:
 *  4×6 photo paper feeds one way (portrait), and borderless is only offered at
 *  that size, so a wide design must be rotated to fill the sheet or it prints
 *  sideways. The saved-to-phone image is NOT rotated — it keeps its true look. */
export async function exportPrint(state, { rotateForPaper = false, scale = PRINT_SCALE } = {}) {
  const page = document.createElement('canvas');
  composePage(page, state, scale);

  let canvas = page;
  if (rotateForPaper && page.width > page.height) {
    canvas = document.createElement('canvas');
    canvas.width = page.height;
    canvas.height = page.width;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(Math.PI / 2); // 90° clockwise: long edge now runs down the 6" side
    ctx.drawImage(page, -page.width / 2, -page.height / 2);
  }

  // A photographic page (the watercolor paper + photos) makes a huge PNG that is
  // slow to encode — ~6.6MB and ~400ms at 600 DPI, which hitched the coverflow — and
  // it always fell back to JPEG anyway. So for art frames, encode JPEG straight away
  // (~75ms, indistinguishable on photo paper). Plain frames keep lossless PNG.
  const photographic = !!(FRAMES[state.frameId] && FRAMES[state.frameId].art);
  let blob;
  if (photographic) {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
  } else {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob && blob.size > 3 * 1024 * 1024) {
      const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
      if (jpeg) blob = jpeg;
    }
  }
  if (!blob) throw new Error('This browser could not render the print.');
  return { blob, width: canvas.width, height: canvas.height };
}

/** Single photo filling a canvas — used by the crop editor and the slot thumbs. */
export function drawSinglePhoto(canvas, photo, filterId = 'none') {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawPhoto(ctx, { x: 0, y: 0, w: canvas.width, h: canvas.height }, photo, filterId);
  return canvas;
}
