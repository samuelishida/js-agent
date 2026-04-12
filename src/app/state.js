// -- STATE ---------------------------------------------------------------------
// Safe localStorage read: returns fallback on SecurityError (private browsing).
function safeGet(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

let apiKey = safeGet('cloud_api_key') || safeGet('gemini_api_key') || '';
let messages = [];   // agentic loop history [{role, content}]
let sessionStats = { rounds: 0, tools: 0, resets: 0, msgs: 0 };
let isBusy = false;
const CHAT_SESSIONS_KEY = 'agent_chat_sessions_v1';
const ACTIVE_SESSION_KEY = 'agent_active_session_v1';
const TOOL_CACHE_KEY = 'agent_tool_cache_v1';
const TOOL_CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 2;
const SESSION_SCHEMA_VERSION = 2;
const SIDEBAR_COLLAPSED_KEY = 'agent_sidebar_collapsed_v1';
const SIDEBAR_AUTO_COLLAPSE_WIDTH = 1180;
const CACHE_SYNC_CHANNEL = 'loopagent-cache-v1';
const BUSY_CHANNEL = 'loopagent-busy-v1';
const NON_CACHEABLE_TOOL_PREFIXES = ['fs_'];
const NON_CACHEABLE_TOOLS = new Set([
  'notification_request_permission',
  'notification_send',
  'tab_listen',
  'tab_broadcast',
  'todo_write',
  'task_create',
  'task_update',
  'worker_batch',
  'worker_list',
  'worker_get',
  'ask_user_question',
  'memory_write',
  'memory_search',
  'memory_list',
  // file write / edit tools must never be served from cache — skip the actual write
  'file_write',
  'write_file',
  'file_edit',
  'edit_file',
  'file_append',
  'write_file_content',
  'runtime_writeFile',
  'runtime_editFile',
  'runtime_multiEdit',
  'runtime_runTerminal',
  'runtime_todoWrite',
  'runtime_memoryWrite',
  'runtime_spawnAgent'
]);
let notificationPermissionRequested = false;
// Derive a stable instance ID from localStorage so it survives module load order races.
// Each page load gets a fresh ID (not persisted), but within a load it is consistent.
const agentInstanceId = (() => {
  const key = '_agent_instance_id_session';
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) return stored;
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return Math.random().toString(36).slice(2);
  }
})();
let cacheSyncChannel = null;
let busyChannel = null;
let otherTabBusy = false;
let enabledTools = {
  web_search: true,
  calc: true,
  datetime: true,
  read_page: true,
  web_fetch: true,
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
  notification_request_permission: true,
  notification_send: true,
  tab_broadcast: true,
  tab_listen: true,
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
  fs_glob: true,
  fs_grep: true,
  fs_tree: true,
  fs_walk: true,
  fs_exists: true,
  fs_stat: true,
  fs_mkdir: true,
  fs_touch: true,
  fs_write_file: true,
  fs_copy_file: true,
  fs_move_file: true,
  fs_delete_path: true,
  fs_rename_path: true,
  file_read: true,
  read_file: true,
  file_write: true,
  write_file: true,
  file_edit: true,
  edit_file: true,
  glob: true,
  grep: true,
  todo_write: true,
  task_create: true,
  task_get: true,
  task_list: true,
  task_update: true,
  worker_batch: true,
  worker_list: true,
  worker_get: true,
  ask_user_question: true,
  memory_write: true,
  memory_search: true,
  memory_list: true,
  runtime_readFile: true,
  runtime_writeFile: true,
  runtime_editFile: true,
  runtime_multiEdit: true,
  runtime_listDir: true,
  runtime_glob: true,
  runtime_searchCode: true,
  runtime_runTerminal: true,
  runtime_webFetch: true,
  runtime_getDiagnostics: true,
  runtime_todoWrite: true,
  runtime_memoryRead: true,
  runtime_memoryWrite: true,
  runtime_lsp: true,
  runtime_spawnAgent: true,
  tool_search: true,
  snapshot_skill_catalog: true
};
let localBackend = {
  enabled: safeGet('agent_prefer_local_backend') === 'true',
  url: safeGet('agent_local_backend_url') || '',
  model: safeGet('agent_local_backend_model') || '',
  chatPath: safeGet('agent_local_backend_chat_path') || '',
  name: safeGet('agent_local_backend_name') || '',
  detected: false,
  corsBlocked: false
};
let ollamaBackend = {
  enabled: safeGet('agent_ollama_enabled') === 'true',
  url: safeGet('agent_ollama_url') || 'http://localhost:11434',
};
// Set of model names confirmed installed locally via /api/tags probe.
// Used by isSelectedOllamaModelCloud() for reliable local-vs-cloud routing.
const ollamaInstalledModels = new Set();
console.debug(`[State Init] localBackend: enabled=${localBackend.enabled}, url='${localBackend.url}', model='${localBackend.model}'`);
console.debug(`[State Init] ollamaBackend: enabled=${ollamaBackend.enabled}, url='${ollamaBackend.url}'`);
let chatSessions = [];
let activeSessionId = safeGet(ACTIVE_SESSION_KEY) || null;

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
function getMaxRounds() {
  const el = document.getElementById('sl-rounds');
  return el ? parseInt(el.value, 10) : 50;
}

