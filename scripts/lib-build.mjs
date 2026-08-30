// Shared builder for the self-contained guest-app preview. Given the raw source
// files and a version string, it inlines the CSS and the four ES modules
// (import/export stripped into one shared module scope) and shims /api/* so the
// app runs offline in save/share mode. Both build-preview.mjs (working tree) and
// build-site.mjs (any git ref, for versioned snapshots) call this.

// Strip cross-module imports and the `export ` keyword so the files share a
// single module scope when concatenated. Dependencies must come first.
function strip(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*import\s.*from\s+'\.\/[\w.]+';?\s*$/.test(line))
    .map((line) => line.replace(/^(\s*)export\s+(async\s+function|function|const|let|class|var)\b/, '$1$2'))
    .join('\n');
}

/**
 * Build the preview HTML.
 * @param {{index:string, css:string, filters:string, layouts:string, render:string, app:string}} files
 * @param {string} version  shown in the footer via the session shim
 * @param {boolean} [bodyOnly]  emit body-only content for a claude.ai artifact
 * @returns {string} the HTML, or '' if the source didn't have the expected hooks
 */
// The hosted preview has no live booth, so its name is fixed. Bake it into both the
// session shim AND the initial <h1> so the title shows the real name immediately —
// no "Photo Booth" → "BFF Photo Booth" flash while the shim session loads.
const PREVIEW_BOOTH_NAME = 'BFF Photo Booth';

export function buildDocument({ files, version, bodyOnly = false }) {
  const modules = [
    ['js/filters.mjs', files.filters],
    ['js/layouts.mjs', files.layouts],
    ['js/render.mjs', files.render],
    ['js/app.mjs', files.app],
  ].map(([name, src]) => `\n/* ===== ${name} ===== */\n${strip(src)}`);

  // No booth behind a static preview, so answer /api/* locally. printingEnabled is
  // true so the Print button shows exactly like the real guest app, but
  // previewNoPrint makes the actual Print tap a no-op (there's no printer to hit),
  // and the printers shim reports one healthy printer so no "offline" banner shows.
  const shim = `
const __PREVIEW_SESSION = {
  version: ${JSON.stringify(version)}, boothName: ${JSON.stringify(PREVIEW_BOOTH_NAME)},
  message: 'Pick 4 photos. Take it home.',
  maxCopies: 3, defaultCopies: 1, shareHashtag: '#bff2026',
  printingEnabled: true, previewNoPrint: true, requireApproval: false, keyRequired: false,
  remote: false, dryRun: false,
};
const __origFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const u = typeof input === 'string' ? input : (input && input.url) || '';
  if (u.includes('/api/session')) return Promise.resolve(new Response(JSON.stringify(__PREVIEW_SESSION), { status: 200, headers: { 'content-type': 'application/json' } }));
  if (u.includes('/api/printers')) return Promise.resolve(new Response(JSON.stringify({ printers: [{ name: 'Preview Printer' }], remote: false, agentOnline: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
  if (u.includes('/api/')) return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'Preview mode — printing needs the booth.' }), { status: 503, headers: { 'content-type': 'application/json' } }));
  return __origFetch(input, init);
};
`;
  const scriptTag = `<script type="module">\n${shim}\n${modules.join('\n')}\n</script>`;

  if (bodyOnly) {
    const html = files.index;
    const bodyInner = html
      .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
      .replace(/(<h1 id="boothName">)[^<]*(<\/h1>)/, `$1${PREVIEW_BOOTH_NAME}$2`)
      .replace(/<script[^>]*src="\/js\/app\.mjs"[^>]*><\/script>\s*/, '')
      .trim();
    return `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>
${files.css}
</style>

${bodyInner}

${scriptTag}
`;
  }

  // (Placeholder demo photos were injected here so the hosted preview landed on the
  //  coverflow without picking every launch. Removed for now — the preview opens on the
  //  real empty welcome screen; use the pick button to add your own photos.)

  const out = files.index
    .replace(/^\s*<link rel="manifest"[^>]*>\s*$\n?/m, '')
    .replace(/^\s*<link rel="icon"[^>]*>\s*$\n?/m, '')
    .replace(/^\s*<link rel="apple-touch-icon"[^>]*>\s*$\n?/m, '')
    .replace(/(<h1 id="boothName">)[^<]*(<\/h1>)/, `$1${PREVIEW_BOOTH_NAME}$2`)
    .replace(/<link rel="stylesheet" href="\/css\/style\.css">/, `<style>\n${files.css}\n</style>`)
    .replace(/<script type="module" src="\/js\/app\.mjs"><\/script>/, scriptTag);

  // If the CSS/JS hooks weren't both present (an older layout), the inline didn't
  // happen and the page would 404 its assets — signal that with an empty result.
  if (out.includes('src="/js/app.mjs"') || out.includes('href="/css/style.css"')) return '';
  return out;
}
