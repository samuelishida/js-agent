// electron/main.js
// Electron main process entry for JS Agent desktop app.

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// ── Single instance lock ───────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[main] Another instance already running; quitting.');
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const PROJECT_ROOT = isDev
  ? path.resolve(__dirname, '..')
  : path.resolve(__dirname, '..', '..', 'app.asar.unpacked');
const STATIC_ROOT = isDev ? PROJECT_ROOT : app.getAppPath();
const RUNTIME_ROOT = isDev ? PROJECT_ROOT : path.join(app.getAppPath(), '..', 'app.asar.unpacked');

// ── Portable userData ──────────────────────────────────────────────────────
// Persist Electron profile data beside the portable exe (not in %APPDATA%).
// This ensures localStorage, IndexedDB, etc. travel with the portable app.

function resolvePortableUserDataDir() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) {
    return path.join(portableDir, 'JS Agent Data');
  }
  if (!isDev) {
    const exeDir = path.dirname(app.getPath('exe'));
    return path.join(exeDir, 'JS Agent Data');
  }
  return null; // dev mode: use Electron default
}

const portableDataDir = resolvePortableUserDataDir();
if (portableDataDir) {
  fs.mkdirSync(portableDataDir, { recursive: true });
  app.setPath('userData', portableDataDir);
  console.log(`[main] portable mode: userData → ${portableDataDir}`);
} else {
  console.log(`[main] dev mode: userData → ${app.getPath('userData')}`);
}

// ── Stable port selection ──────────────────────────────────────────────────
// Using PORT=0 gives a random port each launch → different origin →
// Chromium scopes localStorage per origin → app "forgets" state on relaunch.
// Prefer a deterministic port in the 5500..5510 range; persist the chosen port.

const PORT_RANGE = [5500, 5501, 5502, 5503, 5504, 5505, 5506, 5507, 5508, 5509, 5510];
const PORT_PREFS_FILENAME = '.electron-port';

function getPortPrefsPath() {
  return path.join(app.getPath('userData'), PORT_PREFS_FILENAME);
}

function readPreferredElectronPort() {
  try {
    const raw = fs.readFileSync(getPortPrefsPath(), 'utf-8').trim();
    const port = Number(raw);
    if (Number.isInteger(port) && port >= 5500 && port <= 5510) return port;
  } catch { /* file missing or invalid */ }
  return null;
}

function writePreferredElectronPort(port) {
  try {
    fs.writeFileSync(getPortPrefsPath(), String(port), 'utf-8');
  } catch (err) {
    console.warn(`[main] could not persist preferred port: ${err.message}`);
  }
}

function getElectronPortCandidates() {
  const preferred = readPreferredElectronPort();
  if (preferred) {
    return [preferred, ...PORT_RANGE.filter(p => p !== preferred)];
  }
  return [...PORT_RANGE];
}

/**
 * Check if a port is available by attempting to listen on it.
 * Returns true if the port is free, false if EADDRINUSE.
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const net = require('node:net');
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(false);
      else resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort() {
  const candidates = isDev
    ? [0] // dev mode: random port is fine (separate dev server)
    : getElectronPortCandidates();

  for (const port of candidates) {
    if (port === 0) return { port: 0, stable: false };
    if (await isPortAvailable(port)) {
      return { port, stable: true };
    }
    console.log(`[main] port ${port} in use, trying next candidate`);
  }

  // All stable candidates taken; fall back to OS-assigned random port
  console.warn('[main] WARNING: all stable ports (5500-5510) in use; falling back to random port.');
  console.warn('[main] localStorage may not persist across launches with different origins.');
  return { port: 0, stable: false };
}

// ── Server management ───────────────────────────────────────────────────────

let mainWindow;
let serverProcess;
let serverPort = null;
let serverStarting = false;
let chosenPortInfo = null; // { port, stable } once resolved

function isSafeExternalUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Start the embedded dev server and capture its assigned port.
 * Guards against double-start and clears state on unexpected exit.
 * In production, spawns Electron with ELECTRON_RUN_AS_NODE=1 so it behaves as Node.js.
 * @returns {Promise<number>}
 */
