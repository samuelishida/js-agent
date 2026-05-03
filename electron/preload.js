// electron/preload.js
// Secure preload script exposing a minimal API to the renderer.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Get the Electron app version.
   * @returns {Promise<string>}
   */
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),

  /**
   * Show a native open-file dialog.
   * @param {import('electron').OpenDialogOptions} [options]
   * @returns {Promise<import('electron').OpenDialogReturnValue>}
   */
  openFileDialog: (options) => ipcRenderer.invoke('dialog:open-file', options),

  /**
   * Show a native save-file dialog.
   * @param {import('electron').SaveDialogOptions} [options]
   * @returns {Promise<import('electron').SaveDialogReturnValue>}
   */
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:save-file', options),

  /**
   * Open a path in the default system application.
   * @param {string} filePath
   * @returns {Promise<void>}
   */
  openPath: (filePath) => ipcRenderer.invoke('shell:open-path', filePath),

  /**
   * Open a URL in the system default browser.
   * @param {string} url
   * @returns {Promise<void>}
   */
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url)
});
