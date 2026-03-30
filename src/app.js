// -- STATE ---------------------------------------------------------------------
let apiKey = localStorage.getItem('gemini_api_key') || '';
let messages = [];   // agentic loop history [{role, content}]
let sessionStats = { rounds: 0, tools: 0, resets: 0, msgs: 0 };
let isBusy = false;
const CHAT_SESSIONS_KEY = 'agent_chat_sessions_v1';
const ACTIVE_SESSION_KEY = 'agent_active_session_v1';
const TOOL_CACHE_KEY = 'agent_tool_cache_v1';
const TOOL_CACHE_TTL_MS = 10 * 60 * 1000;
let enabledTools = {
  web_search: true,
  calc: true,
  datetime: true,
  read_page: true,
  geo_current_location: true,
  weather_current: true,
  http_fetch: true,
  extract_links: true,
  page_metadata: true,
  parse_json: true,
  parse_csv: true,
  clipboard_read: true,
  clipboard_write: true,
  storage_list_keys: true,
  storage_get: true,
  storage_set: true,
  fs_list_roots: true,
  fs_pick_directory: true,
  fs_list_dir: true,
  fs_read_file: true,
  fs_upload_pick: true,
  fs_save_upload: true,
  fs_download_file: true,
  fs_preview_file: true,
  fs_search_name: true,
  fs_search_content: true,
  fs_tree: true,
  fs_exists: true,
  fs_stat: true,
  fs_mkdir: true,
  fs_touch: true,
  fs_write_file: true,
  fs_copy_file: true,
  fs_move_file: true,
  fs_delete_path: true,
  fs_rename_path: true
};
let localBackend = {
  enabled: localStorage.getItem('agent_prefer_local_backend') !== 'false',
  url: localStorage.getItem('agent_local_backend_url') || '',
  model: localStorage.getItem('agent_local_backend_model') || '',
  chatPath: localStorage.getItem('agent_local_backend_chat_path') || '',
  name: localStorage.getItem('agent_local_backend_name') || '',
  detected: false,
  corsBlocked: false
};
let chatSessions = [];
let activeSessionId = localStorage.getItem(ACTIVE_SESSION_KEY) || null;

function getRuntimeModules() {
  return {
    skills: window.AgentSkills,
    regex: window.AgentRegex,
    orchestrator: window.AgentOrchestrator,
    prompts: window.AgentPrompts
  };
}

function runtimeReady() {
  const modules = getRuntimeModules();
  return !!(modules.skills && modules.regex && modules.orchestrator && modules.prompts);
}

function assertRuntimeReady() {
  if (!runtimeReady()) {
    throw new Error('Agent bootstrap failed: required modules were not loaded.');
  }
}

// -- CONSTRAINTS ---------------------------------------------------------------
function getMaxRounds() { return parseInt(document.getElementById('sl-rounds').value); }
function getCtxLimit()  { return parseInt(document.getElementById('sl-ctx').value) * 1000; }
function getDelay()     { return parseInt(document.getElementById('sl-delay').value); }

function updateBadge() {
  document.getElementById('badge-rounds').textContent = `max ${document.getElementById('sl-rounds').value} rounds`;
  document.getElementById('badge-ctx').textContent = `${document.getElementById('sl-ctx').value}k ctx`;
}

// -- API KEY -------------------------------------------------------------------
function saveKey() {
  apiKey = document.getElementById('api-key').value.trim();
  localStorage.setItem('gemini_api_key', apiKey);
  setStatus('ok', 'key saved');
}

