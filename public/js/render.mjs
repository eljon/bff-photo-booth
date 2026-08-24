import { LAYOUTS, FRAMES, autoLayout } from './layouts.mjs';
import { FILTERS, supportsCtxFilter, applyPixelFilter } from './filters.mjs';

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/**
 * Keep a crop inside its cell: however the guest pans, the photo still covers
 * the frame, so a print can never come out with a sliver of blank paper.
 */
export function clampTransform(transform, cellW, cellH, bitmap, fit = 'cover') {
  const t = { zoom: 1, dx: 0, dy: 0, rot: 0, ...transform };
  t.zoom = Math.min(4, Math.max(1, t.zoom));
  const swap = Math.abs(t.rot % 180) === 90;
  const fw = swap ? bitmap.height : bitmap.width;
  const fh = swap ? bitmap.width : bitmap.height;
  const base = fit === 'contain' ? Math.min(cellW / fw, cellH / fh) : Math.max(cellW / fw, cellH / fh);
  const scale = base * t.zoom;
  const slackX = Math.max(0, (fw * scale - cellW) / 2) / cellW;
  const slackY = Math.max(0, (fh * scale - cellH) / 2) / cellH;
  t.dx = Math.min(slackX, Math.max(-slackX, t.dx));
  t.dy = Math.min(slackY, Math.max(-slackY, t.dy));
  return t;
}

/** Draw one photo, cover-fitted into a cell and honouring the guest's crop. */
function drawPhoto(ctx, cell, photo, filterId) {
  const { bitmap } = photo;
  const fit = cell.fit || 'cover';
  const t = clampTransform(photo.transform, cell.w, cell.h, bitmap, fit);
  const swap = Math.abs(t.rot % 180) === 90;
  const nw = bitmap.width;
  const nh = bitmap.height;
  const footprintW = swap ? nh : nw;
  const footprintH = swap ? nw : nh;
  const fitScale = fit === 'contain'
    ? Math.min(cell.w / footprintW, cell.h / footprintH)
    : Math.max(cell.w / footprintW, cell.h / footprintH);
  const scale = fitScale * t.zoom;

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
export function composePage(canvas, state, scale = 1) {
  const base = LAYOUTS[state.layoutId];
  const layout = base.dynamic ? { ...base, ...autoLayout(base, state.photos) } : base;
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

/** Render the print-resolution page and hand back a file ready for the queue. */
export async function exportPrint(state) {
  const canvas = document.createElement('canvas');
  composePage(canvas, state, 1);

  let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('This browser could not render the print.');
  if (blob.size > 3 * 1024 * 1024) {
    // A big PNG crawls over cellular; a 0.94 JPEG is indistinguishable at
    // 300 DPI on photo paper and uploads in a second or two.
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94));
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
