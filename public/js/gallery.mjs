const $ = (id) => document.getElementById(id);
const TOKEN_STORAGE = 'booth.token';

let token = '';
try { token = localStorage.getItem(TOKEN_STORAGE) || ''; } catch { token = ''; }

function toast(message, ms = 2400) {
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

const withToken = (path) => `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

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

  const prints = data.prints || [];
  $('count').textContent = `${data.count} photo${data.count === 1 ? '' : 's'}`;
  $('summary').textContent = prints.length
    ? `${data.count} photo${data.count === 1 ? '' : 's'} · ${human(data.totalBytes)} total`
    : 'No photos yet. They appear here as guests print.';
  $('downloadAll').disabled = !prints.length;

  const grid = $('grid');
  grid.innerHTML = '';
  for (const p of prints) {
    const src = withToken(`/prints/${encodeURIComponent(p.name)}`);
    const a = document.createElement('a');
    a.href = src;
    a.download = p.name;              // hint the browser to save, not navigate
    a.className = 'gallery-item';
    a.title = `${p.name} · ${human(p.size)}`;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = src;
    img.alt = p.name;
    a.appendChild(img);
    grid.appendChild(a);
  }
}

$('downloadAll').addEventListener('click', () => {
  if (!token) return;
  toast('Preparing your download…');
  window.location.href = withToken('/api/prints/download.zip');
});
$('refresh').addEventListener('click', load);
$('signinBtn').addEventListener('click', () => {
  token = $('tokenInput').value.trim();
  try { localStorage.setItem(TOKEN_STORAGE, token); } catch { /* private mode */ }
  load();
});
$('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('signinBtn').click(); });

load();
