// Build the full GitHub Pages site: the latest preview at the root, a snapshot of
// every past version at its own slug (so /<version>/ rolls back to it), and a
// versions index. Run with `npm run preview`.
//
// Historical snapshots are built once from each version's commit and then left
// alone; only the root and the current version's folder are rebuilt each run.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocument } from './lib-build.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = {
  index: 'public/index.html',
  css: 'public/css/style.css',
  filters: 'public/js/filters.mjs',
  layouts: 'public/js/layouts.mjs',
  render: 'public/js/render.mjs',
  app: 'public/js/app.mjs',
};

const git = (a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
const gitFile = (ref, rel) =>
  execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
const exists = (p) => access(p, constants.F_OK).then(() => true).catch(() => false);

async function filesFromDisk() {
  const f = {};
  for (const [k, rel] of Object.entries(SOURCES)) f[k] = await readFile(path.join(ROOT, rel), 'utf8');
  return f;
}
function filesFromRef(ref) {
  const f = {};
  for (const [k, rel] of Object.entries(SOURCES)) f[k] = gitFile(ref, rel); // throws if a file is absent at that ref
  return f;
}
async function writeVersion(version, html) {
  const dir = path.join(ROOT, version);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), html, 'utf8');
}
const cmpVerDesc = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
};

// --- current version (working tree) → root index.html + its own slug ---
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const current = pkg.version;
const currentHtml = buildDocument({ files: await filesFromDisk(), version: current });
if (!currentHtml) throw new Error('Working tree is missing the CSS/JS hooks the preview needs.');
await writeFile(path.join(ROOT, 'index.html'), currentHtml, 'utf8');
await writeVersion(current, currentHtml);
console.log(`latest → index.html and /${current}/  (${currentHtml.length} bytes)`);

// --- every past version → /<version>/, built once from its commit ---
const commits = git(['log', '--format=%H', '--', 'package.json']).trim().split('\n');
const versionCommit = new Map(); // version → newest commit that carried it
for (const c of commits) {
  let v;
  try { v = JSON.parse(gitFile(c, 'package.json')).version; } catch { continue; }
  if (v && !versionCommit.has(v)) versionCommit.set(v, c);
}

const built = new Set([current]);
const skipped = [];
for (const [version, commit] of versionCommit) {
  if (version === current) continue;
  if (await exists(path.join(ROOT, version, 'index.html'))) { built.add(version); continue; }
  let html = '';
  try { html = buildDocument({ files: filesFromRef(commit), version }); } catch { html = ''; }
  if (!html) { skipped.push(version); continue; }
  await writeVersion(version, html);
  built.add(version);
  console.log(`built /${version}/`);
}
if (skipped.length) console.log(`skipped (incompatible layout): ${skipped.join(', ')}`);

// --- versions index at /versions.html ---
const list = [...built].sort(cmpVerDesc);
const rows = list
  .map((v, i) => `      <li><a href="./${v}/">v${v}</a>${v === current ? ' <span class="tag">latest</span>' : ''}${i === 0 && v !== current ? '' : ''}</li>`)
  .join('\n');
const versionsHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Photo Booth versions</title>
<style>
  :root { --bg:#15111b; --card:#241d2e; --ink:#f6f1ef; --dim:#b7abc4; --accent:#ff5d7e; --line:#372c45; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px 64px; background:var(--bg); color:var(--ink);
         font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width:520px; margin:0 auto; }
  h1 { font-size:22px; letter-spacing:.14em; text-transform:uppercase; margin:0 0 4px; }
  p.sub { color:var(--dim); margin:0 0 24px; }
  a.latest { display:block; text-align:center; text-decoration:none; font-weight:700;
             background:var(--accent); color:#1b1020; border-radius:12px; padding:14px; margin-bottom:20px; }
  ul { list-style:none; margin:0; padding:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; background:var(--card); }
  li { border-top:1px solid var(--line); }
  li:first-child { border-top:none; }
  li a { display:flex; align-items:center; gap:10px; padding:13px 16px; color:var(--ink); text-decoration:none; }
  li a:hover { background:rgba(255,255,255,.04); }
  .tag { font-size:11px; color:var(--accent); border:1px solid var(--accent); border-radius:999px; padding:1px 8px; letter-spacing:.04em; }
  footer { color:var(--dim); font-size:13px; text-align:center; margin-top:24px; }
</style>
</head>
<body>
<main>
  <h1>BFF Photo Booth</h1>
  <p class="sub">Every version of the guest app. Open one to preview it — or add the version to the URL, e.g. <code>/${current}/</code>.</p>
  <a class="latest" href="./">Open the latest (v${current})</a>
  <ul>
${rows}
  </ul>
  <footer>Printing is off in these previews — that needs the booth Mac.</footer>
</main>
</body>
</html>
`;
await writeFile(path.join(ROOT, 'versions.html'), versionsHtml, 'utf8');
console.log(`versions.html → ${list.length} versions`);
