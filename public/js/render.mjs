import { LAYOUTS, FRAMES, resolveGrid, designVariants } from './layouts.mjs';
import { FILTERS, supportsCtxFilter, applyPixelFilter } from './filters.mjs';

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

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
  ctx.beginPath();
  ctx.rect(cell.x, cell.y, cell.w, cell.h);
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

  for (const cell of layout.cells) {
    const photo = state.photos[cell.photo];
    if (photo && photo.bitmap) drawPhoto(ctx, cell, photo, state.filterId);
    else drawPlaceholder(ctx, cell, cell.photo, frame);
  }

  drawCutLine(ctx, layout, frame);
  for (const box of layout.captions) drawCaption(ctx, box, frame, state.caption, state.subtitle);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

// Layouts are described at 300 DPI. We render the PRINT at PRINT_SCALE× that
// (600 DPI) so a capable photo printer gets real detail instead of upscaling a
// 300 DPI image — the difference between a crisp print and a soft, grainy one.
// The on-screen preview stays at its own (smaller) scale, so this costs nothing
// there. Source photos are kept large enough (MAX_SOURCE_DIM) to fill a full-page
// cell at this resolution.
export const PRINT_SCALE = 2;

/** Render the print-resolution page and hand back a file ready for the queue. */
export async function exportPrint(state) {
  const canvas = document.createElement('canvas');
  composePage(canvas, state, PRINT_SCALE);

  let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('This browser could not render the print.');
  if (blob.size > 3 * 1024 * 1024) {
    // A big PNG crawls over cellular; a 0.95 JPEG is indistinguishable on photo
    // paper and uploads in a second or two.
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (jpeg) blob = jpeg;
  }
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
