// src/app/mcp/mcp-http-transport.js
// MCP HTTP transport using /api/mcp-proxy. Publishes: window.AgentMcpHttpTransport

(() => {
  'use strict';

  const MCP_PROTOCOL_VERSION = '2024-11-05';
  const REQUEST_TIMEOUT = 15000;

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @returns {Promise<{ protocolVersion: string, serverInfo: object, capabilities: object } | { error: string }>}
   */
  async function connect(config) {
    try {
      const result = await _httpRequest(config, 'initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        clientInfo: { name: 'js-agent', version: '1.0' }
      });
      if (result?.error) return { error: String(result.error.message || result.error) };
      return {
        protocolVersion: result?.protocolVersion || MCP_PROTOCOL_VERSION,
        serverInfo: result?.serverInfo || {},
        capabilities: result?.capabilities || {}
      };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }

  /** @returns {void} */
  function disconnect() {
    // HTTP transport is stateless; no-op
  }

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @returns {Promise<object[]>}
   */
  async function listTools(config) {
    try {
      const result = await _httpRequest(config, 'tools/list', {});
      return result?.tools || [];
    } catch (err) {
      console.warn('[MCP HTTP] listTools error:', err.message || err);
      return [];
    }
  }

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @param {string} toolName
   * @param {Record<string,any>} args
   * @returns {Promise<object>}
   */
  async function callTool(config, toolName, args = {}) {
    try {
      const result = await _httpRequest(config, 'tools/call', { name: toolName, arguments: args });
      if (result?.isError) {
        const msg = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        throw new Error(`MCP tool error: ${msg || 'unknown error'}`);
      }
      return result;
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @returns {Promise<object[]>}
   */
  async function listResources(config) {
    try {
      const result = await _httpRequest(config, 'resources/list', {});
      return result?.resources || [];
    } catch (err) {
      console.warn('[MCP HTTP] listResources error:', err.message || err);
      return [];
    }
  }

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @param {string} uri
   * @returns {Promise<object>}
   */
  async function readResource(config, uri) {
    try {
      const result = await _httpRequest(config, 'resources/read', { uri });
      return result;
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @returns {Promise<object[]>}
   */
  async function listPrompts(config) {
    try {
      const result = await _httpRequest(config, 'prompts/list', {});
      return result?.prompts || [];
    } catch (err) {
      console.warn('[MCP HTTP] listPrompts error:', err.message || err);
      return [];
    }
  }

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @param {string} name
   * @param {Record<string,any>} [args]
   * @returns {Promise<object>}
   */
  async function getPrompt(config, name, args = {}) {
    try {
      const result = await _httpRequest(config, 'prompts/get', { name, arguments: args });
      return result;
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @param {string} method
   * @param {Record<string,any>} params
   * @returns {Promise<object>}
   */
  async function _httpRequest(config, method, params = {}) {
    const url = String(config.url || '').trim();
    if (!url) throw new Error('Server URL is required');
    const authHeader = _resolveAuthHeader(config);
    const headers = { ...config.headers };
    if (authHeader) headers['Authorization'] = authHeader;

    const res = await fetchWithTimeout('/api/mcp-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: url, method, params, headers })
    }, REQUEST_TIMEOUT);

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MCP proxy HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`MCP proxy returned invalid JSON: ${text.slice(0, 200)}`); }
    if (data.error) {
      throw new Error(`MCP error [${data.error.code ?? '?'}]: ${data.error.message || JSON.stringify(data.error)}`);
    }
    return data.result;
  }

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @returns {string|null}
   */
  function _resolveAuthHeader(config) {
    if (!config.authRef) return null;
    const ref = String(config.authRef).trim();
    // Browser-only: try localStorage header store (v1 compat)
    if (ref.startsWith('localstorage:')) {
      const key = ref.slice('localstorage:'.length);
      try { return localStorage.getItem(key) || null; } catch { return null; }
    }
    if (ref.startsWith('header:')) {
      return ref.slice('header:'.length);
    }
    return ref;
  }

  /**
   * Fetch with a timeout.
   * @param {string} url
   * @param {RequestInit} init
   * @param {number} timeoutMs
   * @returns {Promise<Response>}
   */
  async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(id);
    }
  }

  window.AgentMcpHttpTransport = {
    connect,
    disconnect,
    listTools,
    callTool,
    listResources,
    readResource,
    listPrompts,
    getPrompt
  };
})();