function getCtxLimit() {
  const el = document.getElementById('sl-ctx');
  return el ? parseInt(el.value, 10) * 1000 : 32000;
}

function getDelay() {
  const el = document.getElementById('sl-delay');
  return el ? parseInt(el.value, 10) : 500;
}

function updateBadge() {
  const badgeRounds = document.getElementById('badge-rounds');
  const slRounds = document.getElementById('sl-rounds');
  if (badgeRounds && slRounds) {
    badgeRounds.textContent = `rounds ${slRounds.value}`;
  }
  
  const badgeCtx = document.getElementById('badge-ctx');
  const slCtx = document.getElementById('sl-ctx');
  if (badgeCtx && slCtx) {
    badgeCtx.textContent = `context ${slCtx.value}k`;
  }
}

function shouldAutoCollapseSidebar() {
  return window.innerWidth <= SIDEBAR_AUTO_COLLAPSE_WIDTH;
}

function syncSidebarToggleButtons() {
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  const openBtn = document.getElementById('sidebar-open-btn');
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  const openLabel = collapsed ? 'Show sidebar' : 'Hide sidebar';
  const openIcon = collapsed ? '\u2630' : '\u2190';

  if (openBtn) {
    openBtn.textContent = openIcon;
    openBtn.title = openLabel;
    openBtn.setAttribute('aria-label', openLabel);
    openBtn.setAttribute('aria-expanded', String(!collapsed));
  }

  if (collapseBtn) {
    collapseBtn.textContent = '\u2190';
    collapseBtn.title = 'Hide sidebar';
    collapseBtn.setAttribute('aria-label', 'Hide sidebar');
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
  }
}

function applySidebarState() {
  const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
  const collapsed = stored == null ? shouldAutoCollapseSidebar() : stored === 'true';
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  syncSidebarToggleButtons();
}
function toggleSidebar() {
  const next = !document.body.classList.contains('sidebar-collapsed');
  document.body.classList.toggle('sidebar-collapsed', next);
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
  syncSidebarToggleButtons();
}

function handleResponsiveSidebar() {
  if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) == null) {
    applySidebarState();
  }
  syncSidebarToggleButtons();
}

function updateFileAccessStatus() {
  const el = document.getElementById('file-access-status');
  if (!el) return;

  const roots = [...(window.AgentSkills?.state?.roots?.keys?.() || [])];
  el.textContent = roots.length
    ? `authorized: ${roots.join(', ')}`
    : 'no folder authorized';
}

