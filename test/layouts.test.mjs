import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, LAYOUT_ORDER, FRAMES, autoLayout, resolveGrid } from '../public/js/layouts.mjs';

// Four stand-in photos of mixed orientation, so the dynamic grid is exercised
// on the case that matters — not just placeholders.
const MIXED = [
  { bitmap: { width: 1600, height: 1000 }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } },
  { bitmap: { width: 1000, height: 1600 }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } },
  { bitmap: { width: 1200, height: 1200 }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } },
  { bitmap: { width: 1600, height: 1000 }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } },
];

/** The resolved layout for an id — dynamic grids flip the sheet to fit. */
function resolved(id, photos = MIXED) {
  const base = LAYOUTS[id];
  const r = base.dynamic ? resolveGrid(base, photos) : { cells: base.cells, page: base.page };
  return { cells: r.cells, page: r.page };
}
function cellsFor(id, photos = MIXED) {
  return resolved(id, photos).cells;
}

const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('every layout is a real photo paper size at 300 DPI', () => {
  for (const id of LAYOUT_ORDER) {
    const { page } = LAYOUTS[id];
    const inches = [page.w / 300, page.h / 300].sort((a, b) => a - b);
    assert.deepEqual(inches, [4, 6], `${id} should be a 4x6 sheet`);
  }
});

test('cells stay on the paper and never overlap each other', () => {
  for (const id of LAYOUT_ORDER) {
    const { cells, page } = resolved(id);
    for (const cell of cells) {
      assert.ok(cell.x >= -1 && cell.y >= -1, `${id}: cell starts off the page`);
      assert.ok(cell.x + cell.w <= page.w + 1, `${id}: cell runs off the right edge`);
      assert.ok(cell.y + cell.h <= page.h + 1, `${id}: cell runs off the bottom edge`);
      assert.ok(cell.w > 100 && cell.h > 100, `${id}: cell is implausibly small`);
    }
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        assert.ok(!overlaps(cells[i], cells[j]), `${id}: cells ${i} and ${j} overlap`);
      }
    }
  }
});

test('each layout uses all four photos', () => {
  for (const id of LAYOUT_ORDER) {
    const used = new Set(cellsFor(id).map((cell) => cell.photo));
    assert.deepEqual([...used].sort(), [0, 1, 2, 3], `${id} should place photos 0-3`);
  }
});

test('the classic strip prints two identical copies with a cut line', () => {
  const strip = LAYOUTS.strip;
  assert.equal(strip.cells.length, 8);
  assert.ok(strip.cutLine, 'strip needs a cut guide');
  const left = strip.cells.slice(0, 4);
  const right = strip.cells.slice(4);
  left.forEach((cell, i) => {
    assert.equal(cell.photo, right[i].photo, 'both strips show the same four photos');
    assert.equal(cell.y, right[i].y, 'strips are aligned');
    assert.equal(cell.w, right[i].w);
  });
  assert.equal(strip.cutLine.x, strip.page.w / 2);
});

test('caption blocks sit clear of every photo', () => {
  for (const id of LAYOUT_ORDER) {
    const layout = LAYOUTS[id];
    for (const box of layout.captions) {
      assert.ok(box.h > 60, `${id}: caption block is too short to read`);
      assert.ok(box.y + box.h <= layout.page.h, `${id}: caption runs off the page`);
      for (const cell of cellsFor(id)) {
        assert.ok(!overlaps(box, cell), `${id}: caption overlaps a photo`);
      }
    }
  }
});

test('frames define a readable ink colour', () => {
  for (const frame of Object.values(FRAMES)) {
    assert.match(frame.bg, /^#[0-9a-f]{6}$/i, `${frame.id} background`);
    assert.match(frame.ink, /^#[0-9a-f]{6}$/i, `${frame.id} ink`);
    assert.match(frame.accent, /^#[0-9a-f]{6}$/i, `${frame.id} accent`);
  }
});

test('the auto grid gives every photo a cell shaped to it — so nothing is cropped', () => {
  const mixes = [
    [[1000, 1600], [1000, 1600], [1000, 1600], [1000, 1600]],       // 4 portrait
    [[1600, 1000], [1600, 1000], [1600, 1000], [1600, 1000]],       // 4 landscape
    [[1000, 1600], [1600, 1000], [1600, 1000], [1600, 1000]],       // 1P + 3L
    [[1600, 1000], [1000, 1600], [1200, 1200], [1600, 1000]],       // a bit of everything
  ];
  for (const mix of mixes) {
    const photos = mix.map(([w, h]) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } }));
    const { cells } = autoLayout(LAYOUTS.grid, photos);
    assert.equal(cells.length, 4);
    cells.forEach((cell, i) => {
      const photoAspect = photos[i].bitmap.width / photos[i].bitmap.height;
      const cellAspect = cell.w / cell.h;
      // Cell matches the photo, so a contain-fit fills it with no crop and no bars.
      assert.ok(Math.abs(photoAspect - cellAspect) / photoAspect < 0.02,
        `photo ${i} (${photoAspect.toFixed(2)}) got a cell of ${cellAspect.toFixed(2)} — it would crop`);
      assert.equal(cell.fit, 'contain', 'auto-grid cells must contain-fit');
    });
  }
});

test('the auto grid keeps a fair spread — the smallest photo is not a stamp', () => {
  const photos = [[1600, 1000], [1000, 1600], [1600, 1000], [1000, 1600]]
    .map(([w, h]) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } }));
  const { cells } = autoLayout(LAYOUTS.grid, photos);
  const areas = cells.map((c) => c.w * c.h);
  const ratio = Math.min(...areas) / Math.max(...areas);
  assert.ok(ratio > 0.35, `smallest cell is ${(ratio * 100).toFixed(0)}% of the largest — too lopsided`);
});

test('the sheet rotates to landscape when that fills more paper', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });

  const landscapes = resolveGrid(LAYOUTS.grid, [mk(1600, 1000), mk(1600, 1000), mk(1600, 1000), mk(1600, 1000)]);
  assert.ok(landscapes.page.w > landscapes.page.h, 'four landscapes should print on a landscape sheet');
  assert.equal(landscapes.media, 'Custom.6x4in');

  const portraits = resolveGrid(LAYOUTS.grid, [mk(1000, 1600), mk(1000, 1600), mk(1000, 1600), mk(1000, 1600)]);
  assert.ok(portraits.page.h > portraits.page.w, 'four portraits should stay on a portrait sheet');
  assert.equal(portraits.media, 'Custom.4x6in');

  // the rotate is only taken when it genuinely helps
  const coverage = (r) => r.cells.reduce((s, c) => s + c.w * c.h, 0) / (r.page.w * r.page.h);
  assert.ok(coverage(landscapes) > 0.5, 'landscape sheet should be well filled by landscape photos');
});
