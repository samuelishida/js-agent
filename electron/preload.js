// electron/preload.js
// Secure preload script exposing a minimal API to the renderer.
// Must use require() — sandboxed preload does NOT support ES module syntax.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getGeneratedFilesDir: () => ipcRenderer.invoke('app:get-generated-files-dir'),
  saveBytes: (opts) => ipcRenderer.invoke('app:save-bytes', opts),
  openFileDialog: (options) => ipcRenderer.invoke('dialog:open-file', options),
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:save-file', options),
  openPath: (filePath) => ipcRenderer.invoke('shell:open-path', filePath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url)
});