async function requestDirectoryAccess() {
  if (!runtimeReady()) return;

  try {
    setStatus('busy', 'authorizing folder');
    const result = await window.AgentSkills.registry.fs_pick_directory.run();
    clearToolCache(key => key.startsWith('fs_'));
    addNotice(result.replace(/^##\s*fs_pick_directory\s*/i, '').trim());
    updateFileAccessStatus();
    setStatus('ok', 'folder authorized');
  } catch (error) {
    addNotice(`File access failed: ${error.message}`);
    setStatus('error', 'file access blocked');
  }
}

function supportsNotifications() {
  return 'Notification' in window;
}

function maybeRequestNotifPermission() {
  if (notificationPermissionRequested || !supportsNotifications()) return;
  if (window.Notification.permission !== 'default') return;

  notificationPermissionRequested = true;
  window.Notification.requestPermission()
    .then(permission => {
      if (permission === 'granted') {
        addNotice('Notifications enabled.');
      }
    })
    .catch(() => {
      notificationPermissionRequested = false;
    });
}

// -- API KEY -------------------------------------------------------------------
function saveKey() {
  apiKey = document.getElementById('api-key').value.trim();
  localStorage.setItem('cloud_api_key', apiKey);
  localStorage.setItem('gemini_api_key', apiKey);
  setStatus('ok', 'key saved');
  maybeRequestNotifPermission();
}

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

// Returns true when the currently-selected Ollama model needs cloud routing.
// Primary check: model name NOT in the ollamaInstalledModels Set (populated by probe).
// Secondary check (when Set is empty / never probed): DOM optgroup id.
function isSelectedOllamaModelCloud() {
  const select = document.getElementById('ollama-model-select');
  if (!select || !select.options.length) return false;
  const idx = select.selectedIndex;
  if (idx < 0) return false;
  const model = select.options[idx].value;
  if (!model) return false; // placeholder selected

  // If we have probe data, trust it: anything not in the installed set is cloud.
  if (ollamaInstalledModels.size > 0) {
    return !ollamaInstalledModels.has(model);
  }

  // Fallback: check which optgroup the option belongs to.
  const group = select.options[idx].parentElement;
  return !!(group && group.id === 'ollama-cloud-optgroup');
}

// -- OLLAMA BACKEND ------------------------------------------------------------

function toggleOllamaBackend() {
  const checkbox = document.getElementById('toggle-ollama');
  ollamaBackend.enabled = checkbox ? checkbox.checked : !ollamaBackend.enabled;
  localStorage.setItem('agent_ollama_enabled', ollamaBackend.enabled ? 'true' : 'false');
  if (ollamaBackend.enabled && localBackend.enabled) {
    // Disable LM Studio when Ollama is turned on
    localBackend.enabled = false;
    localStorage.setItem('agent_prefer_local_backend', 'false');
    const lmToggle = document.getElementById('toggle-local');
    if (lmToggle) lmToggle.checked = false;
  }
  updateBadge();
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

    // Update the installed-models Set (used for reliable local-vs-cloud routing).
    ollamaInstalledModels.clear();
    models.forEach(m => ollamaInstalledModels.add(m.name));

    if (select) {
      const saved = localStorage.getItem('agent_ollama_cloud_model') || '';
      // Remove any previous "Installed" optgroup, keep the static cloud optgroup
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
        // Prepend before the cloud optgroup (or at top if no cloud group)
        cloudGroup ? select.insertBefore(localGroup, cloudGroup) : select.prepend(localGroup);
        if (saved && !select.value) select.value = saved;
      }
      console.debug(`[Ollama] Probe complete: ${models.length} local models, cloud routing guard updated.`);
    }

    if (statusLabel) statusLabel.textContent = `${models.length} model${models.length !== 1 ? 's' : ''} installed`;
    if (dot) dot.className = 'status-dot ok';
  } catch (e) {
    if (statusLabel) statusLabel.textContent = `unreachable: ${e.message}`;
    if (dot) dot.className = 'status-dot error';
  }
}

function loadOllamaBackendState() {
  const urlInput = document.getElementById('ollama-url');
  if (urlInput) urlInput.value = ollamaBackend.url || 'http://localhost:11434';
  const toggle = document.getElementById('toggle-ollama');
  if (toggle) toggle.checked = ollamaBackend.enabled;
  loadOllamaCloudApiKey();
  // Restore saved selection in the select (cloud optgroup is always present)
  const saved = localStorage.getItem('agent_ollama_cloud_model') || '';
  if (saved) {
    const sel = document.getElementById('ollama-model-select');
    if (sel) {
      // Try to select the saved model — it may be in the cloud optgroup already
      const existing = Array.from(sel.options).find(o => o.value === saved);
      if (existing) sel.value = saved;
    }
  }
  // If Ollama is enabled, auto-probe on startup to load installed models
  if (ollamaBackend.enabled) probeOllama().catch(() => {});
}

