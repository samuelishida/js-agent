// src/app/core/electron-file-save.js
// Shared helper: save generated artifacts via Electron IPC when available,
// fall back to browser Blob URL download otherwise.

(() => {
  function isElectron() {
    return !!(window.electronAPI && window.electronAPI.saveBytes);
  }

  async function saveGeneratedArtifact({ name, mimeType, base64 }) {
    if (isElectron()) {
      try {
        const result = await window.electronAPI.saveBytes({
          filename: name,
          base64: base64,
          mimeType: mimeType || 'application/octet-stream'
        });
        await window.electronAPI.openPath(pathDir(result.path));
        return { mode: 'electron', path: result.path, name: result.name, size: result.size };
      } catch (err) {
        console.warn('[electron-file-save] IPC saveBytes failed, falling back to Blob download:', err);
      }
    }
    return blobDownload({ name, mimeType, base64 });
  }

  function pathDir(p) {
    const sep = p.includes('/') ? '/' : '\\';
    const parts = p.split(sep);
    parts.pop();
    return parts.join(sep) || (sep === '/' ? '/' : 'C:\\');
  }

  function blobDownload({ name, mimeType, base64 }) {
    const bytes = base64ToUint8Array(base64);
    const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { mode: 'browser', name, size: bytes.length };
  }

  function base64ToUint8Array(b64) {
    const binaryStr = atob(String(b64 || ''));
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    return bytes;
  }

  async function getGeneratedFilesDir() {
    if (isElectron()) {
      try { return await window.electronAPI.getGeneratedFilesDir(); } catch {}
    }
    return null;
  }

  window.ElectronFileSave = { isElectron, saveGeneratedArtifact, getGeneratedFilesDir, blobDownload };
})();