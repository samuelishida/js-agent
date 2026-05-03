// src/app/llm/local-backend.js
// Local backend probing and model discovery.

/** @type {Array<{port: number, paths: string[], name: string, chatPath: string}>} */
const LOCAL_CANDIDATES = [
  { port: 1234,  paths: ['/v1/models'], name: 'LM Studio', chatPath: '/v1/chat/completions' },
  { port: 8080,  paths: ['/v1/models'], name: 'llama.cpp', chatPath: '/v1/chat/completions' },
  { port: 5000,  paths: ['/v1/models'], name: 'generic',   chatPath: '/v1/chat/completions' },
];

/**
 * Fetch with timeout.
 * @param {string} url - URL to fetch
 * @param {Object} [options={}] - Fetch options
 * @param {number} [timeoutMs=5000] - Timeout in ms
 * @returns {Promise<Response>} Fetch response
 */
function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const mergedSignal = options.signal;
  if (mergedSignal) {
    if (mergedSignal.aborted) { clearTimeout(timer); return Promise.reject(new Error('Aborted')); }
    mergedSignal.addEventListener('abort', () => { clearTimeout(timer); controller.abort(); }, { once: true });
  }
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

window.fetchWithTimeout = fetchWithTimeout;

/**
 * Deduplicate probe targets.
 * @param {Array<{url: string}>} targets - Targets
 * @returns {Array<{url: string}>} Unique targets
 */