function saveGithubToken() {
  const token = document.getElementById('github-token').value.trim();
  if (token) {
    localStorage.setItem('github_token', token);
    const status = document.getElementById('github-token-status');
    if (status) {
      status.textContent = 'Token set (5000 req/hr limit)';
      status.style.color = 'var(--green)';
    }
    addNotice('GitHub token saved. Search quota increased to 5000 requests/hour.');
  } else {
    localStorage.removeItem('github_token');
    const status = document.getElementById('github-token-status');
    if (status) {
      status.textContent = 'No token set (60 req/hr limit)';
      status.style.color = 'var(--text-tertiary)';
    }
  }
}

function loadGithubTokenStatus() {
  const token = localStorage.getItem('github_token');
  const input = document.getElementById('github-token');
  const status = document.getElementById('github-token-status');
  
  if (input && token) {
    input.value = token.substring(0, 10) + '...' + token.substring(token.length - 4);
  }
  
  if (status) {
    if (token) {
      status.textContent = 'Token set (5000 req/hr limit)';
      status.style.color = 'var(--green)';
    } else {
      status.textContent = 'No token set (60 req/hr limit)';
      status.style.color = 'var(--text-tertiary)';
    }
  }
}

function loadToolCache() {
  const emptyStore = {
    version: CACHE_SCHEMA_VERSION,
    buckets: { tool: {} }
  };

  try {
    const raw = JSON.parse(localStorage.getItem(TOOL_CACHE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return emptyStore;

    if (Number(raw.version) === CACHE_SCHEMA_VERSION && raw.buckets && typeof raw.buckets === 'object') {
      return raw;
    }

    // Migrate legacy flat map cache into the new namespaced structure.
    return {
      version: CACHE_SCHEMA_VERSION,
      buckets: {
        tool: raw
      }
    };
  } catch {
    return emptyStore;
  }
}

function saveToolCache(cacheStore) {
  try {
    localStorage.setItem(TOOL_CACHE_KEY, JSON.stringify(cacheStore));
  } catch {
    // Quota exceeded or storage blocked — cached results are optional, swallow.
    console.warn('[ToolCache] Could not persist tool cache (storage quota exceeded or blocked).');
  }
}

function getCacheBucket(cacheStore, scope = 'tool') {
  if (!cacheStore.buckets || typeof cacheStore.buckets !== 'object') {
    cacheStore.buckets = {};
  }
  if (!cacheStore.buckets[scope] || typeof cacheStore.buckets[scope] !== 'object') {
    cacheStore.buckets[scope] = {};
  }
  return cacheStore.buckets[scope];
}

function pruneCacheBucket(cacheStore, scope = 'tool') {
  const bucket = getCacheBucket(cacheStore, scope);
  const now = Date.now();
  let changed = false;

  for (const key of Object.keys(bucket)) {
    const entry = bucket[key];
    if (!entry || typeof entry !== 'object') {
      delete bucket[key];
      changed = true;
      continue;
    }

    const ttlMs = Number(entry.ttlMs || TOOL_CACHE_TTL_MS);
    const timestamp = Number(entry.timestamp || 0);
    if (!timestamp || (now - timestamp) > ttlMs) {
      delete bucket[key];
      changed = true;
    }
  }

  return changed;
}

function getToolCacheKey(call) {
  return `${call.tool}:${JSON.stringify(call.args || {})}`;
}

function isCacheableTool(call) {
  const name = String(call?.tool || '');
  if (!name) return false;
  if (NON_CACHEABLE_TOOLS.has(name)) return false;
  if (NON_CACHEABLE_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))) return false;
  return true;
}

