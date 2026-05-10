// src/app/mcp/mcp-manager.js
// Orchestrator for the MCP subsystem. Composes store, transports, filtering, and status.
// Publishes: window.AgentMcpManager

(() => {
  'use strict';

  const Store = window.AgentMcpStore;
  const HttpTransport = window.AgentMcpHttpTransport;
  const StdioTransport = window.AgentMcpStdioTransport;

  if (!Store) {
    console.warn('[MCP Manager] AgentMcpStore not found. MCP subsystem disabled.');
    return;
  }
  if (!StdioTransport) {
    console.warn('[MCP Manager] AgentMcpStdioTransport not found. Stdio transport disabled.');
  }

  /** @type {Map<string, import('../../types/index.js').McpServerConfigV2>} */
  let _servers = new Map();
  /** @type {Map<string, import('../../types/index.js').McpServerStatus>} */
  let _status = new Map();
  /** @type {Set<Function>} */
  const _subscribers = new Set();
  /** @type {Map<string, { timeoutId: number }>} */
  const _reloadQueue = new Map();
  /** @type {number} */
  const RELOAD_QUEUE_MAX_MS = 5 * 60 * 1000;

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Sync internal _servers map from the store.
   * Call before any operation that reads _servers to prevent stale state.
   */
  function syncServersFromStore() {
    const servers = Store.loadServers();
    _servers.clear();
    for (const s of servers) _servers.set(s.id, s);
  }

  /**
   * Load servers from store, migrate v1 if needed, and connect enabled servers.
   * @returns {Promise<void>}
   */
  async function loadAndConnect() {
    if (!Store.isEnabled()) {
      console.log('[MCP Manager] Feature flag disabled; skipping MCP.');
      return;
    }
    syncServersFromStore();

    const enabled = [..._servers.values()].filter(s => s.enabled);
    // Parallel background connect with Promise.allSettled
    await Promise.allSettled(enabled.map(s => connect(s.id)));
  }

  /**
   * Connect to a server (initialize + fetch metadata).
   * @param {string} serverId
   * @returns {Promise<void>}
   */
  async function connect(serverId) {
    syncServersFromStore();
    const config = _servers.get(serverId);
    if (!config) {
      throw new Error(`Server ${serverId} not found`);
    }
    if (!config.enabled) return;

    _setStatus(serverId, { state: 'connecting', refreshRevision: (_status.get(serverId)?.refreshRevision || 0) + 1 });
    const start = performance.now();
    let result;
    if (config.transport === 'stdio') {
      if (!StdioTransport) {
        const errStatus = {
          state: 'error',
          lastError: 'stdio transport not available',
          lastRefreshAt: Date.now(),
          latencyMs: Math.round(performance.now() - start),
          refreshRevision: (_status.get(serverId)?.refreshRevision || 0) + 1
        };
        _setStatus(serverId, errStatus);
        throw new Error('stdio transport not available');
      }
      result = await StdioTransport.connect(config);
      if (result?.error) {
        const errStatus = {
          state: 'error',
          lastError: result.error,
          lastRefreshAt: Date.now(),
          latencyMs: Math.round(performance.now() - start),
          refreshRevision: (_status.get(serverId)?.refreshRevision || 0) + 1
        };
        _setStatus(serverId, errStatus);
        throw new Error(result.error);
      }
      _setStatus(serverId, {
        state: 'connected',
        stdioSessionId: result?.sessionId,
        protocolVersion: result?.protocolVersion,
        serverInfo: result?.serverInfo,
        capabilities: result?.capabilities,
        lastRefreshAt: Date.now(),
        latencyMs: Math.round(performance.now() - start),
        refreshRevision: (_status.get(serverId)?.refreshRevision || 0) + 1
      });
      return;
    }
    result = await HttpTransport.connect(config);
    const latency = Math.round(performance.now() - start);
    if (result?.error) {
      _setStatus(serverId, { state: 'error', lastError: result.error, lastRefreshAt: Date.now(), latencyMs: latency, refreshRevision: (_status.get(serverId)?.refreshRevision || 0) + 1 });
      throw new Error(result.error);
    }
    _setStatus(serverId, {
      state: 'connected',
      protocolVersion: result?.protocolVersion,
      serverInfo: result?.serverInfo,
      capabilities: result?.capabilities,
      lastRefreshAt: Date.now(),
      latencyMs: latency,
      refreshRevision: (_status.get(serverId)?.refreshRevision || 0) + 1
    });
  }

  /**
   * Disconnect from a server.
   * @param {string} serverId
   * @returns {void}
   */
  function disconnect(serverId) {
    syncServersFromStore();
    const st = _status.get(serverId);
    if (!st) return;
    const config = _servers.get(serverId);
    if (config?.transport === 'stdio' && StdioTransport) {
      StdioTransport.disconnect(config);
    } else {
      HttpTransport.disconnect();
    }
    _setStatus(serverId, { state: 'disconnected', stdioSessionId: undefined });
  }

  /**
   * Reload a single server (reconnect + refresh tools).
   * @param {string} serverId
   * @returns {Promise<void>}
   */
  async function reloadServer(serverId) {
    syncServersFromStore();
    const activeRun = window.AgentRunGraph?.getActiveRun?.();
    if (activeRun?.status === 'running') {
      // Queue reload
      if (_reloadQueue.has(serverId)) clearTimeout(_reloadQueue.get(serverId).timeoutId);
      const timeoutId = setTimeout(() => {
        _reloadQueue.delete(serverId);
        reloadServer(serverId).catch(() => {});
      }, RELOAD_QUEUE_MAX_MS);
      _reloadQueue.set(serverId, { timeoutId });
      _setStatus(serverId, { state: 'idle', lastError: 'Reload queued until active run completes' });
      return;
    }

    // Unregister stale tools before reconnect
    window.AgentMcpBridge?.unregisterMcpTools?.(serverId);
    await connect(serverId);
    // Adapter must re-register after this
    window.AgentMcpBridge?.discoverAndRegisterMcpTools?.().catch(() => {});
  }

  /**
   * Reload all enabled servers.
   * @returns {Promise<void>}
   */
  async function reloadAll() {
    syncServersFromStore();
    const enabled = [..._servers.values()].filter(s => s.enabled).map(s => s.id);
    await Promise.allSettled(enabled.map(id => reloadServer(id)));
  }

  /**
   * List tools for a server (from cached status) or fetch if missing.
   * @param {string} serverId
   * @returns {Promise<object[]>}
   */
  async function listTools(serverId) {
    syncServersFromStore();
    const config = _servers.get(serverId);
    if (!config) throw new Error(`Server ${serverId} not found`);
    const cached = _status.get(serverId)?.tools;
    if (Array.isArray(cached) && cached.length > 0) return cached;
    const transport = _getTransport(config);
    const tools = await transport.listTools(config);
    _setStatus(serverId, { tools });
    return tools;
  }

  /**
   * Call a tool on a server.
   * @param {string} serverId
   * @param {string} toolName
   * @param {Record<string,any>} [args]
   * @returns {Promise<{ content?: {type:string,text?:string}[], isError?: boolean, error?: string }>}
   */
  async function callTool(serverId, toolName, args = {}) {
    syncServersFromStore();
    const config = _servers.get(serverId);
    if (!config) throw new Error(`Server ${serverId} not found`);
    // Heartbeat: if stale > 60s, do a lightweight ping
    const st = _status.get(serverId);
    if (st && st.state === 'connected' && st.lastRefreshAt && (Date.now() - st.lastRefreshAt) > 60000) {
      const ping = await _getTransport(config).connect(config);
      if (ping?.error) {
        _setStatus(serverId, { state: 'error', lastError: ping.error });
        return { error: `Server ${serverId} stale: ${ping.error}` };
      }
      _setStatus(serverId, { lastRefreshAt: Date.now() });
    }
    return _getTransport(config).callTool(config, toolName, args);
  }

  /**
   * Get server status.
   * @param {string} serverId
   * @returns {import('../../types/index.js').McpServerStatus | undefined}
   */
  function getStatus(serverId) {
    syncServersFromStore();
    return _status.get(serverId);
  }

  /**
   * Subscribe to status changes.
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  function subscribe(callback) {
    if (typeof callback !== 'function') return () => {};
    _subscribers.add(callback);
    return () => _subscribers.delete(callback);
  }

  /**
   * Set tool filter for a server.
   * @param {string} serverId
   * @param {import('../../types/index.js').McpToolFilter} filter
   * @returns {boolean}
   */
  function setToolFilter(serverId, filter) {
    const ok = Store.updateServer(serverId, { toolFilter: filter });
    if (!ok) return false;
    syncServersFromStore();
    return true;
  }

  /**
   * Get tool filter for a server.
   * @param {string} serverId
   * @returns {import('../../types/index.js').McpToolFilter | undefined}
   */
  function getToolFilter(serverId) {
    return _servers.get(serverId)?.toolFilter;
  }

  /**
   * Choose the right transport for a config.
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @returns {object}
   */
  function _getTransport(config) {
    return config?.transport === 'stdio' && StdioTransport ? StdioTransport : HttpTransport;
  }

  /**
   * List resources for a server.
   * @param {string} serverId
   * @returns {Promise<object[]>}
   */
  async function listResources(serverId) {
    syncServersFromStore();
    const config = _servers.get(serverId);
    if (!config) throw new Error(`Server ${serverId} not found`);
    const cached = _status.get(serverId)?.resources;
    if (Array.isArray(cached) && cached.length > 0) return cached;
    const transport = _getTransport(config);
    const resources = await transport.listResources(config);
    _setStatus(serverId, { resources });
    return resources;
  }

  /**
   * Read a resource from a server.
   * @param {string} serverId
   * @param {string} uri
   * @returns {Promise<object>}
   */
  async function readResource(serverId, uri) {
    syncServersFromStore();
    const config = _servers.get(serverId);
    if (!config) throw new Error(`Server ${serverId} not found`);
    return _getTransport(config).readResource(config, uri);
  }

  /**
   * List prompts for a server.
   * @param {string} serverId
   * @returns {Promise<object[]>}
   */
  async function listPrompts(serverId) {
    syncServersFromStore();
    const config = _servers.get(serverId);
    if (!config) throw new Error(`Server ${serverId} not found`);
    const cached = _status.get(serverId)?.prompts;
    if (Array.isArray(cached) && cached.length > 0) return cached;
    const transport = _getTransport(config);
    const prompts = await transport.listPrompts(config);
    _setStatus(serverId, { prompts });
    return prompts;
  }

  /**
   * Get a prompt from a server.
   * @param {string} serverId
   * @param {string} name
   * @param {Record<string,any>} [args]
   * @returns {Promise<object>}
   */
  async function getPrompt(serverId, name, args = {}) {
    syncServersFromStore();
    const config = _servers.get(serverId);
    if (!config) throw new Error(`Server ${serverId} not found`);
    return _getTransport(config).getPrompt(config, name, args);
  }

  /**
   * Refresh a server if its cached data is stale.
   * @param {string} serverId
   * @returns {Promise<void>}
   */
  async function refreshIfNeeded(serverId) {
    syncServersFromStore();
    const config = _servers.get(serverId);
    if (!config || !config.enabled) return;
    const st = _status.get(serverId);
    if (!st || st.state !== 'connected') {
      await connect(serverId);
      return;
    }
    const transport = _getTransport(config);
    const [tools, resources, prompts] = await Promise.allSettled([
      transport.listTools(config),
      transport.listResources(config),
      transport.listPrompts(config)
    ]);
    const patch = {
      tools: tools.status === 'fulfilled' ? tools.value : st.tools,
      resources: resources.status === 'fulfilled' ? resources.value : st.resources,
      prompts: prompts.status === 'fulfilled' ? prompts.value : st.prompts,
      lastRefreshAt: Date.now()
    };
    _setStatus(serverId, patch);
  }

  /**
   * Map MCP tool schema to existing risk taxonomy.
   * @param {object} toolSchema
   * @returns {'safe'|'irreversible'|'shared'}
   */
  function _mapRisk(toolSchema) {
    const n = String(toolSchema?.name || '').toLowerCase();
    const safe = /read|get|list|search|fetch|describe|info|status/;
    const irreversible = /write|edit|delete|create|update|modify|send|post|put|patch|remove|drop|clear|kill|exec|spawn|run|deploy/;
    if (safe.test(n)) return 'safe';
    if (irreversible.test(n)) return 'irreversible';
    return 'shared';
  }

  /**
   * Generate a safe tool name for the registry.
   * @param {string} slug
   * @param {string} rawName
   * @returns {string}
   */
  function _safeToolName(slug, rawName) {
    const safe = String(rawName || '').replace(/[^a-z0-9_]/gi, '_');
    return `mcp_${slug}_${safe}`;
  }

  /**
   * @returns {import('../../types/index.js').McpServerConfigV2[]}
   */
  function getServers() {
    syncServersFromStore();
    return [..._servers.values()];
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * @param {string} serverId
   * @param {Partial<import('../../types/index.js').McpServerStatus>} patch
   */
  function _setStatus(serverId, patch) {
    const existing = _status.get(serverId) || {
      serverId,
      state: 'idle',
      tools: [],
      resources: [],
      prompts: [],
      refreshRevision: 0
    };
    /** @type {import('../../types/index.js').McpServerStatus} */
    const next = { ...existing, ...patch };
    // Arrays should be replaced, not merged
    if (patch.tools !== undefined) next.tools = patch.tools;
    if (patch.resources !== undefined) next.resources = patch.resources;
    if (patch.prompts !== undefined) next.prompts = patch.prompts;
    if (patch.capabilities !== undefined) next.capabilities = patch.capabilities;
    if (patch.serverInfo !== undefined) next.serverInfo = patch.serverInfo;
    _status.set(serverId, next);
    _notify();
  }

  function _notify() {
    for (const cb of _subscribers) {
      try { cb(); } catch (e) { console.warn('[MCP Manager] subscriber error:', e); }
    }
  }

  window.AgentMcpManager = {
    loadAndConnect,
    connect,
    disconnect,
    reloadServer,
    reloadAll,
    listTools,
    callTool,
    listResources,
    readResource,
    listPrompts,
    getPrompt,
    refreshIfNeeded,
    getStatus,
    subscribe,
    setToolFilter,
    getToolFilter,
    _mapRisk,
    _safeToolName,
    getServers
  };
})();
