/**
 * preload.js — Secure bridge between Electron main and renderer.
 * Exposes a minimal API to the renderer via window.aigov.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aigov', {
  // Status events from main process
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, data) => callback(data));
  },

  // Engine control
  startEngine: () => ipcRenderer.invoke('start-engine'),
  stopEngine: () => ipcRenderer.invoke('stop-engine'),
  restartEngine: () => ipcRenderer.invoke('restart-engine'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  openLogs: () => ipcRenderer.invoke('open-logs'),

  // App info
  platform: process.platform,
  arch: process.arch,
});
