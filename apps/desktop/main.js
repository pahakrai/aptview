/**
 * main.js — Electron main process for AIGov Desktop
 *
 * On startup:
 *   1. Ensures Docker Desktop is running
 *   2. Starts Docker containers (PostgreSQL + Redis)
 *   3. Pushes DB schema
 *   4. Spawns NestJS backend
 *   5. Waits for /health to return 200
 *   6. Opens the HITL review UI window
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

let mainWindow = null;
let backendProcess = null;

const BACKEND_PORT = process.env.PORT || 3000;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on('ready', async () => {
  await startupSequence();
});

app.on('before-quit', async () => {
  await shutdownSequence();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC handlers (called from renderer)
// ---------------------------------------------------------------------------

ipcMain.handle('get-status', async () => ({
  apiRunning: await checkHealth(),
  backendPid: backendProcess?.pid || null,
}));

ipcMain.handle('start-engine', async () => {
  await startupSequence();
  return { success: true };
});

ipcMain.handle('stop-engine', async () => {
  await shutdownSequence();
  return { success: true };
});

ipcMain.handle('restart-engine', async () => {
  await shutdownSequence();
  await new Promise((r) => setTimeout(r, 2000));
  await startupSequence();
  return { success: true };
});

ipcMain.handle('open-logs', () => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Logs',
    message: 'Logs are written to the terminal that launched the app.\nRun from terminal to see full output.',
  });
});

// ---------------------------------------------------------------------------
// Startup sequence
// ---------------------------------------------------------------------------

async function startupSequence() {
  sendStatus('starting_infra', 'Starting infrastructure...');

  try {
    // 1. Ensure Docker containers are running
    execSync('docker compose -f docker-compose.infra.yml up -d', {
      cwd: path.join(__dirname, '../..'),
      stdio: 'pipe',
      timeout: 60_000,
    });
    sendStatus('infra_ready', 'PostgreSQL + Redis containers running');
  } catch (err) {
    sendStatus('error', 'Docker is not running. Please start Docker Desktop.');
    return;
  }

  await sleep(2000);

  // 2. Push DB schema
  try {
    sendStatus('running_migrations', 'Running database migrations...');
    execSync('yarn db:push', {
      cwd: path.join(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgresql://aigov:aigov123@localhost:5432/aigov' },
      stdio: 'pipe',
      timeout: 30_000,
    });
    sendStatus('migrations_done', 'Database schema applied');
  } catch {
    sendStatus('migrations_skipped', 'Migrations skipped (may already be applied)');
  }

  // 3. Spawn NestJS backend
  sendStatus('starting_api', 'Starting API service...');

  backendProcess = spawn('node', ['dist/main'], {
    cwd: path.join(__dirname, '../../apps/backend'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(BACKEND_PORT),
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
      DATABASE_URL: 'postgresql://aigov:aigov123@localhost:5432/aigov',
      AUDIT_MODE: 'sdk',                     // Desktop = no containers, use SDK
      DECOMP_MODE: 'inline',                 // Fast placeholder decomposition
      CORS_ORIGIN: 'http://localhost:5173',
    },
    stdio: 'pipe',
  });

  backendProcess.stdout.on('data', (d) => console.log(`[backend] ${d.toString().trim()}`));
  backendProcess.stderr.on('data', (d) => console.error(`[backend] ${d.toString().trim()}`));
  backendProcess.on('close', (code) => {
    console.log(`[backend] Process exited with code ${code}`);
    sendStatus('api_stopped', 'API service stopped');
  });

  // 4. Wait for health
  sendStatus('waiting_health', 'Waiting for API to be healthy...');
  const healthy = await waitForHealth(30_000);
  if (!healthy) {
    sendStatus('error', 'API did not start within 30 seconds. Check logs.');
    return;
  }

  sendStatus('connected', `API running on ${BACKEND_URL}`);

  // 5. Open the UI window
  if (!mainWindow) {
    createWindow();
  }
  mainWindow.loadFile('src/App.html');
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

async function shutdownSequence() {
  sendStatus('stopping', 'Stopping engine...');

  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    backendProcess = null;
    await sleep(3000);
  }

  sendStatus('stopped', 'Engine stopped. Docker containers remain running.');
}

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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendStatus(status, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', { status, message, timestamp: Date.now() });
  }
  console.log(`[status] ${status}: ${message}`);
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
    const ok = await checkHealth();
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