function clearToolCache(predicate = () => true) {
  const cacheStore = loadToolCache();
  const cache = getCacheBucket(cacheStore, 'tool');
  let changed = false;

  for (const key of Object.keys(cache)) {
    if (predicate(key, cache[key])) {
      delete cache[key];
      changed = true;
    }
  }

  if (changed) {
    saveToolCache(cacheStore);
  }
}

function getCachedToolResult(call) {
  if (!isCacheableTool(call)) return null;
  const cacheStore = loadToolCache();
  const pruned = pruneCacheBucket(cacheStore, 'tool');
  if (pruned) saveToolCache(cacheStore);
  const cache = getCacheBucket(cacheStore, 'tool');
  const key = getToolCacheKey(call);
  const entry = cache[key];
  if (!entry) return null;

  // Backward compatibility with legacy cache shape.
  if (Object.prototype.hasOwnProperty.call(entry, 'result')) {
    return entry.result;
  }

  return entry.payload;
}

function setCachedToolResult(call, result) {
  if (!isCacheableTool(call)) return;
  const cacheStore = loadToolCache();
  const cache = getCacheBucket(cacheStore, 'tool');
  const key = getToolCacheKey(call);
  const entry = {
    payload: result,
    timestamp: Date.now(),
    ttlMs: TOOL_CACHE_TTL_MS
  };
  cache[key] = entry;
  saveToolCache(cacheStore);
  cacheSyncChannel?.postMessage({
    type: 'cache-set',
    scope: 'tool',
    key,
    entry,
    from: agentInstanceId
  });
}

function updateBusyBadgeHint() {
  const badge = document.getElementById('badge-status');
  if (!badge) return;
  badge.title = otherTabBusy ? 'Another tab is running' : '';
}

function initCacheSync() {
  if (!('BroadcastChannel' in window) || cacheSyncChannel) return;

  cacheSyncChannel = new BroadcastChannel(CACHE_SYNC_CHANNEL);
  cacheSyncChannel.onmessage = event => {
    const { type, scope, key, entry, from } = event.data || {};
    if (from === agentInstanceId || type !== 'cache-set' || !key || !entry) return;

    const cacheStore = loadToolCache();
    const bucket = getCacheBucket(cacheStore, String(scope || 'tool'));
    if (!bucket[key] || Number(bucket[key].timestamp || 0) < Number(entry.timestamp || 0)) {
      bucket[key] = entry;
      saveToolCache(cacheStore);
    }
  };
}

function initBusySync() {
  if (!('BroadcastChannel' in window) || busyChannel) return;

  busyChannel = new BroadcastChannel(BUSY_CHANNEL);
  busyChannel.onmessage = event => {
    const { from, busy } = event.data || {};
    if (from === agentInstanceId) return;
    otherTabBusy = !!busy;
    updateBusyBadgeHint();
  };

  updateBusyBadgeHint();
}

function broadcastBusyState(busy) {
  busyChannel?.postMessage({
    busy: !!busy,
    from: agentInstanceId
  });
}

