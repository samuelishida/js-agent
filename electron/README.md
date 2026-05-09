# JS Agent — Electron Desktop App

Electron wrapper for JS Agent web UI. Frontend requires zero changes.

## Architecture

- `electron/main.js` — Main process. Starts embedded `proxy/dev-server.js`, loads UI via `http://localhost:<port>`
- `electron/preload.js` — Secure preload script. Exposes minimal `window.electronAPI` to renderer

All API calls (`/api/env`, `/api/terminal`, etc.) work because UI loaded over HTTP against embedded server.

## Quick Start

```bash
npm install
npm run electron          # dev mode (auto-opens DevTools)
npm run electron:build    # build production installers
```

Output per-platform:

| Platform | Output |
|----------|--------|
| Windows  | `.exe` (NSIS) + portable `.exe` |
| macOS    | `.dmg` + `.zip` |
| Linux    | `.AppImage` + `.deb` |

## Native APIs

Preload script exposes `window.electronAPI`:

| Method | Description |
|--------|-------------|
| `getAppVersion()` | App version string |
| `openFileDialog(options)` | Native file-open dialog |
| `saveFileDialog(options)` | Native save-file dialog |
| `openPath(filePath)` | Open file/folder with default system app |
| `openExternal(url)` | Open URL in system default browser |

Example:

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

## Security

- `contextIsolation: true`, `nodeIntegration: false`
- All native access through preload script `contextBridge`
- External links forced to system browser, not inside Electron
- Embedded server binds to `127.0.0.1` only
