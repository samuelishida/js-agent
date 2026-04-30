// src/app/llm/mcp-client.js
// MCP (Model Context Protocol) client.
// Connects to external MCP servers via the /api/mcp-proxy route (avoids browser CORS).
// Publishes: window.AgentMcpClient

(() => {
  'use strict';

  const MCP_SERVERS_KEY = 'agent_mcp_servers_v1';
  const MCP_PROTOCOL_VERSION = '2024-11-05';

  function loadMcpServers() {
    try { return JSON.parse(localStorage.getItem(MCP_SERVERS_KEY) || '[]'); }
    catch { return []; }
  }

  function saveMcpServers(servers) {
    localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(servers || []));
  }

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

  async function initializeServer(serverConfig) {
    return mcpRequest(serverConfig.url, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'js-agent', version: '1.0' }
    }, serverConfig.authHeader || '');
  }

  async function listTools(serverConfig) {
    const result = await mcpRequest(serverConfig.url, 'tools/list', {}, serverConfig.authHeader || '');
    return result?.tools || [];
  }

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

  async function testConnection(serverConfig) {
    try {
      await initializeServer(serverConfig);
      const tools = await listTools(serverConfig);
      return { ok: true, toolCount: tools.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function addServer({ url, name, authHeader = '', enabled = true } = {}) {
    if (!String(url || '').trim()) throw new Error('url is required');
    const servers = loadMcpServers();
    const id = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    servers.push({ id, url: String(url).trim(), name: String(name || url).trim(), authHeader, enabled });
    saveMcpServers(servers);
    return id;
  }

  function removeServer(id) {
    saveMcpServers(loadMcpServers().filter(s => s.id !== id));
  }

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
