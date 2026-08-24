import { qrMatrix, drawQr } from './qr.mjs';

const $ = (id) => document.getElementById(id);
let config = null;
let urls = [];

function toast(message, ms = 2400) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('hidden'), ms);
}

function paintQr(url) {
  $('joinUrl').textContent = url;
  drawQr($('qr'), qrMatrix(url, { ecc: 'M' }), { moduleSize: 10, quiet: 3, dark: '#15111b' });
}

async function loadConfig() {
  const response = await fetch('/api/config');
  const data = await response.json();
  config = data.config;
  urls = data.urls.length ? data.urls : [location.origin];

  $('hostName').textContent = `${config.boothName} · Host`;
  $('modePill').textContent = data.dryRun ? 'dry run' : config.printingEnabled ? 'live' : 'printing off';
  $('modePill').className = `pill ${data.dryRun ? 'quiet' : config.printingEnabled ? 'good' : 'bad'}`;

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
  $('fitToPage').checked = config.fitToPage;
  $('printingEnabled').checked = config.printingEnabled;
  $('requireApproval').checked = config.requireApproval;
  $('maxCopies').value = String(config.maxCopies);
  $('boothNameInput').value = config.boothName;
  $('messageInput').value = config.message;
}

async function loadPrinters() {
  const response = await fetch('/api/printers');
  const data = await response.json();
  const select = $('printerPick');
  select.innerHTML = '';

  if (!data.printers.length) {
    const option = document.createElement('option');
    option.textContent = 'No printers found';
    option.value = '';
    select.appendChild(option);
    $('printerHint').textContent = data.cupsAvailable === false
      ? 'CUPS is not answering. Open System Settings ▸ Printers & Scanners and add your printer.'
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
    ? 'DRY_RUN=1 — strips are saved to ./prints but never handed to a printer.'
    : `Default destination: ${data.default || 'none'}.`;
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

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function refreshQueue() {
  let data;
  try {
    data = await (await fetch('/api/queue')).json();
  } catch {
    return;
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
  const failed = data.jobs.filter((job) => job.status === 'failed').slice(0, 3);
  if (!data.cupsJobs.length && !failed.length) {
    queueBox.innerHTML = '<p class="hint">Queue is empty.</p>';
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

  $('saveConfig').addEventListener('click', async () => {
    const patch = {
      printer: $('printerPick').value || null,
      media: $('mediaPick').value,
      fitToPage: $('fitToPage').checked,
      printingEnabled: $('printingEnabled').checked,
      requireApproval: $('requireApproval').checked,
      maxCopies: Number($('maxCopies').value) || 3,
      boothName: $('boothNameInput').value.trim() || 'Photo Booth',
      message: $('messageInput').value.trim(),
    };
    const data = await post('/api/config', patch);
    config = data.config;
    await loadConfig();
    await loadPrinters();
    toast('Saved.');
  });
}

await loadConfig();
await loadPrinters();
bind();
refreshQueue();
setInterval(refreshQueue, 3000);
