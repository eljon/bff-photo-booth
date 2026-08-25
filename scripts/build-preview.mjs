// Build a single self-contained HTML preview of the guest app from the working
// tree — no backend. Inlines the CSS and the four ES modules and shims /api/*.
// The output is committed as the repo-root index.html, which GitHub Pages serves
// at the stable preview URL. For the full site (root + versioned snapshots +
// index), use build-site.mjs (`npm run preview`).
//
//   node scripts/build-preview.mjs --out index.html          # full HTML document
//   node scripts/build-preview.mjs --body --out preview.html # body-only (artifact)
//
// Zero dependencies, on purpose.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocument } from './lib-build.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

const args = process.argv.slice(2);
const BODY_ONLY = args.includes('--body');
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, '_site', 'index.html');

const read = (rel) => readFile(path.join(PUB, rel), 'utf8');
const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

const files = {
  index: await read('index.html'),
  css: await read('css/style.css'),
  filters: await read('js/filters.mjs'),
  layouts: await read('js/layouts.mjs'),
  render: await read('js/render.mjs'),
  app: await read('js/app.mjs'),
};

const out = buildDocument({ files, version, bodyOnly: BODY_ONLY });
if (!out) throw new Error('The source is missing the CSS/JS hooks the preview needs.');

await mkdir(path.dirname(path.resolve(OUT)), { recursive: true });
await writeFile(OUT, out, 'utf8');
console.log(`wrote ${OUT} (${out.length} bytes)${BODY_ONLY ? ' [artifact body]' : ' [full document]'}`);
