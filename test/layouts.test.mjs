import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, LAYOUT_ORDER, FRAMES, resolveGrid, designVariants, stickerSpec } from '../public/js/layouts.mjs';

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

test('nothing is cropped: each photo cell is shaped to its own photo', () => {
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
      assert.ok(c.x >= -1 && c.y >= -1 && c.x + c.w <= page.w + 1 && c.y + c.h <= page.h + 1, 'cell stays on the page');
      // The cell has the SAME aspect as its photo, so the whole photo shows — nothing cropped,
      // no bars. The paper around the block is the matting.
      const p = photos[c.photo].bitmap;
      const photoAspect = p.width / p.height;
      assert.ok(Math.abs(photoAspect - c.w / c.h) / photoAspect < 0.02, 'cell is shaped to its photo — no crop');
    }
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        assert.ok(!overlaps(cells[i], cells[j]), `cells ${i} and ${j} overlap`);
      }
    }
  }
});

test('the sticker sits in the margin and is never stamped on a photo', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  const photos = [mk(1000, 1500), mk(1600, 1000), mk(1200, 1200), mk(1000, 1500)];
  const sticker = stickerSpec(FRAMES.watercolor);
  for (const v of designVariants(LAYOUTS.grid, photos, sticker)) {
    const stick = v.cells.filter((c) => c.extra === 'sticker');
    const photoCells = v.cells.filter((c) => c.photo !== undefined);
    assert.equal(stick.length, 1, `${v.key}: exactly one sticker`);
    assert.equal(photoCells.length, 4, `${v.key}: four photo cells`);
    for (const p of photoCells) {
      assert.ok(!overlaps(stick[0], p), `${v.key}: sticker overlaps a photo`);
    }
  }
});

test('no photo dominates: within a set of like-shaped photos, none is over 2× another', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  // Real phone shoots are all-portrait (or all-landscape). For like-shaped photos the
  // cap is fully achievable, so no photo — hero included — runs more than 2× another.
  // (A wide-vs-tall mix can't satisfy this without cropping; that's handled softly and
  // covered by the "no runaway hero" test below.)
  const mixes = [
    [mk(900, 1300), mk(900, 1300), mk(900, 1300), mk(900, 1300)],
    [mk(900, 1300), mk(1000, 1400), mk(880, 1320), mk(950, 1300)],
    [mk(1200, 1200), mk(1200, 1200), mk(1200, 1200), mk(1200, 1200)],
    [mk(1500, 1000), mk(1500, 1000), mk(1500, 1000), mk(1500, 1000)],
  ];
  for (const photos of mixes) {
    const { cells } = resolveGrid(LAYOUTS.grid, photos);
    const areas = cells.map((c) => c.w * c.h);
    const hero = cells[0].w * cells[0].h;
    const smallest = Math.min(...areas);
    assert.ok(hero <= smallest * 2 + 1, `hero is ${(hero / smallest).toFixed(1)}× the smallest — over the 2× cap`);
    assert.ok(Math.max(...areas) <= smallest * 2 + 1, `a photo is ${(Math.max(...areas) / smallest).toFixed(1)}× the smallest — one photo dominates`);
  }
});

test('no runaway hero: even a wide-vs-tall mix never lets one photo balloon', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  // The old full-strip hero ran 15–45× the smallest. Mixed aspects cannot be held to a
  // clean 2× without cropping, but the soft cap must still keep things sane — well under
  // the runaway range.
  const mixes = [
    [mk(1000, 1500), mk(1600, 1000), mk(1100, 1100), mk(1000, 1500)],
    [mk(1200, 1200), mk(1000, 1500), mk(1600, 1000), mk(900, 1300)],
    [mk(1600, 1000), mk(1200, 1200), mk(1200, 1200), mk(1200, 1200)],
  ];
  for (const photos of mixes) {
    const { cells } = resolveGrid(LAYOUTS.grid, photos);
    const areas = cells.map((c) => c.w * c.h);
    assert.ok(Math.max(...areas) / Math.min(...areas) < 3, `a photo is ${(Math.max(...areas) / Math.min(...areas)).toFixed(1)}× the smallest — too domineering`);
  }
});

