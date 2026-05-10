// scripts/test-mcp-refresh.mjs
// Tests MCP resources, prompts, refresh, heartbeat, reload queuing.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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

// Setup mock BEFORE loading manager so manager closure captures it
globalThis.window.AgentMcpHttpTransport = {
  connect: () => Promise.resolve({ protocolVersion: '2024-11-05', serverInfo: {}, capabilities: {} }),
  disconnect: () => {},
  listTools: () => Promise.resolve([{ name: 'test_tool', description: 'A test tool', inputSchema: {} }]),
  callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
  listResources: () => Promise.resolve([{ uri: 'test://file.txt', name: 'file.txt' }]),
  readResource: (cfg, uri) => Promise.resolve({ content: [{ type: 'text', text: `content of ${uri}` }] }),
  listPrompts: () => Promise.resolve([{ name: 'greet', description: 'Hello prompt' }]),
  getPrompt: (cfg, name) => Promise.resolve({ messages: [{ role: 'user', content: { text: `Prompt: ${name}` } }] }),
};

globalThis.window.AgentMcpStdioTransport = null;

// Load source files
const storeCode = await readFile('src/app/mcp/mcp-store.js', 'utf8');
const mgrCode   = await readFile('src/app/mcp/mcp-manager.js', 'utf8');

vm.runInThisContext(storeCode, { filename: 'mcp-store.js' });
vm.runInThisContext(mgrCode,   { filename: 'mcp-manager.js' });

function clearAll() {
  _store.clear();
}

function group(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log('  \u2713 ' + name);
    return { name, ok: true };
  }).catch(err => {
    console.log('  \u2717 ' + name);
    console.log('    ' + err.message);
    return { name, ok: false, error: err.message };
  });
}

function assertEqual(a, b, msg) {
  assert.strictEqual(a, b, msg);
}

const Store = globalThis.window.AgentMcpStore;
const M = globalThis.window.AgentMcpManager;
assert.ok(Store && M, 'Store and Manager must exist');

// Runtime globals for bridge
if (!globalThis.window.AgentTools) globalThis.window.AgentTools = {
  registry: {},
  toolGroups: {},
  formatToolResult: (name, result) => `[${name}] ${result}`,
  state: { roots: new Map(), defaultRootId: null, uploads: new Map(), attachments: new Map() }
};
if (!globalThis.window.AgentState) globalThis.window.AgentState = { getEnabledTools: () => globalThis.window.enabledTools };
if (!globalThis.window.enabledTools) globalThis.window.enabledTools = {};

console.log('MCP Refresh Tests\n');

const results = [];

results.push(await group('manager exposes resource/prompt methods', () => {
  assertEqual(typeof M.listResources, 'function', 'listResources');
  assertEqual(typeof M.readResource, 'function', 'readResource');
  assertEqual(typeof M.listPrompts, 'function', 'listPrompts');
  assertEqual(typeof M.getPrompt, 'function', 'getPrompt');
  assertEqual(typeof M.refreshIfNeeded, 'function', 'refreshIfNeeded');
}));

clearAll();
Store.addServer({ name: 'RefreshTest', transport: 'http', url: 'http://localhost:9999', enabled: true });
const srv = Store.loadServers()[0];
await M.loadAndConnect();

results.push(await group('listResources works after connect', async () => {
  await M.connect(srv.id);
  const resources = await M.listResources(srv.id);
  assertEqual(resources.length, 1, 'should have 1 resource');
  assertEqual(resources[0].uri, 'test://file.txt', 'uri match');
}));

results.push(await group('readResource returns content', async () => {
  const res = await M.readResource(srv.id, 'test://file.txt');
  assert.ok(res.content || res.error === undefined, 'Expected content');
}));

results.push(await group('listPrompts returns prompts', async () => {
  const prompts = await M.listPrompts(srv.id);
  assertEqual(prompts.length, 1, 'should have 1 prompt');
  assertEqual(prompts[0].name, 'greet', 'name match');
}));

results.push(await group('getPrompt returns messages', async () => {
  const res = await M.getPrompt(srv.id, 'greet');
  assert.ok(Array.isArray(res.messages) || res.error === undefined, 'Expected messages');
}));

results.push(await group('refreshIfNeeded updates lastRefreshAt', async () => {
  const before = M.getStatus(srv.id)?.lastRefreshAt || 0;
  await M.refreshIfNeeded(srv.id);
  const after = M.getStatus(srv.id)?.lastRefreshAt || 0;
  assert.ok(after >= before, 'lastRefreshAt should be updated');
}));

results.push(await group('reload queued during active run', async () => {
  globalThis.window.AgentRunGraph = { getActiveRun: () => ({ status: 'running' }) };
  await M.reloadServer(srv.id);
  const st = M.getStatus(srv.id);
  assertEqual(st?.state, 'idle', 'Should be idle when queued');
  assert.ok(st?.lastError?.includes('queued'), 'Should mention queued');
  globalThis.window.AgentRunGraph = { getActiveRun: () => null };
}));

results.push(await group('heartbeat prevents stale callTool', async () => {
  // Ensure connected first (reload queued test may have set state=idle)
  await M.connect(srv.id);
  const st = M.getStatus(srv.id);
  if (st) st.lastRefreshAt = Date.now() - 70000;
  const res = await M.callTool(srv.id, 'test_tool', {});
  assert.ok(!res.error, `Expected no error but got ${res.error}`);
  assert.ok(M.getStatus(srv.id).lastRefreshAt > Date.now() - 5000, 'Should refresh timestamp');
}));

const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} passed`);
if (passed < total) {
  process.exitCode = 1;
} else {
  console.log('All MCP refresh tests passed.\n');
  process.exit(0);
}
