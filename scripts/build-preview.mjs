// Build a single self-contained HTML preview of the guest app — no backend.
//
// It inlines the guest CSS and the four ES modules (import/export stripped, one
// shared module scope) and shims /api/* so the app runs offline in save/share
// mode. The output is committed as the repo-root index.html, which GitHub Pages
// (Deploy-from-a-branch) serves at the stable preview URL. Regenerate it with
// `npm run preview` whenever the guest app changes. Also reusable for the
// claude.ai artifact preview (--body).
//
//   npm run preview                                          # writes ./index.html
//   node scripts/build-preview.mjs --out index.html          # full HTML document
//   node scripts/build-preview.mjs --body --out preview.html # body-only (artifact)
//
// Zero dependencies, on purpose.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

const args = process.argv.slice(2);
const BODY_ONLY = args.includes('--body');
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, '_site', 'index.html');

const read = (rel) => readFile(path.join(PUB, rel), 'utf8');

// Show the real app version on the preview (the footer reads session.version).
const { version: VERSION } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

// Strip cross-module imports and the `export ` keyword so all four files share a
// single module scope when concatenated. Dependencies must come first.
function strip(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*import\s.*from\s+'\.\/[\w.]+';?\s*$/.test(line))
    .map((line) => line.replace(/^(\s*)export\s+(async\s+function|function|const|let|class|var)\b/, '$1$2'))
    .join('\n');
}

const css = await read('css/style.css');

const moduleFiles = ['js/filters.mjs', 'js/layouts.mjs', 'js/render.mjs', 'js/app.mjs'];
const modules = [];
for (const f of moduleFiles) modules.push(`\n/* ===== ${f} ===== */\n` + strip(await read(f)));

// No booth backend behind a static preview, so answer /api/* locally. A session
// with printingEnabled:false puts the app in save/share mode — the real
// download-only guest experience. Everything else (photo pick, the coverflow of
// designs, the reflections, save, Facebook share) runs entirely client-side.
const shim = `
const __PREVIEW_SESSION = {
  version: ${JSON.stringify(VERSION)}, boothName: 'BFF Photo Booth',
  message: 'Pick 4 photos. Take it home.',
  maxCopies: 3, defaultCopies: 1, shareHashtag: '#bff2026',
  printingEnabled: false, requireApproval: false, keyRequired: false,
  remote: false, dryRun: false,
};
const __origFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const u = typeof input === 'string' ? input : (input && input.url) || '';
  if (u.includes('/api/session')) return Promise.resolve(new Response(JSON.stringify(__PREVIEW_SESSION), { status: 200, headers: { 'content-type': 'application/json' } }));
  if (u.includes('/api/')) return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'Preview mode — printing needs the booth.' }), { status: 503, headers: { 'content-type': 'application/json' } }));
  return __origFetch(input, init);
};
`;

const scriptTag = `<script type="module">\n${shim}\n${modules.join('\n')}\n</script>`;

let out;
if (BODY_ONLY) {
  // For a claude.ai artifact: content only, the host adds <!doctype>/<head>/<body>.
  const html = await read('index.html');
  const bodyInner = html
    .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
    .replace(/<script[^>]*src="\/js\/app\.mjs"[^>]*><\/script>\s*/, '')
    .trim();
  out = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>
${css}
</style>

${bodyInner}

${scriptTag}
`;
} else {
  // For GitHub Pages: a complete standalone document. Keep index.html's real
  // <head> (viewport, theme-color, title); inline the CSS; drop the PWA links
  // that would 404 on a static host; inline the app modules.
  out = (await read('index.html'))
    .replace(/^\s*<link rel="manifest"[^>]*>\s*$\n?/m, '')
    .replace(/^\s*<link rel="icon"[^>]*>\s*$\n?/m, '')
    .replace(/^\s*<link rel="apple-touch-icon"[^>]*>\s*$\n?/m, '')
    .replace(/<link rel="stylesheet" href="\/css\/style\.css">/, `<style>\n${css}\n</style>`)
    .replace(/<script type="module" src="\/js\/app\.mjs"><\/script>/, scriptTag);
}

await mkdir(path.dirname(path.resolve(OUT)), { recursive: true });
await writeFile(OUT, out, 'utf8');
console.log(`wrote ${OUT} (${out.length} bytes)${BODY_ONLY ? ' [artifact body]' : ' [full document]'}`);
