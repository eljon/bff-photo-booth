'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// A small, explicit surface for the renderer — no full Node access in the page.
contextBridge.exposeInMainWorld('helper', {
  getState: () => ipcRenderer.invoke('helper:getState'),
  connect: (payload) => ipcRenderer.send('helper:connect', payload),
  disconnect: () => ipcRenderer.send('helper:disconnect'),
  openReleases: () => ipcRenderer.send('helper:openReleases'),
  onStatus: (cb) => ipcRenderer.on('helper:status', (_e, status) => cb(status)),
});
