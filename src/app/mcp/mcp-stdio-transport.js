// src/app/mcp/mcp-stdio-transport.js
// MCP stdio transport using dev-server sidecar. Publishes: window.AgentMcpStdioTransport

(() => {
  'use strict';

  const REQUEST_TIMEOUT = 15000;

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @returns {Promise<{ sessionId: string, protocolVersion: string, serverInfo: object, capabilities: object } | { error: string }>}
   */
  async function connect(config) {
    try {
      const token = window.__terminalToken || '';
      const res = await fetchWithTimeout('/api/mcp-stdio/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd
        })
      }, REQUEST_TIMEOUT);

      const data = await res.json();
      if (!res.ok || data.error) {
        return { error: data.error || `HTTP ${res.status}` };
      }

      const sessionId = data.id;
      if (!sessionId) return { error: 'No session id returned' };

      // Send initialize
      const init = await _call(sessionId, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        clientInfo: { name: 'js-agent', version: '1.0' }
      });
      if (init?.error) return { error: String(init.error.message || init.error) };

      return {
        sessionId,
        protocolVersion: init?.protocolVersion || '2024-11-05',
        serverInfo: init?.serverInfo || {},
        capabilities: init?.capabilities || {}
      };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @returns {Promise<{ ok: boolean } | { error: string }>}
   */
  async function disconnect(config) {
    try {
      const token = window.__terminalToken || '';
      const sessionId = config.stdioSessionId;
      if (!sessionId) return { ok: true };
      const res = await fetchWithTimeout(`/api/mcp-stdio/kill/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      }, REQUEST_TIMEOUT);
      const data = await res.json();
      return { ok: res.ok && !data.error };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }

  /**
   * @param {import('../../types/index.js').McpServerConfigV2} config
   * @returns {Promise<object[]>}
   */
  async function listTools(config) {
    try {
      const result = await _callByConfig(config, 'tools/list', {});
      return result?.tools || [];
    } catch (err) {
      console.warn('[MCP stdio] listTools error:', err.message || err);
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
      const result = await _callByConfig(config, 'tools/call', { name: toolName, arguments: args });
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
      const result = await _callByConfig(config, 'resources/list', {});
      return result?.resources || [];
    } catch (err) {
      console.warn('[MCP stdio] listResources error:', err.message || err);
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
      const result = await _callByConfig(config, 'resources/read', { uri });
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
      const result = await _callByConfig(config, 'prompts/list', {});
      return result?.prompts || [];
    } catch (err) {
      console.warn('[MCP stdio] listPrompts error:', err.message || err);
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
      const result = await _callByConfig(config, 'prompts/get', { name, arguments: args });
      return result;
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }

  async function _callByConfig(config, method, params) {
    const sessionId = config.stdioSessionId;
    if (!sessionId) throw new Error('No stdio session');
    return _call(sessionId, method, params);
  }

  async function _call(sessionId, method, params) {
    const token = window.__terminalToken || '';
    const res = await fetchWithTimeout(`/api/mcp-stdio/call/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ method, params })
    }, REQUEST_TIMEOUT);

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MCP stdio call HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Invalid JSON: ${text.slice(0, 200)}`); }
    if (data.error) throw new Error(`MCP error: ${data.error}`);
    return data;
  }

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

  window.AgentMcpStdioTransport = {
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
