import { LAYOUTS, LAYOUT_ORDER, FRAMES } from './layouts.mjs';
import { FILTERS, FILTER_ORDER } from './filters.mjs';
import { composePage, exportPrint, drawSinglePhoto, clampTransform, resolveLayout } from './render.mjs';

const $ = (id) => document.getElementById(id);
const MAX_SOURCE_DIM = 2400; // plenty for a 300 DPI cell, gentle on phone memory

// One layout, one look, one paper. The guest picks photos and prints — that is
// the whole app.
const state = {
  layoutId: 'grid',
  frameId: 'white',
  filterId: 'none',
  caption: '',
  subtitle: '',
  copies: 1,
  photos: [null, null, null, null],
};

const session = {
  boothName: 'Photo Booth',
  maxCopies: 3,
  printingEnabled: true,
  requireApproval: false,
  keyRequired: false,
  remote: false,
  dryRun: false,
  online: false,
};

const KEY_STORAGE = 'booth.key';

/**
 * A public booth carries its access key in the QR link (?k=…). Stash it and
 * tidy the address bar, so the guest never types anything and a shared
 * screenshot of the URL bar does not hand out printing rights.
 */
function claimAccessKey() {
  const url = new URL(location.href);
  const fromLink = url.searchParams.get('k');
  if (fromLink) {
    try {
      localStorage.setItem(KEY_STORAGE, fromLink);
    } catch {
      /* private mode — the key still works for this page load */
    }
    url.searchParams.delete('k');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return fromLink;
  }
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

let accessKey = claimAccessKey();

let editorIndex = null;
let pendingSlot = null;
let replaceAllNext = false;
let lastPrintBlob = null;
let printGeneration = 0; // bumped whenever the page changes, so stale renders are dropped
let warmTimer = null;

// ---------------------------------------------------------------- utilities

function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('hidden'), ms);
}

function todayStamp() {
  return new Date()
    .toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
    .toUpperCase();
}

/** Decode a picked file, honouring EXIF rotation, and shrink it for memory. */
async function loadPhoto(file) {
  let source = null;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await loadViaImgElement(file);
  }
  if (!source || !source.width) throw new Error('That file is not a photo this browser can read.');
  return downscale(source, MAX_SOURCE_DIM);
}

function loadViaImgElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not open that photo. Try a different one.'));
    };
    img.src = url;
  });
}

function downscale(source, maxDim) {
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const longest = Math.max(w, h);
  if (longest <= maxDim) return source;
  const ratio = maxDim / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (source.close) source.close();
  return canvas;
}

function filledCount() {
  return state.photos.filter(Boolean).length;
}

// ---------------------------------------------------------------- rendering

let frameRequested = false;

function scheduleRender() {
  lastPrintBlob = null; // anything that redraws invalidates the exported page
  printGeneration += 1;
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    renderAll();
  });
}

function previewScale(layout) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssWidth = Math.min(300, window.innerWidth * 0.78);
  return Math.min(1, (cssWidth * dpr) / layout.page.w);
}

function renderAll() {
  const layout = resolveLayout(state);
  state.subtitle = `${session.boothName} · ${todayStamp()}`;
  composePage($('preview'), state, previewScale(layout));
  $('paperNote').textContent = layout.paper;
  updatePickButton();
  $('printBtn').disabled = filledCount() < 4 || !session.printingEnabled;
  $('saveBtn').disabled = filledCount() < 4;
  renderSlots();
  warmPrint();
}

/**
 * Render the page ahead of time once all four photos are in. iOS only lets
 * navigator.share run inside the tap that asked for it, and rendering a 300 DPI
 * page takes long enough to lose that permission — so have it ready first.
 * Debounced, because a resize can fire renders in a burst.
 */
