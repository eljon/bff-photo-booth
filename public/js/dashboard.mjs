const $ = (id) => document.getElementById(id);

function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

const STATUS = {
  active: 'Active', pending_payment: 'Awaiting payment',
  cancelled: 'Cancelled', expired: 'Expired', exhausted: 'Used up',
};

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function guard() {
  const me = await (await fetch('/api/me')).json().catch(() => ({}));
  if (!me.user) { location.href = '/'; return null; }
  $('who').textContent = me.user.name || me.user.email;
  return me.user;
}

function sessionCard(s) {
  const el = document.createElement('div');
  el.className = 'session';
  const when = new Date(s.createdAt).toLocaleDateString();
  const quota = s.printQuota == null ? 'Unlimited prints' : `${s.printsUsed}/${s.printQuota} prints`;
  el.innerHTML = `
    <span class="badge ${s.status}">${STATUS[s.status] || s.status}</span>
    <h3>${escapeHtml(s.name)}</h3>
    <div class="meta">${when} · ${quota}</div>
    <div class="row"></div>`;
  const row = el.querySelector('.row');
  if (s.status === 'active' && s.canOpen) {
    const b = document.createElement('button');
    b.className = 'btn primary'; b.textContent = 'Open host';
    b.addEventListener('click', () => openHost(s, b));
    row.appendChild(b);
  } else if (s.status === 'pending_payment') {
    const span = document.createElement('span');
    span.className = 'meta'; span.textContent = 'Finish checkout to activate.';
    row.appendChild(span);
  }
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function load() {
  const data = await (await fetch('/api/sessions')).json().catch(() => ({ sessions: [] }));
  const list = data.sessions || [];
  const grid = $('sessions');
  grid.innerHTML = '';
  $('empty').classList.toggle('hidden', list.length > 0);
  for (const s of list) grid.appendChild(sessionCard(s));
}

async function openHost(s, btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Starting booth…';
  const { status, data } = await api(`/api/sessions/${s.id}/open`);
  btn.disabled = false; btn.textContent = label;
  if (status === 200 && data.ok) {
    window.open(data.hostUrl, '_blank', 'noopener');
    toast('Booth ready — the host screen has this session’s QR.');
  } else {
    toast(data.error || 'Could not start the booth.');
  }
}

async function buy() {
  const name = prompt('Name this session (e.g. "Maria\'s 30th"):', 'New event');
  if (name === null) return;
  toast('Setting up your session…');
  const { status, data } = await api('/api/sessions/buy', { name: name.trim() || 'New event' });
  if (status !== 200 || !data.ok) { toast(data.error || 'Could not start the purchase.'); return; }
  if (data.checkoutUrl) { location.href = data.checkoutUrl; return; } // Stripe
  toast('Session ready!'); // dev mode
  load();
}

$('buy').addEventListener('click', buy);
$('buyEmpty').addEventListener('click', buy);
$('logout').addEventListener('click', async () => { await api('/api/auth/logout'); location.href = '/'; });

// Returning from Stripe checkout.
const params = new URLSearchParams(location.search);
if (params.get('paid')) { toast('Payment received — your session is active!'); history.replaceState({}, '', '/dashboard'); }
if (params.get('cancelled')) { toast('Checkout cancelled.'); history.replaceState({}, '', '/dashboard'); }

(async () => { if (await guard()) load(); })();
