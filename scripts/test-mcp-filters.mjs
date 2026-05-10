// scripts/test-mcp-filters.mjs
// Tests for MCP tool filtering, risk mapping, meta tools, and defaults.

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
globalThis.fetch = async (url, init) => {
  _fetchCalls.push({ url, init });
  return {
    ok: true,
    status: 200,
    headers: { get: h => h === 'content-type' ? 'application/json' : '' },
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })
  };
};

// ── Load source files ────────────────────────────────────────────────────────
const storeCode = await readFile('src/app/mcp/mcp-store.js', 'utf8');
const httpCode  = await readFile('src/app/mcp/mcp-http-transport.js', 'utf8');
const mgrCode   = await readFile('src/app/mcp/mcp-manager.js', 'utf8');
const bridgeCode= await readFile('src/tools/mcp-bridge.js', 'utf8');

vm.runInThisContext(storeCode, { filename: 'mcp-store.js' });
vm.runInThisContext(httpCode,  { filename: 'mcp-http-transport.js' });
vm.runInThisContext(mgrCode,   { filename: 'mcp-manager.js' });
vm.runInThisContext(bridgeCode, { filename: 'mcp-bridge.js' });

// ── Helpers ─────────────────────────────────────────────────────────────────
function clearAll() {
  _store.clear();
  _fetchCalls = [];
  globalThis.window.AgentMcpHttpTransport.listTools = async () => [];
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

// ── Runtime globals expected by bridge ───────────────────────────────────────
if (!globalThis.window.AgentTools) globalThis.window.AgentTools = {
  registry: {},
  toolGroups: {},
  formatToolResult: (name, result) => `[${name}] ${result}`,
  state: { roots: new Map(), defaultRootId: null, uploads: new Map(), attachments: new Map() }
};
if (!globalThis.window.AgentState) globalThis.window.AgentState = { getEnabledTools: () => globalThis.window.enabledTools };
if (!globalThis.window.enabledTools) globalThis.window.enabledTools = {};

// ── Tests ───────────────────────────────────────────────────────────────────
console.log('MCP Filter Tests\n');

const results = [];

results.push(await group('meta tools registered in bridge', async () => {
  const reg = globalThis.window.AgentTools.registry;
  const groups = globalThis.window.AgentTools.toolGroups;
  // First clear any existing meta group
  delete groups['mcp_meta'];
  // Ensure metas are not already in registry
  for (const n of ['mcp_reload','mcp_list_servers','mcp_list_tools','mcp_list_resources','mcp_read_resource','mcp_list_prompts','mcp_get_prompt','mcp_find_tools']) {
    delete reg[n];
  }
  await globalThis.window.AgentMcpBridge.discoverAndRegisterMcpTools();
  assert.ok(reg['mcp_reload'], 'mcp_reload should be registered');
  assert.ok(reg['mcp_list_servers'], 'mcp_list_servers should be registered');
  assert.ok(reg['mcp_list_tools'], 'mcp_list_tools should be registered');
  assert.ok(reg['mcp_list_resources'], 'mcp_list_resources should be registered');
  assert.ok(reg['mcp_read_resource'], 'mcp_read_resource should be registered');
  assert.ok(reg['mcp_list_prompts'], 'mcp_list_prompts should be registered');
  assert.ok(reg['mcp_get_prompt'], 'mcp_get_prompt should be registered');
  assert.ok(reg['mcp_find_tools'], 'mcp_find_tools should be registered');
  assert.ok(groups['mcp_meta'] && groups['mcp_meta'].tools.length === 8, 'mcp_meta group with 8 tools');
}));

results.push(await group('meta tools default enabled', async () => {
  const et = globalThis.window.enabledTools;
  await globalThis.window.AgentMcpBridge.discoverAndRegisterMcpTools();
  assert.strictEqual(et['mcp_reload'], true, 'mcp_reload default enabled');
  assert.strictEqual(et['mcp_list_servers'], true, 'mcp_list_servers default enabled');
}));

results.push(await group('meta tool risk level is irreversible', async () => {
  const reg = globalThis.window.AgentTools.registry;
  await globalThis.window.AgentMcpBridge.discoverAndRegisterMcpTools();
  assertEqual(reg['mcp_reload']?.riskLevel, 'irreversible', 'risk');
  assertEqual(reg['mcp_read_resource']?.riskLevel, 'irreversible', 'risk');
}));

results.push(await group('filter persistence through store round-trip', () => {
  clearAll();
  const { id } = globalThis.window.AgentMcpStore.addServer({ name: 'Demo', url: 'http://example.com/mcp', enabled: true });
  const mgr = globalThis.window.AgentMcpManager;
  mgr.setToolFilter(id, { mode: 'include', names: ['readFile', 'listDir'] });
  const servers = globalThis.window.AgentMcpStore.loadServers();
  const s = servers.find(srv => srv.id === id);
  assert.ok(s, 'server found after round-trip');
  assertEqual(s.toolFilter.mode, 'include', 'mode persisted');
  assert.deepStrictEqual(s.toolFilter.names, ['readFile', 'listDir'], 'names persisted');
}));

results.push(await group('risk mapping heuristic', () => {
  const mgr = globalThis.window.AgentMcpManager;
  assertEqual(mgr._mapRisk({ name: 'readFile' }), 'safe', 'read');
  assertEqual(mgr._mapRisk({ name: 'createBucket' }), 'irreversible', 'create');
  assertEqual(mgr._mapRisk({ name: 'doMagic' }), 'shared', 'unknown');
  assertEqual(mgr._mapRisk({ name: 'listTasks' }), 'safe', 'list');
  assertEqual(mgr._mapRisk({ name: 'deleteUser' }), 'irreversible', 'delete');
}));

results.push(await group('default filter for remote server is none', async () => {
  clearAll();
  globalThis.window.AgentMcpStore.addServer({ name: 'Remote', url: 'http://10.0.0.1:3000/mcp', enabled: true });
  const reg = globalThis.window.AgentTools.registry;
  // Remove any existing entries
  Object.keys(reg).forEach(k => { if (k.startsWith('mcp_')) delete reg[k]; });

  // Inject fake tools into manager status via HTTP transport monkey-patch
  const originalListTools = globalThis.window.AgentMcpHttpTransport.listTools;
  globalThis.window.AgentMcpHttpTransport.listTools = async () => [
    { name: 'remoteA', description: 'A' },
    { name: 'remoteB', description: 'B' }
  ];

  await globalThis.window.AgentMcpManager.loadAndConnect();
  await globalThis.window.AgentMcpBridge.discoverAndRegisterMcpTools();

  const hasRemote = Object.keys(reg).some(k => k.includes('remote'));
  assert.ok(!hasRemote, 'remote server tools should be blocked by default');

  globalThis.window.AgentMcpHttpTransport.listTools = originalListTools;
}));

results.push(await group('default filter for localhost is all', async () => {
  clearAll();
  globalThis.window.AgentMcpStore.addServer({ name: 'Local', url: 'http://localhost:3000/mcp', enabled: true });
  const reg = globalThis.window.AgentTools.registry;
  Object.keys(reg).forEach(k => { if (k.startsWith('mcp_')) delete reg[k]; });

  const originalListTools = globalThis.window.AgentMcpHttpTransport.listTools;
  globalThis.window.AgentMcpHttpTransport.listTools = async () => [
    { name: 'localA', description: 'A' },
    { name: 'localB', description: 'B' }
  ];

  await globalThis.window.AgentMcpManager.loadAndConnect();
  await globalThis.window.AgentMcpBridge.discoverAndRegisterMcpTools();

  const hasLocal = Object.keys(reg).some(k => k.includes('local'));
  assert.ok(hasLocal, 'localhost tools should be allowed by default');

  globalThis.window.AgentMcpHttpTransport.listTools = originalListTools;
}));

// ── Summary ─────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} passed`);
if (passed < total) {
  process.exitCode = 1;
} else {
  console.log('All MCP filter tests passed.\n');
}
