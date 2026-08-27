// A procedurally-drawn watercolor "kids" frame: warm paper, loose scribble strokes
// and flat little icons (sun, clouds, hearts, flowers, sparkles, leaves, a house)
// scattered around the margins, leaving the centre clear for the photos. Drawn to a
// 2D context at whatever resolution the page needs, so it stays crisp at 600 DPI.
//
// Everything is seeded so a given page (orientation + size) always paints the SAME
// frame — the on-screen preview and the printed sheet must match exactly.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE = {
  coral: '#ef6f6c', red: '#e8615c', peach: '#f6b26b', apricot: '#f7c59f',
  yellow: '#f6c445', teal: '#5cc0be', aqua: '#7fd1cc', green: '#8cc152',
  leaf: '#a5d76e', sky: '#5bb3e0', blue: '#3f8fce', pink: '#ef5f8a',
};

/** A soft, slightly irregular watercolour "scribble" — a stack of translucent wavy
 *  strokes, like a brush dragged back and forth. */
function scribble(ctx, rnd, cx, cy, len, color, rows) {
  const h = len * 0.12;
  for (let r = 0; r < rows; r++) {
    const yy = cy + (r - (rows - 1) / 2) * (h * 0.9);
    const w = len * (0.7 + rnd() * 0.5);
    ctx.beginPath();
    const x0 = cx - w / 2;
    const steps = 5;
    ctx.moveTo(x0, yy);
    for (let s = 1; s <= steps; s++) {
      const x = x0 + (w * s) / steps;
      const wob = (rnd() - 0.5) * h * 0.7;
      ctx.lineTo(x, yy + wob);
    }
    ctx.lineWidth = h * (0.7 + rnd() * 0.5);
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.5 + rnd() * 0.35;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function heart(ctx, x, y, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.fillStyle = color; ctx.beginPath();
  ctx.moveTo(0, s * 0.3);
  ctx.bezierCurveTo(s * 0.5, -s * 0.35, s * 1.1, s * 0.25, 0, s);
  ctx.bezierCurveTo(-s * 1.1, s * 0.25, -s * 0.5, -s * 0.35, 0, s * 0.3);
  ctx.fill(); ctx.restore();
}

function sparkle(ctx, x, y, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.fillStyle = color; ctx.beginPath();
  ctx.moveTo(0, -s); ctx.quadraticCurveTo(s * 0.16, -s * 0.16, s, 0);
  ctx.quadraticCurveTo(s * 0.16, s * 0.16, 0, s);
  ctx.quadraticCurveTo(-s * 0.16, s * 0.16, -s, 0);
  ctx.quadraticCurveTo(-s * 0.16, -s * 0.16, 0, -s);
  ctx.fill(); ctx.restore();
}

function flower(ctx, x, y, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.fillStyle = color;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    const a = (i / 5) * Math.PI * 2;
    ctx.ellipse(Math.cos(a) * s * 0.62, Math.sin(a) * s * 0.62, s * 0.5, s * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, s * 0.42, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function sun(ctx, x, y, s) {
  ctx.save(); ctx.translate(x, y); ctx.fillStyle = PALETTE.yellow;
  for (let i = 0; i < 12; i++) {
    ctx.save(); ctx.rotate((i / 12) * Math.PI * 2);
    ctx.beginPath(); ctx.moveTo(-s * 0.12, -s * 1.05); ctx.lineTo(s * 0.12, -s * 1.05);
    ctx.lineTo(0, -s * 1.45); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  ctx.fillStyle = '#f7a70a'; ctx.beginPath(); ctx.arc(0, 0, s, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = PALETTE.yellow; ctx.beginPath(); ctx.arc(0, 0, s * 0.82, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function cloud(ctx, x, y, s) {
  ctx.save(); ctx.translate(x, y); ctx.fillStyle = '#a9dbf0';
  ctx.beginPath();
  ctx.arc(-s * 0.7, s * 0.1, s * 0.55, 0, Math.PI * 2);
  ctx.arc(0, -s * 0.15, s * 0.7, 0, Math.PI * 2);
  ctx.arc(s * 0.75, s * 0.12, s * 0.5, 0, Math.PI * 2);
  ctx.rect(-s * 0.7, s * 0.1, s * 1.45, s * 0.55);
  ctx.fill(); ctx.restore();
}

function leafSprig(ctx, x, y, s, angle, color) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.fillStyle = color;
  ctx.strokeStyle = color; ctx.lineWidth = s * 0.08; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -s * 1.6); ctx.stroke();
  for (let i = 1; i <= 3; i++) {
    const ly = -s * 0.4 * i;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(dir * s * 0.28, ly, s * 0.34, s * 0.16, dir * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function house(ctx, x, y, s) {
  ctx.save(); ctx.translate(x, y);
  // hill
  ctx.fillStyle = PALETTE.green; ctx.beginPath();
  ctx.ellipse(0, s * 1.1, s * 2.2, s * 0.9, 0, Math.PI, Math.PI * 2); ctx.fill();
  // body + roof
  ctx.fillStyle = '#2f6f8f'; ctx.fillRect(-s * 0.7, -s * 0.1, s * 1.4, s * 1.1);
  ctx.fillStyle = '#3f9ec0'; ctx.beginPath();
  ctx.moveTo(-s, -s * 0.1); ctx.lineTo(0, -s); ctx.lineTo(s, -s * 0.1); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#bfe6f2'; ctx.fillRect(s * 0.1, s * 0.25, s * 0.35, s * 0.4); // window
  ctx.fillStyle = '#1f5570'; ctx.fillRect(-s * 0.45, s * 0.35, s * 0.32, s * 0.65); // door
  ctx.restore();
}

const ICONS = [
  (ctx, x, y, s, rnd) => heart(ctx, x, y, s * 0.9, pick(rnd, [PALETTE.coral, PALETTE.blue, PALETTE.yellow, PALETTE.leaf, PALETTE.pink])),
  (ctx, x, y, s, rnd) => sparkle(ctx, x, y, s * 0.9, pick(rnd, [PALETTE.sky, PALETTE.green, PALETTE.yellow, PALETTE.blue])),
  (ctx, x, y, s, rnd) => flower(ctx, x, y, s * 0.85, pick(rnd, [PALETTE.pink, PALETTE.yellow, PALETTE.sky, PALETTE.coral])),
  (ctx, x, y, s, rnd) => leafSprig(ctx, x, y, s * 1.1, (rnd() - 0.5) * 1.2, pick(rnd, [PALETTE.leaf, PALETTE.green, PALETTE.aqua])),
];

function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }

/** Paint the whole watercolor frame onto ctx, filling w×h. Deterministic per size. */
export function drawWatercolorFrame(ctx, w, h, seed = 7) {
  const rnd = mulberry32(seed + Math.round(w) * 3 + Math.round(h) * 7);
  const u = Math.min(w, h) / 100; // one "unit" ≈ 1% of the short side

  // Warm paper
  ctx.fillStyle = '#f7f3ea';
  ctx.fillRect(0, 0, w, h);
  // Faint fibrous speckle for a paper feel
  ctx.save();
  for (let i = 0; i < (w * h) / 2600; i++) {
    ctx.globalAlpha = 0.03 + rnd() * 0.04;
    ctx.fillStyle = rnd() > 0.5 ? '#d8cfbc' : '#fffdf7';
    const sx = rnd() * w, sy = rnd() * h, ss = u * (0.15 + rnd() * 0.35);
    ctx.fillRect(sx, sy, ss, ss);
  }
  ctx.restore();

  // Watercolor scribble clusters hugging the four edges (never the centre).
  const strokeColors = [PALETTE.coral, PALETTE.peach, PALETTE.teal, PALETTE.green, PALETTE.sky, PALETTE.apricot, PALETTE.red];
  const clusters = [
    { x: w * 0.12, y: h * 0.05, len: w * 0.24 }, { x: w * 0.55, y: h * 0.04, len: w * 0.22 },
    { x: w * 0.9, y: h * 0.06, len: w * 0.22 }, { x: w * 0.06, y: h * 0.32, len: h * 0.16 },
    { x: w * 0.05, y: h * 0.7, len: h * 0.16 }, { x: w * 0.95, y: h * 0.35, len: h * 0.16 },
    { x: w * 0.94, y: h * 0.72, len: h * 0.16 }, { x: w * 0.2, y: h * 0.96, len: w * 0.22 },
    { x: w * 0.75, y: h * 0.96, len: w * 0.24 },
  ];
  clusters.forEach((c, i) => scribble(ctx, rnd, c.x, c.y, c.len, strokeColors[i % strokeColors.length], 3 + Math.floor(rnd() * 2)));

  // Anchor motifs in a couple of corners.
  sun(ctx, w - u * 14, u * 12, u * 6);
  cloud(ctx, w * 0.5 * (0.3 + rnd() * 0.1) + u * 6, u * 9, u * 6);
  house(ctx, u * 12, h - u * 12, u * 6);

  // Scatter little icons around the margin band, skipping the central photo area.
  const margin = 0.16; // fraction of each edge kept as the "frame" band
  const count = Math.round((w + h) / (u * 26));
  for (let i = 0; i < count; i++) {
    let x, y;
    if (rnd() < 0.5) { // top/bottom bands
      x = w * (0.08 + rnd() * 0.84);
      y = rnd() < 0.5 ? h * (0.03 + rnd() * margin) : h * (1 - 0.03 - rnd() * margin);
    } else { // left/right bands
      x = rnd() < 0.5 ? w * (0.03 + rnd() * margin) : w * (1 - 0.03 - rnd() * margin);
      y = h * (0.1 + rnd() * 0.8);
    }
    const s = u * (2.2 + rnd() * 2.2);
    pick(rnd, ICONS)(ctx, x, y, s, rnd);
  }
}

export const WATERCOLOR_BORDERS = ['#f5a623', '#4aa8c9', '#7cc04a', '#ef6f8a', '#5cc0be'];
