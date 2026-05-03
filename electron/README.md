# JS Agent — Electron Desktop App

This folder contains the Electron wrapper that turns the JS Agent web UI into a native desktop application.

## Architecture

- **`electron/main.js`** — Electron main process. Starts the embedded `proxy/dev-server.js` as a child process, then loads the UI via `http://localhost:<port>`.
- **`electron/preload.js`** — Secure preload script exposing a minimal `window.electronAPI` to the renderer.

The frontend code in `src/` and `index.html` requires **zero changes** — all API calls (`/api/env`, `/api/terminal`, etc.) continue to work because the UI is loaded over HTTP against the embedded server.

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Run in development

```bash
npm run electron
```

This starts the embedded server on a random free port and opens the Electron window. DevTools are auto-opened in development.

### 3. Build for production

```bash
npm run electron:build
```

Outputs per-platform installers to `dist-electron/`:

| Platform | Output |
|----------|--------|
| Windows  | `.exe` (NSIS installer) + portable `.exe` |
| macOS    | `.dmg` + `.zip` |
| Linux    | `.AppImage` + `.deb` |

## Native APIs exposed to renderer

The preload script exposes `window.electronAPI`:

| Method | Description |
|--------|-------------|
| `getAppVersion()` | Returns the app version string |
| `openFileDialog(options)` | Native file-open dialog |
| `saveFileDialog(options)` | Native save-file dialog |
| `openPath(filePath)` | Open a file/folder with the default system app |
| `openExternal(url)` | Open a URL in the system default browser |

Example usage from frontend JS:

```javascript
if (window.electronAPI) {
  const result = await window.electronAPI.openFileDialog({
    properties: ['openFile'],
    filters: [{ name: 'Text', extensions: ['txt'] }]
  });
  if (!result.canceled) {
    console.log('Selected:', result.filePaths[0]);
  }
}
```

## Security notes

- `contextIsolation: true` and `nodeIntegration: false` are enforced.
- All native access goes through the preload script's `contextBridge`.
- External links are forced to open in the system browser, not inside Electron.
- The embedded server only binds to `127.0.0.1` (localhost) and is not reachable from other machines.
