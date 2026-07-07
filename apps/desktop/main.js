/**
 * main.js — Electron main process for AIGov Desktop
 *
 * The desktop app is a pure UI client. Skaffold manages the backend,
 * database, and Redis. The app only connects to the running backend.
 *
 * Startup:
 *   1. Opens the HITL review UI window
 *   2. Polls /health until backend is reachable
 *   3. Shows "connected" when healthy
 *   4. Shows "backend not ready — run `skaffold dev`" when unreachable
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow = null;

const BACKEND_PORT = process.env.PORT || 3000;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on('ready', () => {
  createWindow();
  startHealthPolling();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('get-status', async () => ({
  apiRunning: await checkHealth(),
}));

ipcMain.handle('retry-connection', async () => {
  sendStatus('waiting_health', 'Checking backend...');
  const healthy = await waitForHealth(10_000);
  if (healthy) {
    sendStatus('connected', `Connected to ${BACKEND_URL}`);
    return { connected: true };
  }
  sendStatus('error', `Cannot reach ${BACKEND_URL} — run "skaffold dev" first`);
  return { connected: false };
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'AIGov — AI Code Governance',
    backgroundColor: '#020617',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('src/App.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// Health polling
// ---------------------------------------------------------------------------

function startHealthPolling() {
  sendStatus('waiting_health', 'Connecting to backend...');
  healthLoop();
}

async function healthLoop() {
  const ok = await checkHealth();
  if (ok) {
    sendStatus('connected', `Connected to ${BACKEND_URL}`);
    return;
  }
  sendStatus('error', `Backend not ready — run "skaffold dev" to start`);
  await sleep(3000);
  healthLoop();
}

async function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${BACKEND_URL}/api/v1/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth()) return true;
    await sleep(1000);
  }
  return false;
}

// ---------------------------------------------------------------------------
// IPC → renderer
// ---------------------------------------------------------------------------

function sendStatus(status, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', { status, message, timestamp: Date.now() });
  }
  console.log(`[status] ${status}: ${message}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
