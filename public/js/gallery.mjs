const $ = (id) => document.getElementById(id);
const TOKEN_STORAGE = 'booth.token';

let token = '';
try { token = localStorage.getItem(TOKEN_STORAGE) || ''; } catch { token = ''; }

let prints = [];                 // latest /api/prints entries
const selected = new Set();      // selected filenames
let current = null;              // the photo open in the detail sheet

const STATUS = {
  'awaiting-approval': ['Awaiting approval', 'warn'],
  pending: ['Queued', 'warn'],
  claimed: ['Queued', 'warn'],
  printing: ['Printing', 'info'],
  done: ['Printed', 'ok'],
  failed: ['Failed', 'bad'],
  rejected: ['Rejected', 'bad'],
  cancelled: ['Cancelled', 'bad'],
  saved: ['Saved', 'muted'],
};
const statusOf = (s) => STATUS[s] || ['Saved', 'muted'];

function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
const when = (ms) => (ms ? new Date(ms).toLocaleString() : '-');
const withToken = (p) => `${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
const imgUrl = (name) => withToken(`/prints/${encodeURIComponent(name)}`);
const nameOf = (p) => (p.printNo ? `P${p.printNo}` : p.name);

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-booth-token': token },
    body: JSON.stringify(body),
  });
  return res.json();
}

function showSignin(show) {
  $('signin').classList.toggle('hidden', !show);
  $('grid').classList.toggle('hidden', show);
}

async function load() {
  if (!token) { showSignin(true); $('summary').textContent = ''; return; }
  let data;
  try {
    const res = await fetch('/api/prints', { headers: { 'x-booth-token': token } });
    if (res.status === 401) { showSignin(true); $('summary').textContent = 'That token was not accepted.'; return; }
    data = await res.json();
  } catch {
    $('summary').textContent = 'Could not reach the booth.';
    return;
  }
  showSignin(false);
  prints = data.prints || [];
  // Drop selections for photos that no longer exist.
  for (const n of [...selected]) if (!prints.some((p) => p.name === n)) selected.delete(n);

  $('count').textContent = `${data.count} photo${data.count === 1 ? '' : 's'}`;
  $('summary').textContent = prints.length
    ? `${data.count} photo${data.count === 1 ? '' : 's'} · ${human(data.totalBytes)} total`
    : 'No photos yet. They appear here as guests print.';
  $('downloadAll').disabled = !prints.length;
  render();
}

function render() {
  const grid = $('grid');
  grid.innerHTML = '';
  for (const p of prints) {
    const [label, cls] = statusOf(p.status);
    const tile = document.createElement('div');
    tile.className = `gallery-item${selected.has(p.name) ? ' picked' : ''}`;
    tile.innerHTML = `
      <input type="checkbox" class="sel" ${selected.has(p.name) ? 'checked' : ''} aria-label="Select ${nameOf(p)}">
      <img loading="lazy" src="${imgUrl(p.name)}" alt="${nameOf(p)}">
      <div class="tile-meta"><span class="pno">${nameOf(p)}</span><span class="badge ${cls}">${label}</span></div>`;
    tile.querySelector('.sel').addEventListener('click', (e) => {
      e.stopPropagation();
      toggle(p.name, e.target.checked, tile);
    });
    tile.addEventListener('click', () => openDetail(p));
    grid.appendChild(tile);
  }
  renderSelBar();
}

function toggle(name, on, tileEl) {
  if (on) selected.add(name); else selected.delete(name);
  if (tileEl) tileEl.classList.toggle('picked', on); // update just this tile, don't rebuild the grid
  renderSelBar();
}

function renderSelBar() {
  const bar = $('selBar');
  bar.classList.toggle('hidden', selected.size === 0);
  $('selCount').textContent = `${selected.size} selected`;
}

function openDetail(p) {
  current = p;
  const [label, cls] = statusOf(p.status);
  $('detailImg').src = imgUrl(p.name);
  $('detailName').textContent = nameOf(p);
  const st = $('detailStatus');
  st.textContent = label; st.className = `badge ${cls}`;
  $('detailPrinter').textContent = p.printer ? `${p.printer}${p.computer && p.computer !== 'This Mac' ? ` (${p.computer})` : ''}` : '-';
  $('detailTime').textContent = when(p.at);
  $('detailDownload').href = imgUrl(p.name);
  $('detailDownload').setAttribute('download', p.name);
  $('detail').classList.remove('hidden');
}
function closeDetail() { $('detail').classList.add('hidden'); current = null; }

async function reprint(names, priority) {
  if (!names.length) return;
  const r = await post('/api/prints/reprint', { names, priority });
  if (r && r.ok) {
    toast(`Reprinting ${r.reprinted} photo${r.reprinted === 1 ? '' : 's'} ${priority === 'front' ? 'now' : 'to the queue'}.`);
    load();
  } else {
    toast((r && r.error) || 'Could not reprint.');
  }
}

function downloadNames(names) {
  if (!names.length) return;
  const q = names.map((n) => encodeURIComponent(n)).join(',');
  toast('Preparing your download…');
  window.location.href = withToken(`/api/prints/download.zip?names=${q}`);
}

// ── wiring ──────────────────────────────────────────────────────────────────
$('downloadAll').addEventListener('click', () => {
  if (!token) return;
  toast('Preparing your download…');
  window.location.href = withToken('/api/prints/download.zip');
});
$('refresh').addEventListener('click', load);

$('selDownload').addEventListener('click', () => downloadNames([...selected]));
$('selReprint').addEventListener('click', () => reprint([...selected], 'queue'));
$('selClear').addEventListener('click', () => { selected.clear(); render(); });

$('detailClose').addEventListener('click', closeDetail);
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) closeDetail(); });
$('reprintFront').addEventListener('click', () => { if (current) { reprint([current.name], 'front'); closeDetail(); } });
$('reprintQueue').addEventListener('click', () => { if (current) { reprint([current.name], 'queue'); closeDetail(); } });

$('signinBtn').addEventListener('click', () => {
  token = $('tokenInput').value.trim();
  try { localStorage.setItem(TOKEN_STORAGE, token); } catch { /* private mode */ }
  load();
});
$('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('signinBtn').click(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

load();
