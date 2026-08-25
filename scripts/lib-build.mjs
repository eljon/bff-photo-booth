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
export function buildDocument({ files, version, bodyOnly = false }) {
  const modules = [
    ['js/filters.mjs', files.filters],
    ['js/layouts.mjs', files.layouts],
    ['js/render.mjs', files.render],
    ['js/app.mjs', files.app],
  ].map(([name, src]) => `\n/* ===== ${name} ===== */\n${strip(src)}`);

  // No booth behind a static preview, so answer /api/* locally. printingEnabled:
  // false puts the app in save/share mode — the real download-only experience.
  const shim = `
const __PREVIEW_SESSION = {
  version: ${JSON.stringify(version)}, boothName: 'BFF Photo Booth',
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

  if (bodyOnly) {
    const html = files.index;
    const bodyInner = html
      .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
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

  // Testing convenience for the hosted preview: drop four placeholder photos into
  // the real file picker on load, so you land on the coverflow without picking
  // every launch. Varied aspect ratios exercise the layouts. "Swap all 4 photos"
  // still lets you choose your own. Pages build only — never the artifact body.
  const placeholders = `<script>
window.addEventListener('load', () => setTimeout(() => {
  const specs = [
    { w: 1200, h: 1600, bg: '#e2453b', n: '1' },
    { w: 1600, h: 1200, bg: '#8a3ffc', n: '2' },
    { w: 1400, h: 1400, bg: '#2f9e44', n: '3' },
    { w: 1080, h: 1620, bg: '#1f8ecd', n: '4' },
  ];
  Promise.all(specs.map((s, i) => new Promise((res) => {
    const c = document.createElement('canvas'); c.width = s.w; c.height = s.h;
    const x = c.getContext('2d');
    x.fillStyle = s.bg; x.fillRect(0, 0, s.w, s.h);
    x.strokeStyle = 'rgba(255,255,255,0.3)'; x.lineWidth = s.w * 0.015;
    for (let g = 1; g < 6; g++) { x.beginPath(); x.moveTo(s.w * g / 6, 0); x.lineTo(s.w * g / 6, s.h); x.stroke(); }
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '700 ' + Math.min(s.w, s.h) * 0.5 + 'px -apple-system, sans-serif';
    x.fillText(s.n, s.w / 2, s.h / 2);
    c.toBlob((b) => res(new File([b], 'placeholder-' + s.n + '.png', { type: 'image/png' })), 'image/png');
  }))).then((files) => {
    const input = document.getElementById('filePicker');
    if (!input) return;
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }).catch(() => {});
}, 60));
</script>`;

  const out = files.index
    .replace(/^\s*<link rel="manifest"[^>]*>\s*$\n?/m, '')
    .replace(/^\s*<link rel="icon"[^>]*>\s*$\n?/m, '')
    .replace(/^\s*<link rel="apple-touch-icon"[^>]*>\s*$\n?/m, '')
    .replace(/<link rel="stylesheet" href="\/css\/style\.css">/, `<style>\n${files.css}\n</style>`)
    .replace(/<script type="module" src="\/js\/app\.mjs"><\/script>/, `${scriptTag}\n${placeholders}`);

  // If the CSS/JS hooks weren't both present (an older layout), the inline didn't
  // happen and the page would 404 its assets — signal that with an empty result.
  if (out.includes('src="/js/app.mjs"') || out.includes('href="/css/style.css"')) return '';
  return out;
}
