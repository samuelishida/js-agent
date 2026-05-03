// src/app/llm/mcp-client.js
// MCP (Model Context Protocol) client.
// Connects to external MCP servers via the /api/mcp-proxy route (avoids browser CORS).
// Publishes: window.AgentMcpClient

(() => {
  'use strict';

  /** @type {string} */
  const MCP_SERVERS_KEY = 'agent_mcp_servers_v1';
  /** @type {string} */
  const MCP_PROTOCOL_VERSION = '2024-11-05';

  /**
   * Load MCP servers from localStorage.
   * @returns {Array<Object>} Server configs
   */
  function loadMcpServers() {
    try { return JSON.parse(localStorage.getItem(MCP_SERVERS_KEY) || '[]'); }
    catch { return []; }
  }

  /**
   * Save MCP servers to localStorage.
   * @param {Array<Object>} servers - Server configs
   * @returns {void}
   */
  function saveMcpServers(servers) {
    localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(servers || []));
  }

  /**
   * Make an MCP request via proxy.
   * @param {string} serverUrl - MCP server URL
   * @param {string} method - JSON-RPC method
   * @param {Object} [params={}] - Request params
   * @param {string} [authHeader=''] - Auth header
   * @returns {Promise<any>} Response result
   */
  async function mcpRequest(serverUrl, method, params = {}, authHeader = '') {
    const res = await fetch('/api/mcp-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: String(serverUrl), method, params, authHeader })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP proxy HTTP ${res.status}: ${text.slice(0, 200)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`MCP proxy returned invalid JSON: ${text.slice(0, 200)}`); }
    if (data.error) {
      throw new Error(`MCP error [${data.error.code ?? '?'}]: ${data.error.message || JSON.stringify(data.error)}`);
    }
    return data.result;
  }

  /**
   * Initialize an MCP server.
   * @param {Object} serverConfig - Server config
   * @returns {Promise<any>} Initialize result
   */
  async function initializeServer(serverConfig) {
    return mcpRequest(serverConfig.url, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'js-agent', version: '1.0' }
    }, serverConfig.authHeader || '');
  }

  /**
   * List tools from an MCP server.
   * @param {Object} serverConfig - Server config
   * @returns {Promise<Array>} Tool list
   */
  async function listTools(serverConfig) {
    const result = await mcpRequest(serverConfig.url, 'tools/list', {}, serverConfig.authHeader || '');
    return result?.tools || [];
  }

  /**
   * Call a tool on an MCP server.
   * @param {Object} serverConfig - Server config
   * @param {string} toolName - Tool name
   * @param {Object} [args={}] - Tool arguments
   * @returns {Promise<string>} Tool result
   */
  async function callTool(serverConfig, toolName, args = {}) {
    const result = await mcpRequest(
      serverConfig.url,
      'tools/call',
      { name: toolName, arguments: args },
      serverConfig.authHeader || ''
    );
    // MCP tools/call returns { content: [{ type: 'text'|'image', text: '...' }], isError?: bool }
    if (result?.isError) {
      const msg = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      throw new Error(`MCP tool error: ${msg || 'unknown error'}`);
    }
    return (result?.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n') || JSON.stringify(result);
  }

  /**
   * Test connection to an MCP server.
   * @param {Object} serverConfig - Server config
   * @returns {Promise<{ok: boolean, toolCount?: number, error?: string}>} Test result
   */
  async function testConnection(serverConfig) {
    try {
      await initializeServer(serverConfig);
      const tools = await listTools(serverConfig);
      return { ok: true, toolCount: tools.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Add an MCP server.
   * @param {Object} [opts={}] - Options
   * @param {string} opts.url - Server URL
   * @param {string} [opts.name] - Server name
   * @param {string} [opts.authHeader=''] - Auth header
   * @param {boolean} [opts.enabled=true] - Enabled flag
   * @returns {string} Server ID
   */
  function addServer({ url, name, authHeader = '', enabled = true } = {}) {
    if (!String(url || '').trim()) throw new Error('url is required');
    const servers = loadMcpServers();
    const id = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    servers.push({ id, url: String(url).trim(), name: String(name || url).trim(), authHeader, enabled });
    saveMcpServers(servers);
    return id;
  }

  /**
   * Remove an MCP server.
   * @param {string} id - Server ID
   * @returns {void}
   */
  function removeServer(id) {
    saveMcpServers(loadMcpServers().filter(s => s.id !== id));
  }

  /**
   * Toggle MCP server enabled state.
   * @param {string} id - Server ID
   * @param {boolean} enabled - Enabled state
   * @returns {void}
   */
  function toggleServer(id, enabled) {
    saveMcpServers(loadMcpServers().map(s => s.id === id ? { ...s, enabled } : s));
  }

  window.AgentMcpClient = {
    loadMcpServers,
    saveMcpServers,
    initializeServer,
    listTools,
    callTool,
    testConnection,
    addServer,
    removeServer,
    toggleServer
  };
})();