function warmPrint() {
  clearTimeout(warmTimer);
  if (filledCount() < 4 || lastPrintBlob) return;

  warmTimer = setTimeout(() => {
    const generation = printGeneration;
    exportPrint(state)
      .then((result) => {
        if (generation === printGeneration) lastPrintBlob = result.blob;
      })
      .catch(() => {
        /* a real Save or Print will surface the failure */
      });
  }, 500);
}

/** The picker is the main event: one tap should get all four photos. */
function updatePickButton() {
  const missing = 4 - filledCount();
  const button = $('addAll');
  const label = $('pickLabel');
  const hint = $('pickHint');

  if (missing === 4) {
    label.textContent = 'Pick 4 photos';
    hint.textContent = 'One tap opens your camera roll — select all four there, then hit Done.';
  } else if (missing > 0) {
    label.textContent = `Add ${missing} more`;
    hint.textContent = 'Pick them all at once — they drop into the empty slots in order.';
  } else {
    label.textContent = 'Swap all 4';
    hint.textContent = 'Happy with these? Save them, or print.';
  }

  button.classList.toggle('btn-primary', missing > 0);
  button.classList.toggle('btn-ghost', missing === 0);
  $('pickOverlay').classList.toggle('compact', missing === 0);
  // Nothing to tap yet — no empty grid, no crop hint, just the one button.
  const empty = missing === 4;
  $('slots').classList.toggle('hidden', empty);
  $('editHint').classList.toggle('hidden', empty);
}

function renderSlots() {
  const container = $('slots');
  if (!container.childElementCount) {
    for (let i = 0; i < 4; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot';
      btn.dataset.index = String(i);
      btn.addEventListener('click', () => onSlotTap(i));
      container.appendChild(btn);
    }
  }

  [...container.children].forEach((btn, i) => {
    const photo = state.photos[i];
    btn.classList.toggle('filled', Boolean(photo));
    btn.innerHTML = '';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    if (!photo) {
      btn.textContent = String(i + 1);
      btn.disabled = true;
      btn.setAttribute('aria-label', `Photo ${i + 1}, empty`);
      return;
    }
    btn.disabled = false;
    const thumb = document.createElement('canvas');
    thumb.width = 120;
    thumb.height = 160;
    drawSinglePhoto(thumb, photo, state.filterId);
    btn.appendChild(thumb);
    btn.appendChild(num);
    btn.setAttribute('aria-label', `Adjust photo ${i + 1}`);
  });
}

// ---------------------------------------------------------------- controls

// ---------------------------------------------------------------- picking

function onSlotTap(index) {
  // Empty slots are placeholders now — the one button above fills them.
  if (state.photos[index]) openEditor(index);
}

function pickInto(index) {
  pendingSlot = index;
  $('fileOne').value = '';
  $('fileOne').click();
}

async function acceptFiles(files, startIndex = null) {
  const chosen = [...files];
  const list = chosen.slice(0, 4);
  if (!list.length) return;

  if (startIndex === null && replaceAllNext) {
    state.photos = [null, null, null, null];
    overflowCursor = 0;
  }
  replaceAllNext = false;

  const tooMany = chosen.length > 4;
  toast(tooMany ? 'A print holds 4 — using the first four you picked.' : list.length > 1 ? 'Loading your photos…' : 'Loading…', tooMany ? 3200 : 1400);

  let cursor = startIndex;
  for (const file of list) {
    try {
      const bitmap = await loadPhoto(file);
      const slot = cursor !== null ? cursor : nextOpenSlot();
      state.photos[slot] = { bitmap, transform: { zoom: 1, dx: 0, dy: 0, rot: 0 } };
      cursor = null; // an explicit slot only claims the first file
      scheduleRender();
    } catch (err) {
      toast(err.message);
    }
  }

  // Do not talk over the "only four fit" notice — that one is news.
  if (filledCount() === 4 && !tooMany) toast('Looking good — print it, or save it to your phone.', 2400);
}

let overflowCursor = 0;

function nextOpenSlot() {
  const open = state.photos.findIndex((p) => !p);
  if (open !== -1) return open;
  const slot = overflowCursor % 4;
  overflowCursor += 1;
  return slot;
}

