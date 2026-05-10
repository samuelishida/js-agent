// src/app/mcp/mcp-http-transport.js
// MCP HTTP/SSE transport using /api/mcp-proxy and /api/mcp-sse-proxy.
// Publishes: window.AgentMcpHttpTransport

(() => {
  'use strict';

  const MCP_PROTOCOL_VERSION = '2024-11-05';
  const REQUEST_TIMEOUT = 15000;

  /**
   * Choose the proxy route based on transport type.
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @returns {string}
   */
  function _proxyRoute(config) {
    return config.transport === 'sse' ? '/api/mcp-sse-proxy' : '/api/mcp-proxy';
  }

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
    // HTTP transport is stateless; SSE sessions are managed server-side
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
   * Detect HTML responses (e.g. VS Code "Cannot POST /sse" page) and produce
   * an actionable error instead of "invalid JSON".
   * @param {string} text
   * @param {string} serverUrl
   * @returns {Error|null}
   */
  function _maybeHtmlError(text, serverUrl) {
    const trimmed = text.trim();
    if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<!doctype')) {
      return new Error(
        `Server returned HTML instead of JSON. ` +
        `This looks like an SSE endpoint (e.g. VS Code MCP). ` +
        `Select SSE transport in settings or use the Streamable HTTP /mcp endpoint. ` +
        `URL: ${serverUrl}`
      );
    }
    if (/<html/i.test(trimmed) && /<body/i.test(trimmed)) {
      return new Error(
        `Server returned HTML page. ` +
        `If this is an SSE endpoint, switch the transport to SSE in MCP settings. ` +
        `URL: ${serverUrl}`
      );
    }
    return null;
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

    const res = await fetchWithTimeout(_proxyRoute(config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverUrl: url, method, params, headers })
    }, REQUEST_TIMEOUT);

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MCP proxy HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const htmlErr = _maybeHtmlError(text, url);
    if (htmlErr) throw htmlErr;

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
