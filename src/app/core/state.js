// src/app/core/state.js
// Core state: variables, window bindings, runtime glue, and delegations to
// extracted modules (session-manager, tool-cache, provider-state).

function safeGet(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

let apiKey = safeGet('cloud_api_key') || safeGet('gemini_api_key') || '';
let messages = [];
let sessionStats = { rounds: 0, tools: 0, resets: 0, msgs: 0 };
let isBusy = false;

const SIDEBAR_COLLAPSED_KEY = 'agent_sidebar_collapsed_v1';
const SIDEBAR_AUTO_COLLAPSE_WIDTH = 1180;
const BUSY_CHANNEL = 'loopagent-busy-v1';

let otherTabBusy = false;

let enabledTools = {
  web_search:true, calc:true, datetime:true, read_page:true, web_fetch:true,
  geo_current_location:true, weather_current:true, http_fetch:true,
  extract_links:true, page_metadata:true, parse_json:true, parse_csv:true,
  clipboard_read:true, clipboard_write:true, storage_list_keys:true,
  storage_get:true, storage_set:true, notification_request_permission:true,
  notification_send:true, tab_broadcast:true, tab_listen:true,
  fs_list_roots:true, fs_pick_directory:true, fs_list_dir:true,
  fs_read_file:true, fs_upload_pick:true, fs_save_upload:true,
  fs_download_file:true, fs_preview_file:true, fs_search_name:true,
  fs_search_content:true, fs_glob:true, fs_grep:true, fs_tree:true,
  fs_walk:true, fs_exists:true, fs_stat:true, fs_mkdir:true, fs_touch:true,
  fs_write_file:true, fs_copy_file:true, fs_move_file:true,
  fs_delete_path:true, fs_rename_path:true, file_read:true, read_file:true,
  file_write:true, write_file:true, file_edit:true, edit_file:true,
  glob:true, grep:true, todo_write:true, task_create:true, task_get:true,
  task_list:true, task_update:true, worker_batch:true, worker_list:true,
  worker_get:true, ask_user_question:true, memory_write:true,
  memory_search:true, memory_list:true, runtime_readFile:true,
  runtime_writeFile:true, runtime_editFile:true, runtime_multiEdit:true,
  runtime_listDir:true, runtime_glob:true, runtime_searchCode:true,
  runtime_runTerminal:true, runtime_webFetch:true, runtime_getDiagnostics:true,
  runtime_todoWrite:true, runtime_memoryRead:true, runtime_memoryWrite:true,
  runtime_lsp:true, runtime_spawnAgent:true, tool_search:true,
  snapshot_skill_catalog:true
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

let openrouterBackend = {
  enabled: safeGet('agent_openrouter_enabled') === 'true',
  apiKey: safeGet('agent_openrouter_api_key') || '',
  model: safeGet('agent_openrouter_model') || 'nvidia/nemotron-3-super-120b-a12b:free',
};

const ollamaInstalledModels = new Set();
const ollamaModelContextSizes = new Map();

console.debug(`[State Init] localBackend: enabled=${localBackend.enabled}, url='${localBackend.url}', model='${localBackend.model}'`);
console.debug(`[State Init] ollamaBackend: enabled=${ollamaBackend.enabled}, url='${ollamaBackend.url}'`);

let chatSessions = [];
let activeSessionId = safeGet('agent_active_session_v1') || null;

// BroadcastChannel state (used by initCacheSync, initBusySync, broadcastBusyState)
// cacheSyncChannel is declared in tool-cache.js (loaded before state.js)
let busyChannel = null;

// agentInstanceId is defined in tool-cache.js; state.js uses it in BroadcastChannel handlers
// CACHE_SCHEMA_VERSION is defined in tool-cache.js; used in fallback loadToolCache delegation

function normalizeSessionStats(value) {
  return {
    rounds: Number(value?.rounds || 0),
    tools: Number(value?.tools || 0),
    resets: Number(value?.resets || 0),
    msgs: Number(value?.msgs || 0)
  };
}

function bindWindowStateProperty(name, getter, setter) {
  Object.defineProperty(window, name, {
    configurable: true, enumerable: true,
    get: getter,
    set: setter
  });
}

bindWindowStateProperty('apiKey', () => apiKey, value => { apiKey = String(value || ''); });
bindWindowStateProperty('messages', () => messages, value => { messages = Array.isArray(value) ? value : []; });
bindWindowStateProperty('sessionStats', () => sessionStats, value => { sessionStats = normalizeSessionStats(value); });
bindWindowStateProperty('isBusy', () => isBusy, value => { isBusy = !!value; });
bindWindowStateProperty('enabledTools', () => enabledTools, value => { if (value && typeof value === 'object' && !Array.isArray(value)) enabledTools = value; });
bindWindowStateProperty('localBackend', () => localBackend, value => { if (value && typeof value === 'object' && !Array.isArray(value)) localBackend = value; });
bindWindowStateProperty('ollamaBackend', () => ollamaBackend, value => { if (value && typeof value === 'object' && !Array.isArray(value)) ollamaBackend = value; });
bindWindowStateProperty('openrouterBackend', () => openrouterBackend, value => { if (value && typeof value === 'object' && !Array.isArray(value)) openrouterBackend = value; });
bindWindowStateProperty('chatSessions', () => chatSessions, value => { chatSessions = Array.isArray(value) ? value : []; });
bindWindowStateProperty('activeSessionId', () => activeSessionId, value => { activeSessionId = value == null ? null : String(value); });

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
  if (!runtimeReady()) throw new Error('Agent bootstrap failed: required modules were not loaded.');
}

// -- File access --------------------------------------------------------------
function updateFileAccessStatus() {
  const el = document.getElementById('file-access-status');
  if (!el) return;
  const roots = [...(window.AgentSkills?.state?.roots?.keys?.() || [])];
  el.textContent = roots.length ? `authorized: ${roots.join(', ')}` : 'no folder authorized';
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

// -- GitHub token -------------------------------------------------------------
function saveGithubToken() {
  const token = document.getElementById('github-token').value.trim();
  if (token) {
    localStorage.setItem('github_token', token);
    const status = document.getElementById('github-token-status');
    if (status) { status.textContent = 'Token set (5000 req/hr limit)'; status.style.color = 'var(--green)'; }
    addNotice('GitHub token saved. Search quota increased to 5000 requests/hour.');
  } else {
    localStorage.removeItem('github_token');
    const status = document.getElementById('github-token-status');
    if (status) { status.textContent = 'No token set (60 req/hr limit)'; status.style.color = 'var(--text-tertiary)'; }
  }
}

function loadGithubTokenStatus() {
  const token = localStorage.getItem('github_token');
  const input = document.getElementById('github-token');
  const status = document.getElementById('github-token-status');
  if (input && token) input.value = token.substring(0, 10) + '...' + token.substring(token.length - 4);
  if (status) {
    if (token) { status.textContent = 'Token set (5000 req/hr limit)'; status.style.color = 'var(--green)'; }
    else { status.textContent = 'No token set (60 req/hr limit)'; status.style.color = 'var(--text-tertiary)'; }
  }
}

// -- BroadcastChannel sync ----------------------------------------------------
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
  busyChannel?.postMessage({ busy: !!busy, from: agentInstanceId });
}

// -- Delegations to extracted modules -----------------------------------------
// Session Manager
function loadSessions() { return window.AgentSessionManager?.loadSessions() ?? []; }
function saveSessions() { return window.AgentSessionManager?.saveSessions(); }
function makeSessionTitle(sourceText) { return window.AgentSessionManager?.makeSessionTitle(sourceText) ?? 'New session'; }
function createSession(initialTitle) { return window.AgentSessionManager?.createSession(initialTitle); }
function resetLiveSessionState() { return window.AgentSessionManager?.resetLiveSessionState(); }
function clearSession() { return window.AgentSessionManager?.clearSession(); }
function getActiveSession() { return window.AgentSessionManager?.getActiveSession() ?? null; }
function scheduleSaveSessions() { return window.AgentSessionManager?.scheduleSaveSessions(); }
function flushSaveSessions() { return window.AgentSessionManager?.flushSaveSessions(); }
function syncSessionState() { return window.AgentSessionManager?.syncSessionState(); }
function activateSession(sessionId) { return window.AgentSessionManager?.activateSession(sessionId); }
function deleteSession(sessionId) { return window.AgentSessionManager?.deleteSession(sessionId); }
function deleteAllSessions() { return window.AgentSessionManager?.deleteAllSessions(); }

// Tool Cache
function loadToolCache() { return window.AgentToolCache?.loadToolCache() ?? { version: CACHE_SCHEMA_VERSION, buckets: { tool: {} } }; }
function saveToolCache(cacheStore) { return window.AgentToolCache?.saveToolCache(cacheStore); }
function getCacheBucket(cacheStore, scope) { return window.AgentToolCache?.getCacheBucket(cacheStore, scope) ?? {}; }
function pruneCacheBucket(cacheStore, scope) { return window.AgentToolCache?.pruneCacheBucket(cacheStore, scope) ?? false; }
function getToolCacheKey(call) { return window.AgentToolCache?.getToolCacheKey(call) ?? ''; }
function isCacheableTool(call) { return window.AgentToolCache?.isCacheableTool(call) ?? false; }
function clearToolCache(predicate) { return window.AgentToolCache?.clearToolCache(predicate); }
function getCachedToolResult(call) { return window.AgentToolCache?.getCachedToolResult(call) ?? null; }
function setCachedToolResult(call, result) { return window.AgentToolCache?.setCachedToolResult(call, result); }

// Provider State
function getMaxRounds() { return window.AgentProviderState?.getMaxRounds() ?? 50; }
function getCtxLimit() { return window.AgentProviderState?.getCtxLimit() ?? 128000; }
function getDelay() { return window.AgentProviderState?.getDelay() ?? 500; }
function getStoredCloudModelSelection() { return window.AgentProviderState?.getStoredCloudModelSelection() ?? 'gemini/gemini-2.5-flash'; }
function getSelectedCloudModelLabel() { return window.AgentProviderState?.getSelectedCloudModelLabel() ?? 'gemini/gemini-2.5-flash'; }
function activateCloudProvider(opts) { return window.AgentProviderState?.activateCloudProvider(opts); }
function saveKey() { return window.AgentProviderState?.saveKey(); }
function saveCloudModelSelection() { return window.AgentProviderState?.saveCloudModelSelection(); }
function loadCloudModelSelection() { return window.AgentProviderState?.loadCloudModelSelection(); }
function isLocalModeActive() { return window.AgentProviderState?.isLocalModeActive() ?? false; }
function isOllamaReady() { return window.AgentProviderState?.isOllamaReady() ?? { ready: false, reason: '' }; }
function getSelectedCloudProvider() { return window.AgentProviderState?.getSelectedCloudProvider() ?? 'gemini'; }
function getCloudReadiness() { return window.AgentProviderState?.getCloudReadiness() ?? { ready: false, reason: '' }; }
function canUseCloud() { return window.AgentProviderState?.canUseCloud() ?? false; }