// ---------------------------------------------------------------- editor

const crop = { dragging: false, startX: 0, startY: 0, baseDx: 0, baseDy: 0, pinchDist: 0, baseZoom: 1 };

function cellFor(index) {
  const layout = resolveLayout(state);
  return layout.cells.find((c) => c.photo === index) || layout.cells[0];
}

function openEditor(index) {
  editorIndex = index;
  $('editorIndex').textContent = String(index + 1);
  updateHeroButton();
  $('editor').classList.remove('hidden');
  sizeCropCanvas();
  $('zoom').value = String(state.photos[index].transform.zoom);
  drawCrop();
}

function closeEditor() {
  editorIndex = null;
  $('editor').classList.add('hidden');
  scheduleRender();
}

function sizeCropCanvas() {
  const cell = cellFor(editorIndex);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssWidth = Math.min(320, window.innerWidth * 0.74);
  const canvas = $('cropCanvas');
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${Math.round((cssWidth * cell.h) / cell.w)}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(((cssWidth * cell.h) / cell.w) * dpr);
}

function drawCrop() {
  if (editorIndex === null) return;
  const photo = state.photos[editorIndex];
  if (!photo) return;
  const canvas = $('cropCanvas');
  photo.transform = clampTransform(photo.transform, canvas.width, canvas.height, photo.bitmap);
  drawSinglePhoto(canvas, photo, state.filterId);
}

function bindCropGestures() {
  const canvas = $('cropCanvas');
  const pointers = new Map();

  canvas.addEventListener('pointerdown', (event) => {
    if (editorIndex === null) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, event);
    const t = state.photos[editorIndex].transform;
    if (pointers.size === 1) {
      crop.dragging = true;
      crop.startX = event.clientX;
      crop.startY = event.clientY;
      crop.baseDx = t.dx;
      crop.baseDy = t.dy;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      crop.pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      crop.baseZoom = t.zoom;
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (editorIndex === null || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, event);
    const photo = state.photos[editorIndex];
    const rect = canvas.getBoundingClientRect();

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (crop.pinchDist > 0) {
        photo.transform.zoom = Math.min(4, Math.max(1, (crop.baseZoom * dist) / crop.pinchDist));
        $('zoom').value = String(Math.min(3, photo.transform.zoom));
      }
    } else if (crop.dragging) {
      photo.transform.dx = crop.baseDx + (event.clientX - crop.startX) / rect.width;
      photo.transform.dy = crop.baseDy + (event.clientY - crop.startY) / rect.height;
    }
    drawCrop();
  });

  const release = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) crop.pinchDist = 0;
    if (pointers.size === 0) crop.dragging = false;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
}

// ---------------------------------------------------------------- printing

/** POST the page with a progress bar — uploads matter on a cellular booth. */
function uploadPrint(path, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', path);
    request.timeout = 120_000;
    request.setRequestHeader('content-type', blob.type || 'image/png');
    if (accessKey) request.setRequestHeader('x-booth-key', accessKey);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    request.addEventListener('load', () => {
      try {
        resolve({ status: request.status, data: JSON.parse(request.responseText) });
      } catch {
        reject(new Error('The booth sent back something unreadable.'));
      }
    });
    request.addEventListener('error', () => reject(new Error('network')));
    request.addEventListener('timeout', () => reject(new Error('network')));
    request.send(blob);
  });
}

const WAITING = ['awaiting-approval', 'pending', 'claimed', 'printing'];

