import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, LAYOUT_ORDER, FRAMES, resolveGrid, designVariants } from '../public/js/layouts.mjs';

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

test('nothing is cropped, and the grid is flush to all four paper edges', () => {
  const mixes = [
    [[1000, 1500], [1200, 1200], [1200, 1200], [1200, 1200]],   // portrait hero
    [[1600, 1000], [1200, 1200], [1200, 1200], [1200, 1200]],   // landscape hero
    [[1000, 1500], [1600, 1000], [1000, 1500], [1200, 1200]],   // mixed
  ];
  for (const mix of mixes) {
    const photos = mix.map(([w, h]) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } }));
    const { cells, page } = resolveGrid(LAYOUTS.grid, photos);
    assert.equal(cells.length, 4);

    for (const c of cells) {
      // contain-fit is what guarantees no crop — the photo shrinks to fit its
      // cell, it is never scaled up and clipped.
      assert.equal(c.fit, 'contain', 'contain-fit is what guarantees no crop');
      assert.ok(c.x >= -1 && c.y >= -1 && c.x + c.w <= page.w + 1 && c.y + c.h <= page.h + 1, 'cell stays on the page');
    }

    // The combined grid touches every edge of the paper — no outer margin.
    const left = Math.min(...cells.map((c) => c.x));
    const top = Math.min(...cells.map((c) => c.y));
    const right = Math.max(...cells.map((c) => c.x + c.w));
    const bottom = Math.max(...cells.map((c) => c.y + c.h));
    assert.ok(left <= 1, `grid has a ${left.toFixed(0)}px gap on the left — should be flush`);
    assert.ok(top <= 1, `grid has a ${top.toFixed(0)}px gap on the top — should be flush`);
    assert.ok(right >= page.w - 1, `grid stops ${(page.w - right).toFixed(0)}px short of the right edge`);
    assert.ok(bottom >= page.h - 1, `grid stops ${(page.h - bottom).toFixed(0)}px short of the bottom edge`);

    // The cells tile the whole sheet save for the thin uniform gutters between
    // them, so the frame is nearly fully used.
    const coverage = cells.reduce((s, c) => s + c.w * c.h, 0) / (page.w * page.h);
    assert.ok(coverage > 0.9, `only ${(coverage * 100).toFixed(0)}% of the paper covered by cells — should be higher`);
  }
});

test('the gutters between the four photos are uniform', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  const photos = [mk(1000, 1500), mk(1200, 1200), mk(1200, 1200), mk(1200, 1200)];
  const { cells } = resolveGrid(LAYOUTS.grid, photos);
  const hero = cells[0];
  const thumbs = cells.slice(1);

  // Whether the hero sits on top or on the left, the three thumbs share one
  // axis. Every neighbouring gap along that axis is the same width.
  const stacked = thumbs.every((t) => Math.abs(t.x - thumbs[0].x) < 1); // a vertical column
  const gaps = [];
  if (stacked) {
    for (let i = 1; i < thumbs.length; i++) gaps.push(thumbs[i].y - (thumbs[i - 1].y + thumbs[i - 1].h));
    gaps.push(thumbs[0].x - (hero.x + hero.w)); // hero-to-column gap
  } else {
    for (let i = 1; i < thumbs.length; i++) gaps.push(thumbs[i].x - (thumbs[i - 1].x + thumbs[i - 1].w));
    gaps.push(thumbs[0].y - (hero.y + hero.h)); // hero-to-row gap
  }
  for (const g of gaps) {
    assert.ok(Math.abs(g - gaps[0]) < 1, `gutter ${g.toFixed(0)}px differs from ${gaps[0].toFixed(0)}px — should be uniform`);
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

test('the coverflow offers each photo as the hero plus an even grid, all distinct', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  const photos = [mk(1000, 1500), mk(1600, 1000), mk(1200, 1200), mk(1000, 1500)];
  const variants = designVariants(LAYOUTS.grid, photos);

  // Every photo can be the hero (both placements) and there is a no-hero option.
  for (let h = 0; h < 4; h++) {
    assert.ok(variants.some((v) => v.kind === 'hero' && v.heroIndex === h), `photo ${h} is offered as a hero`);
  }
  assert.ok(variants.some((v) => v.kind === 'even'), 'an even grid is offered');
  assert.ok(variants.length >= 5, 'there are several designs to swipe through');

  // No two cards are the same design, and each has a stable key and a label.
  const keys = new Set(variants.map((v) => v.key));
  assert.equal(keys.size, variants.length, 'every design has a unique key');
  for (const v of variants) {
    assert.ok(v.key && v.title, 'a card has a key and a title');
    assert.deepEqual([...new Set(v.cells.map((c) => c.photo))].sort(), [0, 1, 2, 3], `${v.key} uses all four photos`);
  }
});

test('every coverflow design is flush to the paper and crops nothing', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  const photos = [mk(1000, 1500), mk(1600, 1000), mk(1200, 1200), mk(1000, 1500)];
  for (const v of designVariants(LAYOUTS.grid, photos)) {
    for (const c of v.cells) {
      assert.equal(c.fit, 'contain', `${v.key} crops nothing`);
      assert.ok(c.x >= -1 && c.y >= -1 && c.x + c.w <= v.page.w + 1 && c.y + c.h <= v.page.h + 1, `${v.key} stays on the page`);
    }
    const left = Math.min(...v.cells.map((c) => c.x));
    const top = Math.min(...v.cells.map((c) => c.y));
    const right = Math.max(...v.cells.map((c) => c.x + c.w));
    const bottom = Math.max(...v.cells.map((c) => c.y + c.h));
    assert.ok(left <= 1 && top <= 1, `${v.key} is flush to the top-left`);
    assert.ok(right >= v.page.w - 1 && bottom >= v.page.h - 1, `${v.key} is flush to the bottom-right`);
  }
});

test('the first coverflow design is what the booth would pick on its own', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  const photos = [mk(1000, 1500), mk(1600, 1000), mk(1200, 1200), mk(1000, 1500)];
  const auto = resolveGrid(LAYOUTS.grid, photos);
  const first = designVariants(LAYOUTS.grid, photos)[0];
  assert.equal(first.heroIndex, 0, 'the lead card heroes photo 1');
  assert.equal(first.page.w, auto.page.w, 'the lead card matches the auto sheet');
  assert.equal(first.page.h, auto.page.h);
  assert.deepEqual(first.cells.map((c) => c.photo), auto.cells.map((c) => c.photo), 'same cell order as auto');
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
