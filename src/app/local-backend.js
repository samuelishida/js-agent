const LOCAL_CANDIDATES = [
  { port: 1234,  paths: ['/v1/models'], name: 'LM Studio', chatPath: '/v1/chat/completions' },
  { port: 8080,  paths: ['/v1/models'], name: 'llama.cpp', chatPath: '/v1/chat/completions' },
  { port: 5000,  paths: ['/v1/models'], name: 'generic',   chatPath: '/v1/chat/completions' },
];

function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs))
  ]);
}

window.fetchWithTimeout = fetchWithTimeout;

function uniqueTargets(targets) {
  const seen = new Set();
  return targets.filter(t => {
    const key = t.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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

async function probeLocal() {
  if (typeof maybeRequestNotifPermission === 'function') {
    maybeRequestNotifPermission();
  }

  const manualUrl = document.getElementById('local-url').value.trim();
  setLocalStatus('busy', 'probing…');

  // If user typed a custom URL, probe that first
  const targets = getProbeTargets(manualUrl);

  for (const target of targets) {
    const baseUrl = target.url.replace(/\/$/, '');
    const pathsToTry = target.paths || ['/v1/models'];
    let isReachable = false;
    const discoveredModels = new Set();

    for (const p of pathsToTry) {
      try {
        const timeoutMs = p === '/api/tags' ? 7000 : 2500;
        const probeUrl = new URL(p.replace(/^\/+/, ''), baseUrl + '/').toString();
        const res = await fetchWithTimeout(probeUrl, { cache: 'no-store' }, timeoutMs);
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
      } catch {}
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
      const opaqueRes = await fetchWithTimeout(probeUrl, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store'
      }, 1200);
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
      const res = await fetchWithTimeout(probeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'probe', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        cache: 'no-store'
      }, 1800);
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

// -- TOOLS ---------------------------------------------------------------------
