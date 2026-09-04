'use strict';

/**
 * BFF Booth Helper — the printer-side app.
 *
 * It does exactly what `npm run agent` does (see ../server/agent.js), but wrapped in a
 * tiny desktop app so the operator never opens a terminal: enter the relay URL and the
 * pairing code shown on the host screen, hit Connect, and it prints the queue. It makes
 * only OUTBOUND https calls, so the printer computer needs no open ports.
 *
 * The agent logic is reused verbatim — this process forks the bundled ../server/agent.js
 * as a Node child (utilityProcess) with the right env, so there is one source of truth
 * for pairing, printing, and the long-poll.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// A menu-bar/tray icon embedded as a data URL, so the app needs no binary asset checked in.
const TRAY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAeElEQVR4nN2UywnAIBBEXzE2YiNbiYXZXXJRkBA/MTsQMjAXkXeY2V34owJgQCq28ratCGTg6DiXP4+UBsCrkwK6DI8b0OphLKNMZ849aHgBrb6dFnMAm1dpSyXKwLIoZOXJxg3lguyWKLkXy9A2Fvez2cr90H9TJykQ4sma2avoAAAAAElFTkSuQmCC';

const CONFIG_PATH = path.join(app.getPath('userData'), 'helper-config.json');
// The bundled agent + its files (see extraResources in package.json). In dev, fall back
// to the repo copy one level up.
const RES = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'server'))
  ? process.resourcesPath
  : path.join(__dirname, '..');
const AGENT_PATH = path.join(RES, 'server', 'agent.js');
const PRINTS_DIR = path.join(app.getPath('userData'), 'prints');

let win = null;
let tray = null;
let child = null;
let status = { state: 'idle', message: 'Not connected', printers: [] };

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2)); } catch { /* best effort */ }
  return next;
}

function pushStatus(next) {
  status = { ...status, ...next };
  if (win && !win.isDestroyed()) win.webContents.send('helper:status', status);
  if (tray) tray.setToolTip(`BFF Booth Helper — ${status.message}`);
}

/** Start the bundled agent with the relay URL + pairing code (or a saved token). */
function connect({ relay, code }) {
  const relayUrl = String(relay || '').trim().replace(/\/+$/, '');
  const pairCode = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!relayUrl) return pushStatus({ state: 'error', message: 'Enter the relay web address first.' });
  if (!pairCode) return pushStatus({ state: 'error', message: 'Enter the pairing code from the host screen.' });

  disconnect();
  saveConfig({ relay: relayUrl });
  fs.mkdirSync(PRINTS_DIR, { recursive: true });
  pushStatus({ state: 'connecting', message: 'Connecting…', printers: [] });

  child = utilityProcess.fork(AGENT_PATH, [], {
    stdio: 'pipe',
    env: {
      ...process.env,
      RELAY_URL: relayUrl,
      PAIR_CODE: pairCode,
      PRINTS_DIR,
      AGENT_NAME: `${require('node:os').hostname()} (helper)`,
    },
  });

  const onLine = (buf) => {
    const text = buf.toString();
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (/token received|printing|printers:/i.test(line)) pushStatus({ state: 'connected', message: 'Connected — printing the queue as it arrives.' });
      if (/pairing failed|rejected/i.test(line)) pushStatus({ state: 'error', message: line });
    }
  };
  child.stdout && child.stdout.on('data', onLine);
  child.stderr && child.stderr.on('data', onLine);
  child.on('spawn', () => pushStatus({ state: 'connected', message: 'Connected — printing the queue as it arrives.' }));
  child.on('exit', (codeNum) => {
    child = null;
    if (status.state !== 'error') pushStatus({ state: 'idle', message: codeNum ? `Stopped (code ${codeNum}).` : 'Disconnected.' });
  });
  buildTrayMenu();
}

function disconnect() {
  if (child) { try { child.kill(); } catch { /* already gone */ } child = null; }
  pushStatus({ state: 'idle', message: 'Disconnected.' });
  buildTrayMenu();
}

function showWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    title: 'BFF Booth Helper',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status.message, enabled: false },
    { type: 'separator' },
    { label: 'Open BFF Booth Helper…', click: showWindow },
    child ? { label: 'Disconnect', click: disconnect } : { label: 'Connect…', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { disconnect(); app.quit(); } },
  ]));
}

app.whenReady().then(() => {
  const img = nativeImage.createFromBuffer(Buffer.from(TRAY_PNG, 'base64'));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('BFF Booth Helper');
  buildTrayMenu();
  showWindow();

  ipcMain.handle('helper:getState', () => ({ ...status, config: loadConfig() }));
  ipcMain.on('helper:connect', (_e, payload) => connect(payload));
  ipcMain.on('helper:disconnect', () => disconnect());
  ipcMain.on('helper:openReleases', () => shell.openExternal('https://github.com/eljon/bff-photo-booth/releases/latest'));

  app.on('activate', showWindow);
});

// Keep running in the tray when the window is closed (this is a background helper).
app.on('window-all-closed', (e) => { e.preventDefault(); });
app.on('before-quit', disconnect);
