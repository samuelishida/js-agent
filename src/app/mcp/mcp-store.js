// src/app/mcp/mcp-store.js
// MCP server config persistence, migration (v1 -> v2), CRUD, and slugging.
// Publishes: window.AgentMcpStore

(() => {
  'use strict';

  /** @type {string} */
  const MCP_V2_KEY = 'agent_mcp_servers_v2';
  /** @type {string} */
  const MCP_V1_KEY = 'agent_mcp_servers_v1';
  /** @type {string} */
  const BACKUP_KEY_PREFIX = 'agent_mcp_servers_v1_backup_';
  /** @type {string} */
  const FEATURE_FLAG_KEY = 'agent_mcp_manager_enabled';

  /**
   * Internal: create a Map-backed localStorage-like store.
   * @returns {Storage}
   */
  function _makeMapStorage() {
    const map = new Map();
    return {
      getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
      setItem: (key, value) => map.set(String(key), String(value)),
      removeItem: key => map.delete(String(key)),
      clear: () => map.clear(),
      key: index => [...map.keys()][index] ?? null,
      get length() { return map.size; }
    };
  }

  /** @type {Storage} */
  const _storage = (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage) ? globalThis.localStorage : _makeMapStorage();

  /**
   * Load all MCP server configs (v2). Migrates v1 if present.
   * @returns {import('../../types/index.js').McpServerConfigV2[]}
   */
  function loadServers() {
    const rawV1 = _storage.getItem(MCP_V1_KEY);
    if (rawV1 !== null) {
      try {
        const parsed = JSON.parse(rawV1);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const { servers } = migrateV1(parsed);
          const saveResult = saveServers(servers);
          if (saveResult.ok) {
            _storage.setItem(BACKUP_KEY_PREFIX + Date.now(), rawV1);
            _storage.removeItem(MCP_V1_KEY);
          }
        } else {
          _storage.removeItem(MCP_V1_KEY);
        }
      } catch (err) {
        _storage.setItem(BACKUP_KEY_PREFIX + Date.now(), rawV1);
        _storage.setItem(MCP_V2_KEY, JSON.stringify({ version: 2, servers: [], _migrationError: String(err.message || err) }));
        _storage.removeItem(MCP_V1_KEY);
      }
    }

    try {
      const raw = _storage.getItem(MCP_V2_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.servers)) {
        return parsed.servers.map(normalizeServer);
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Save all MCP server configs (v2).
   * @param {import('../../types/index.js').McpServerConfigV2[]} servers
   * @returns {{ ok: boolean, error?: string }}
   */
  function saveServers(servers) {
    try {
      _storage.setItem(MCP_V2_KEY, JSON.stringify({ version: 2, servers: servers || [] }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  /**
   * Migrate v1 server configs to v2 shape.
   * @param {any[]} serversV1
   * @returns {{ servers: import('../../types/index.js').McpServerConfigV2[], backupKey?: string }}
   */
  function migrateV1(serversV1) {
    /** @type {import('../../types/index.js').McpServerConfigV2[]} */
    const servers = [];
    const seenIds = new Set();

    for (const s of serversV1) {
      if (!s || typeof s !== 'object') continue;
      let id = String(s.id || '');
      if (!id || seenIds.has(id)) {
        id = _generateId();
      }
      seenIds.add(id);

      /** @type {Record<string,string>} */
      const headers = {};
      const rawAuth = s.authHeader || s.authRef;
      if (typeof rawAuth === 'string' && rawAuth.trim()) {
        headers['Authorization'] = rawAuth.trim();
      }

      servers.push(normalizeServer({
        id,
        name: String(s.name || s.url || id),
        transport: 'http',
        enabled: !!s.enabled,
        url: String(s.url || '').trim() || undefined,
        headers: Object.keys(headers).length ? headers : undefined,
        createdAt: Number(s.createdAt) || Date.now(),
        updatedAt: Number(s.updatedAt) || Date.now()
      }));
    }

    const backupKey = BACKUP_KEY_PREFIX + Date.now();
    return { servers, backupKey };
  }

  /**
   * Add a new MCP server.
   * @param {Partial<import('../../types/index.js').McpServerConfigV2>} cfg
   * @returns {{ id: string }}
   */
  function addServer(cfg) {
    const servers = loadServers();
    const id = _generateId();
    const now = Date.now();
    const server = normalizeServer({
      id,
      name: cfg.name ? String(cfg.name).trim() : `Server ${id.slice(0, 6)}`,
      transport: cfg.transport || 'http',
      enabled: cfg.enabled !== false,
      url: cfg.url ? String(cfg.url).trim() : undefined,
      command: cfg.command ? String(cfg.command).trim() : undefined,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : undefined,
      headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : undefined,
      authRef: cfg.authRef ? String(cfg.authRef) : undefined,
      toolFilter: cfg.toolFilter || undefined,
      resourceFilter: cfg.resourceFilter || undefined,
      promptFilter: cfg.promptFilter || undefined,
      riskPolicy: cfg.riskPolicy ? String(cfg.riskPolicy) : undefined,
      createdAt: now,
      updatedAt: now
    });
    servers.push(server);
    saveServers(servers);
    return { id };
  }

  /**
   * Update an existing MCP server (partial).
   * @param {string} id
   * @param {Partial<import('../../types/index.js').McpServerConfigV2>} patch
   * @returns {boolean}
   */
  function updateServer(id, patch) {
    const servers = loadServers();
    const idx = servers.findIndex(s => s.id === id);
    if (idx === -1) return false;
    const existing = servers[idx];
    const updated = normalizeServer({
      ...existing,
      ...(patch.name !== undefined ? { name: String(patch.name).trim() } : {}),
      ...(patch.transport !== undefined ? { transport: patch.transport } : {}),
      ...(patch.enabled !== undefined ? { enabled: !!patch.enabled } : {}),
      ...(patch.url !== undefined ? { url: patch.url ? String(patch.url).trim() : undefined } : {}),
      ...(patch.command !== undefined ? { command: patch.command ? String(patch.command).trim() : undefined } : {}),
      ...(patch.args !== undefined ? { args: Array.isArray(patch.args) ? patch.args.map(String) : undefined } : {}),
      ...(patch.env !== undefined ? { env: patch.env && typeof patch.env === 'object' ? patch.env : undefined } : {}),
      ...(patch.headers !== undefined ? { headers: patch.headers && typeof patch.headers === 'object' ? patch.headers : undefined } : {}),
      ...(patch.authRef !== undefined ? { authRef: patch.authRef ? String(patch.authRef) : undefined } : {}),
      ...(patch.toolFilter !== undefined ? { toolFilter: patch.toolFilter } : {}),
      ...(patch.resourceFilter !== undefined ? { resourceFilter: patch.resourceFilter } : {}),
      ...(patch.promptFilter !== undefined ? { promptFilter: patch.promptFilter } : {}),
      ...(patch.riskPolicy !== undefined ? { riskPolicy: patch.riskPolicy ? String(patch.riskPolicy) : undefined } : {}),
      updatedAt: Date.now()
    });
    servers[idx] = updated;
    saveServers(servers);
    return true;
  }

  /**
   * Remove an MCP server.
   * @param {string} id
   * @returns {boolean}
   */
  function removeServer(id) {
    const servers = loadServers();
    const idx = servers.findIndex(s => s.id === id);
    if (idx === -1) return false;
    servers.splice(idx, 1);
    saveServers(servers);
    return true;
  }

  /**
   * Toggle enabled state.
   * @param {string} id
   * @param {boolean} enabled
   * @returns {boolean}
   */
  function setEnabled(id, enabled) {
    return updateServer(id, { enabled });
  }

  /**
   * Generate a server id.
   * @returns {string}
   */
  function _generateId() {
    return `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Slugify a display name.
   * @param {string} name
   * @returns {string}
   */
  function _slugify(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  /**
   * Compute server slug from config.
   * @param {import('../../types/index.js').McpServerConfigV2} server
   * @returns {string}
   */
  function _serverSlug(server) {
    const base = _slugify(server.name || server.url || server.command || server.id);
    if (!base) return 'unknown';
    return base;
  }

  /**
   * Normalize a raw server object into a clean v2 shape.
   * @param {any} raw
   * @returns {import('../../types/index.js').McpServerConfigV2}
   */
  function normalizeServer(raw) {
    const now = Date.now();
    return {
      id: String(raw.id || _generateId()),
      name: String(raw.name || raw.id || 'Untitled').trim(),
      transport: (raw.transport === 'stdio' || raw.transport === 'sse' || raw.transport === 'streamable_http') ? raw.transport : 'http',
      enabled: !!raw.enabled,
      url: raw.url ? String(raw.url).trim() : undefined,
      command: raw.command ? String(raw.command).trim() : undefined,
      args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
      env: raw.env && typeof raw.env === 'object' ? raw.env : undefined,
      headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : undefined,
      authRef: raw.authRef ? String(raw.authRef) : undefined,
      toolFilter: raw.toolFilter && typeof raw.toolFilter === 'object' ? {
        mode: ['all', 'none', 'include'].includes(raw.toolFilter.mode) ? raw.toolFilter.mode : 'all',
        names: Array.isArray(raw.toolFilter.names) ? raw.toolFilter.names.map(String) : undefined
      } : undefined,
      resourceFilter: raw.resourceFilter && typeof raw.resourceFilter === 'object' ? {
        mode: ['all', 'none', 'include'].includes(raw.resourceFilter.mode) ? raw.resourceFilter.mode : 'all',
        uris: Array.isArray(raw.resourceFilter.uris) ? raw.resourceFilter.uris.map(String) : undefined
      } : undefined,
      promptFilter: raw.promptFilter && typeof raw.promptFilter === 'object' ? {
        mode: ['all', 'none', 'include'].includes(raw.promptFilter.mode) ? raw.promptFilter.mode : 'all',
        names: Array.isArray(raw.promptFilter.names) ? raw.promptFilter.names.map(String) : undefined
      } : undefined,
      riskPolicy: raw.riskPolicy ? String(raw.riskPolicy) : undefined,
      createdAt: Number(raw.createdAt) || now,
      updatedAt: Number(raw.updatedAt) || now
    };
  }

  /**
   * Read the feature flag state.
   * @returns {boolean}
   */
  function isEnabled() {
    try {
      const raw = _storage.getItem(FEATURE_FLAG_KEY);
      if (raw === null) return true;
      return raw !== 'false';
    } catch {
      return true;
    }
  }

  window.AgentMcpStore = {
    loadServers,
    saveServers,
    migrateV1,
    addServer,
    updateServer,
    removeServer,
    setEnabled,
    _generateId,
    _slugify,
    _serverSlug,
    normalizeServer,
    isEnabled
  };
})();
