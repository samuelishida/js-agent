// src/app/app-init.js
// Application bootstrap and initialization.

/** @type {boolean} */
let extensionChannelWarningShown = false;

/**
 * Install a guard that suppresses benign extension channel warnings.
 * @returns {void}
 */
function installUnhandledRejectionGuard() {
  if (/** @type {any} */ (window).__agentUnhandledRejectionGuardInstalled) return;
  /** @type {any} */ (window).__agentUnhandledRejectionGuardInstalled = true;

  window.addEventListener('unhandledrejection', event => {
    const message = String(event?.reason?.message || event?.reason || '');
    const isExtensionChannelClose = /A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received/i.test(message);
    if (!isExtensionChannelClose) return;

    event.preventDefault();
    if (extensionChannelWarningShown) return;
    extensionChannelWarningShown = true;
    addNotice('Ignored extension async response warning from browser message channel.');
  });
}

/**
 * Slider definition for UI initialization.
 * @typedef {Object} SliderDef
 * @property {string} id - Slider element id
 * @property {string} valId - Value display element id
 * @property {string} key - localStorage key
 */

/**
 * Initialize the application on DOM ready.
 * @returns {void}
 */
document.addEventListener('DOMContentLoaded', () => {
  installUnhandledRejectionGuard();
  applySidebarState();
  window.addEventListener('resize', handleResponsiveSidebar);

  /** @type {SliderDef[]} */
  const sliderDefs = [
    { id: 'sl-rounds', valId: 'val-rounds', key: 'agent_sl_rounds' },
    { id: 'sl-ctx',    valId: 'val-ctx',    key: 'agent_sl_ctx'    },
    { id: 'sl-delay',  valId: 'val-delay',  key: 'agent_sl_delay'  }
  ];
  for (const def of sliderDefs) {
    try {
      const stored = localStorage.getItem(def.key);
      if (stored !== null) {
        const sl = document.getElementById(def.id);
        const vl = document.getElementById(def.valId);
        if (sl) /** @type {HTMLInputElement} */ (sl).value = stored;
        if (vl) vl.textContent = stored;
      }
    } catch {}
  }

  updateBadge();
  updateStats();
  updateCtxBar();

  if (!runtimeReady()) {
    setStatus('error', 'bootstrap failed');
    addNotice('ERROR: required modules did not load. Check the browser console and reload the page.');
    return;
  }

  window.chatSessions = loadSessions();
  initCacheSync();
  initBusySync();
  updateFileAccessStatus();
  loadGithubTokenStatus();
  if (typeof loadCloudModelSelection === 'function') loadCloudModelSelection();
  if (typeof loadOllamaBackendState === 'function') loadOllamaBackendState();
  if (typeof loadOpenRouterBackendState === 'function') loadOpenRouterBackendState();

  // Fetch server env: terminal token + OpenRouter key availability flag.
  // The actual API key is never sent to the browser; the server proxies via /api/openrouter.
  try {
    fetch('/api/env')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        // Store terminal auth token for use in /api/terminal requests
        if (data.terminalToken) {
          /** @type {any} */ (window).__terminalToken = data.terminalToken;
        }
        // If server has OpenRouter key, activate proxy mode (no local key needed)
        if (data.hasOpenRouterKey && !openrouterBackend.apiKey) {
          /** @type {any} */ (window).__serverHasOpenRouterKey = true;
          // Enable openrouter backend pointing at the local proxy
          if (!openrouterBackend.enabled) {
            openrouterBackend.enabled = true;
            openrouterBackend.apiKey = '__proxy__'; // sentinel — not a real key
          }
          updateOpenRouterStatus?.();
          console.log('[Agent] Server has OpenRouter key; using /api/openrouter proxy');
        }
      })
      .catch(() => {});
  } catch {}

  // Discover and register MCP server tools (non-blocking; failures are logged only)
  /** @type {any} */ (window).AgentMcpBridge?.discoverAndRegisterMcpTools?.().catch(() => {});

  // Auto-load built-in skills (methodology/expertise .md files)
  if (window.AgentSkillLoader) {
    window.AgentSkillLoader.registerSkillsFromManifest('src/skills/skills-manifest.json')
      .then(results => {
        const loaded = results.filter(Boolean);
        if (loaded.length) {
          console.log(`[Agent] Loaded ${loaded.length} skills: ${loaded.map(s => s.name).join(', ')}`);
        }
      })
      .catch(() => {});
  }

  if (!window.chatSessions.length) createSession();
  if (!getActiveSession()) window.activeSessionId = window.chatSessions[0]?.id || createSession().id;
  renderSessionList();
  if (typeof loadPersistedEnabledTools === 'function') loadPersistedEnabledTools();
  renderToolGroups();
  activateSession(window.activeSessionId);
  if (window.apiKey) {
    document.getElementById('api-key').value = window.apiKey;
    setStatus('ok', 'key set');
  }
  if (window.localBackend?.url) {
    document.getElementById('local-url').value = window.localBackend.url;
    if (window.localBackend.model) {
      const sel = document.getElementById('local-model-select');
      sel.innerHTML = `<option value="${window.localBackend.model}">${window.localBackend.model}</option>`;
      /** @type {HTMLSelectElement} */ (sel).value = window.localBackend.model;
      document.getElementById('local-model-row').style.display = 'block';

      sel?.addEventListener('change', function() {
        const model = /** @type {HTMLSelectElement} */ (this).value;
        if (model) {
          window.localBackend.model = model;
          localStorage.setItem('agent_local_backend_model', model);
          updateModelBadgeForLocal(model);
          updateBadge();
        }
      });
    }
    if (window.localBackend.enabled) {
      _activateLocal(true);
    }
  }
  if (window.ollamaBackend?.enabled) {
    console.debug('[Agent] Skipping local backend probe \u2014 Ollama is active');
  } else {
    probeLocal().catch(error => {
      const message = String(error?.message || 'probe failed');
      console.warn('[Local Probe] startup probe failed:', message);
    });
  }
  window.addEventListener('beforeunload', flushSaveSessions);
  setStopButtonState(false);
});