test('the gutters within a thumb strip are uniform', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  const photos = [mk(1000, 1500), mk(1200, 1200), mk(1200, 1200), mk(1200, 1200)];
  const { cells } = resolveGrid(LAYOUTS.grid, photos);
  // The photos that share a row line up on y and are evenly spaced along it. (The hero
  // sits in a corner, so we check the run of photos that share the hero's top edge or
  // the widest shared row.)
  const byRow = new Map();
  for (const c of cells) {
    const key = Math.round(c.y / 5) * 5;
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push(c);
  }
  const row = [...byRow.values()].sort((a, b) => b.length - a.length)[0];
  if (row.length >= 3) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w));
    for (const g of gaps) assert.ok(Math.abs(g - gaps[0]) < 1.5, `gutter ${g.toFixed(0)}px differs from ${gaps[0].toFixed(0)}px`);
  }
});

test('there is no caption band eating into the photos', () => {
  const photos = [1, 2, 3, 4].map(() => ({ bitmap: { width: 1200, height: 1200 }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } }));
  const { captions } = resolveGrid(LAYOUTS.grid, photos);
  assert.deepEqual(captions, [], 'the caption was removed — photos own the whole sheet');
});

test('the hero photo leads and is among the largest, within the cap', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  // Like-shaped photos, where the layout can honour the cap cleanly.
  const photos = [mk(900, 1300), mk(950, 1300), mk(900, 1350), mk(920, 1280)];
  const { cells } = resolveGrid(LAYOUTS.grid, photos);

  assert.equal(cells[0].photo, 0, 'photo 0 leads as the hero');
  const heroArea = cells[0].w * cells[0].h;
  const areas = cells.map((c) => c.w * c.h);
  // Space is the priority, so with equal-ish photos the hero is the biggest cell or ties
  // for it — never a shrunken thumbnail — and stays within the 2× cap.
  assert.ok(heroArea >= Math.max(...areas) - 1, 'the hero is the largest cell (or tied)');
  assert.ok(heroArea <= Math.min(...areas) * 2 + 1, 'the hero stays within 2× the smallest');
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

test('every coverflow design crops nothing and never overlaps', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  const photos = [mk(1000, 1500), mk(1600, 1000), mk(1200, 1200), mk(1000, 1500)];
  for (const v of designVariants(LAYOUTS.grid, photos)) {
    const photoCells = [];
    for (const c of v.cells) {
      assert.ok(c.x >= -1 && c.y >= -1 && c.x + c.w <= v.page.w + 1 && c.y + c.h <= v.page.h + 1, `${v.key} stays on the page`);
      if (c.photo !== undefined) {
        const p = photos[c.photo].bitmap;
        const photoAspect = p.width / p.height;
        assert.ok(Math.abs(photoAspect - c.w / c.h) / photoAspect < 0.02, `${v.key}: photo cell shaped to its photo — no crop`);
        photoCells.push(c);
      }
    }
    // Photos never overlap each other (the sticker is a badge drawn on top, so it is
    // allowed to sit over a photo corner — it is not a photo cell).
    for (let i = 0; i < photoCells.length; i++) {
      for (let j = i + 1; j < photoCells.length; j++) {
        assert.ok(!overlaps(photoCells[i], photoCells[j]), `${v.key}: photo cells ${i} and ${j} overlap`);
      }
    }
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

test('the grid prints on a 4×6 sheet in either orientation, media matching', () => {
  const mk = (w, h) => ({ bitmap: { width: w, height: h }, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } });
  // The optimiser chooses the sheet orientation (4×6 portrait or 6×4 landscape) by which
  // fills more paper for the actual photo shapes. Either way it's the same 4×6 paper and
  // the media string matches the chosen orientation.
  const mixes = [
    [mk(1600, 1000), mk(1600, 1000), mk(1600, 1000), mk(1600, 1000)], // landscape group shots
    [mk(1000, 1600), mk(1200, 1200), mk(1200, 1200), mk(1200, 1200)], // a tall portrait hero
  ];
  for (const photos of mixes) {
    const r = resolveGrid(LAYOUTS.grid, photos);
    const inches = [r.page.w / 300, r.page.h / 300].sort((a, b) => a - b);
    assert.deepEqual(inches, [4, 6], 'a 4×6 sheet in some orientation');
    assert.equal(r.media, r.page.w > r.page.h ? 'Custom.6x4in' : 'Custom.4x6in', 'media matches the orientation');
  }
});
