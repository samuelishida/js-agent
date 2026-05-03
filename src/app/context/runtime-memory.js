// src/app/context/runtime-memory.js
// Runtime cache and long-term memory management.

(() => {
  /** @type {string} */
  const RUNTIME_CACHE_KEY = 'agent_runtime_cache_v1';
  /** @type {number} */
  const RUNTIME_CACHE_SCHEMA = 1;
  /** @type {string} */
  const LONG_TERM_MEMORY_KEY = 'agent_long_term_memory_v1';
  /** @type {number} */
  const LONG_TERM_MEMORY_SCHEMA = 1;
  /** @type {number} */
  const MAX_LONG_TERM_MEMORIES = 400;

  /** @type {Object<string, {ttlMs: number, maxEntries: number, maxBytes: number}>} */
  const DEFAULT_SCOPE_POLICIES = {
    tool_hot: { ttlMs: 10 * 60 * 1000, maxEntries: 400, maxBytes: 2_000_000 },
    context_summary: { ttlMs: 6 * 60 * 60 * 1000, maxEntries: 160, maxBytes: 1_000_000 },
    tool_result_digest: { ttlMs: 24 * 60 * 60 * 1000, maxEntries: 600, maxBytes: 2_000_000 },
    tool_result_archive: { ttlMs: 24 * 60 * 60 * 1000, maxEntries: 300, maxBytes: 2_500_000 },
    memory_retrieval: { ttlMs: 5 * 60 * 1000, maxEntries: 200, maxBytes: 600_000 }
  };

  /**
   * Safely parse JSON.
   * @param {string} value - JSON string
   * @param {any} fallback - Fallback value
   * @returns {any} Parsed value or fallback
   */
  function safeJsonParse(value, fallback) {
    try {
      const parsed = JSON.parse(String(value || ''));
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Get current ISO timestamp.
   * @returns {string} ISO string
   */
  function nowIso() {
    return new Date().toISOString();
  }

  /**
   * Convert value to number with fallback.
   * @param {any} value - Value to convert
   * @param {number} [fallback=0] - Fallback
   * @returns {number} Number or fallback
   */
  function toNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  /**
   * Estimate byte size of a value.
   * @param {any} value - Value to measure
   * @returns {number} Byte size
   */
  function estimateBytes(value) {
    try {
      return JSON.stringify(value).length;
    } catch {
      return String(value || '').length;
    }
  }

  /**
   * Normalize scope policy with overrides.
   * @param {string} scope - Cache scope
   * @param {Object} [overrides={}] - Policy overrides
   * @returns {{ttlMs: number, maxEntries: number, maxBytes: number}} Normalized policy
   */
  function normalizeScopePolicy(scope, overrides = {}) {
    const base = DEFAULT_SCOPE_POLICIES[scope] || { ttlMs: 10 * 60 * 1000, maxEntries: 200, maxBytes: 1_000_000 };
    return {
      ttlMs: Math.max(1_000, toNumber(overrides.ttlMs, base.ttlMs)),
      maxEntries: Math.max(10, toNumber(overrides.maxEntries, base.maxEntries)),
      maxBytes: Math.max(10_000, toNumber(overrides.maxBytes, base.maxBytes))
    };
  }

  /**
   * Load runtime cache store from localStorage.
   * @returns {{version: number, scopes: Object}} Cache store
   */
  function loadRuntimeCacheStore() {
    const empty = { version: RUNTIME_CACHE_SCHEMA, scopes: {} };
    const raw = safeJsonParse(localStorage.getItem(RUNTIME_CACHE_KEY), null);
    if (!raw || typeof raw !== 'object') return empty;
    if (toNumber(raw.version) === RUNTIME_CACHE_SCHEMA && raw.scopes && typeof raw.scopes === 'object') {
      return raw;
    }
    if (raw.buckets && typeof raw.buckets === 'object') {
      return { version: RUNTIME_CACHE_SCHEMA, scopes: raw.buckets };
    }
    return empty;
  }

  /**
   * Save runtime cache store to localStorage.
   * @param {{version: number, scopes: Object}} store - Cache store
   * @returns {void}
   */
  function saveRuntimeCacheStore(store) {
    try {
      localStorage.setItem(RUNTIME_CACHE_KEY, JSON.stringify(store));
    } catch {
      console.warn('[RuntimeCache] Could not persist cache (storage quota exceeded or blocked).');
    }
  }

  /**
   * Ensure a scope exists in the cache store.
   * @param {{version: number, scopes: Object}} store - Cache store
   * @param {string} scope - Scope name
   * @returns {Object} Scope bucket
   */
  function ensureScope(store, scope) {
    if (!store.scopes || typeof store.scopes !== 'object') {
      store.scopes = {};
    }
    if (!store.scopes[scope] || typeof store.scopes[scope] !== 'object') {
      store.scopes[scope] = {};
    }
    return store.scopes[scope];
  }

  /**
   * Prune expired entries from a runtime scope.
   * @param {{version: number, scopes: Object}} store - Cache store
   * @param {string} scope - Scope name
   * @param {Object} [options={}] - Prune options
   * @returns {boolean} True if changes were made
   */
  function pruneRuntimeScope(store, scope, options = {}) {
    const bucket = ensureScope(store, scope);
    const policy = normalizeScopePolicy(scope, options);
    const now = Date.now();
    let changed = false;

    for (const key of Object.keys(bucket)) {
      const entry = bucket[key];
      if (!entry || typeof entry !== 'object') {
        delete bucket[key];
        changed = true;
        continue;
      }
      const timestamp = toNumber(entry.timestamp);
      const ttlMs = Math.max(1_000, toNumber(entry.ttlMs, policy.ttlMs));
      if (!timestamp || (now - timestamp) > ttlMs) {
        delete bucket[key];
        changed = true;
      }
    }

    const entries = Object.entries(bucket).map(([key, entry]) => ({
      key,
      entry,
      sizeBytes: Math.max(1, toNumber(entry?.sizeBytes, estimateBytes(entry?.payload))),
      lastAccessedAt: toNumber(entry?.lastAccessedAt, toNumber(entry?.timestamp))
    }));

    let totalBytes = entries.reduce((sum, item) => sum + item.sizeBytes, 0);

    if (entries.length > policy.maxEntries || totalBytes > policy.maxBytes) {
      const sorted = entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
      for (const item of sorted) {
        if (Object.keys(bucket).length <= policy.maxEntries && totalBytes <= policy.maxBytes) break;
        delete bucket[item.key];
        totalBytes -= item.sizeBytes;
        changed = true;
      }
    }

    return changed;
  }

  /**
   * Get a value from runtime cache.
   * @param {string} scope - Cache scope
   * @param {string} key - Cache key
   * @param {Object} [options={}] - Options
   * @returns {any|null} Cached value or null
   */
  function getRuntimeCache(scope, key, options = {}) {
    const store = loadRuntimeCacheStore();
    const bucket = ensureScope(store, scope);
    const changed = pruneRuntimeScope(store, scope, options);
    const entry = bucket[key];
    if (!entry) {
      if (changed) saveRuntimeCacheStore(store);
      return null;
    }

    entry.lastAccessedAt = Date.now();
    entry.hits = toNumber(entry.hits, 0) + 1;
    if (entry.hits % 10 === 0 || changed) saveRuntimeCacheStore(store);
    return entry.payload;
  }

  /**
   * Set a value in runtime cache.
   * @param {string} scope - Cache scope
   * @param {string} key - Cache key
   * @param {any} payload - Value to cache
   * @param {Object} [options={}] - Options
   * @returns {boolean} True if set
   */
  function setRuntimeCache(scope, key, payload, options = {}) {
    const store = loadRuntimeCacheStore();
    const bucket = ensureScope(store, scope);
    const policy = normalizeScopePolicy(scope, options);
    const timestamp = Date.now();
    const sizeBytes = estimateBytes(payload);

    if (sizeBytes > policy.maxBytes) {
      return false;
    }

    bucket[key] = {
      payload,
      timestamp,
      lastAccessedAt: timestamp,
      ttlMs: policy.ttlMs,
      hits: 0,
      sizeBytes
    };

    pruneRuntimeScope(store, scope, options);
    saveRuntimeCacheStore(store);
    return true;
  }

  /**
   * Delete a key from runtime cache.
   * @param {string} scope - Cache scope
   * @param {string} key - Cache key
   * @returns {boolean} True if deleted
   */
  function deleteRuntimeCache(scope, key) {
    const store = loadRuntimeCacheStore();
    const bucket = ensureScope(store, scope);
    if (!Object.prototype.hasOwnProperty.call(bucket, key)) return false;
    delete bucket[key];
    saveRuntimeCacheStore(store);
    return true;
  }

  /**
   * Clear all entries in a runtime scope.
   * @param {string} scope - Cache scope
   * @returns {void}
   */
  function clearRuntimeScope(scope) {
    const store = loadRuntimeCacheStore();
    if (!store.scopes || typeof store.scopes !== 'object') return;
    delete store.scopes[scope];
    saveRuntimeCacheStore(store);
  }

  /**
   * Normalize tags array.
   * @param {any[]} tags - Raw tags
   * @returns {string[]} Normalized tags
   */
  function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return [...new Set(tags
      .map(tag => String(tag || '').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12))];
  }

  /**
   * Normalize memory text.
   * @param {string} text - Raw text
   * @returns {string} Normalized text
   */
  function normalizeMemoryText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 480);
  }

  /**
   * Generate a fingerprint for memory text.
   * @param {string} text - Text to fingerprint
   * @returns {string} Fingerprint
   */
  function memoryFingerprint(text) {
    return normalizeMemoryText(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function loadLongTermMemoryStore() {
    const empty = { version: LONG_TERM_MEMORY_SCHEMA, entries: [] };
    const raw = safeJsonParse(localStorage.getItem(LONG_TERM_MEMORY_KEY), null);
    if (!raw || typeof raw !== 'object') return empty;
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    return {
      version: LONG_TERM_MEMORY_SCHEMA,
      entries: entries
        .map(entry => {
          const text = normalizeMemoryText(entry?.text);
          if (!text) return null;
          const createdAt = String(entry?.createdAt || nowIso());
          const updatedAt = String(entry?.updatedAt || createdAt);
          return {
            id: String(entry?.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
            text,
            tags: normalizeTags(entry?.tags),
            source: String(entry?.source || 'auto'),
            importance: Math.max(0, Math.min(1, toNumber(entry?.importance, 0.4))),
            createdAt,
            updatedAt,
            lastAccessedAt: String(entry?.lastAccessedAt || updatedAt),
            useCount: Math.max(0, Math.floor(toNumber(entry?.useCount, 0))),
            fingerprint: String(entry?.fingerprint || memoryFingerprint(text))
          };
        })
        .filter(Boolean)
        .slice(0, MAX_LONG_TERM_MEMORIES)
    };
  }

  function saveLongTermMemoryStore(store) {
    const sorted = [...(store.entries || [])]
      .sort((a, b) => toNumber(Date.parse(b.updatedAt)) - toNumber(Date.parse(a.updatedAt)))
      .slice(0, MAX_LONG_TERM_MEMORIES);

    localStorage.setItem(
      LONG_TERM_MEMORY_KEY,
      JSON.stringify({
        version: LONG_TERM_MEMORY_SCHEMA,
        entries: sorted
      })
    );
  }

  function writeLongTermMemory({ text, tags = [], source = 'auto', importance = 0.5 } = {}) {
    const normalizedText = normalizeMemoryText(text);
    if (!normalizedText) {
      return { saved: false, reason: 'empty_text' };
    }

    const fingerprint = memoryFingerprint(normalizedText);
    if (!fingerprint || fingerprint.length < 8) {
      return { saved: false, reason: 'too_short' };
    }

    const store = loadLongTermMemoryStore();
    const existing = store.entries.find(entry => entry.fingerprint === fingerprint);
    const timestamp = nowIso();

    if (existing) {
      existing.updatedAt = timestamp;
      existing.lastAccessedAt = timestamp;
      existing.useCount = Math.max(0, toNumber(existing.useCount, 0));
      existing.tags = [...new Set([...normalizeTags(existing.tags), ...normalizeTags(tags)])].slice(0, 12);
      existing.importance = Math.max(existing.importance, Math.max(0, Math.min(1, toNumber(importance, 0.5))));
      if (source && source !== 'auto') existing.source = String(source);
      saveLongTermMemoryStore(store);
      return { saved: true, duplicate: true, entry: existing };
    }

    const entry = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: normalizedText,
      tags: normalizeTags(tags),
      source: String(source || 'auto'),
      importance: Math.max(0, Math.min(1, toNumber(importance, 0.5))),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAccessedAt: timestamp,
      useCount: 0,
      fingerprint
    };

    store.entries.unshift(entry);
    saveLongTermMemoryStore(store);
    return { saved: true, duplicate: false, entry };
  }

  function listLongTermMemories({ limit = 50 } = {}) {
    const max = Math.max(1, Math.min(500, toNumber(limit, 50)));
    const store = loadLongTermMemoryStore();
    return store.entries.slice(0, max);
  }

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 2);
  }

  function scoreMemory(entry, queryTokens) {
    const textTokens = new Set(tokenize(entry.text));
    const tagTokens = new Set((entry.tags || []).flatMap(tag => tokenize(tag)));
    const overlap = queryTokens.filter(token => textTokens.has(token) || tagTokens.has(token)).length;
    const overlapScore = queryTokens.length ? overlap / queryTokens.length : 0;

    const ageHours = Math.max(0, (Date.now() - toNumber(Date.parse(entry.updatedAt))) / (1000 * 60 * 60));
    const recencyScore = 1 / (1 + ageHours / 72);
    const usageScore = Math.min(0.2, Math.log1p(toNumber(entry.useCount, 0)) * 0.05);
    const importanceScore = Math.max(0, Math.min(1, toNumber(entry.importance, 0.4)));

    return overlapScore * 0.6 + recencyScore * 0.2 + importanceScore * 0.15 + usageScore * 0.05;
  }

  function searchLongTermMemories({ query = '', limit = 8 } = {}) {
    const max = Math.max(1, Math.min(40, toNumber(limit, 8)));
    const normalizedQuery = normalizeMemoryText(query);
    const cacheKey = `${normalizedQuery.toLowerCase()}::${max}`;
    const cached = getRuntimeCache('memory_retrieval', cacheKey);
    if (cached) return cached;

    const tokens = tokenize(normalizedQuery);
    const store = loadLongTermMemoryStore();
    const scored = store.entries
      .map(entry => ({ entry, score: scoreMemory(entry, tokens) }))
      .filter(item => item.score > 0.08)
      .sort((a, b) => b.score - a.score)
      .slice(0, max);

    const selected = scored.map(item => item.entry);
    setRuntimeCache('memory_retrieval', cacheKey, selected);
    return selected;
  }

  function touchMemoryEntries(entries = []) {
    if (!entries.length) return;
    const store = loadLongTermMemoryStore();
    const now = nowIso();
    const ids = new Set(entries.map(entry => entry.id));
    let changed = false;

    for (const entry of store.entries) {
      if (!ids.has(entry.id)) continue;
      entry.useCount = Math.max(0, toNumber(entry.useCount, 0)) + 1;
      entry.lastAccessedAt = now;
      changed = true;
    }

    if (changed) {
      saveLongTermMemoryStore(store);
      clearRuntimeScope('memory_retrieval');
    }
  }

  function buildMemoryContextBlock(userMessage, historyMessages = []) {
    const queryContext = [
      String(userMessage || ''),
      ...((Array.isArray(historyMessages) ? historyMessages : [])
        .filter(item => item?.role === 'user')
        .slice(-2)
        .map(item => String(item.content || '')))
    ].join('\n');

    const matches = searchLongTermMemories({ query: queryContext, limit: 6 });
    if (!matches.length) return '';
    touchMemoryEntries(matches);

    const lines = matches.map((entry, index) => {
      const tags = entry.tags?.length ? ` [tags: ${entry.tags.join(', ')}]` : '';
      return `${index + 1}. ${entry.text}${tags}`;
    });

    return `<long_term_memory>\n${lines.join('\n')}\n</long_term_memory>`;
  }

  function extractMemoryCandidatesFromText(text) {
    const value = String(text || '').trim();
    if (!value) return [];

    const candidates = [];
    const lines = value
      .split(/\r?\n/)
      .map(line => line.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 30);

    const explicitRemember = /\b(remember|from now on|always|never|my preference|i prefer|use this setting)\b/i;
    const profileSignal = /\b(my name is|i am|i'm|my timezone|i use|my project|my repo|my stack|my default)\b/i;

    for (const line of lines) {
      if (line.length < 18 || line.length > 280) continue;
      if (explicitRemember.test(line) || profileSignal.test(line)) {
        candidates.push(line);
      }
    }

    return [...new Set(candidates)];
  }

  function extractFromTurn({ userMessage = '', assistantMessage = '' } = {}) {
    const candidates = [
      ...extractMemoryCandidatesFromText(userMessage),
      ...extractMemoryCandidatesFromText(assistantMessage)
    ];

    let saved = 0;
    let duplicates = 0;
    for (const candidate of candidates.slice(0, 6)) {
      const result = writeLongTermMemory({
        text: candidate,
        source: 'auto',
        importance: /\b(always|never|critical|must)\b/i.test(candidate) ? 0.8 : 0.5
      });
      if (!result.saved) continue;
      if (result.duplicate) duplicates += 1;
      else saved += 1;
    }

    return { scanned: candidates.length, saved, duplicates };
  }

  function formatMemoryList(entries) {
    if (!entries.length) return '(no memories)';
    return entries
      .map((entry, index) => {
        const tags = entry.tags?.length ? ` [${entry.tags.join(', ')}]` : '';
        return `${index + 1}. ${entry.text}${tags}`;
      })
      .join('\n');
  }

  window.AgentRuntimeCache = {
    get: getRuntimeCache,
    set: setRuntimeCache,
    delete: deleteRuntimeCache,
    clearScope: clearRuntimeScope,
    pruneScope(scope, options) {
      const store = loadRuntimeCacheStore();
      const changed = pruneRuntimeScope(store, scope, options);
      if (changed) saveRuntimeCacheStore(store);
      return changed;
    }
  };

  window.AgentMemory = {
    write: writeLongTermMemory,
    list: listLongTermMemories,
    search: searchLongTermMemories,
    buildContextBlock: buildMemoryContextBlock,
    extractFromTurn,
    formatList: formatMemoryList,
    onTurnComplete({ userMessage = '', assistantMessage = '' } = {}) {
      return extractFromTurn({ userMessage, assistantMessage });
    }
  };
})();
