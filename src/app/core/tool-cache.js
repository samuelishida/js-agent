// src/app/core/tool-cache.js
// Tool result caching with TTL eviction and BroadcastChannel sync.

const TOOL_CACHE_KEY = 'agent_tool_cache_v1';
const TOOL_CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 2;
const CACHE_SYNC_CHANNEL = 'loopagent-cache-v1';
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

function loadToolCache() {
  const emptyStore = { version: CACHE_SCHEMA_VERSION, buckets: { tool: {} } };
  try {
    const raw = JSON.parse(localStorage.getItem(TOOL_CACHE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return emptyStore;
    if (Number(raw.version) === CACHE_SCHEMA_VERSION && raw.buckets && typeof raw.buckets === 'object') return raw;
    return { version: CACHE_SCHEMA_VERSION, buckets: { tool: raw } };
  } catch { return emptyStore; }
}

function saveToolCache(cacheStore) {
  try {
    localStorage.setItem(TOOL_CACHE_KEY, JSON.stringify(cacheStore));
  } catch {
    console.warn('[ToolCache] Could not persist tool cache (storage quota exceeded or blocked).');
  }
}

function getCacheBucket(cacheStore, scope = 'tool') {
  if (!cacheStore.buckets || typeof cacheStore.buckets !== 'object') cacheStore.buckets = {};
  if (!cacheStore.buckets[scope] || typeof cacheStore.buckets[scope] !== 'object') cacheStore.buckets[scope] = {};
  return cacheStore.buckets[scope];
}

function pruneCacheBucket(cacheStore, scope = 'tool') {
  const bucket = getCacheBucket(cacheStore, scope);
  const now = Date.now();
  let changed = false;
  for (const key of Object.keys(bucket)) {
    const entry = bucket[key];
    if (!entry || typeof entry !== 'object') { delete bucket[key]; changed = true; continue; }
    const ttlMs = Number(entry.ttlMs || TOOL_CACHE_TTL_MS);
    const timestamp = Number(entry.timestamp || 0);
    if (!timestamp || (now - timestamp) > ttlMs) { delete bucket[key]; changed = true; }
  }
  return changed;
}

function getToolCacheKey(call) {
  const args = call.args || {};
  const keys = Object.keys(args).sort();
  const sorted = {};
  for (const k of keys) sorted[k] = args[k];
  return `${call.tool}:${JSON.stringify(sorted)}`;
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
    if (predicate(key, cache[key])) { delete cache[key]; changed = true; }
  }
  if (changed) saveToolCache(cacheStore);
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
  if (Object.prototype.hasOwnProperty.call(entry, 'result')) return entry.result;
  return entry.payload;
}

function setCachedToolResult(call, result) {
  if (!isCacheableTool(call)) return;
  const cacheStore = loadToolCache();
  const cache = getCacheBucket(cacheStore, 'tool');
  const key = getToolCacheKey(call);
  const entry = { payload: result, timestamp: Date.now(), ttlMs: TOOL_CACHE_TTL_MS };
  cache[key] = entry;
  saveToolCache(cacheStore);
  cacheSyncChannel?.postMessage({ type: 'cache-set', scope: 'tool', key, entry, from: agentInstanceId });
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

window.AgentToolCache = {
  loadToolCache,
  saveToolCache,
  getCacheBucket,
  pruneCacheBucket,
  getToolCacheKey,
  isCacheableTool,
  clearToolCache,
  getCachedToolResult,
  setCachedToolResult,
  initCacheSync
};
