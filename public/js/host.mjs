import { qrMatrix, drawQr } from './qr.mjs';

const $ = (id) => document.getElementById(id);
const TOKEN_STORAGE = 'booth.token';

let config = null;
let info = null;
let urls = [];
let token = readToken();
let timer = null;
let chosenSticker = null; // the sticker the host has picked (committed on Save)

function readToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE) || '';
  } catch {
    return '';
  }
}

function toast(message, ms = 2400) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('hidden'), ms);
}

/** Every host call carries the booth token; a public booth rejects it without. */
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), ...(token ? { 'x-booth-token': token } : {}) },
  });
  if (response.status === 401) {
    askForToken();
    throw new Error('unauthorised');
  }
  return response;
}

const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((response) => response.json());

function askForToken(message = '') {
  clearInterval(timer);
  $('signinError').textContent = message;
  $('signin').classList.remove('hidden');
  $('tokenInput').focus();
}

/** The guest link carries the access key when the booth is public. */
function guestUrl(base) {
  return info && info.keyRequired ? `${base}/?k=${encodeURIComponent(config.accessKey)}` : base;
}

function paintQr(base) {
  const link = guestUrl(base);
  $('joinUrl').textContent = link;
  drawQr($('qr'), qrMatrix(link, { ecc: 'M' }), { moduleSize: 10, quiet: 3, dark: '#15111b' });
}

async function loadConfig() {
  const data = await (await api('/api/config')).json();
  config = data.config;
  info = data;
  urls = data.urls.length ? data.urls : [location.origin];

  $('hostName').textContent = `${config.boothName} · Host`;
  $('versionPill').textContent = `v${data.version}${data.commit ? ` · ${data.commit}` : ''}`;
  $('updateHint').replaceChildren(
    document.createTextNode('To update: Control-C to stop, then '),
    Object.assign(document.createElement('code'), { textContent: 'git pull' }),
    document.createTextNode(' and '),
    Object.assign(document.createElement('code'), { textContent: 'caffeinate -dims npm start' }),
    document.createTextNode(' — the pull alone does not restart it.'),
  );
  const mode = data.mode === 'relay' ? 'relay' : data.exposed ? 'public' : 'local Wi-Fi';
  $('modePill').textContent = data.dryRun ? 'dry run' : config.printingEnabled ? mode : 'printing off';
  $('modePill').className = `pill ${data.dryRun ? 'quiet' : config.printingEnabled ? 'good' : 'bad'}`;

  const remote = data.mode === 'relay';
  $('agentPill').classList.toggle('hidden', !remote);
  if (remote) {
    $('agentPill').textContent = data.agent.online ? `booth mac: ${data.agent.name || 'connected'}` : 'booth mac offline';
    $('agentPill').className = `pill ${data.agent.online ? 'good' : 'bad'}`;
  }

  $('joinHint').textContent = data.exposed
    ? 'Works from anywhere — cellular, another Wi-Fi, wherever. The link includes the booth key, so guests just scan and print.'
    : 'Guests must be on the same Wi-Fi as this Mac. Start with --tunnel to let them join from anywhere.';
  $('rotateKey').classList.toggle('hidden', !data.keyRequired);

  const picker = $('urlPick');
  picker.innerHTML = '';
  for (const url of urls) {
    const option = document.createElement('option');
    option.value = url;
    option.textContent = url;
    picker.appendChild(option);
  }
  picker.classList.toggle('hidden', urls.length < 2);
  paintQr(urls[0]);

  $('mediaPick').value = config.media;
  $('borderless').checked = config.borderless;
  $('fitToPage').checked = config.fitToPage;
  $('printingEnabled').checked = config.printingEnabled;
  $('requireApproval').checked = config.requireApproval;
  $('maxCopies').value = String(config.maxCopies);
  $('boothNameInput').value = config.boothName;
  $('messageInput').value = config.message;
  renderStickers(info.stickers || [], config.sticker);
}

