let extensionChannelWarningShown = false;

function installUnhandledRejectionGuard() {
  if (window.__agentUnhandledRejectionGuardInstalled) return;
  window.__agentUnhandledRejectionGuardInstalled = true;

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

document.addEventListener('DOMContentLoaded', () => {
  installUnhandledRejectionGuard();
  applySidebarState();
  window.addEventListener('resize', handleResponsiveSidebar);

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
        if (sl) sl.value = stored;
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

  // Auto-detect OPEN_ROUTER_API_KEY from server env and pre-fill if available
  try {
    fetch('/api/env')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.OPEN_ROUTER_API_KEY && !openrouterBackend.apiKey) {
          openrouterBackend.apiKey = data.OPEN_ROUTER_API_KEY;
          localStorage.setItem('agent_openrouter_api_key', data.OPEN_ROUTER_API_KEY);
          const input = document.getElementById('openrouter-api-key');
          if (input) input.value = data.OPEN_ROUTER_API_KEY;
          updateOpenRouterStatus();
          console.log('[Agent] Auto-loaded OPEN_ROUTER_API_KEY from server env');
        }
      })
      .catch(() => {});
  } catch {}

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
      sel.value = window.localBackend.model;
      document.getElementById('local-model-row').style.display = 'block';

      sel?.addEventListener('change', function() {
        const model = this.value;
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