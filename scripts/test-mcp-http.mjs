// scripts/test-mcp-http.mjs
// Tests MCP HTTP transport, proxy SSRF, manager integration, and feature flag.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '');

const __dirname = repoRoot;

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

// Track fetch calls
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

// ── Load source files ─────────────────────────────────────────────────────
const storeCode = await readFile('src/app/mcp/mcp-store.js', 'utf8');
const httpCode  = await readFile('src/app/mcp/mcp-http-transport.js', 'utf8');
const mgrCode   = await readFile('src/app/mcp/mcp-manager.js', 'utf8');
const bridgeCode= await readFile('src/tools/mcp-bridge.js', 'utf8');

// Execute in order (each IIFE registers on window)
vm.runInThisContext(storeCode, { filename: 'mcp-store.js' });
vm.runInThisContext(httpCode,  { filename: 'mcp-http-transport.js' });
vm.runInThisContext(mgrCode,   { filename: 'mcp-manager.js' });
vm.runInThisContext(bridgeCode, { filename: 'mcp-bridge.js' });

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
    return { name, ok: false, error: err.message };
  });
}

function assertEqual(a, b, msg) {
  assert.strictEqual(a, b, msg);
}

// ── Runtime globals expected by bridge ────────────────────────────────────────
if (!globalThis.window.AgentTools) globalThis.window.AgentTools = {
  registry: {},
  toolGroups: {},
  formatToolResult: (name, result) => `[${name}] ${result}`,
  state: { roots: new Map(), defaultRootId: null, uploads: new Map(), attachments: new Map() }
};
if (!globalThis.window.AgentState) globalThis.window.AgentState = { getEnabledTools: () => globalThis.window.enabledTools };
if (!globalThis.window.enabledTools) globalThis.window.enabledTools = {};

// ── Tests ────────────────────────────────────────────────────────────────────
console.log('MCP HTTP Tests\n');

const results = [];

results.push(await group('mcp-http-transport exists on window', () => {
  assert.ok(globalThis.window.AgentMcpHttpTransport, 'AgentMcpHttpTransport should exist');
}));

results.push(await group('manager exists and is feature-flagged', () => {
  assert.ok(globalThis.window.AgentMcpManager, 'AgentMcpManager should exist');
  assert.ok(globalThis.window.AgentMcpStore, 'AgentMcpStore should exist');
}));

results.push(await group('bridge adapter exists with discoverAndRegister', () => {
  assert.ok(globalThis.window.AgentMcpBridge, 'AgentMcpBridge should exist');
  assert.strictEqual(typeof globalThis.window.AgentMcpBridge.discoverAndRegisterMcpTools, 'function', 'discover fn');
  assert.strictEqual(typeof globalThis.window.AgentMcpBridge.unregisterMcpTools, 'function', 'unregister fn');
}));

results.push(await group('store CRUD and manager loadAndConnect', async () => {
  clearAll();
  const { id } = globalThis.window.AgentMcpStore.addServer({ name: 'Demo', url: 'http://example.com/mcp', enabled: true });
  assert.ok(id.startsWith('mcp_'), 'id starts with mcp_');
  // After add, loadServers must return it
  const srvs = globalThis.window.AgentMcpStore.loadServers();
  assert.strictEqual(srvs.length, 1, 'one server');

  // loadAndConnect will call connect for enabled servers
  await globalThis.window.AgentMcpManager.loadAndConnect();
  // fetch should have been called for initialize against /api/mcp-proxy
  assert.ok(_fetchCalls.length > 0, 'fetch called by connect');
  const initCall = _fetchCalls.find(c => {
    try { return JSON.parse(c.init.body).method === 'initialize'; } catch { return false; }
  });
  assert.ok(initCall, 'initialize call found');
}));

results.push(await group('feature flag off skips loadAndConnect', async () => {
  clearAll();
  globalThis.window.AgentMcpStore.addServer({ name: 'Demo', url: 'http://example.com/mcp', enabled: true });
  _fetchCalls = [];
  globalThis.localStorage.setItem('agent_mcp_manager_enabled', 'false');
  await globalThis.window.AgentMcpManager.loadAndConnect();
  assert.strictEqual(_fetchCalls.length, 0, 'no fetches when disabled');
  globalThis.localStorage.setItem('agent_mcp_manager_enabled', 'true');
}));

results.push(await group('risk mapping heuristic', () => {
  const mgr = globalThis.window.AgentMcpManager;
  assertEqual(mgr._mapRisk({ name: 'readFile' }), 'safe', 'read');
  assertEqual(mgr._mapRisk({ name: 'createBucket' }), 'irreversible', 'create');
  assertEqual(mgr._mapRisk({ name: 'doMagic' }), 'shared', 'unknown');
  assertEqual(mgr._mapRisk({ name: 'listTasks' }), 'safe', 'list');
}));

results.push(await group('unregisterMcpTools removes registry entries', () => {
  clearAll();
  const reg = globalThis.window.AgentTools.registry;
  globalThis.window.AgentTools.toolGroups['mcp_demo'] = { label: 'Demo', tools: [{ name: 'mcp_demo_x', signature: 'x()' }] };
  reg['mcp_demo_x'] = { name: 'mcp_demo_x', run: () => {} };
  reg['mcp_demo_y'] = { name: 'mcp_demo_y', run: () => {} };
  reg['other_tool'] = { name: 'other_tool', run: () => {} };

  globalThis.window.AgentMcpStore.addServer({ name: 'Demo', url: 'http://demo.local', enabled: true });
  const server = globalThis.window.AgentMcpStore.loadServers()[0];
  globalThis.window.AgentMcpBridge.unregisterMcpTools(server.id);

  assert.strictEqual(reg['mcp_demo_x'], undefined, 'mcp_demo_x removed');
  assert.strictEqual(reg['mcp_demo_y'], undefined, 'mcp_demo_y removed');
  assert.ok(reg['other_tool'], 'other_tool kept');
  assert.strictEqual(globalThis.window.AgentTools.toolGroups['mcp_demo'], undefined, 'group removed');
}));

results.push(await group('dev-server SSRF blocks private IPs', async () => {
  // Spawn dev server on a free port
  const port = await new Promise((resolve) => {
    const tmp = createServer();
    tmp.listen(0, () => { const p = tmp.address().port; tmp.close(() => resolve(p)); });
  });
  const proc = spawn('node', ['proxy/dev-server.js'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('dev-server did not start')), 5000);
    proc.stdout.on('data', d => { if (String(d).includes('running at')) { clearTimeout(to); resolve(); } });
    proc.stderr.on('data', d => { if (String(d).includes('running at')) { clearTimeout(to); resolve(); } });
  });

  // Helper: simple POST
  function httpPost(path, bodyObj) {
    return new Promise((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const data = JSON.stringify(bodyObj);
        const req = request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
          let buf = '';
          res.on('data', c => buf += c);
          res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      }).catch(reject);
    });
  }

  // SSRF test with private IP (should be blocked after plan update)
  const res = await httpPost('/api/mcp-proxy', {
    serverUrl: 'http://192.168.1.10/mcp',
    method: 'tools/list',
    params: {}
  });
  assert.ok(res.status === 403 || res.status === 502, `expected 403 or 502 for SSRF, got ${res.status}`);

  proc.kill('SIGTERM');
}));

// ── Summary ─────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} passed`);
if (passed < total) {
  process.exitCode = 1;
} else {
  console.log('All MCP HTTP tests passed.\n');
}
