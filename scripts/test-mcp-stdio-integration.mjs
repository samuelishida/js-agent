// scripts/test-mcp-stdio-integration.mjs
// Tests stdio integration through Manager (not just raw transport)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// ── Browser stubs ───────────────────────────────────────────────────────────
const _store = new Map();
globalThis.localStorage = {
  getItem(k) { return _store.get(k) ?? null; },
  setItem(k, v) { _store.set(k, String(v)); },
  removeItem(k) { _store.delete(k); },
  clear() { _store.clear(); },
  key(i) { return [..._store.keys()][i] ?? null; },
  get length() { return _store.size; }
};

if (!globalThis.window) globalThis.window = {};

let _fetchCalls = [];
let _stdioCallCount = 0;
globalThis.fetch = async (url, init) => {
  _fetchCalls.push({ url, init });
  const makeRes = (data) => ({
    ok: true,
    status: 200,
    headers: { get: h => h === 'content-type' ? 'application/json' : '' },
    text: async () => JSON.stringify(data),
    json: async () => data
  });
  // Mock stdio endpoints
  if (url.includes('/api/mcp-stdio/create')) {
    return makeRes({
      id: 'test-session-123',
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'test-stdio' },
      capabilities: {}
    });
  }
  if (url.includes('/api/mcp-stdio/call/')) {
    const body = JSON.parse(init.body);
    _stdioCallCount++;
    // First call is initialize, second is tools/list
    if (body.method === 'initialize') {
      return makeRes({
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'test-stdio' },
        capabilities: {}
      });
    }
    if (body.method === 'tools/list') {
      return makeRes({ tools: [{ name: 'testTool', description: 'A test tool' }] });
    }
    if (body.method === 'tools/call') {
      return makeRes({ content: [{ type: 'text', text: 'done' }] });
    }
  }
  if (url.includes('/api/mcp-stdio/kill/')) {
    return makeRes({ ok: true });
  }
  return makeRes({ jsonrpc: '2.0', id: 1, result: {} });
};

// ── Load source files ────────────────────────────────────────────────────────
const storeCode = await readFile('src/app/mcp/mcp-store.js', 'utf8');
const httpCode  = await readFile('src/app/mcp/mcp-http-transport.js', 'utf8');
const stdioCode = await readFile('src/app/mcp/mcp-stdio-transport.js', 'utf8');
const mgrCode   = await readFile('src/app/mcp/mcp-manager.js', 'utf8');

vm.runInThisContext(storeCode, { filename: 'mcp-store.js' });
vm.runInThisContext(httpCode,  { filename: 'mcp-http-transport.js' });
vm.runInThisContext(stdioCode, { filename: 'mcp-stdio-transport.js' });
vm.runInThisContext(mgrCode,   { filename: 'mcp-manager.js' });

// ── Helpers ─────────────────────────────────────────────────────────────────
function clearAll() {
  _store.clear();
  _fetchCalls = [];
}

function group(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log('  \u2713 ' + name);
    return { name, ok: true };
  }).catch(err => {
    console.log('  \u2717 ' + name);
    console.log('    ' + err.message);
    console.log('    ' + (err.stack || ''));
    return { name, ok: false, error: err.message };
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────
console.log('MCP Stdio Integration Tests\n');

const results = [];

results.push(await group('Manager stores stdioSessionId in status after connect', async () => {
  clearAll();
  _stdioCallCount = 0;
  const { id } = globalThis.window.AgentMcpStore.addServer({
    name: 'TestStdio',
    transport: 'stdio',
    command: 'node',
    args: ['test.js'],
    enabled: true
  });
  await globalThis.window.AgentMcpManager.connect(id);
  const status = globalThis.window.AgentMcpManager.getStatus(id);
  assert.ok(status, 'status exists');
  assert.strictEqual(status.state, 'connected', 'state is connected');
  assert.ok(status.stdioSessionId, 'sessionId stored in status');
}));

results.push(await group('Manager enriches config with sessionId for stdio calls', async () => {
  clearAll();
  _stdioCallCount = 0;
  const { id } = globalThis.window.AgentMcpStore.addServer({
    name: 'TestStdio2',
    transport: 'stdio',
    command: 'node',
    args: ['test.js'],
    enabled: true
  });
  await globalThis.window.AgentMcpManager.connect(id);
  
  const tools = await globalThis.window.AgentMcpManager.listTools(id);
  assert.ok(Array.isArray(tools), 'tools is array');
  assert.ok(tools.length > 0, 'tools returned');
}));

results.push(await group('Manager callTool uses enriched config with sessionId', async () => {
  clearAll();
  _stdioCallCount = 0;
  const { id } = globalThis.window.AgentMcpStore.addServer({
    name: 'TestStdio3',
    transport: 'stdio',
    command: 'node',
    args: ['test.js'],
    enabled: true
  });
  await globalThis.window.AgentMcpManager.connect(id);
  
  const result = await globalThis.window.AgentMcpManager.callTool(id, 'testTool', {});
  assert.ok(result, 'result exists');
}));

results.push(await group('Manager disconnect uses enriched config', async () => {
  clearAll();
  _stdioCallCount = 0;
  let killCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.includes('/api/mcp-stdio/kill/')) {
      killCalled = true;
      return {
        ok: true,
        status: 200,
        headers: { get: h => h === 'content-type' ? 'application/json' : '' },
        text: async () => JSON.stringify({ ok: true }),
        json: async () => ({ ok: true })
      };
    }
    return origFetch(url, init);
  };
  
  const { id } = globalThis.window.AgentMcpStore.addServer({
    name: 'TestStdio4',
    transport: 'stdio',
    command: 'node',
    args: ['test.js'],
    enabled: true
  });
  await globalThis.window.AgentMcpManager.connect(id);
  globalThis.window.AgentMcpManager.disconnect(id);
  assert.ok(killCalled, 'kill endpoint called');
  
  globalThis.fetch = origFetch;
}));

results.push(await group('Stdio servers treated as localhost (default all tools)', async () => {
  const bridgeCode = await readFile('src/tools/mcp-bridge.js', 'utf8');
  assert.ok(bridgeCode.includes('if (server.transport === \'stdio\') return true;'), 'bridge checks stdio transport');
  console.log('  ✓ Stdio treated as localhost in bridge');
  return { name: 'Stdio servers treated as localhost (default all tools)', ok: true };
}));

// ── Summary ─────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} passed`);
if (passed < total) {
  process.exitCode = 1;
} else {
  console.log('All MCP stdio integration tests passed.\n');
}
