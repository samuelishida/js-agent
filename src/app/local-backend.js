const LOCAL_CANDIDATES = [
  { port: 1234,  paths: ['/v1/models'], name: 'LM Studio', chatPath: '/v1/chat/completions' },
  { port: 11434, paths: ['/api/tags'],  name: 'Ollama',    chatPath: '/api/chat' },
  { port: 8080,  paths: ['/v1/models'], name: 'llama.cpp', chatPath: '/v1/chat/completions' },
  { port: 5000,  paths: ['/v1/models'], name: 'generic',   chatPath: '/v1/chat/completions' },
];

function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs))
  ]);
}

function setLocalBadge(text, color = '', borderColor = '') {
  const badge = document.getElementById('badge-local');
  if (!badge) return;
  badge.textContent = text;
  if (color) badge.style.color = color;
  if (borderColor) badge.style.borderColor = borderColor;
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
    return `${parsed.protocol}//${parsed.host}`;
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
  setLocalBadge('local: probing…', '', '');

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
        const res = await fetchWithTimeout(baseUrl + p, { cache: 'no-store' }, timeoutMs);
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
      setLocalBadge(`local: ${target.name}`, 'var(--green)', 'var(--green2)');
      if (localStorage.getItem('agent_prefer_local_backend') !== 'false') {
        _activateLocal(true);
      }
      return;
    }

    // Fallback: detect open local endpoint even when CORS blocks response body.
    const modelListPath = pathsToTry[0] || '/v1/models';
    try {
      const opaqueRes = await fetchWithTimeout(baseUrl + modelListPath, {
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
        setLocalBadge('local: CORS?', 'var(--amber)', 'var(--amber2)');
        return;
      }
    } catch {}

    // Last fallback: some servers answer chat endpoint with 400/405 but are reachable.
    try {
      const res = await fetchWithTimeout(baseUrl + (target.chatPath || '/v1/chat/completions'), {
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
        setLocalBadge(`local: ${target.name}`, 'var(--green)', 'var(--green2)');
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
  setLocalStatus('error', 'nothing found on :1234 / :11434 / :8080');
  setLocalBadge('local: offline', 'var(--red)', '#993C1D');
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
    probeLocal().then(() => {
      if (localBackend.detected) _activateLocal();
    });
    return;
  }
  localBackend.enabled ? _deactivateLocal() : _activateLocal();
}

function _activateLocal(isSilent=false) {
  localBackend.enabled = true;
  localStorage.setItem('agent_prefer_local_backend', 'true');

  const ctxSlider = document.getElementById('sl-ctx');
  const ctxValue = document.getElementById('val-ctx');
  if (ctxSlider && ctxValue) {
    ctxSlider.value = '45';
    ctxValue.textContent = '45';
    if (typeof updateBadge === 'function') updateBadge();
  }

  const tog = document.getElementById('toggle-local');
  if (tog) { tog.checked = true; tog.classList.add('active'); }

  const topbarModel = document.getElementById('topbar-model');
  if (topbarModel) topbarModel.textContent = 'local/' + (localBackend.model || 'unknown');
  
  if (!isSilent) addNotice('Local backend activated. Routing LLM calls to ' + localBackend.url);
}

function _deactivateLocal() {
  localBackend.enabled = false;
  localStorage.setItem('agent_prefer_local_backend', 'false');
  const tog = document.getElementById('toggle-local');
  if (tog) { tog.checked = false; tog.classList.remove('active'); }

  const topbarModel = document.getElementById('topbar-model');
  const m = document.getElementById('model-select');
  if (topbarModel && m) topbarModel.textContent = m.value.split('/').pop() || m.value;
  addNotice('Local backend deactivated. Back to cloud model.');
}

// -- TOOLS ---------------------------------------------------------------------