function uniqueTargets(targets) {
  const seen = new Set();
  return targets.filter(t => {
    const key = t.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Infer probe config from URL.
 * @param {string} url - Backend URL
 * @returns {{paths: string[], chatPath: string, name: string}} Probe config
 */
function inferProbeConfigFromUrl(url) {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const looksLikeOllama = /ollama/i.test(`${parsed.hostname}${parsed.pathname}`);

    if (port === '11434' || looksLikeOllama) {
      return { paths: ['/api/tags', '/v1/models'], chatPath: '/api/chat', name: 'custom/ollama' };
    }

    return { paths: ['/v1/models', '/api/tags'], chatPath: '/v1/chat/completions', name: 'custom/openai' };
  } catch {
    return { paths: ['/v1/models', '/api/tags'], chatPath: '/v1/chat/completions', name: 'custom' };
  }
}

/**
 * Normalize probe URL.
 * @param {string} rawUrl - Raw URL
 * @returns {string} Normalized URL
 */
function normalizeProbeUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return '';

  const withScheme = /^https?:\/\//i.test(input) ? input : `http://${input}`;

  try {
    const parsed = new URL(withScheme);
    const pathname = String(parsed.pathname || '').replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return input.replace(/\/+$/, '');
  }
}

/**
 * Get probe targets for local backend.
 * @param {string} [manualUrl] - Manual URL
 * @returns {Array<{url: string, paths: string[], chatPath: string, name: string}>} Targets
 */
function getProbeTargets(manualUrl) {
  const candidateTargets = LOCAL_CANDIDATES.map(candidate => ({
    ...candidate,
    url: `http://localhost:${candidate.port}`
  }));

  const normalizedManual = normalizeProbeUrl(manualUrl);

  if (!normalizedManual) return candidateTargets;

  return uniqueTargets([
    {
      url: normalizedManual,
      ...inferProbeConfigFromUrl(normalizedManual)
    },
    ...candidateTargets
  ]);
}

/**
 * Extract models from probe payload.
 * @param {any} data - Payload data
 * @returns {string[]} Model names
 */
function extractModelsFromPayload(data) {
  const out = [];

  if (Array.isArray(data?.data)) {
    data.data.forEach(model => {
      if (typeof model === 'string' && model.trim()) {
        out.push(model.trim());
        return;
      }
      const value = model?.id || model?.name || model?.model;
      if (typeof value === 'string' && value.trim()) out.push(value.trim());
    });
  }

  if (Array.isArray(data?.models)) {
    data.models.forEach(model => {
      if (typeof model === 'string' && model.trim()) {
        out.push(model.trim());
        return;
      }
      const value = model?.name || model?.model || model?.id;
      if (typeof value === 'string' && value.trim()) out.push(value.trim());
    });
  }

  return [...new Set(out)];
}

/**
 * Probe local backends for available models.
 * @returns {Promise<void>}
 */
async function probeLocal() {
  if (typeof maybeRequestNotifPermission === 'function') {
    maybeRequestNotifPermission();
  }

  if (typeof ollamaBackend !== 'undefined' && ollamaBackend.enabled) {
    setLocalStatus('error', 'Ollama is active — disable it first to use a local backend');
    return;
  }

  const manualUrl = document.getElementById('local-url').value.trim();
  setLocalStatus('busy', 'probing…');

  const targets = getProbeTargets(manualUrl);

  for (const target of targets) {
    const baseUrl = target.url.replace(/\/+$/, '');
    const pathsToTry = target.paths || ['/v1/models'];
    let isReachable = false;
    const discoveredModels = new Set();

    for (const p of pathsToTry) {
      try {
        const timeoutMs = p === '/api/tags' ? 4000 : 2000;
        const probeUrl = new URL(p.replace(/^\/+/, ''), baseUrl + '/').toString();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
          res = await fetch(probeUrl, { cache: 'no-store', signal: controller.signal });
        } finally {
          clearTimeout(timeoutId);
        }
        if (res.ok) {
          isReachable = true;
          let models = [];
          try {
            const data = await res.json();
            models = extractModelsFromPayload(data);
          } catch {}
          for (const model of models) {
            discoveredModels.add(model);
          }
        }
      } catch {
        // Connection refused or timeout — expected for inactive servers, suppress noise.
      }
    }

    if (isReachable) {
      const models = [...discoveredModels];
      const savedModel = localStorage.getItem('agent_local_backend_model') || localBackend.model || '';
      const selectedModel = models.includes(savedModel) ? savedModel : (models[0] || '');

      localBackend.url = baseUrl;
      localBackend.detected = true;
      localBackend.corsBlocked = false;
      localBackend.model = selectedModel;
      localBackend.chatPath = target.chatPath || '/v1/chat/completions';
      localBackend.name = target.name || 'local';
      localStorage.setItem('agent_local_backend_url', baseUrl);
      localStorage.setItem('agent_local_backend_model', localBackend.model || '');
      localStorage.setItem('agent_local_backend_chat_path', localBackend.chatPath);
      localStorage.setItem('agent_local_backend_name', localBackend.name);

      // Populate model dropdown with the full aggregated model list.
      const sel = document.getElementById('local-model-select');
      if (sel) {
        sel.innerHTML = models.length
          ? models.map(m => `<option value="${m}">${m}</option>`).join('')
          : `<option value="">unknown model</option>`;
        if (selectedModel) sel.value = selectedModel;
      }
      const row = document.getElementById('local-model-row');
      if (row) row.style.display = 'block';
      const urlInput = document.getElementById('local-url');
      if (urlInput) urlInput.value = baseUrl;

      const label = `${target.name} @ ${baseUrl.replace('http://localhost:',':')}`;
      setLocalStatus('ok', label);
      if (localStorage.getItem('agent_prefer_local_backend') !== 'false') {
        _activateLocal(true);
      }
      return;
    }

    // Fallback: detect open local endpoint even when CORS blocks response body.
    const modelListPath = pathsToTry[0] || '/v1/models';
    try {
      const probeUrl = new URL(modelListPath.replace(/^\/+/, ''), baseUrl + '/').toString();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200);
      let opaqueRes;
      try {
        opaqueRes = await fetch(probeUrl, {
          method: 'GET',
          mode: 'no-cors',
          cache: 'no-store',
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (opaqueRes && opaqueRes.type === 'opaque') {
        localBackend.url = baseUrl;
        localBackend.detected = true;
        localBackend.corsBlocked = true;
        localBackend.model = '';
        localBackend.chatPath = target.chatPath || '/v1/chat/completions';
        localBackend.name = target.name || 'local';
        localStorage.setItem('agent_local_backend_url', baseUrl);
        localStorage.setItem('agent_local_backend_chat_path', localBackend.chatPath);
        localStorage.setItem('agent_local_backend_name', localBackend.name);

        const sel = document.getElementById('local-model-select');
        if (sel) sel.innerHTML = `<option value="">CORS blocked - enable CORS in server</option>`;
        const row = document.getElementById('local-model-row');
        if (row) row.style.display = 'block';
        const url = document.getElementById('local-url');
        if (url) url.value = baseUrl;

        setLocalStatus('busy', `${target.name} reachable (CORS blocked)`);
        return;
      }
    } catch {}

    // Last fallback: some servers answer chat endpoint with 400/405 but are reachable.
    try {
      const probeUrl = new URL((target.chatPath || '/v1/chat/completions').replace(/^\/+/, ''), baseUrl + '/').toString();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1800);
      let res;
      try {
        res = await fetch(probeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'probe', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
          cache: 'no-store',
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if ([200, 400, 401, 404, 405].includes(res.status)) {
        localBackend.url = baseUrl;
        localBackend.detected = true;
        localBackend.corsBlocked = false;
        localBackend.model = '';
        localBackend.chatPath = target.chatPath || '/v1/chat/completions';
        localBackend.name = target.name || 'local';
        localStorage.setItem('agent_local_backend_url', baseUrl);
        localStorage.setItem('agent_local_backend_chat_path', localBackend.chatPath);
        localStorage.setItem('agent_local_backend_name', localBackend.name);

        const sel = document.getElementById('local-model-select');
        if (sel) sel.innerHTML = `<option value="">detected - probe model list</option>`;
        const row = document.getElementById('local-model-row');
        if (row) row.style.display = 'block';
        const url = document.getElementById('local-url');
        if (url) url.value = baseUrl;

        setLocalStatus('ok', `${target.name} reachable`);
        if (localStorage.getItem('agent_prefer_local_backend') !== 'false') {
          _activateLocal(true);
        }
        return;
      }
    } catch {}
  }

  // Nothing found
  localBackend.url = '';
  localBackend.model = '';
  localBackend.detected = false;
  localBackend.corsBlocked = false;
  localBackend.chatPath = '';
  localBackend.name = '';
  localStorage.removeItem('agent_local_backend_url');
  localStorage.removeItem('agent_local_backend_model');
  localStorage.removeItem('agent_local_backend_chat_path');
  localStorage.removeItem('agent_local_backend_name');
  setLocalStatus('error', 'nothing found on :1234 / :8080 / :5000 — check LM Studio is running');
}

function setLocalStatus(state, label) {
  const dot = document.getElementById('local-dot');
  if (dot) dot.className = `status-dot ${state}`;
  const lbl = document.getElementById('local-status-label');
  if (lbl) lbl.textContent = label;
}

function toggleLocalBackend() {
  if (localBackend.corsBlocked) {
    addNotice('Warning: local backend appears reachable, but CORS blocks browser access. Enable CORS in LM Studio/Ollama and probe again.');
    return;
  }
  if (!localBackend.detected && !localBackend.enabled) {
    probeLocal()
      .then(() => {
        if (localBackend.detected) _activateLocal();
      })
      .catch(error => {
        const message = String(error?.message || 'probe failed');
        console.warn('[Local Probe] failed:', message);
        setLocalStatus('error', 'probe failed');
        if (typeof addNotice === 'function') {
          addNotice(`Local backend probe failed: ${message}`);
        }
      });
    return;
  }
  localBackend.enabled ? _deactivateLocal() : _activateLocal();
}

function _activateLocal(isSilent=false) {
  if (typeof ollamaBackend !== 'undefined' && ollamaBackend.enabled) {
    ollamaBackend.enabled = false;
    localStorage.setItem('agent_ollama_enabled', 'false');
    const ollamaToggle = document.getElementById('toggle-ollama');
    if (ollamaToggle) ollamaToggle.checked = false;
  }

  localBackend.enabled = true;
  localStorage.setItem('agent_prefer_local_backend', 'true');

  const tog = document.getElementById('toggle-local');
  if (tog) { tog.checked = true; tog.classList.add('active'); }

  if (typeof updateActiveProviderBadge === 'function') {
    updateActiveProviderBadge();
  } else {
    const topbarModel = document.getElementById('topbar-model');
    if (topbarModel) topbarModel.textContent = 'local/' + (localBackend.model || 'unknown');
  }
  
  if (!isSilent) addNotice('Local backend activated. Routing LLM calls to ' + localBackend.url);
}

function _deactivateLocal() {
  localBackend.enabled = false;
  localStorage.setItem('agent_prefer_local_backend', 'false');
  const tog = document.getElementById('toggle-local');
  if (tog) { tog.checked = false; tog.classList.remove('active'); }

  if (typeof updateActiveProviderBadge === 'function') {
    updateActiveProviderBadge();
  } else {
    const topbarModel = document.getElementById('topbar-model');
    const m = document.getElementById('model-select');
    if (topbarModel && m) topbarModel.textContent = m.value.split('/').pop() || m.value;
  }
  addNotice('Local backend deactivated. Back to cloud model.');
}

// ── Ollama backend (moved from state.js) ────────────────────────────────────

function saveOllamaCloudApiKey() {
  const input = document.getElementById('ollama-cloud-api-key');
  if (!input) return;
  const key = String(input.value || '').trim();
  if (key) {
    localStorage.setItem('agent_ollama_cloud_api_key', key);
    setStatus('ok', 'Ollama API key saved');
  } else {
    localStorage.removeItem('agent_ollama_cloud_api_key');
    setStatus('ok', 'Ollama API key cleared');
  }
}

function loadOllamaCloudApiKey() {
  const input = document.getElementById('ollama-cloud-api-key');
  if (!input) return;
  input.value = localStorage.getItem('agent_ollama_cloud_api_key') || '';
}

function saveOllamaCloudModelSelection() {
  const select = document.getElementById('ollama-model-select');
  const model = (select && select.value) || '';
  if (model) localStorage.setItem('agent_ollama_cloud_model', model);
  if (typeof updateActiveProviderBadge === 'function') updateActiveProviderBadge();
  if (model && !ollamaModelContextSizes.has(model)) {
    fetchModelContextLength(model).catch(() => {});
  }
}

function getOllamaCloudApiKey() {
  return localStorage.getItem('agent_ollama_cloud_api_key') || '';
}

function getOllamaCloudModel() {
  const select = document.getElementById('ollama-model-select');
  if (select && select.value) return select.value;
  return localStorage.getItem('agent_ollama_cloud_model') || 'qwen3.5:9b';
}

function getOllamaCloudProxyUrl() {
  const stored = localStorage.getItem('agent_ollama_cloud_proxy_url') || '';
  if (stored) return stored;
  return (ollamaBackend.url || 'http://localhost:11434').replace(/\/+$/, '');
}

function isSelectedOllamaModelCloud() {
  const select = document.getElementById('ollama-model-select');
  if (!select || !select.options.length) return false;
  const idx = select.selectedIndex;
  if (idx < 0) return false;
  const model = select.options[idx].value;
  if (!model) return false;
  if (ollamaInstalledModels.size > 0) {
    return !ollamaInstalledModels.has(model);
  }
  const group = select.options[idx].parentElement;
  return !!(group && group.id === 'ollama-cloud-optgroup');
}

function toggleOllamaBackend() {
  const checkbox = document.getElementById('toggle-ollama');
  ollamaBackend.enabled = checkbox ? checkbox.checked : !ollamaBackend.enabled;
  localStorage.setItem('agent_ollama_enabled', ollamaBackend.enabled ? 'true' : 'false');
  if (ollamaBackend.enabled && localBackend.enabled) {
    localBackend.enabled = false;
    localStorage.setItem('agent_prefer_local_backend', 'false');
    const lmToggle = document.getElementById('toggle-local');
    if (lmToggle) {
      lmToggle.checked = false;
      lmToggle.classList.remove('active');
    }
  }
  if (typeof updateBadge === 'function') updateBadge();
  if (typeof updateActiveProviderBadge === 'function') updateActiveProviderBadge();
}

async function probeOllama() {
  const urlInput = document.getElementById('ollama-url');
  const statusLabel = document.getElementById('ollama-status-label');
  const dot = document.getElementById('ollama-dot');
  const select = document.getElementById('ollama-model-select');

  const rawUrl = (urlInput ? urlInput.value.trim() : '') || ollamaBackend.url || 'http://localhost:11434';
  const baseUrl = rawUrl.replace(/\/+$/, '');

  ollamaBackend.url = baseUrl;
  localStorage.setItem('agent_ollama_url', baseUrl);
  if (urlInput) urlInput.value = baseUrl;

  if (statusLabel) statusLabel.textContent = 'probing\u2026';
  if (dot) dot.className = 'status-dot busy';

  try {
    const res = await fetchWithTimeout(`${baseUrl}/api/tags`, {}, 5000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];

    const newInstalledModels = new Set();
    const newContextSizes = new Map();
    models.forEach(m => {
      newInstalledModels.add(m.name);
      const baseName = m.name.split(':')[0];
      if (baseName !== m.name) newInstalledModels.add(baseName);
      const ctxLen = inferContextLength(m.name, m);
      if (ctxLen) newContextSizes.set(m.name, { contextLength: ctxLen });
    });
    ollamaInstalledModels.clear();
    for (const name of newInstalledModels) ollamaInstalledModels.add(name);
    ollamaModelContextSizes.clear();
    for (const [k, v] of newContextSizes) ollamaModelContextSizes.set(k, v);

    if (select) {
      const saved = localStorage.getItem('agent_ollama_cloud_model') || '';
      const existing = select.querySelector('optgroup[label="Installed (local)"]');
      if (existing) existing.remove();
      const cloudGroup = select.querySelector('#ollama-cloud-optgroup');

      if (models.length) {
        const localGroup = document.createElement('optgroup');
        localGroup.label = 'Installed (local)';
        models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.name;
          opt.textContent = m.name;
          if (m.name === saved) opt.selected = true;
          localGroup.appendChild(opt);
        });
        cloudGroup ? select.insertBefore(localGroup, cloudGroup) : select.prepend(localGroup);
        if (saved && !select.value) select.value = saved;
      }
      console.debug(`[Ollama] Probe complete: ${models.length} local models, cloud routing guard updated.`);
    }

    if (statusLabel) statusLabel.textContent = `${models.length} model${models.length !== 1 ? 's' : ''} installed`;
    if (dot) dot.className = 'status-dot ok';
    if (typeof updateActiveProviderBadge === 'function') updateActiveProviderBadge();
  } catch (e) {
    if (statusLabel) statusLabel.textContent = `unreachable: ${e.message}`;
    if (dot) dot.className = 'status-dot error';
  }
}

function inferContextLength(modelName, modelMeta) {
  if (modelMeta?.parameters) {
    const m = String(modelMeta.parameters).match(/num_ctx\s+(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  const name = String(modelName || '');
  const kMatch = name.match(/(\d+)k/i);
  if (kMatch) return parseInt(kMatch[1], 10) * 1024;
  const sizeMatch = name.match(/:(\d+)b/i);
  if (sizeMatch) {
    const b = parseInt(sizeMatch[1], 10);
    if (b >= 70) return 128 * 1024;
    if (b >= 30) return 32 * 1024;
    if (b >= 14) return 16 * 1024;
    return 8 * 1024;
  }
  return 8 * 1024;
}

// ── OpenRouter backend ───────────────────────────────────────────────────────

function saveOpenRouterApiKey() {
  const input = document.getElementById('openrouter-api-key');
  if (!input) return;
  const key = String(input.value || '').trim();
  if (key) {
    localStorage.setItem('agent_openrouter_api_key', key);
    openrouterBackend.apiKey = key;
    setStatus('ok', 'OpenRouter API key saved');
  } else {
    localStorage.removeItem('agent_openrouter_api_key');
    openrouterBackend.apiKey = '';
    setStatus('ok', 'OpenRouter API key cleared');
  }
  updateOpenRouterStatus();
}

function loadOpenRouterApiKey() {
  const input = document.getElementById('openrouter-api-key');
  if (!input) return;
  const key = localStorage.getItem('agent_openrouter_api_key') || '';
  input.value = key;
  openrouterBackend.apiKey = key;
  updateOpenRouterStatus();
}

function saveOpenRouterModelSelection() {
  const select = document.getElementById('openrouter-model-select');
  const model = (select && select.value) || '';
  if (model) {
    localStorage.setItem('agent_openrouter_model', model);
    openrouterBackend.model = model;
  }
  if (typeof updateActiveProviderBadge === 'function') updateActiveProviderBadge();
}

function loadOpenRouterModelSelection() {
  const select = document.getElementById('openrouter-model-select');
  if (!select) return;
  const saved = localStorage.getItem('agent_openrouter_model') || 'nvidia/nemotron-3-super-120b-a12b:free';
  select.value = saved;
  openrouterBackend.model = saved;
}

function toggleOpenRouterBackend() {
  const checkbox = document.getElementById('toggle-openrouter');
  const enabled = checkbox ? checkbox.checked : false;
  openrouterBackend.enabled = enabled;
  localStorage.setItem('agent_openrouter_enabled', String(enabled));

  if (enabled) {
    localBackend.enabled = false;
    if (typeof ollamaBackend !== 'undefined') ollamaBackend.enabled = false;
    localStorage.setItem('agent_prefer_local_backend', 'false');
    localStorage.setItem('agent_ollama_enabled', 'false');
    const localCb = document.getElementById('toggle-local');
    const ollamaCb = document.getElementById('toggle-ollama');
    if (localCb) localCb.checked = false;
    if (ollamaCb) ollamaCb.checked = false;
    setStatus('ok', 'OpenRouter active');
  } else {
    setStatus('ok', 'OpenRouter deactivated');
  }

  if (typeof updateBadge === 'function') updateBadge();
  if (typeof updateActiveProviderBadge === 'function') updateActiveProviderBadge();
  updateOpenRouterStatus();
}

function loadOpenRouterBackendState() {
  const checkbox = document.getElementById('toggle-openrouter');
  if (checkbox) checkbox.checked = openrouterBackend.enabled;
  loadOpenRouterApiKey();
  loadOpenRouterModelSelection();
  updateOpenRouterStatus();
}

function updateOpenRouterStatus() {
  const dot = document.getElementById('openrouter-dot');
  const label = document.getElementById('openrouter-status-label');
  if (!dot || !label) return;

  const hasKey = !!String(openrouterBackend.apiKey || '').trim();
  if (!hasKey) {
    dot.className = 'status-dot error';
    label.textContent = 'no API key';
    return;
  }
  if (openrouterBackend.enabled) {
    dot.className = 'status-dot ok';
    label.textContent = openrouterBackend.model;
  } else {
    dot.className = 'status-dot';
    label.textContent = 'ready';
  }
}

function isOpenRouterReady() {
  return {
    ready: !!String(openrouterBackend?.apiKey || '').trim(),
    reason: openrouterBackend?.apiKey ? '' : 'OpenRouter API key not set.'
  };
}

async function fetchModelContextLength(modelName) {
  const cached = ollamaModelContextSizes.get(modelName);
  if (cached?.contextLength) return cached.contextLength;
  const baseUrl = (ollamaBackend.url || 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const res = await fetchWithTimeout(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName })
    }, 5000);
    if (res.ok) {
      const data = await res.json();
      const params = String(data.parameters || '');
      const m = params.match(/num_ctx\s+(\d+)/);
      if (m) {
        const ctxLen = parseInt(m[1], 10);
        ollamaModelContextSizes.set(modelName, { contextLength: ctxLen });
        return ctxLen;
      }
      const template = data.template || '';
      const meta = { parameters: params, template };
      return inferContextLength(modelName, meta);
    }
  } catch {}
  return inferContextLength(modelName, null);
}

function getModelContextLength() {
  const model = typeof getOllamaCloudModel === 'function' ? getOllamaCloudModel() : '';
  if (!model) return (typeof C === 'function' ? C() : window.CONSTANTS)?.DEFAULT_CTX_LIMIT_CHARS || 128000;
  if (typeof ollamaBackend !== 'undefined' && !ollamaBackend.enabled) {
    return (typeof C === 'function' ? C() : window.CONSTANTS)?.DEFAULT_CTX_LIMIT_CHARS || 128000;
  }
  const cached = ollamaModelContextSizes.get(model);
  if (cached?.contextLength) return cached.contextLength;
  return inferContextLength(model, null);
}

function getMaxTokensForModel() {
  const ctxLen = getModelContextLength();
  const ctxLimit = typeof getCtxLimit === 'function' ? getCtxLimit() : 128000;
  const effectiveCtx = Math.min(ctxLen, ctxLimit);
  return Math.max(512, Math.floor(effectiveCtx * 0.25));
}

function loadOllamaBackendState() {
  const urlInput = document.getElementById('ollama-url');
  if (urlInput) urlInput.value = ollamaBackend.url || 'http://localhost:11434';
  const toggle = document.getElementById('toggle-ollama');
  if (toggle) toggle.checked = ollamaBackend.enabled;
  loadOllamaCloudApiKey();
  const saved = localStorage.getItem('agent_ollama_cloud_model') || '';
  if (saved) {
    const sel = document.getElementById('ollama-model-select');
    if (sel) {
      const existing = Array.from(sel.options).find(o => o.value === saved);
      if (existing) sel.value = saved;
    }
  }
  if (ollamaBackend.enabled) probeOllama().catch(() => {});
  if (typeof updateActiveProviderBadge === 'function') updateActiveProviderBadge();
}

// -- TOOLS ---------------------------------------------------------------------
