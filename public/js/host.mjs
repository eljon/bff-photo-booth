import { qrMatrix, drawQr } from './qr.mjs';

const $ = (id) => document.getElementById(id);
const TOKEN_STORAGE = 'booth.token';

let config = null;
let info = null;
let urls = [];
let token = readToken();
let timer = null;
let chosenSticker = null; // the sticker the host has picked (committed on Save)
let availablePrinters = []; // every printer across the connected computers
let selection = new Map();   // "agentId|name" -> host-set label (the printers to run)
let lastPrinterData = null;  // the most recent /api/printers payload, for re-rendering

function readToken() {
  try {
    // Opened from the dashboard as /host?token=… — adopt it, then scrub it from the URL
    // so the token isn't left sitting in the address bar.
    const here = new URL(location.href);
    const passed = here.searchParams.get('token');
    if (passed) {
      localStorage.setItem(TOKEN_STORAGE, passed);
      here.searchParams.delete('token');
      history.replaceState({}, '', here.pathname + here.search + here.hash);
      return passed;
    }
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

/** Each print's running number (P1, P2, …) — the identifier shown in place of a name. */
function pno(job) {
  return job && job.printNo ? `P${job.printNo}` : 'Print';
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
    document.createTextNode('. The pull alone does not restart it.'),
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
    ? 'Works from anywhere: cellular, another Wi-Fi, wherever. The link includes the booth key, so guests just scan and print.'
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
  $('requireVoucher').checked = config.requireVoucher;
  $('voucherBox').hidden = !config.requireVoucher;
  loadVouchers();
  $('maxCopies').value = String(config.maxCopies);
  $('boothNameInput').value = config.boothName;
  $('messageInput').value = config.message;
  renderStickers(info.stickers || [], config.sticker);
}

/** Show how many print codes exist and how many are still unused. */
async function loadVouchers() {
  try {
    const v = await (await api('/api/vouchers')).json();
    $('voucherStats').textContent = v.total
      ? `${v.unused} unused · ${v.used} used · ${v.total} total`
      : 'No codes yet. Generate a batch, then download and print them.';
  } catch { /* leave the placeholder text */ }
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

const slotKey = (agentId, name) => `${agentId || 'local'}|${name}`;

/** The printers the host has ticked, with their names, ready to save. */
function selectedPrinters() {
  return availablePrinters
    .filter((p) => selection.has(slotKey(p.agentId, p.name)))
    .map((p) => ({ agentId: p.agentId || 'local', name: p.name, label: selection.get(slotKey(p.agentId, p.name)) || p.name }));
}

/** The printer used to read paper sizes (the first ticked one, or the default). */
function primaryPrinter() {
  const sel = selectedPrinters();
  return sel.length ? sel[0].name : (config.printer || (availablePrinters[0] && availablePrinters[0].name) || '');
}

/** The connected-computer pill, shared by the full load and the lightweight connect poll. */
function renderAgentPill(data) {
  const state = $('agentState');
  if (data.remote) {
    const n = (data.agents || []).length;
    state.textContent = data.agentOnline ? (n > 1 ? `${n} computers connected` : 'computer connected') : 'no computer connected';
    state.className = `pill ${data.agentOnline ? 'good' : 'bad'}`;
  } else {
    state.textContent = data.dryRun ? 'dry run' : 'this mac';
    state.className = 'pill quiet';
  }
}

// ── Connect a printer computer (download the helper, pair, auto-detect) ──────────
let pairCode = '';
let pairPending = false;
let lastAgentOnline = null;
const HELPER_ASSETS = { mac: 'BFF-Booth-Helper.dmg', win: 'BFF-Booth-Helper-Setup.exe' };

function osKind() {
  const ua = navigator.userAgent || '';
  const plat = navigator.platform || '';
  if (/Mac/i.test(ua) || /Mac/i.test(plat)) return 'mac';
  if (/Win/i.test(ua) || /Win/i.test(plat)) return 'win';
  return 'other';
}

function renderHelperDownload() {
  const dl = $('helperDownload');
  const note = $('helperOsNote');
  if (!dl) return;
  const helper = (info && info.helper) || {};
  const os = osKind();
  const asset = HELPER_ASSETS[os];
  if (helper.downloadBase && asset) {
    dl.href = `${helper.downloadBase}/${asset}`;
    dl.textContent = os === 'mac' ? 'Download for macOS' : 'Download for Windows';
    note.textContent = os === 'mac'
      ? 'macOS: open the .dmg and drag the app to Applications. First launch: right-click the app ▸ Open.'
      : 'Windows: run the installer. First launch: More info ▸ Run anyway.';
  } else {
    dl.href = helper.releasesPage || '#';
    dl.textContent = 'Download the helper';
    note.textContent = 'Pick the file for your operating system.';
  }
}

/** Fetch a fresh pairing code to show in the card (idempotent unless forced). */
async function ensurePairCode(force = false) {
  if (pairPending || (pairCode && !force)) return;
  pairPending = true;
  try {
    const r = await post('/api/pair/new', {});
    pairCode = r.code || '';
    $('pairCode').textContent = pairCode || '····';
  } catch {
    /* leave the placeholder; the refresh button can retry */
  } finally {
    pairPending = false;
  }
}

/** Show/hide the connect card from a /api/printers payload, and celebrate a new connection. */
function renderConnect(data) {
  renderAgentPill(data);
  const card = $('connectCard');
  if (!card) return;
  const online = Boolean(data.agentOnline);
  const showCard = Boolean(data.remote) && !online;
  card.hidden = !showCard;
  if (showCard) { renderHelperDownload(); ensurePairCode(); }
  if (lastAgentOnline === false && online) {
    toast('Printer connected! 🎉');
    pairCode = ''; // spent its purpose; a later disconnect mints a fresh one
    loadPrinters(); // a computer arrived — populate the picker
  }
  lastAgentOnline = online;
}

/** Lightweight poll (does NOT touch the printer selection) so the card reacts live. */
async function pollConnect() {
  try {
    const data = await (await fetch('/api/printers')).json();
    renderConnect(data);
  } catch {
    /* transient — try again next tick */
  }
}

async function loadPrinters() {
  const data = await (await fetch('/api/printers')).json();
  availablePrinters = data.printers || [];

  renderAgentPill(data);

  // Seed the selection from what's saved: the chosen printers, else the legacy single
  // printer. Nothing saved => nothing pre-ticked (the booth still prints to the default),
  // so the host deliberately picks which printers to run.
  selection = new Map();
  const saved = Array.isArray(config.printers) ? config.printers : [];
  if (saved.length) {
    for (const p of saved) selection.set(slotKey(p.agentId, p.name), p.label || p.name);
  } else if (config.printer && availablePrinters.some((p) => p.name === config.printer)) {
    const p = availablePrinters.find((x) => x.name === config.printer);
    selection.set(slotKey(p.agentId, p.name), p.name);
  }
  lastPrinterData = data;
  renderPrinterSummary();
  renderPrinterList(data);

  // Initial connect-card state (visibility only; pollConnect handles live transitions).
  const card = $('connectCard');
  if (card) {
    const showCard = Boolean(data.remote) && !data.agentOnline;
    card.hidden = !showCard;
    if (showCard) { renderHelperDownload(); ensurePairCode(); }
    if (lastAgentOnline === null) lastAgentOnline = Boolean(data.agentOnline);
  }
}

/** The compact default view: just the printers currently chosen (with their names/numbers),
 *  so the settings stay short. The full picker opens on demand. */
function renderPrinterSummary() {
  const box = $('printerSummary');
  if (!box) return;
  const sel = selectedPrinters();
  box.innerHTML = '';
  if (!sel.length) {
    box.innerHTML = '<p class="hint">No printers chosen - the booth uses whatever printer is available. Tap “Choose printers” to pick and name them.</p>';
    return;
  }
  for (const p of sel) {
    const chip = document.createElement('div');
    chip.className = 'printer-chip';
    const label = document.createElement('b');
    label.textContent = p.label || p.name;
    const sub = document.createElement('span');
    sub.textContent = p.label && p.label !== p.name ? p.name : '';
    chip.append(label, sub);
    box.appendChild(chip);
  }
}

/** Draw the printer checklist: a row per printer (grouped by computer in relay mode),
 *  each with a tick to run it and a name/number the guests will see. */
function renderPrinterList(data) {
  const box = $('printerList');
  box.innerHTML = '';
  if (!availablePrinters.length) {
    box.innerHTML = `<p class="hint">${data.remote && !data.agentOnline
      ? 'No computer connected yet. Start the agent on each printing computer: npm run agent'
      : 'No printers found. Add one in System Settings ▸ Printers &amp; Scanners, then reload.'}</p>`;
    return;
  }
  let lastAgent = null;
  for (const p of availablePrinters) {
    if (data.remote && p.agentName !== lastAgent) {
      lastAgent = p.agentName;
      const head = document.createElement('div');
      head.className = 'printer-computer';
      head.textContent = p.agentName || 'a computer';
      box.appendChild(head);
    }
    const key = slotKey(p.agentId, p.name);
    const row = document.createElement('div');
    row.className = 'printer-row';
    // Checkbox + full printer name on the top line (the name wraps, so long CUPS names
    // like "CANON_G4010_series" show in full); the name/number field sits below it.
    const head = document.createElement('label');
    head.className = 'printer-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selection.has(key);
    const name = document.createElement('span');
    name.className = 'printer-name';
    name.textContent = p.state ? `${p.name} · ${p.state}` : p.name;
    head.append(cb, name);
    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'text-input printer-label';
    label.maxLength = 40;
    label.placeholder = 'Name or number guests see (e.g. #1)';
    label.value = selection.get(key) || '';
    label.disabled = !cb.checked;
    cb.addEventListener('change', () => {
      if (cb.checked) { selection.set(key, label.value.trim() || p.name); label.disabled = false; label.focus(); }
      else { selection.delete(key); label.disabled = true; }
      renderPrinterSummary();
    });
    label.addEventListener('input', () => { if (cb.checked) { selection.set(key, label.value.trim() || p.name); renderPrinterSummary(); } });
    row.append(head, label);
    box.appendChild(row);
  }
  $('printerHint').textContent = data.dryRun
    ? 'Dry run: prints are saved but never handed to a printer.'
    : `${selectedPrinters().length || 'No'} printer${selectedPrinters().length === 1 ? '' : 's'} selected - prints go to whichever is free first.`;
}

/** Populate the Paper dropdown with the page sizes the selected printer actually
 *  supports, so a borderless (full-bleed) size can be chosen by name. Falls back to
 *  the static list when the driver list is unavailable (dry run, relay, no printer). */
async function loadMedia() {
  const printer = primaryPrinter();
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
    el.textContent = option.id + (option.borderless ? ' · borderless' : '') + (option.isDefault ? ' (default)' : '');
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
    // This box is the manual-approval hold: with "Ask me before each print" on, every print
    // waits here for the host to tap Print. With it off, prints go straight to the printer.
    pendingBox.innerHTML = config && config.requireApproval
      ? '<p class="hint">Nothing waiting for your OK right now.</p>'
      : '<p class="hint">Prints go straight to the printer. Turn on “Ask me before each print” above to hold each one here for your approval first.</p>';
  } else {
    for (const job of pending) {
      pendingBox.appendChild(jobCard(
        {
          image: job.image,
          title: pno(job),
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
    const onPrinter = job.status === 'printing' || job.status === 'claimed';
    const where = onPrinter && job.printerLabel
      ? ` · ${job.printerLabel}${job.computer && job.computer !== 'This Mac' ? ` (${job.computer})` : ''}`
      : '';
    const state = onPrinter ? 'Printing' : 'On its way to the printer';
    queueBox.appendChild(jobCard(
      { image: job.image, title: pno(job), subtitle: `${state}${where} · ${job.layout}` },
      [{ label: 'Cancel', run: async () => {
        try {
          const r = await post('/api/cancel-job', { id: job.id });
          toast(r && r.ok ? `Cancelled ${pno(job)}.` : (r && r.error) || 'Could not cancel that print.');
        } catch { toast('Could not cancel that print.'); }
        refreshQueue();
      } }],
    ));
  }
  for (const job of data.cupsJobs) {
    queueBox.appendChild(jobCard(
      { title: job.id, subtitle: `${job.owner} · ${job.submitted}` },
      [{ label: 'Cancel', run: async () => {
        try {
          const r = await post('/api/cancel', { cupsJobId: job.id });
          toast(r && r.ok ? 'Cancelling that job…' : (r && r.error) || 'Could not cancel that job.');
        } catch { toast('Could not cancel that job.'); }
        refreshQueue();
      } }],
    ));
  }
  for (const job of failed) {
    queueBox.appendChild(jobCard({ image: job.image, title: `${pno(job)} · failed`, subtitle: job.error || 'Unknown error' }, []));
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

  $('requireVoucher').addEventListener('change', (e) => { $('voucherBox').hidden = !e.target.checked; });

  $('genVouchers').addEventListener('click', async () => {
    const count = Math.max(1, Math.min(10000, Number($('voucherCount').value) || 1000));
    if (!confirm(`Generate ${count} new print codes? They are added to any existing ones.`)) return;
    const r = await post('/api/vouchers', { action: 'generate', count });
    toast(`Added ${r.added} codes.`);
    loadVouchers();
  });
  $('dlVouchers').addEventListener('click', () => {
    // Same-origin download; the token rides in the query so a fresh tab is still authorised.
    window.open(`/api/vouchers/export?only=unused&token=${encodeURIComponent(token)}`, '_blank');
  });
  $('clearVouchers').addEventListener('click', async () => {
    if (!confirm('Delete ALL print codes? Any vouchers you handed out stop working.')) return;
    await post('/api/vouchers', { action: 'clear' });
    toast('All codes cleared.');
    loadVouchers();
  });

  $('pairRefresh').addEventListener('click', () => ensurePairCode(true));

  $('choosePrinters').addEventListener('click', () => {
    const list = $('printerList');
    const open = list.hidden;
    list.hidden = !open;
    $('choosePrinters').textContent = open ? 'Done choosing' : 'Choose printers';
  });

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
    toast('New guest link. Show the fresh QR code.');
  });

  $('saveConfig').addEventListener('click', async () => {
    const printers = selectedPrinters();
    await post('/api/config', {
      printers,
      printer: printers[0] ? printers[0].name : null, // legacy fallback / relay default
      media: $('mediaPick').value,
      borderless: $('borderless').checked,
      fitToPage: $('fitToPage').checked,
      printingEnabled: $('printingEnabled').checked,
      requireApproval: $('requireApproval').checked,
      requireVoucher: $('requireVoucher').checked,
      maxCopies: Number($('maxCopies').value) || 3,
      boothName: $('boothNameInput').value.trim() || 'Photo Booth',
      message: $('messageInput').value.trim(),
      ...(chosenSticker ? { sticker: chosenSticker } : {}),
    });
    await loadConfig();
    await loadPrinters();
    await loadMedia();
    $('printerList').hidden = true; // collapse the picker back to the compact summary
    $('choosePrinters').textContent = 'Choose printers';
    toast('Saved.');
  });
}

function start() {
  clearInterval(timer);
  refreshQueue();
  pollConnect();
  timer = setInterval(() => { refreshQueue(); pollConnect(); }, 3000);
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
