// -- STATE ---------------------------------------------------------------------
let apiKey = localStorage.getItem('cloud_api_key') || localStorage.getItem('gemini_api_key') || '';
let messages = [];   // agentic loop history [{role, content}]
let sessionStats = { rounds: 0, tools: 0, resets: 0, msgs: 0 };
let isBusy = false;
const CHAT_SESSIONS_KEY = 'agent_chat_sessions_v1';
const ACTIVE_SESSION_KEY = 'agent_active_session_v1';
const TOOL_CACHE_KEY = 'agent_tool_cache_v1';
const TOOL_CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 2;
const SESSION_SCHEMA_VERSION = 2;
const DEFAULT_TOOL_CACHE_TTL_MS = TOOL_CACHE_TTL_MS;
const SIDEBAR_COLLAPSED_KEY = 'agent_sidebar_collapsed_v1';
const SIDEBAR_PANELS_KEY = 'agent_sidebar_panels_v1';
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
  'clawd_writeFile',
  'clawd_editFile',
  'clawd_multiEdit',
  'clawd_runTerminal',
  'clawd_todoWrite',
  'clawd_memoryWrite',
  'clawd_spawnAgent'
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
  clawd_readFile: true,
  clawd_writeFile: true,
  clawd_editFile: true,
  clawd_multiEdit: true,
  clawd_listDir: true,
  clawd_glob: true,
  clawd_searchCode: true,
  clawd_runTerminal: true,
  clawd_webFetch: true,
  clawd_getDiagnostics: true,
  clawd_todoWrite: true,
  clawd_memoryRead: true,
  clawd_memoryWrite: true,
  clawd_lsp: true,
  clawd_spawnAgent: true,
  tool_search: true,
  snapshot_skill_catalog: true
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
console.debug(`[State Init] localBackend: enabled=${localBackend.enabled}, url='${localBackend.url}', model='${localBackend.model}'`);
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
function getMaxRounds() { 
  const el = document.getElementById('sl-rounds');
  return el ? parseInt(el.value) : 10;
}

function getCtxLimit() {
  const el = document.getElementById('sl-ctx');
  return el ? parseInt(el.value) * 1000 : 32000;
}

function getDelay() {
  const el = document.getElementById('sl-delay');
  return el ? parseInt(el.value) : 500;
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

function loadSidebarPanels() {
  try {
    return JSON.parse(localStorage.getItem(SIDEBAR_PANELS_KEY) || '{}');
  } catch {
    return {};
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

  const panels = loadSidebarPanels();
  document.querySelectorAll('.sidebar-panel[data-panel]').forEach(panel => {
    const key = panel.dataset.panel;
    if (Object.prototype.hasOwnProperty.call(panels, key)) {
      panel.open = !!panels[key];
    }
  });
}

function bindSidebarPanels() {
  document.querySelectorAll('.sidebar-panel[data-panel]').forEach(panel => {
    panel.addEventListener('toggle', () => {
      const panels = loadSidebarPanels();
      panels[panel.dataset.panel] = panel.open;
      localStorage.setItem(SIDEBAR_PANELS_KEY, JSON.stringify(panels));
    });
  });
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

function saveOllamaCloudEndpoint() {
  const input = document.getElementById('ollama-cloud-endpoint');
  if (!input) return;

  const raw = String(input.value || '').trim();
  if (!raw) {
    localStorage.removeItem('agent_ollama_cloud_endpoint');
    setStatus('ok', 'ollama endpoint reset');
    return;
  }

  // Allow same-origin relative paths (example: /api/ollama/v1) for browser CORS-safe proxying.
  if (raw.startsWith('/')) {
    const normalizedPath = raw.replace(/\/+$/, '') || '/api/ollama/v1';
    localStorage.setItem('agent_ollama_cloud_endpoint', normalizedPath);
    input.value = normalizedPath;
    setStatus('ok', 'ollama endpoint saved');
    return;
  }

  let endpoint = raw;
  if (!/^https?:\/\//i.test(endpoint)) {
    endpoint = `https://${endpoint}`;
  }

  try {
    const parsed = new URL(endpoint);
    let normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
    normalized = normalized.replace(/^https:\/\/api\.ollama\.com$/i, 'https://ollama.com');
    localStorage.setItem('agent_ollama_cloud_endpoint', normalized);
    input.value = normalized;
    setStatus('ok', 'ollama endpoint saved');
  } catch {
    setStatus('error', 'invalid ollama endpoint');
    addNotice('Invalid Ollama endpoint URL. Use https://ollama.com/v1 or /api/ollama/v1');
  }
}

function loadOllamaCloudEndpoint() {
  const input = document.getElementById('ollama-cloud-endpoint');
  if (!input) return;
  // No default — empty means auto: proxy if available, then cloud.
  // User must explicitly set an endpoint to pin behaviour.
  const stored = localStorage.getItem('agent_ollama_cloud_endpoint') || '';
  input.value = stored.startsWith('/')
    ? stored
    : stored.replace(/^https:\/\/api\.ollama\.com/i, 'https://ollama.com');
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
  localStorage.setItem(TOOL_CACHE_KEY, JSON.stringify(cacheStore));
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

    const ttlMs = Number(entry.ttlMs || DEFAULT_TOOL_CACHE_TTL_MS);
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
  pruneCacheBucket(cacheStore, 'tool');
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
    ttlMs: DEFAULT_TOOL_CACHE_TTL_MS
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
  localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify({
    version: SESSION_SCHEMA_VERSION,
    sessions: chatSessions
  }));
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