/** Turn a job record into what the guest sees. */
function showJob(job) {
  if (job.status === 'awaiting-approval') {
    return showResult({
      emoji: '👀',
      title: 'Waiting for the host',
      body: 'Your print is in the queue — the booth host taps print. Stay close to the tray.',
      image: job.image,
      busy: true,
    });
  }
  if (WAITING.includes(job.status)) {
    return showResult({
      emoji: '📡',
      title: 'Sending it to the booth',
      body: 'The printer is picking up your photos now.',
      image: job.image,
      busy: true,
    });
  }
  if (job.status === 'failed') {
    return showResult({
      emoji: '🙃',
      title: 'The printer said no',
      body: `${job.error || 'Printing failed.'} You can still save the photo to your phone.`,
      image: job.image,
    });
  }
  if (job.status === 'rejected') {
    return showResult({
      emoji: '🤷',
      title: 'The host skipped this one',
      body: 'Ask them why. You can still save it to your phone.',
      image: job.image,
    });
  }
  return showResult({
    emoji: '🎉',
    title: session.dryRun ? 'Saved (dry run)' : 'Printing now!',
    body: session.dryRun
      ? 'The booth is in dry-run mode, so nothing was sent to a real printer.'
      : `${job.copies} ${job.copies === 1 ? 'copy' : 'copies'} on the way${job.cupsJobId ? ` · job ${job.cupsJobId}` : ''}. ${session.remote ? 'Collect it from the booth.' : 'Grab it from the tray.'}`,
    image: job.image,
  });
}

/** Follow a job until the printer has actually taken it. */
async function trackJob(job) {
  const deadline = Date.now() + 120_000;
  let current = job;
  while (WAITING.includes(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const response = await fetch(`/api/job?id=${encodeURIComponent(current.id)}`);
      if (!response.ok) return;
      const data = await response.json();
      current = data.job;
    } catch {
      return;
    }
    showJob(current);
  }
}

function showResult({ emoji, title, body, image, busy }) {
  $('resultEmoji').textContent = emoji;
  $('resultTitle').textContent = title;
  $('resultBody').textContent = body;
  $('result').classList.remove('hidden');
  $('resultDone').disabled = Boolean(busy);
  const img = $('resultImage');
  if (image) {
    img.src = image;
    img.classList.remove('hidden');
  } else {
    img.classList.add('hidden');
  }
}

async function doPrint() {
  if (filledCount() < 4) {
    toast('Four photos first.');
    return;
  }
  showResult({ emoji: '🖨️', title: 'Building your print…', body: 'Rendering at 300 DPI.', busy: true });

  let result;
  try {
    result = await exportPrint(state);
  } catch (err) {
    showResult({ emoji: '😵', title: 'Could not build the print', body: err.message });
    return;
  }
  lastPrintBlob = result.blob;

  const params = new URLSearchParams({
    layout: state.layoutId,
    copies: String(state.copies),
    guest: '',
    orient: resolveLayout(state).page.w > resolveLayout(state).page.h ? 'landscape' : 'portrait',
  });

  try {
    const { status, data } = await uploadPrint(`/api/print?${params}`, result.blob, (fraction) => {
      showResult({
        emoji: '📤',
        title: 'Sending to the booth…',
        body: `${Math.round(fraction * 100)}% uploaded`,
        busy: true,
      });
    });

    if (status === 401) {
      accessKey = '';
      try {
        localStorage.removeItem(KEY_STORAGE);
      } catch {
        /* nothing to clear */
      }
      showResult({
        emoji: '🔑',
        title: 'Scan the booth QR code',
        body: 'This booth only prints for guests who came in through its QR code. Scan it and try again — your photos stay put.',
      });
      return;
    }

    if (status < 200 || status >= 300 || !data.ok) {
      showResult({
        emoji: '🙃',
        title: 'The printer said no',
        body: `${data.error || 'Printing failed.'} You can still save the photo to your phone.`,
      });
      return;
    }

    showJob(data.job);
    trackJob(data.job);
  } catch (err) {
    showResult({
      emoji: '📶',
      title: err.message === 'network' ? 'Lost the connection' : 'Something went wrong',
      body: 'Check your signal and try again — or save the photo to your phone.',
    });
  }
}