function loadSessions() {
  const normalizeStats = stats => ({
    rounds: Number(stats?.rounds || 0),
    tools: Number(stats?.tools || 0),
    resets: Number(stats?.resets || 0),
    msgs: Number(stats?.msgs || 0)
  });

  const normalizeSession = (session, index = 0) => {
    const fallbackId = `session_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      id: String(session?.id || fallbackId),
      title: makeSessionTitle(session?.title || 'New session'),
      createdAt: String(session?.createdAt || new Date().toISOString()),
      updatedAt: String(session?.updatedAt || session?.createdAt || new Date().toISOString()),
      messages: Array.isArray(session?.messages) ? session.messages : [],
      stats: normalizeStats(session?.stats),
      context: {
        compactions: Number(session?.context?.compactions || 0),
        lastCompactedAt: session?.context?.lastCompactedAt || null,
        permissionMode: String(session?.context?.permissionMode || 'default'),
        permissionDenialsCount: Number(session?.context?.permissionDenialsCount || 0),
        lastPermissionDeniedAt: session?.context?.lastPermissionDeniedAt || null,
        queryTracking: session?.context?.queryTracking && typeof session.context.queryTracking === 'object'
          ? session.context.queryTracking
          : null
      }
    };
  };

  try {
    const stored = JSON.parse(localStorage.getItem(CHAT_SESSIONS_KEY) || '[]');
    if (Array.isArray(stored)) {
      return stored.map((session, index) => normalizeSession(session, index));
    }

    if (stored && typeof stored === 'object' && Array.isArray(stored.sessions)) {
      return stored.sessions.map((session, index) => normalizeSession(session, index));
    }

    return [];
  } catch {
    return [];
  }
}

function saveSessions() {
  const payload = JSON.stringify({ version: SESSION_SCHEMA_VERSION, sessions: chatSessions });
  try {
    localStorage.setItem(CHAT_SESSIONS_KEY, payload);
  } catch {
    // Quota exceeded — try again with message content stripped to bare metadata.
    try {
      const slim = chatSessions.map(s => ({
        ...s,
        messages: s.messages.slice(-5).map(m => ({ role: m.role, content: String(m.content||'').slice(0, 200) }))
      }));
      localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify({ version: SESSION_SCHEMA_VERSION, sessions: slim }));
    } catch {
      console.warn('[Sessions] Could not persist sessions (storage quota exceeded or blocked).');
    }
  }
}

function makeSessionTitle(sourceText = 'New session') {
  return String(sourceText || 'New session').trim().slice(0, 48) || 'New session';
}

function createSession(initialTitle = 'New session') {
  const session = {
    id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: makeSessionTitle(initialTitle),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    stats: { rounds: 0, tools: 0, resets: 0, msgs: 0 },
    context: {
      compactions: 0,
      lastCompactedAt: null,
      permissionMode: 'default',
      permissionDenialsCount: 0,
      lastPermissionDeniedAt: null,
      queryTracking: null
    }
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

let _saveSessionsTimer = null;

// Debounced save used during the agentic loop to avoid serializing MBs of
// conversation history on every round. Immediate saves are still used for
// session create/delete/switch where fast persistence matters.
function scheduleSaveSessions() {
  if (_saveSessionsTimer) clearTimeout(_saveSessionsTimer);
  _saveSessionsTimer = setTimeout(() => {
    _saveSessionsTimer = null;
    saveSessions();
  }, 2000);
}

// Flush any pending scheduled save (called on page unload).
function flushSaveSessions() {
  if (_saveSessionsTimer) {
    clearTimeout(_saveSessionsTimer);
    _saveSessionsTimer = null;
    saveSessions();
  }
}

function syncSessionState() {
  let session = getActiveSession();
  if (!session) session = createSession();

  session.updatedAt = new Date().toISOString();
  session.messages = messages;
  session.stats = sessionStats;
  scheduleSaveSessions();
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
      <div class="session-item ${session.id === activeSessionId ? 'active' : ''}" onclick="activateSession('${session.id}')">
        <span class="session-title">${escHtml(session.title)}</span>
        <button class="delete-btn" onclick="event.stopPropagation();deleteSession('${session.id}')" title="Delete">×</button>
      </div>`).join('')
    : '<div class="session-empty">No conversations yet</div>';
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
  const container = document.getElementById('messages');
  const chat = document.getElementById('chat');

  // Clear messages container
  if (container) container.innerHTML = '';

  // Show/hide empty state
  const existingEmpty = document.getElementById('empty');
  if (!messages.length) {
    if (!existingEmpty && chat) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'empty-state';
      emptyEl.id = 'empty';
      emptyEl.innerHTML = `
        <div class="empty-logo">⬡</div>
        <div class="empty-title">What can I help you with?</div>
        <div class="empty-examples">
          <button class="example-chip" onclick="useExample(this)">What's the current USD/BRL exchange rate?</button>
          <button class="example-chip" onclick="useExample(this)">Calculate compound interest: $10k at 5.5% for 7 years</button>
          <button class="example-chip" onclick="useExample(this)">Search for the latest Fed rate decision and summarize</button>
          <button class="example-chip" onclick="useExample(this)">What's today's date and what day of the week is it?</button>
        </div>`;
      chat.insertBefore(emptyEl, container || null);
    }
    return;
  }

  if (existingEmpty) existingEmpty.remove();

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