function startEmbeddedServer(portToUse) {
  if (serverStarting || serverPort) {
    return serverPort
      ? Promise.resolve(serverPort)
      : Promise.reject(new Error('Server already starting'));
  }
  serverStarting = true;

  return new Promise((resolve, reject) => {
    const serverPath = path.join(PROJECT_ROOT, 'proxy', 'dev-server.js');
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(portToUse),
      STATIC_ROOT: STATIC_ROOT,
      RUNTIME_ROOT: RUNTIME_ROOT
    };

    serverProcess = spawn(process.execPath, [serverPath], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderrBuffer = '';

    const onStdout = (data) => {
      const text = data.toString();
      console.log(`[server] ${text.trim()}`);
      const match = text.match(/\[dev-server\] running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        const port = Number(match[1]);
        serverPort = port;
        serverStarting = false;
        serverProcess.stdout.off('data', onStdout);
        resolve(port);
      }
    };

    serverProcess.stdout.on('data', onStdout);

    serverProcess.stderr.on('data', (data) => {
      const text = data.toString();
      stderrBuffer += text;
      console.error(`[server] ${text.trim()}`);
    });

    serverProcess.on('error', (err) => {
      serverStarting = false;
      serverProcess = null;
      reject(err);
    });

    serverProcess.on('exit', (code) => {
      serverStarting = false;
      serverProcess = null;
      const hadPort = serverPort;
      serverPort = null;
      if (!hadPort) {
        const stderrHint = stderrBuffer ? ` Stderr: ${stderrBuffer.slice(0, 200)}` : '';
        reject(new Error(`Server exited with code ${code} before binding to a port.${stderrHint}`));
      }
    });

    // Safety timeout
    setTimeout(() => {
      if (!serverPort) {
        serverStarting = false;
        if (serverProcess) {
          serverProcess.kill();
          serverProcess = null;
        }
        const stderrHint = stderrBuffer ? ` Stderr: ${stderrBuffer.slice(0, 200)}` : '';
        reject(new Error(`Server failed to start within 15 seconds.${stderrHint}`));
      }
    }, 15000);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'JS Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools();
  });

  const loadUrl = async () => {
    try {
      if (serverStarting) {
        dialog.showErrorBox('Server Busy', 'Embedded server is already starting. Please wait a moment and try again.');
        app.quit();
        return;
      }
      if (serverPort) {
        const url = `http://127.0.0.1:${serverPort}`;
        console.log(`[main] loading ${url}`);
        mainWindow.loadURL(url);
        return;
      }

      chosenPortInfo = await findAvailablePort();
      const port = await startEmbeddedServer(chosenPortInfo.port);

      if (chosenPortInfo.stable && chosenPortInfo.port !== 0) {
        writePreferredElectronPort(chosenPortInfo.port);
      }

      const url = `http://127.0.0.1:${port}`;
      console.log(`[main] loading ${url} (stable: ${chosenPortInfo.stable})`);
      mainWindow.loadURL(url);
    } catch (err) {
      console.error('Failed to start embedded server:', err);
      dialog.showErrorBox('Server Error', err.message);
      app.quit();
    }
  };
  loadUrl();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) shell.openExternal(url);
    }
  });
}

// ── Filename sanitization ───────────────────────────────────────────────────

function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'unnamed';
  let safe = path.basename(name);
  safe = safe.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
  if (reserved.test(safe)) safe = `_${safe}`;
  safe = safe.replace(/^\.+/, '_').replace(/\.+$/, '').trim();
  if (!safe) safe = 'unnamed';
  return safe;
}

function uniqueFilePath(dir, base) {
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  let candidate = path.join(dir, base);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n++;
    if (n > 200) break;
  }
  return candidate;
}

function getGeneratedFilesDir() {
  const dir = path.join(app.getPath('userData'), 'Generated Files');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── IPC handlers ───────────────────────────────────────────────────────────

ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('app:get-generated-files-dir', () => getGeneratedFilesDir());

ipcMain.handle('app:save-bytes', async (_event, { filename, base64, mimeType }) => {
  const safeName = sanitizeFilename(filename || 'unnamed.bin');
  const dir = getGeneratedFilesDir();
  const filePath = uniqueFilePath(dir, safeName);
  const buffer = Buffer.from(base64, 'base64');
  fs.writeFileSync(filePath, buffer);
  return { path: filePath, name: safeName, size: buffer.length };
});

ipcMain.handle('dialog:open-file', async (_event, options = {}) => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    ...options
  });
  return result;
});

ipcMain.handle('dialog:save-file', async (_event, options = {}) => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

ipcMain.handle('shell:open-path', async (_event, filePath) => {
  await shell.openPath(filePath);
});

ipcMain.handle('shell:open-external', async (_event, url) => {
  if (!isSafeExternalUrl(url)) throw new Error('Unsafe URL protocol');
  await shell.openExternal(url);
});

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});