/** Draw the sticker chooser: a thumbnail per available sticker, the current one marked. */
function renderStickers(stickers, current) {
  chosenSticker = current || (stickers[0] && stickers[0].path) || null;
  const grid = $('stickerGrid');
  grid.innerHTML = '';
  if (!stickers.length) {
    grid.innerHTML = '<p class="hint">No stickers found in public/backgrounds/.</p>';
    return;
  }
  for (const sticker of stickers) {
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'sticker-thumb' + (sticker.path === chosenSticker ? ' sel' : '');
    thumb.title = sticker.name;
    thumb.setAttribute('role', 'radio');
    thumb.setAttribute('aria-checked', sticker.path === chosenSticker ? 'true' : 'false');
    const img = document.createElement('img');
    img.src = '/' + sticker.path;
    img.alt = sticker.name;
    thumb.appendChild(img);
    thumb.addEventListener('click', () => {
      chosenSticker = sticker.path;
      for (const el of grid.children) {
        const on = el === thumb;
        el.classList.toggle('sel', on);
        el.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    });
    grid.appendChild(thumb);
  }
}

async function loadPrinters() {
  const data = await (await fetch('/api/printers')).json();
  const select = $('printerPick');
  select.innerHTML = '';

  const state = $('agentState');
  if (data.remote) {
    state.textContent = data.agentOnline ? 'booth mac connected' : 'booth mac offline';
    state.className = `pill ${data.agentOnline ? 'good' : 'bad'}`;
  } else {
    state.textContent = data.dryRun ? 'dry run' : 'this mac';
    state.className = 'pill quiet';
  }

  if (!data.printers.length) {
    const option = document.createElement('option');
    option.textContent = data.remote && !data.agentOnline ? 'Waiting for the booth Mac…' : 'No printers found';
    option.value = '';
    select.appendChild(option);
    $('printerHint').textContent = data.remote
      ? 'Start the booth agent on the Mac that has the printer:  npm run agent'
      : 'Add a printer in System Settings ▸ Printers & Scanners, then reload this page.';
    return;
  }

  for (const printer of data.printers) {
    const option = document.createElement('option');
    option.value = printer.name;
    option.textContent = `${printer.name} — ${printer.state}`;
    select.appendChild(option);
  }
  select.value = config.printer || data.default || data.printers[0].name;
  $('printerHint').textContent = data.dryRun
    ? 'Dry run — strips are saved but never handed to a printer.'
    : data.remote
      ? `Printing on ${data.printers.length} printer${data.printers.length === 1 ? '' : 's'} reported by the booth Mac.`
      : `Default destination: ${data.default || 'none'}.`;
}

/** Populate the Paper dropdown with the page sizes the selected printer actually
 *  supports, so a borderless (full-bleed) size can be chosen by name. Falls back to
 *  the static list when the driver list is unavailable (dry run, relay, no printer). */
async function loadMedia() {
  const printer = $('printerPick').value || '';
  let options = [];
  try {
    options = (await (await api(`/api/media?printer=${encodeURIComponent(printer)}`)).json()).options || [];
  } catch {
    return;
  }
  if (!options.length) return; // keep the curated static list

  const want = config.media;
  const sel = $('mediaPick');
  sel.innerHTML = '';
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.id + (option.borderless ? ' — borderless' : '') + (option.isDefault ? ' (default)' : '');
    sel.appendChild(el);
  }
  if ([...sel.options].some((o) => o.value === want)) {
    sel.value = want; // keep the saved choice if the driver still offers it
  } else {
    // Prefer a borderless 4×6, else the driver's default, so borderless works out of the box.
    const bl = options.find((o) => o.borderless && /4.?x.?6|6.?x.?4|kg|postcard|10.?15|15.?10/i.test(o.id));
    sel.value = (bl || options.find((o) => o.isDefault) || options[0]).id;
  }
}