function loadToolCache() {
  try {
    return JSON.parse(localStorage.getItem(TOOL_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveToolCache(cache) {
  localStorage.setItem(TOOL_CACHE_KEY, JSON.stringify(cache));
}

function getToolCacheKey(call) {
  return `${call.tool}:${JSON.stringify(call.args || {})}`;
}

function getCachedToolResult(call) {
  const cache = loadToolCache();
  const key = getToolCacheKey(call);
  const entry = cache[key];
  if (!entry) return null;
  if ((Date.now() - entry.timestamp) > TOOL_CACHE_TTL_MS) {
    delete cache[key];
    saveToolCache(cache);
    return null;
  }
  return entry.result;
}

function setCachedToolResult(call, result) {
  const cache = loadToolCache();
  cache[getToolCacheKey(call)] = { result, timestamp: Date.now() };
  saveToolCache(cache);
}

function loadSessions() {
  try {
    const stored = JSON.parse(localStorage.getItem(CHAT_SESSIONS_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function saveSessions() {
  localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(chatSessions));
}

function makeSessionTitle(sourceText = 'New session') {
  return String(sourceText || 'New session').trim().slice(0, 48) || 'New session';
}

function createSession(initialTitle = 'New session') {
  const session = {
    id: `session_${Date.now()}`,
    title: makeSessionTitle(initialTitle),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    stats: { rounds: 0, tools: 0, resets: 0, msgs: 0 }
  };
  chatSessions.unshift(session);
  activeSessionId = session.id;
  localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  saveSessions();
  return session;
}

function resetLiveSessionState() {
  messages = [];
  sessionStats = { rounds: 0, tools: 0, resets: 0, msgs: 0 };
}

function getActiveSession() {
  return chatSessions.find(session => session.id === activeSessionId) || null;
}

function syncSessionState() {
  let session = getActiveSession();
  if (!session) session = createSession();

  session.updatedAt = new Date().toISOString();
  session.messages = messages;
  session.stats = sessionStats;
  saveSessions();
  renderSessionList();
}

function activateSession(sessionId) {
  const session = chatSessions.find(item => item.id === sessionId);
  if (!session) return;

  activeSessionId = session.id;
  localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  messages = Array.isArray(session.messages) ? session.messages : [];
  sessionStats = session.stats || { rounds: 0, tools: 0, resets: 0, msgs: 0 };
  renderSessionList();
  renderChatFromMessages();
  updateStats();
  updateCtxBar();
  setStatus('ok', 'session loaded');
}

function renderSessionList() {
  const host = document.getElementById('session-list');
  if (!host) return;

  host.innerHTML = chatSessions.length
    ? chatSessions.map(session => `
      <div class="session-item ${session.id === activeSessionId ? 'active' : ''}">
        <button class="session-main" onclick="activateSession('${session.id}')">
          <span class="session-title">${escHtml(session.title)}</span>
          <span class="session-meta">${new Date(session.updatedAt).toLocaleString()}</span>
        </button>
        <button class="session-delete" onclick="deleteSession('${session.id}')" title="Delete session">×</button>
      </div>`).join('')
    : '<div class="session-empty">no sessions yet</div>';
}

function deleteSession(sessionId) {
  const nextSessions = chatSessions.filter(session => session.id !== sessionId);
  if (nextSessions.length === chatSessions.length) return;

  chatSessions = nextSessions;

  if (!chatSessions.length) {
    const created = createSession();
    resetLiveSessionState();
    activeSessionId = created.id;
  } else if (activeSessionId === sessionId) {
    activeSessionId = chatSessions[0].id;
    localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
    saveSessions();
    activateSession(activeSessionId);
    return;
  }

  localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  saveSessions();
  renderSessionList();
  renderChatFromMessages();
  updateStats();
  updateCtxBar();
  setStatus('ok', 'session deleted');
}

function deleteAllSessions() {
  chatSessions = [];
  localStorage.removeItem(CHAT_SESSIONS_KEY);
  const created = createSession();
  resetLiveSessionState();
  activeSessionId = created.id;
  localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  renderSessionList();
  renderChatFromMessages();
  updateStats();
  updateCtxBar();
  setStatus('ok', 'all sessions deleted');
}

function renderChatFromMessages() {
  const chat = document.getElementById('chat');
  chat.innerHTML = '';

  if (!messages.length) {
    chat.innerHTML = `
      <div class="empty-state" id="empty">
        <div class="empty-logo">?</div>
        <div class="empty-title">Agentic loop ready</div>
        <div class="empty-sub">
          Simulates the corporate environment:<br>
          max_rounds · ctx_limit · tool dispatch · context summarization
        </div>
        <div class="empty-examples">
          <button class="example-chip" onclick="useExample(this)">What's the current BRL/USD exchange rate?</button>
          <button class="example-chip" onclick="useExample(this)">Calculate compound interest: $10k at 5.5% for 7 years</button>
          <button class="example-chip" onclick="useExample(this)">Search for the latest Fed rate decision and summarize</button>
          <button class="example-chip" onclick="useExample(this)">What's today's date and what day of the week is it?</button>
        </div>
      </div>`;
    return;
  }

  for (const message of messages.filter(m => m.role !== 'system')) {
    if (message.role === 'assistant') {
      const parsed = splitModelReply(message.content);
      addMessage('agent', parsed.visible, null, false, false, parsed.thinkingBlocks);
      continue;
    }

    addMessage(message.role, message.content, null);
  }
}

// -- LOCAL BACKEND PROBE ------------------------------------------------------
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
function renderToolGroups() {
  const host = document.getElementById('tool-groups');
  if (!host) return;

  const groups = Object.values(window.AgentSkillGroups || {});
  host.innerHTML = groups.map(group => `
    <div class="tool-group">
      <div class="tool-group-label">${escHtml(group.label)}</div>
      <div class="tool-list">
        ${group.tools.map(tool => `
          <div class="tool-toggle ${enabledTools[tool.name] ? 'active' : ''}" id="tool-${tool.name}" onclick="toggleTool('${tool.name}')">
            <span class="tool-name">${escHtml(tool.signature)}</span>
            <span class="tool-dot"></span>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

function toggleTool(name) {
  enabledTools[name] = !enabledTools[name];
  document.getElementById(`tool-${name}`)?.classList.toggle('active', enabledTools[name]);
}

function isLocalModeActive() {
  return localBackend.enabled && !!localBackend.url;
}

function canUseGemini() {
  return !!apiKey;
}

// -- SYSTEM PROMPT -------------------------------------------------------------
async function buildSystemPrompt(userMessage = '') {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  const available = Object.entries(enabledTools)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

  return orchestrator.buildSystemPrompt({
    userMessage,
    maxRounds: getMaxRounds(),
    ctxLimit: getCtxLimit(),
    enabledTools: available
  });
}

async function buildDirectAnswerRepairPrompt(userMessage) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  return orchestrator.buildRepairPrompt(userMessage);
}

// -- LLM ROUTER: Gemini or Local ----------------------------------------------
async function callGemini(msgs) { return callLLM(msgs); }

function sanitizeModelReply(text) {
  return splitModelReply(text).visible;
}

const SAFE_HTML_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's',
  'ul', 'ol', 'li', 'code', 'pre', 'blockquote',
  'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'h1', 'h2', 'h3', 'h4', 'hr', 'div', 'span'
]);

const SAFE_HTML_ATTRS = {
  a: new Set(['href', 'title']),
  th: new Set(['colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan'])
};

function extractThinkingBlocks(text) {
  return [...String(text || '').matchAll(/<think>\s*([\s\S]*?)\s*<\/think>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
}

function splitModelReply(text) {
  const raw = String(text || '');
  return {
    raw,
    thinkingBlocks: extractThinkingBlocks(raw),
    visible: raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^\s*```(?:xml|html)?\s*([\s\S]*?)\s*```$/i, '$1')
      .trim()
  };
}

function looksLikeHtmlFragment(text) {
  return /<\/?[a-z][^>]*>/i.test(String(text || ''));
}

function formatPlainTextAsHtml(text) {
  const value = String(text || '').trim();
  if (!value) return '<p></p>';

  return value
    .split(/\n{2,}/)
    .map(block => `<p>${escHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function sanitizeUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(value)) return value;
  return '';
}

function sanitizeHtmlFragment(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');

  const cleanNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.textContent || '');
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return document.createDocumentFragment();
    }

    const tag = node.tagName.toLowerCase();
    if (!SAFE_HTML_TAGS.has(tag)) {
      if (['script', 'style', 'iframe', 'object', 'embed'].includes(tag)) {
        return document.createDocumentFragment();
      }

      const fragment = document.createDocumentFragment();
      [...node.childNodes].forEach(child => fragment.appendChild(cleanNode(child)));
      return fragment;
    }

    const el = document.createElement(tag);
    const allowedAttrs = SAFE_HTML_ATTRS[tag] || new Set();

    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style') continue;
      if (!allowedAttrs.has(name)) continue;

      if (tag === 'a' && name === 'href') {
        const safeHref = sanitizeUrl(attr.value);
        if (!safeHref) continue;
        el.setAttribute('href', safeHref);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
        continue;
      }

      el.setAttribute(name, attr.value);
    }

    [...node.childNodes].forEach(child => el.appendChild(cleanNode(child)));
    return el;
  };

  const fragment = document.createDocumentFragment();
  [...template.content.childNodes].forEach(child => fragment.appendChild(cleanNode(child)));
  const wrapper = document.createElement('div');
  wrapper.appendChild(fragment);
  return wrapper.innerHTML;
}

function renderAgentHtml(text) {
  const source = looksLikeHtmlFragment(text) ? String(text || '') : formatPlainTextAsHtml(text);
  return sanitizeHtmlFragment(source);
}

async function callLLM(msgs) {
  if (localBackend.enabled && localBackend.url) {
    return callLocal(msgs);
  }
  return callGeminiDirect(msgs);
}

async function callGeminiDirect(msgs) {
  const modelSelect = document.getElementById('model-select');
  let model = modelSelect.value;
  if (!localBackend.enabled) document.getElementById('badge-model').textContent = model;

  const contents = msgs
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
  const systemInstruction = msgs.find(m => m.role === 'system');
  const body = { contents, generationConfig: { maxOutputTokens: 2048, temperature: 0.7 } };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction.content }] };

  const fallbackModels = {
    'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
    'gemini-1.5-flash': 'gemini-2.5-flash-lite',
    'gemini-1.5-pro': 'gemini-2.5-flash'
  };

  const requestModel = async activeModel => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${apiKey}`;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { res, text: await res.text() };
  };

  let { res, text } = await requestModel(model);
  if (!res.ok && res.status === 404 && fallbackModels[model]) {
    model = fallbackModels[model];
    modelSelect.value = model;
    if (!localBackend.enabled) document.getElementById('badge-model').textContent = model;
    ({ res, text } = await requestModel(model));
  }

  if (!res.ok) { throw new Error(`Gemini ${res.status}: ${text.slice(0,300)}`); }
  const data = JSON.parse(text);
  if (data.error) throw new Error(data.error.message);
  if (!data.candidates?.[0]) throw new Error('No candidates returned');
  return data.candidates[0].content.parts[0].text || '';
}
async function callLocal(msgs) {
  // Detect endpoint type from model select or probed URL
  const modelSel = document.getElementById('local-model-select').value;
  const model = modelSel || localBackend.model || 'local-model';
  localBackend.model = model;
  localStorage.setItem('agent_local_backend_model', localBackend.model || '');

  // Build OpenAI-compatible messages (works for LM Studio + llama.cpp + Ollama /v1/)
  const openaiMsgs = msgs.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: m.content
  }));

  const inferred = inferProbeConfigFromUrl(localBackend.url || '');
  const preferredChatPath = localBackend.chatPath || inferred.chatPath || '/v1/chat/completions';
  const endpoints = [];
  const pushEndpoint = (path, format) => {
    if (!endpoints.some(endpoint => endpoint.path === path)) {
      endpoints.push({ path, format });
    }
  };
  pushEndpoint(preferredChatPath, preferredChatPath === '/api/chat' ? 'ollama' : 'openai');
  pushEndpoint('/v1/chat/completions', 'openai');
  pushEndpoint('/api/chat', 'ollama');

  for (const ep of endpoints) {
    try {
      let body;
      if (ep.format === 'ollama') {
        body = { model, messages: openaiMsgs, stream: false };
      } else {
        body = { model, messages: openaiMsgs, max_tokens: 2048, temperature: 0.7, stream: false };
      }

      const res = await fetch(localBackend.url + ep.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) continue;
      const data = await res.json();

      // OpenAI format
      if (data.choices?.[0]) return data.choices[0].message?.content || data.choices[0].text || '';
      // Ollama format
      if (data.message?.content) return data.message.content;
      if (data.response) return data.response;
      return JSON.stringify(data);
    } catch (e) {
      if (ep.format === 'openai') continue; // try next
      throw new Error(`Local LLM error: ${e.message}`);
    }
  }
  throw new Error(`Local LLM: no endpoint responded at ${localBackend.url}`);
}

// -- TOOL EXECUTOR -------------------------------------------------------------
function getToolRegex() {
  return getRuntimeModules().regex?.TOOL_BLOCK || /<tool_call>[\s\S]*?<\/tool_call>/gi;
}

function parseToolCall(text) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  return orchestrator.parseToolCall(text);
}

async function executeTool(call) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  const { tool, args } = call;

  if (!enabledTools[tool]) {
    return `ERROR: tool '${tool}' is disabled in this environment.`;
  }

  if (tool === 'calc') {
    const expr = args.expression || '';
    try {
      if (!/^[0-9+\-*/().%\s^epsqrtlogabtincfloreil,MathPI]+$/i.test(expr.replace(/Math\./g,''))) {
        const result = Function('"use strict"; return (' + expr + ')')();
        return `${expr} = ${result}`;
      }
      const result = Function('"use strict"; return (' + expr + ')')();
      return `${expr} = ${result}`;
    } catch (e) {
      return `calc error: ${e.message}`;
    }
  }

  if (tool === 'datetime') {
    const now = new Date();
    return `Current datetime: ${now.toISOString()}\nLocal: ${now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', timeZoneName:'short' })}\nTimezone: America/Sao_Paulo (BRT)`;
  }

  const cachedResult = getCachedToolResult(call);
  if (cachedResult) {
    return `${cachedResult}\n\n[cache hit]`;
  }

  const result = await orchestrator.executeSkill(call, {
    localBackend,
    enabledTools,
    messages
  });
  if (!/^ERROR\b/i.test(result)) {
    setCachedToolResult(call, result);
  }
  return result;
}

// -- CONTEXT SIZE + SUMMARIZE --------------------------------------------------
function ctxSize(msgs) {
  return msgs.reduce((n, m) => n + (m.content || '').length, 0);
}

function updateCtxBar() {
  const size = ctxSize(messages);
  const limit = getCtxLimit();
  const pct = Math.min(100, (size / limit) * 100);
  const bar = document.getElementById('ctx-bar');
  const label = document.getElementById('ctx-pct');
  bar.style.width = pct + '%';
  bar.classList.toggle('warn', pct > 60 && pct <= 85);
  bar.classList.toggle('danger', pct > 85);
  label.textContent = pct.toFixed(1) + '%';
  document.getElementById('stat-ctx').textContent = size.toLocaleString();
}

async function summarizeContext(userQuery) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  addNotice('Context limit reached (' + ctxSize(messages).toLocaleString() + ' chars). Compressing via LLM.');
  sessionStats.resets++;
  updateStats();

  const hist = messages
    .filter(m => m.role !== 'system')
    .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');

  const prompt = await orchestrator.buildSummaryPrompt(hist, userQuery);

  const sysMsg = messages.find(m => m.role === 'system');
  const summary = await callGemini([
    sysMsg,
    { role: 'user', content: prompt }
  ]);

  return [
    sysMsg,
    { role: 'assistant', content: `[SUMMARISED CONTEXT]\n${summary}` },
    { role: 'user', content: userQuery }
  ];
}

// -- AGENTIC LOOP --------------------------------------------------------------
async function agentLoop(userMessage) {
  assertRuntimeReady();
  const { skills, orchestrator } = getRuntimeModules();
  const MAX_ROUNDS = getMaxRounds();
  const CTX_LIMIT  = getCtxLimit();
  const delay      = getDelay();
  const enrichedMessage = await skills.buildInitialContext(userMessage);

  // Init messages for this turn
  messages = [
    { role: 'system', content: await buildSystemPrompt(userMessage) },
    ...messages.filter(m => m.role !== 'system').slice(-20), // keep last 20 non-system
    { role: 'user', content: enrichedMessage }
  ];

  let round = 0;
  sessionStats.msgs++;

  while (round < MAX_ROUNDS) {
    round++;
    sessionStats.rounds++;
    updateStats();

    setStatus('busy', `round ${round}/${MAX_ROUNDS}`);
    showThinking(`round ${round}/${MAX_ROUNDS}`);

    // Corporate delay simulation
    if (delay > 0) await sleep(delay);

    let rawReply;
    let parsedReply;
    let reply;
    try {
      rawReply = await callGemini(messages);
      parsedReply = splitModelReply(rawReply);
      reply = parsedReply.visible;
      if (parsedReply.thinkingBlocks.length) {
      }
    } catch (e) {
      hideThinking();
      addMessage('error', `LLM error: ${e.message}`, round);
      setStatus('error', 'api error');
      return;
    }

    hideThinking();

    // Parse for tool call
    const toolCall = parseToolCall(reply);
    const leakedReasoning = !toolCall && orchestrator.hasReasoningLeak(reply);

    if (leakedReasoning) {
      messages.push({ role: 'assistant', content: rawReply || reply });
      messages.push({ role: 'user', content: await buildDirectAnswerRepairPrompt(userMessage) });
      addNotice('Model exposed internal reasoning. Requesting a direct answer.');
      updateCtxBar();
      continue;
    }

    if (!toolCall) {
      // Final answer
      const cleanReply = reply.replace(getToolRegex(), '').trim();
      addMessage('agent', cleanReply, round, false, false, parsedReply?.thinkingBlocks || []);
      messages.push({ role: 'assistant', content: rawReply || reply });
      syncSessionState();
      setStatus('ok', `done in ${round} round${round>1?'s':''}`);
      updateCtxBar();
      return;
    }

    // Tool call detected
    const toolContent = reply.replace(getToolRegex(), '').trim();
    if (toolContent) addMessage('agent', toolContent, round, false, false, parsedReply?.thinkingBlocks || []);

    sessionStats.tools++;
    updateStats();

    addMessage('tool', `? ${toolCall.tool}(${JSON.stringify(toolCall.args)})`, round, true);
    showThinking(`executing ${toolCall.tool}…`);

    if (delay > 0) await sleep(delay * 0.5);

    const result = await executeTool(toolCall);
    hideThinking();
    addMessage('tool', `? ${result}`, round, false, true);

    messages.push({ role: 'assistant', content: rawReply || reply });
    messages.push({ role: 'user', content: `<tool_result tool="${toolCall.tool}">\n${result}\n</tool_result>` });

    // Check context limit
    if (ctxSize(messages) > CTX_LIMIT) {
      try {
        messages = await summarizeContext(userMessage);
      } catch (e) {
        addNotice(`? Summarization failed: ${e.message}`);
      }
    }
    syncSessionState();
    updateCtxBar();
  }

  // Exhausted rounds — force final answer
  addNotice('max_rounds (' + MAX_ROUNDS + ') reached. Forcing final answer.');
  messages.push({ role: 'user', content: 'Answer now with what you know so far. Return the final answer as valid HTML only.' });
  showThinking('forcing final answer…');
  try {
    const finalReply = await callGemini(messages);
    const parsedFinalReply = splitModelReply(finalReply);
    hideThinking();
    addMessage('agent', parsedFinalReply.visible, MAX_ROUNDS, false, false, parsedFinalReply.thinkingBlocks);
    messages.push({ role: 'assistant', content: finalReply });
    syncSessionState();
  } catch (e) {
    hideThinking();
    addMessage('error', `Final answer failed: ${e.message}`, MAX_ROUNDS);
  }
  setStatus('ok', `max rounds hit`);
  updateCtxBar();
}

// -- UI HELPERS ----------------------------------------------------------------
let thinkingEl = null;

function showThinking(label) {
  hideThinking();
  const el = document.createElement('div');
  el.className = 'thinking';
  el.id = 'thinking';
  el.innerHTML = `
    <div class="thinking-dots">
      <div class="dot"></div><div class="dot"></div><div class="dot"></div>
    </div>
    <span class="thinking-label">${label}</span>`;
  document.getElementById('chat').appendChild(el);
  scrollBottom();
}

function hideThinking() {
  const el = document.getElementById('thinking');
  if (el) el.remove();
}

function addMessage(role, content, round, isCall=false, isResult=false, hiddenThinking=[]) {
  document.getElementById('empty')?.remove();

  const wrap = document.createElement('div');
  wrap.className = 'msg';

  const roleLabels = { user:'USER', agent:'AGENT', tool:'TOOL', system:'SYSTEM', error:'ERROR' };
  const roleCls    = { user:'role-user', agent:'role-agent', tool:'role-tool', system:'role-system', error:'role-error' };

  wrap.innerHTML = `
    <div class="msg-header">
      <span class="msg-role ${roleCls[role]}">${roleLabels[role]}</span>
      ${round ? `<span class="msg-round">R${round}</span>` : ''}
      ${isCall   ? `<span class="msg-round" style="color:var(--green)">call</span>` : ''}
      ${isResult ? `<span class="msg-round" style="color:var(--green)">result</span>` : ''}
    </div>`;

  const body = document.createElement('div');
  body.className = `msg-body ${role==='tool'?'dim':''} ${role==='agent'?'html-body':''}`.trim();
  if (role === 'agent') {
    body.innerHTML = renderAgentHtml(content);
  } else {
    body.textContent = String(content || '');
  }
  wrap.appendChild(body);

  if (role === 'agent' && hiddenThinking.length) {
    const details = document.createElement('details');
    details.className = 'thinking-details';

    const summary = document.createElement('summary');
    summary.textContent = `Hidden thinking (${hiddenThinking.length})`;
    details.appendChild(summary);

    const pre = document.createElement('pre');
    pre.className = 'thinking-pre';
    pre.textContent = hiddenThinking.join('\n\n---\n\n');
    details.appendChild(pre);
    wrap.appendChild(details);
  }

  document.getElementById('chat').appendChild(wrap);
  scrollBottom();
}

function addNotice(text) {
  const el = document.createElement('div');
  el.className = 'ctx-notice';
  el.textContent = text;
  document.getElementById('chat').appendChild(el);
  scrollBottom();
}

function setStatus(state, label) {
  const badge = document.getElementById('badge-status');
  badge.innerHTML = `<span class="status-dot ${state}"></span>&nbsp;${label}`;
}

function updateStats() {
  document.getElementById('stat-rounds').textContent = sessionStats.rounds;
  document.getElementById('stat-tools').textContent  = sessionStats.tools;
  document.getElementById('stat-resets').textContent = sessionStats.resets;
  document.getElementById('stat-msgs').textContent   = sessionStats.msgs;
}

function scrollBottom() {
  const chat = document.getElementById('chat');
  chat.scrollTop = chat.scrollHeight;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -- SEND ----------------------------------------------------------------------
async function sendMessage() {
  if (isBusy) return;
  if (!runtimeReady()) {
    addMessage('error', 'Agent bootstrap failed: required modules were not loaded.', null);
    return;
  }
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;

  if (!isLocalModeActive() && !canUseGemini()) {
    addMessage('error', 'No Gemini API key set. Enter your key in the sidebar and click Save.', null);
    return;
  }

  input.value = '';
  autoResize(input);
  isBusy = true;
  document.getElementById('btn-send').disabled = true;
  document.getElementById('input-status').textContent = 'processing…';

  addMessage('user', text, null);
  if (!getActiveSession() || !getActiveSession().messages.length) {
    const session = getActiveSession() || createSession(text);
    session.title = makeSessionTitle(text);
  }
  saveSessions();
  renderSessionList();

  try {
    await agentLoop(text);
  } catch (e) {
    hideThinking();
    addMessage('error', e.message, null);
    setStatus('error', 'error');
    syncSessionState();
  }

  isBusy = false;
  document.getElementById('btn-send').disabled = false;
  document.getElementById('input-status').textContent = `${sessionStats.msgs} message${sessionStats.msgs!==1?'s':''} sent`;
  input.focus();
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function useExample(btn) {
  const input = document.getElementById('msg-input');
  input.value = btn.textContent;
  autoResize(input);
  input.focus();
}

function clearSession() {
  createSession();
  resetLiveSessionState();
  updateStats();
  updateCtxBar();
  renderChatFromMessages();
  renderSessionList();
  setStatus('ok', 'idle');
}

// -- INIT ----------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  updateBadge();
  updateStats();
  updateCtxBar();

  if (!runtimeReady()) {
    setStatus('error', 'bootstrap failed');
    addNotice('ERROR: required modules did not load. Check the browser console and reload the page.');
    return;
  }

  chatSessions = loadSessions();
  if (!chatSessions.length) createSession();
  if (!getActiveSession()) activeSessionId = chatSessions[0]?.id || createSession().id;
  renderSessionList();
  renderToolGroups();
  activateSession(activeSessionId);
  if (apiKey) {
    document.getElementById('api-key').value = apiKey;
    setStatus('ok', 'key set');
  }
  if (localBackend.url) {
    document.getElementById('local-url').value = localBackend.url;
    if (localBackend.model) {
      const sel = document.getElementById('local-model-select');
      sel.innerHTML = `<option value="${localBackend.model}">${localBackend.model}</option>`;
      sel.value = localBackend.model;
      document.getElementById('local-model-row').style.display = 'block';
    }
    if (localBackend.enabled) {
      _activateLocal(true);
    }
  }
  // Auto-probe local backends on load
  probeLocal();
});







