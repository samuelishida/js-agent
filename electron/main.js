// electron/main.js
// Electron main process entry for JS Agent desktop app.

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── Single instance lock ───────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[main] Another instance already running; quitting.');
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  // Focus existing window when user tries to launch again
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

let mainWindow;
let serverProcess;
let serverPort = null;
let serverStarting = false;

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
 * @returns {Promise<number>}
 */
function startEmbeddedServer() {
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
      PORT: '0',               // let OS assign a free port
      ROOT: PROJECT_ROOT        // ensure server resolves paths correctly
    };

    serverProcess = spawn(process.execPath, [serverPath], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const onStdout = (data) => {
      const text = data.toString();
      console.log(`[server] ${text.trim()}`);
      // dev-server.js logs "Server running on http://localhost:PORT"
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
      console.error(`[server] ${data.toString().trim()}`);
    });

    serverProcess.on('error', (err) => {
      serverStarting = false;
      serverProcess = null;
      reject(err);
    });

    serverProcess.on('exit', (code) => {
      serverStarting = false;
      serverProcess = null;
      serverPort = null;
      if (!serverPort) {
        reject(new Error(`Server exited with code ${code} before binding to a port`));
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
        reject(new Error('Server failed to start within 15 seconds'));
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
    show: false // show once ready-to-show to avoid white flash
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools();
  });

  // Load the app
  if (isDev) {
    // In dev, assume the user already ran `npm start` or we start the server ourselves
    const loadUrl = async () => {
      try {
        if (serverStarting) {
          dialog.showErrorBox('Server Busy', 'Embedded server is already starting. Please wait a moment and try again.');
          app.quit();
          return;
        }
        if (serverPort) {
          mainWindow.loadURL(`http://localhost:${serverPort}`);
          return;
        }
        const port = await startEmbeddedServer();
        mainWindow.loadURL(`http://localhost:${port}`);
      } catch (err) {
        console.error('Failed to start embedded server:', err);
        dialog.showErrorBox('Server Error', err.message);
        app.quit();
      }
    };
    loadUrl();
  } else {
    // Production: always start the embedded server
    if (serverStarting) {
      dialog.showErrorBox('Server Busy', 'Embedded server is already starting. Please wait a moment and try again.');
      app.quit();
      return;
    }
    if (serverPort) {
      mainWindow.loadURL(`http://localhost:${serverPort}`);
    } else {
      startEmbeddedServer()
        .then((port) => {
          mainWindow.loadURL(`http://localhost:${port}`);
        })
        .catch((err) => {
          console.error('Failed to start embedded server:', err);
          dialog.showErrorBox('Server Error', err.message);
          app.quit();
        });
    }
  }

  // Open external links in the system browser, not inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost')) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) shell.openExternal(url);
    }
  });
}

// ── IPC handlers ───────────────────────────────────────────────────────────

ipcMain.handle('app:get-version', () => app.getVersion());

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