function printFile(blob) {
  const extension = blob.type === 'image/png' ? 'png' : 'jpg';
  return new File([blob], `photobooth-${Date.now()}.${extension}`, { type: blob.type || 'image/png' });
}

/** Last resort on desktop, or anywhere the share sheet is not offered. */
function downloadBlob(blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = printFile(blob).name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

/**
 * Hand the print to the phone's share sheet, where "Save Image" puts it in the
 * Photos app. A download link would only drop it in Files, which is not where
 * anyone looks for a photo.
 */
let saveObjectUrl = null;

function isTouchDevice() {
  return 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
}

/** The share sheet's "Save Image" also lands in Photos — kept as the fallback. */
async function shareToPhotos(blob) {
  const file = printFile(blob);
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      toast('Saved to your phone.', 2400);
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return true; // guest closed the sheet
      if (err && err.name === 'NotAllowedError') {
        toast('Tap Share once more.', 2600);
        return true;
      }
    }
  }
  downloadBlob(blob);
  toast('Saved to your downloads.');
  return true;
}

async function buildPrintBlob() {
  if (lastPrintBlob) return lastPrintBlob;
  toast('Getting your photo ready…', 1200);
  try {
    lastPrintBlob = (await exportPrint(state)).blob;
    return lastPrintBlob;
  } catch (err) {
    toast(err.message || 'Could not build the photo.');
    return null;
  }
}

/**
 * On a phone, show the finished photo big and let the guest press-and-hold it —
 * iOS and Android both offer "Save to Photos" / "Download image" from that, and
 * it goes straight to the camera roll with no share sheet in the way. On a
 * desktop, where there is no long-press, go straight to share/download.
 */
async function savePhoto() {
  if (filledCount() < 4) {
    toast('Four photos first.');
    return;
  }
  const blob = await buildPrintBlob();
  if (!blob) return;

  if (!isTouchDevice()) {
    await shareToPhotos(blob);
    return;
  }

  if (saveObjectUrl) URL.revokeObjectURL(saveObjectUrl);
  saveObjectUrl = URL.createObjectURL(blob);
  $('saveImage').src = saveObjectUrl;
  $('saveSheet').classList.remove('hidden');
}

function closeSaveSheet() {
  $('saveSheet').classList.add('hidden');
  if (saveObjectUrl) {
    URL.revokeObjectURL(saveObjectUrl);
    saveObjectUrl = null;
  }
}

