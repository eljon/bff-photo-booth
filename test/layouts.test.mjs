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

test('the four photos tile the whole sheet — every pixel of paper is used', () => {
  const mixes = [
    [[1000, 1500], [1200, 1200], [1200, 1200], [1200, 1200]],   // portrait hero
    [[1600, 1000], [1200, 1200], [1200, 1200], [1200, 1200]],   // landscape hero
    [[1000, 1500], [1600, 1000], [1000, 1500], [1200, 1200]],   // mixed
  ];
  for (const mix of mixes) {
    const photos = mix.map(([w, h]) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } }));
    const { cells, page } = resolveGrid(LAYOUTS.grid, photos);
    assert.equal(cells.length, 4);
    assert.ok(cells.every((c) => c.fit === 'cover'), 'cells cover-fit so they fill the paper');

    // the cells partition the page: areas sum to the whole sheet, nothing spills
    const area = cells.reduce((s, c) => s + c.w * c.h, 0);
    assert.ok(Math.abs(area - page.w * page.h) / (page.w * page.h) < 0.001, 'cells must fill 100% of the sheet');
    for (const c of cells) {
      assert.ok(c.x >= -1 && c.y >= -1 && c.x + c.w <= page.w + 1 && c.y + c.h <= page.h + 1, 'cell stays on the page');
    }
  }
});

test('there is no caption band eating into the photos', () => {
  const photos = [1, 2, 3, 4].map(() => ({ bitmap: { width: 1200, height: 1200 }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } }));
  const { captions } = resolveGrid(LAYOUTS.grid, photos);
  assert.deepEqual(captions, [], 'the caption was removed — photos own the whole sheet');
});

test('the hero is the first photo and dwarfs the other three', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  const photos = [mk(1000, 1500), mk(1200, 1200), mk(1200, 1200), mk(1200, 1200)];
  const { cells } = resolveGrid(LAYOUTS.grid, photos);

  assert.equal(cells[0].photo, 0, 'photo 0 is the hero');
  const heroArea = cells[0].w * cells[0].h;
  for (let i = 1; i < 4; i++) {
    const thumbArea = cells[i].w * cells[i].h;
    assert.ok(heroArea > thumbArea * 3, `hero is only ${(heroArea / thumbArea).toFixed(1)}x a thumb — not dominant enough`);
  }
});

test('a different hero can be chosen by passing its index', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  const photos = [mk(1200, 1200), mk(1200, 1200), mk(1000, 1500), mk(1200, 1200)];
  const { cells } = resolveGrid(LAYOUTS.grid, photos, 2);
  assert.equal(cells[0].photo, 2, 'the chosen index leads as the hero');
});

test('the print picks the sheet orientation whose media matches it', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });

  // A wide-panorama hero fills a landscape sheet better and should rotate to it.
  const pano = resolveGrid(LAYOUTS.grid, [mk(3000, 1000), mk(1200, 1200), mk(1200, 1200), mk(1200, 1200)]);
  assert.ok(pano.page.w > pano.page.h, 'a panorama hero should print landscape');
  assert.equal(pano.media, 'Custom.6x4in');

  // A tall portrait hero stays on a portrait sheet.
  const tall = resolveGrid(LAYOUTS.grid, [mk(1000, 1600), mk(1200, 1200), mk(1200, 1200), mk(1200, 1200)]);
  assert.ok(tall.page.h > tall.page.w, 'a portrait hero should print portrait');
  assert.equal(tall.media, 'Custom.4x6in');

  // Media always matches the chosen sheet, never contradicts it.
  for (const r of [pano, tall]) {
    const wantLandscape = r.page.w > r.page.h;
    assert.equal(r.media, wantLandscape ? 'Custom.6x4in' : 'Custom.4x6in');
  }
});
