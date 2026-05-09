// src/app/core/browser-capabilities.js
// Capability registry for gating UI and provider features.
// Publishes: window.AgentBrowserCapabilities

(() => {
  const model = String(
    document.getElementById('model-select')?.value ||
    (window.localBackend?.model || '') ||
    'unknown'
  ).trim();

  /* ── DOM / File APIs ──────────────────────────────────────────────────── */
  const fileInput = !!(window.showOpenFilePicker || document.createElement('input').type === 'file');
  const dragDrop = true; // always try; feature-detect in listener
  const pasteFiles = !!(navigator.clipboard || document.querySelector('textarea'));
  const fsAccess = !!window.showDirectoryPicker;

  /* ── Provider vision support heuristics ─────────────────────────────────── */
  function providerVision(modelName) {
    return /gemini|gpt-4|claude|llama.*vision|qwen.*vl|gemma.*vision/i.test(String(modelName));
  }

  window.AgentBrowserCapabilities = {
    fileInput,
    dragDrop,
    pasteFiles,
    fsAccess,
    clipboard: !!navigator.clipboard,
    notifications: 'Notification' in window,
    providerVision,
    model: () => String(
      document.getElementById('model-select')?.value ||
      (window.localBackend?.model || '') ||
      'unknown'
    ).trim()
  };
})();