function resetBooth() {
  state.photos = [null, null, null, null];
  lastPrintBlob = null;
  overflowCursor = 0;
  replaceAllNext = false;
  $('result').classList.add('hidden');
  scheduleRender();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------- session

async function loadSession() {
  try {
    const response = await fetch('/api/session');
    const data = await response.json();
    Object.assign(session, data, { online: true });
  } catch {
    session.online = false;
  }

  $('boothName').textContent = session.boothName;
  document.title = session.boothName;
  $('version').textContent = session.version ? `v${session.version}` : '';
  if (session.message) $('boothMessage').textContent = session.message;
  state.copies = Math.min(session.defaultCopies || 1, session.maxCopies || 3);

  if (session.keyRequired && !accessKey) {
    showProblem('Scan the booth QR code to unlock printing — you can still save to your phone.');
  }

  if (!session.printingEnabled || !session.online) {
    $('printBtn').classList.add('hidden');
    $('saveBtn').classList.remove('btn-ghost');
    $('saveBtn').classList.add('btn-primary');
    $('saveBtn').textContent = 'Save to phone';
    $('saveBtn').style.flex = '1';
  }
  scheduleRender();
  if (session.online && session.printingEnabled) refreshPrinter();
}

/** A one-line warning, shown only when something would stop a print. */
function showProblem(message) {
  const el = $('printProblem');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

/** No status chatter — the guest only hears about the printer when it matters. */
async function refreshPrinter() {
  try {
    const data = await (await fetch('/api/printers')).json();
    if (data.remote && !data.agentOnline) {
      showProblem('The booth printer is offline right now. You can still save to your phone.');
      return;
    }
    if (!data.printers.length) {
      showProblem('No printer is set up at the booth yet. You can still save to your phone.');
      return;
    }
    showProblem('');
  } catch {
    showProblem('Cannot reach the booth right now. You can still save to your phone.');
  }
}

// ---------------------------------------------------------------- wiring

function bind() {
  $('addAll').addEventListener('click', () => {
    replaceAllNext = filledCount() === 4; // "Swap all 4" starts a fresh set
    $('filePicker').value = '';
    $('filePicker').click();
  });
  $('filePicker').addEventListener('change', (event) => acceptFiles(event.target.files));
  $('fileOne').addEventListener('change', (event) => {
    const slot = pendingSlot;
    pendingSlot = null;
    acceptFiles(event.target.files, slot);
  });

  $('printBtn').addEventListener('click', doPrint);
  $('saveBtn').addEventListener('click', savePhoto);
  $('resultSave').addEventListener('click', savePhoto);
  $('saveClose').addEventListener('click', closeSaveSheet);
  $('saveShare').addEventListener('click', async () => {
    const blob = await buildPrintBlob();
    if (blob) await shareToPhotos(blob);
  });
  $('resultDone').addEventListener('click', resetBooth);

  $('editorClose').addEventListener('click', closeEditor);
  $('editorDone').addEventListener('click', closeEditor);
  $('editor').addEventListener('click', (event) => {
    if (event.target === $('editor')) closeEditor();
  });
  $('zoom').addEventListener('input', (event) => {
    if (editorIndex === null) return;
    state.photos[editorIndex].transform.zoom = Number(event.target.value);
    drawCrop();
  });
  $('rotateBtn').addEventListener('click', () => {
    if (editorIndex === null) return;
    const t = state.photos[editorIndex].transform;
    t.rot = (t.rot + 90) % 360;
    drawCrop();
  });
  $('resetBtn').addEventListener('click', () => {
    if (editorIndex === null) return;
    state.photos[editorIndex].transform = { zoom: 1, dx: 0, dy: 0, rot: 0 };
    $('zoom').value = '1';
    drawCrop();
  });
  $('replaceBtn').addEventListener('click', () => {
    const index = editorIndex;
    closeEditor();
    pickInto(index);
  });
  $('removeBtn').addEventListener('click', () => {
    if (editorIndex === null) return;
    state.photos[editorIndex] = null;
    closeEditor();
  });
  $('moveLeft').addEventListener('click', () => swapEditor(-1));
  $('moveRight').addEventListener('click', () => swapEditor(1));
  $('makeHero').addEventListener('click', makeHero);

  bindCropGestures();
  window.addEventListener('resize', scheduleRender);
}

/** Move the photo being edited to the front, so it becomes the big hero. */
function makeHero() {
  if (editorIndex === null || editorIndex === 0) return;
  const [moved] = state.photos.splice(editorIndex, 1);
  state.photos.unshift(moved);
  editorIndex = 0;
  $('editorIndex').textContent = '1';
  updateHeroButton();
  sizeCropCanvas();
  drawCrop();
  scheduleRender();
}

/** The front photo is already the hero — hide the button there. */
function updateHeroButton() {
  const btn = document.getElementById('makeHero');
  if (btn) btn.classList.toggle('hidden', editorIndex === 0);
}

function swapEditor(direction) {
  if (editorIndex === null) return;
  const target = (editorIndex + direction + 4) % 4;
  const photos = state.photos;
  [photos[editorIndex], photos[target]] = [photos[target], photos[editorIndex]];
  editorIndex = target;
  $('editorIndex').textContent = String(target + 1);
  updateHeroButton();
  if (!photos[target]) {
    closeEditor();
    return;
  }
  sizeCropCanvas();
  drawCrop();
  scheduleRender();
}

bind();
loadSession();
scheduleRender();