function jobCard(job, actions) {
  const card = document.createElement('div');
  card.className = 'job';

  if (job.image) {
    const img = document.createElement('img');
    img.src = job.image;
    img.alt = '';
    card.appendChild(img);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('strong');
  title.textContent = job.title;
  const sub = document.createElement('span');
  sub.textContent = job.subtitle;
  meta.append(title, sub);
  card.appendChild(meta);

  if (actions && actions.length) {
    const box = document.createElement('div');
    box.className = 'actions';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${action.primary ? 'btn-primary' : 'btn-ghost'}`;
      btn.textContent = action.label;
      btn.addEventListener('click', action.run);
      box.appendChild(btn);
    }
    card.appendChild(box);
  }
  return card;
}

async function refreshQueue() {
  let data;
  try {
    data = await (await api('/api/queue')).json();
  } catch {
    return;
  }

  if (data.agent && info && info.mode === 'relay') {
    $('agentPill').textContent = data.agent.online ? `booth mac: ${data.agent.name || 'connected'}` : 'booth mac offline';
    $('agentPill').className = `pill ${data.agent.online ? 'good' : 'bad'}`;
  }

  const pendingBox = $('pending');
  const pending = data.jobs.filter((job) => job.status === 'awaiting-approval');
  $('pendingCount').textContent = String(pending.length);
  pendingBox.innerHTML = '';
  if (!pending.length) {
    pendingBox.innerHTML = '<p class="hint">Nothing waiting.</p>';
  } else {
    for (const job of pending) {
      pendingBox.appendChild(jobCard(
        {
          image: job.image,
          title: job.guest || 'A guest',
          subtitle: `${job.layout} · ${job.copies} ${job.copies === 1 ? 'copy' : 'copies'}`,
        },
        [
          { label: 'Print', primary: true, run: async () => { await post('/api/approve', { id: job.id }); toast('Sent to the printer.'); refreshQueue(); } },
          { label: 'Skip', run: async () => { await post('/api/reject', { id: job.id }); refreshQueue(); } },
        ],
      ));
    }
  }

  const queueBox = $('cupsQueue');
  queueBox.innerHTML = '';
  const inFlight = data.jobs.filter((job) => ['pending', 'claimed', 'printing'].includes(job.status));
  const failed = data.jobs.filter((job) => job.status === 'failed').slice(0, 3);

  if (!data.cupsJobs.length && !failed.length && !inFlight.length) {
    queueBox.innerHTML = '<p class="hint">Queue is empty.</p>';
  }
  for (const job of inFlight) {
    queueBox.appendChild(jobCard({ image: job.image, title: 'On its way to the printer', subtitle: `${job.guest || 'a guest'} · ${job.layout}` }, []));
  }
  for (const job of data.cupsJobs) {
    queueBox.appendChild(jobCard(
      { title: job.id, subtitle: `${job.owner} · ${job.submitted}` },
      [{ label: 'Cancel', run: async () => { await post('/api/cancel', { cupsJobId: job.id }); refreshQueue(); } }],
    ));
  }
  for (const job of failed) {
    queueBox.appendChild(jobCard({ image: job.image, title: 'Failed', subtitle: job.error || 'Unknown error' }, []));
  }

  const gallery = $('recent');
  gallery.innerHTML = '';
  for (const job of data.jobs.slice(0, 24)) {
    const link = document.createElement('a');
    link.href = job.image;
    link.target = '_blank';
    link.rel = 'noopener';
    const img = document.createElement('img');
    img.src = job.image;
    img.alt = job.layout;
    link.appendChild(img);
    gallery.appendChild(link);
  }
}

function bind() {
  $('urlPick').addEventListener('change', (event) => paintQr(event.target.value));

  $('tokenSave').addEventListener('click', async () => {
    token = $('tokenInput').value.trim();
    try {
      localStorage.setItem(TOKEN_STORAGE, token);
    } catch {
      /* the token still works for this page */
    }
    try {
      await loadConfig();
      await loadPrinters();
      $('signin').classList.add('hidden');
      start();
    } catch {
      askForToken('That token was not accepted. It is the BOOTH_TOKEN the booth was started with.');
    }
  });
  $('tokenInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('tokenSave').click();
  });

  $('rotateKey').addEventListener('click', async () => {
    if (!confirm('Retire the current guest link? Anyone holding the old QR code will have to scan again.')) return;
    await post('/api/config', { rotateKey: true });
    await loadConfig();
    toast('New guest link — show the fresh QR code.');
  });

  $('saveConfig').addEventListener('click', async () => {
    await post('/api/config', {
      printer: $('printerPick').value || null,
      media: $('mediaPick').value,
      borderless: $('borderless').checked,
      fitToPage: $('fitToPage').checked,
      printingEnabled: $('printingEnabled').checked,
      requireApproval: $('requireApproval').checked,
      maxCopies: Number($('maxCopies').value) || 3,
      boothName: $('boothNameInput').value.trim() || 'Photo Booth',
      message: $('messageInput').value.trim(),
      ...(chosenSticker ? { sticker: chosenSticker } : {}),
    });
    await loadConfig();
    await loadPrinters();
    await loadMedia();
    toast('Saved.');
  });

  $('printerPick').addEventListener('change', () => { loadMedia(); });
}

function start() {
  clearInterval(timer);
  refreshQueue();
  timer = setInterval(refreshQueue, 3000);
}

bind();
try {
  await loadConfig();
  await loadPrinters();
  await loadMedia();
  start();
} catch {
  askForToken();
}
