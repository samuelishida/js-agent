// src/app/core/provider-state.js
// Model routing, provider activation, cloud readiness, backend state.

/**
 * Get max rounds from slider.
 * @returns {number} Max rounds
 */
function getMaxRounds() {
  const el = document.getElementById('sl-rounds');
  return el ? parseInt(el.value, 10) : 50;
}

/**
 * Get context limit from slider.
 * @returns {number} Context limit in chars
 */
function getCtxLimit() {
  const el = document.getElementById('sl-ctx');
  return el ? parseInt(el.value, 10) * 1000 : 128000;
}

/**
 * Get delay from slider.
 * @returns {number} Delay in ms
 */
function getDelay() {
  const el = document.getElementById('sl-delay');
  return el ? parseInt(el.value, 10) : 500;
}

/**
 * Get stored cloud model selection.
 * @returns {string} Model ID
 */
function getStoredCloudModelSelection() {
  return localStorage.getItem('agent_cloud_model') || 'gemini/gemini-2.5-flash';
}

/**
 * Get selected cloud model label.
 * @returns {string} Model label
 */
function getSelectedCloudModelLabel() {
  const raw = String(document.getElementById('model-select')?.value || getStoredCloudModelSelection()).trim();
  return raw || 'gemini/gemini-2.5-flash';
}

/**
 * Activate cloud provider.
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.silent=false] - Silent mode
 * @param {string} [opts.reason=''] - Reason
 * @returns {void}
 */
function activateCloudProvider({ silent = false, reason = '' } = {}) {
  const switchedFromLocal = !!localBackend.enabled;
  const switchedFromOllama = !!(typeof ollamaBackend !== 'undefined' && ollamaBackend.enabled);

  localBackend.enabled = false;
  localStorage.setItem('agent_prefer_local_backend', 'false');
  const localToggle = document.getElementById('toggle-local');
  if (localToggle) {
    localToggle.checked = false;
    localToggle.classList.remove('active');
  }

  if (typeof ollamaBackend !== 'undefined') {
    ollamaBackend.enabled = false;
    localStorage.setItem('agent_ollama_enabled', 'false');
    const ollamaToggle = document.getElementById('toggle-ollama');
    if (ollamaToggle) ollamaToggle.checked = false;
  }

  if (typeof updateBadge === 'function') updateBadge();
  if (typeof updateActiveProviderBadge === 'function') updateActiveProviderBadge();

  if (!silent && typeof addNotice === 'function' && (switchedFromLocal || switchedFromOllama)) {
    const detail = reason ? ` ${reason}` : '';
    addNotice(`Cloud provider activated.${detail}`.trim());
  }
}

/**
 * Save API key.
 * @returns {void}
 */
function saveKey() {
  window.apiKey = document.getElementById('api-key').value.trim();
  localStorage.setItem('cloud_api_key', window.apiKey);
  localStorage.setItem('gemini_api_key', window.apiKey);
  if (window.apiKey) {
    activateCloudProvider({ silent: true, reason: 'Using cloud API key for requests.' });
  }
  if (typeof setStatus === 'function') setStatus('ok', 'key saved');
  if (typeof maybeRequestNotifPermission === 'function') maybeRequestNotifPermission();
}

/**
 * Save cloud model selection.
 * @returns {void}
 */
function saveCloudModelSelection() {
  const select = document.getElementById('model-select');
  const model = String(select?.value || '').trim();
  if (model) localStorage.setItem('agent_cloud_model', model);
  else localStorage.removeItem('agent_cloud_model');
  activateCloudProvider({ silent: true, reason: `Switched to ${model || 'cloud model'}.` });
  if (typeof updateActiveProviderBadge === 'function') updateActiveProviderBadge();
}

/**
 * Load cloud model selection.
 * @returns {void}
 */
function loadCloudModelSelection() {
  const select = document.getElementById('model-select');
  if (!select) return;
  const saved = getStoredCloudModelSelection();
  const existing = Array.from(select.options).find(option => option.value === saved);
  if (existing) select.value = saved;
  else if (!select.value && select.options.length) select.selectedIndex = 0;
  if (typeof updateActiveProviderBadge === 'function') updateActiveProviderBadge();
}

/**
 * Check if local mode is active.
 * @returns {boolean} True if local
 */
function isLocalModeActive() {
  if (typeof ollamaBackend !== 'undefined' && ollamaBackend.enabled) return true;
  return localBackend.enabled && !!localBackend.url;
}

/**
 * Check if Ollama is ready.
 * @returns {{ready: boolean, reason: string}} Readiness status
 */
function isOllamaReady() {
  if (typeof ollamaBackend === 'undefined' || !ollamaBackend.enabled) return { ready: false, reason: '' };
  const isCloud = typeof isSelectedOllamaModelCloud === 'function' && isSelectedOllamaModelCloud();
  if (isCloud) {
    const key = typeof getOllamaCloudApiKey === 'function' ? getOllamaCloudApiKey() : '';
    if (!key) return { ready: false, reason: '\u2601 Ollama Cloud model selected \u2014 enter your Ollama API key in Settings \u2192 Ollama and click Save.' };
  }
  return { ready: true, reason: '' };
}

/**
 * Get selected cloud provider.
 * @returns {string} Provider name
 */
function getSelectedCloudProvider() {
  const raw = String(document.getElementById('model-select')?.value || '').trim().toLowerCase();
  if (!raw) return 'gemini';
  const match = raw.match(/^([a-z0-9_-]+)\//i);
  return match ? String(match[1] || 'gemini').toLowerCase() : 'gemini';
}

/**
 * Get cloud readiness status.
 * @returns {{ready: boolean, reason: string}} Readiness status
 */
function getCloudReadiness() {
  const provider = getSelectedCloudProvider();
  if (provider === 'azure') {
    if (!window.apiKey) return { ready: false, reason: 'Azure OpenAI requires an API key. Enter your key and click Save.' };
    const endpoint = String(localStorage.getItem('agent_azure_openai_endpoint') || '').trim();
    const deployment = String(localStorage.getItem('agent_azure_openai_deployment') || '').trim();
    if (!endpoint || !deployment) return { ready: false, reason: 'Azure OpenAI configuration missing. Set localStorage keys: agent_azure_openai_endpoint and agent_azure_openai_deployment.' };
    return { ready: true, reason: '' };
  }
  if (typeof openrouterBackend !== 'undefined' && openrouterBackend.enabled && openrouterBackend.apiKey) {
    return { ready: true, reason: '' };
  }
  if (!window.apiKey) {
    const providerLabel = provider === 'openai' ? 'OpenAI' : provider === 'clawd' ? 'Clawd' : 'Cloud';
    return { ready: false, reason: `${providerLabel} requires an API key. Enter your key and click Save.` };
  }
  return { ready: true, reason: '' };
}

/**
 * Check if cloud can be used.
 * @returns {boolean} True if ready
 */
function canUseCloud() {
  return getCloudReadiness().ready;
}

window.AgentProviderState = {
  getMaxRounds,
  getCtxLimit,
  getDelay,
  getStoredCloudModelSelection,
  getSelectedCloudModelLabel,
  activateCloudProvider,
  saveKey,
  saveCloudModelSelection,
  loadCloudModelSelection,
  isLocalModeActive,
  isOllamaReady,
  getSelectedCloudProvider,
  getCloudReadiness,
  canUseCloud
};
