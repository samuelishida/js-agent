/**
 * Lightweight connection handling for MCP servers.
 *
 * Provides MCPConnection base class and transport-specific subclasses
 * (stdio, SSE, HTTP) plus a factory function.
 *
 * NOTE: This is a Node.js port of the original connections.py.
 * The actual MCP SDK calls are stubbed — the real SDK (@modelcontextprotocol/sdk)
 * should be used in production. This module provides the structural API.
 */

// ── Base class ────────────────────────────────────────────────────────────────

class MCPConnection {
  constructor() {
    this.session = null;
    this._stack = null;
  }

  /** @returns {AsyncGenerator} Connection context — override in subclass */
  _createContext() {
    throw new Error('_createContext() must be implemented by subclass');
  }

  async [Symbol.asyncDispose]() {
    if (this._stack) {
      try { await this._stack.close(); } catch (_) { /* ignore */ }
    }
    this.session = null;
    this._stack = null;
  }

  async listTools() {
    if (!this.session) throw new Error('Not connected');
    return this.session.listTools();
  }

  async callTool(toolName, args) {
    if (!this.session) throw new Error('Not connected');
    return this.session.callTool(toolName, args);
  }
}

// ── Stdio transport ───────────────────────────────────────────────────────────

class MCPConnectionStdio extends MCPConnection {
  constructor({ command, args = [], env = {} } = {}) {
    super();
    if (!command) throw new Error('command is required for stdio transport');
    this.command = command;
    this.args = args;
    this.env = env;
  }

  _createContext() {
    // In production, use @modelcontextprotocol/sdk Client
    // const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    // return new StdioClientTransport({ command: this.command, args: this.args, env: this.env });
    throw new Error('Stdio transport requires @modelcontextprotocol/sdk — install and uncomment');
  }
}

// ── SSE transport ─────────────────────────────────────────────────────────────

class MCPConnectionSSE extends MCPConnection {
  constructor({ url, headers = {} } = {}) {
    super();
    if (!url) throw new Error('url is required for SSE transport');
    this.url = url;
    this.headers = headers;
  }

  _createContext() {
    // In production, use @modelcontextprotocol/sdk Client
    // const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
    // return new SSEClientTransport({ url: this.url, headers: this.headers });
    throw new Error('SSE transport requires @modelcontextprotocol/sdk — install and uncomment');
  }
}

// ── HTTP (Streamable HTTP) transport ──────────────────────────────────────────

class MCPConnectionHTTP extends MCPConnection {
  constructor({ url, headers = {} } = {}) {
    super();
    if (!url) throw new Error('url is required for HTTP transport');
    this.url = url;
    this.headers = headers;
  }

  _createContext() {
    // In production, use @modelcontextprotocol/sdk Client
    // const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    // return new StreamableHTTPClientTransport({ url: this.url, headers: this.headers });
    throw new Error('HTTP transport requires @modelcontextprotocol/sdk — install and uncomment');
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

function createConnection({ transport, command, args, env, url, headers } = {}) {
  const t = (transport || '').toLowerCase();

  if (t === 'stdio') {
    if (!command) throw new Error('Command is required for stdio transport');
    return new MCPConnectionStdio({ command, args, env });
  }

  if (t === 'sse') {
    if (!url) throw new Error('URL is required for SSE transport');
    return new MCPConnectionSSE({ url, headers });
  }

  if (t === 'http' || t === 'streamable_http' || t === 'streamable-http') {
    if (!url) throw new Error('URL is required for HTTP transport');
    return new MCPConnectionHTTP({ url, headers });
  }

  throw new Error(`Unsupported transport type: ${transport}. Use 'stdio', 'sse', or 'http'`);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  MCPConnection,
  MCPConnectionStdio,
  MCPConnectionSSE,
  MCPConnectionHTTP,
  createConnection,
};