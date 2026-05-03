// electron/main.js
// Electron main process entry for JS Agent desktop app.

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const isDev = !app.isPackaged;

let mainWindow;
let serverProcess;
let serverPort = null;

/**
 * Start the embedded dev server and capture its assigned port.
 * @returns {Promise<number>}
 */
function startEmbeddedServer() {
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
        serverProcess.stdout.off('data', onStdout);
        resolve(port);
      }
    };

    serverProcess.stdout.on('data', onStdout);

    serverProcess.stderr.on('data', (data) => {
      console.error(`[server] ${data.toString().trim()}`);
    });

    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      if (!serverPort) {
        reject(new Error(`Server exited with code ${code} before binding to a port`));
      }
    });

    // Safety timeout
    setTimeout(() => {
      if (!serverPort) {
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

  // Open external links in the system browser, not inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost')) {
      event.preventDefault();
      shell.openExternal(url);
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
