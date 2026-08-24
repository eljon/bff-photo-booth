// Photo looks. ctx.filter is used where the browser supports it (fast, GPU
// backed); older iOS Safari falls back to the equivalent per-pixel maths so a
// guest on an old phone still gets the same print.

export const FILTERS = {
  none: { id: 'none', name: 'True', css: 'none' },
  bw: { id: 'bw', name: 'B&W', css: 'grayscale(1) contrast(1.08)' },
  noir: { id: 'noir', name: 'Noir', css: 'grayscale(1) contrast(1.35) brightness(0.96)' },
  warm: { id: 'warm', name: 'Warm', css: 'saturate(1.12) sepia(0.18) brightness(1.03)' },
  cool: { id: 'cool', name: 'Cool', css: 'saturate(1.05) hue-rotate(-8deg) brightness(1.02)' },
  fade: { id: 'fade', name: 'Faded', css: 'contrast(0.88) saturate(0.85) brightness(1.08)' },
};

export const FILTER_ORDER = ['none', 'bw', 'noir', 'warm', 'cool', 'fade'];

let ctxFilterSupported = null;

export function supportsCtxFilter() {
  if (ctxFilterSupported !== null) return ctxFilterSupported;
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.filter = 'grayscale(1)';
    ctxFilterSupported = ctx.filter === 'grayscale(1)';
  } catch {
    ctxFilterSupported = false;
  }
  return ctxFilterSupported;
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

const PIXEL_OPS = {
  none: null,
  bw: (r, g, b) => {
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const c = (y - 128) * 1.08 + 128;
    return [c, c, c];
  },
  noir: (r, g, b) => {
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const c = ((y - 128) * 1.35 + 128) * 0.96;
    return [c, c, c];
  },
  warm: (r, g, b) => [r * 1.07 + 8, g * 1.02 + 2, b * 0.93],
  cool: (r, g, b) => [r * 0.93, g * 1.0, b * 1.09 + 6],
  fade: (r, g, b) => {
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const mix = (v) => (v * 0.85 + y * 0.15) * 0.88 + 30;
    return [mix(r), mix(g), mix(b)];
  },
};

/** Apply a filter preset to a whole canvas in place (fallback path). */
export function applyPixelFilter(canvas, filterId) {
  const op = PIXEL_OPS[filterId];
  if (!op) return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = op(d[i], d[i + 1], d[i + 2]);
    d[i] = clamp(r);
    d[i + 1] = clamp(g);
    d[i + 2] = clamp(b);
  }
  ctx.putImageData(image, 0, 0);
}
