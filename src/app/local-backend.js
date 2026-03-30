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

    if (port === '11434') {
      return { paths: ['/api/tags'], chatPath: '/api/chat', name: 'custom/ollama' };
    }

    return { paths: ['/v1/models'], chatPath: '/v1/chat/completions', name: 'custom/openai' };
  } catch {
    return { paths: ['/v1/models'], chatPath: '/v1/chat/completions', name: 'custom' };
  }
}

function getProbeTargets(manualUrl) {
  const candidateTargets = LOCAL_CANDIDATES.map(candidate => ({
    ...candidate,
    url: `http://localhost:${candidate.port}`
  }));

  if (!manualUrl) return candidateTargets;

  return uniqueTargets([
    {
      url: manualUrl,
      ...inferProbeConfigFromUrl(manualUrl)
    },
    ...candidateTargets
  ]);
}

function extractModelsFromPayload(data) {
  if (Array.isArray(data?.data)) {
    return data.data
      .map(model => model?.id || model?.name)
      .filter(Boolean);
  }

  if (Array.isArray(data?.models)) {
    return data.models
      .map(model => model?.name || model?.id)
      .filter(Boolean);
  }

  return [];
}

async function probeLocal() {
  const manualUrl = document.getElementById('local-url').value.trim();
  setLocalStatus('busy', 'probing…');
  document.getElementById('badge-local').textContent = 'local: probing…';
  document.getElementById('badge-local').style.color = '';
  document.getElementById('badge-local').style.borderColor = '';

  // If user typed a custom URL, probe that first
  const targets = getProbeTargets(manualUrl);

  for (const target of targets) {
    const baseUrl = target.url.replace(/\/$/, '');
    const pathsToTry = target.paths || ['/v1/models'];

    for (const p of pathsToTry) {
      try {
        const res = await fetchWithTimeout(baseUrl + p, { cache: 'no-store' }, 1500);
        if (res.ok) {
          let models = [];
          try {
            const data = await res.json();
            models = extractModelsFromPayload(data);
          } catch {}

          localBackend.url = baseUrl;
          localBackend.detected = true;
          localBackend.corsBlocked = false;
          localBackend.model = models[0] || '';
          localBackend.chatPath = target.chatPath || '/v1/chat/completions';
          localBackend.name = target.name || 'local';
          localStorage.setItem('agent_local_backend_url', baseUrl);
          localStorage.setItem('agent_local_backend_model', localBackend.model || '');
          localStorage.setItem('agent_local_backend_chat_path', localBackend.chatPath);
          localStorage.setItem('agent_local_backend_name', localBackend.name);

          // Populate model dropdown
          const sel = document.getElementById('local-model-select');
          sel.innerHTML = models.length
            ? models.map(m => `<option value="${m}">${m}</option>`).join('')
            : `<option value="">unknown model</option>`;
          document.getElementById('local-model-row').style.display = 'block';
          document.getElementById('local-url').value = baseUrl;

          const label = `${target.name} @ ${baseUrl.replace('http://localhost:',':')}`;
          setLocalStatus('ok', label);
          document.getElementById('badge-local').textContent = `local: ${target.name}`;
          document.getElementById('badge-local').style.color = 'var(--green)';
          document.getElementById('badge-local').style.borderColor = 'var(--green2)';
          if (localStorage.getItem('agent_prefer_local_backend') !== 'false') {
            _activateLocal(true);
          }
          return;
        }
      } catch {}
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
        sel.innerHTML = `<option value="">CORS blocked - enable CORS in server</option>`;
        document.getElementById('local-model-row').style.display = 'block';
        document.getElementById('local-url').value = baseUrl;

        setLocalStatus('busy', `${target.name} reachable (CORS blocked)`);
        document.getElementById('badge-local').textContent = 'local: CORS?';
        document.getElementById('badge-local').style.color = 'var(--amber)';
        document.getElementById('badge-local').style.borderColor = 'var(--amber2)';
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
        sel.innerHTML = `<option value="">detected - probe model list</option>`;
        document.getElementById('local-model-row').style.display = 'block';
        document.getElementById('local-url').value = baseUrl;

        setLocalStatus('ok', `${target.name} reachable`);
        document.getElementById('badge-local').textContent = `local: ${target.name}`;
        document.getElementById('badge-local').style.color = 'var(--green)';
        document.getElementById('badge-local').style.borderColor = 'var(--green2)';
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
  document.getElementById('badge-local').textContent = 'local: offline';
  document.getElementById('badge-local').style.color = 'var(--red)';
  document.getElementById('badge-local').style.borderColor = '#993C1D';
}

function setLocalStatus(state, label) {
  const dot = document.getElementById('local-dot');
  const lbl = document.getElementById('local-status-label');
  dot.className = `status-dot ${state}`;
  lbl.textContent = label;
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
  const tog = document.getElementById('toggle-local');
  tog.classList.add('active');
  document.getElementById('local-toggle-label').textContent = 'on';
  document.getElementById('local-toggle-dot').style.background = 'var(--green)';
  document.getElementById('local-toggle-dot').style.borderColor = 'var(--green)';
  document.getElementById('badge-model').textContent = 'local/' + (localBackend.model || 'unknown');
  document.getElementById('badge-model').style.color = 'var(--green)';
  if (!isSilent) addNotice('Local backend activated. Routing LLM calls to ' + localBackend.url);
}

function _deactivateLocal() {
  localBackend.enabled = false;
  localStorage.setItem('agent_prefer_local_backend', 'false');
  const tog = document.getElementById('toggle-local');
  tog.classList.remove('active');
  document.getElementById('local-toggle-label').textContent = 'off';
  document.getElementById('local-toggle-dot').style.background = '';
  document.getElementById('local-toggle-dot').style.borderColor = '';
  const m = document.getElementById('model-select').value;
  document.getElementById('badge-model').textContent = m;
  document.getElementById('badge-model').style.color = '';
  addNotice('Local backend deactivated. Back to Gemini.');
}

// -- TOOLS ---------------------------------------------------------------------
