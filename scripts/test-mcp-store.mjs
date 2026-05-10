// scripts/test-mcp-store.mjs
// Tests for MCP store: migration, CRUD, slugging, backup behavior.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// ── Stub Storage ────────────────────────────────────────────────────────────
if (!globalThis.window) globalThis.window = {};

const _store = new Map();

if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem(k) { return _store.get(k) ?? null; },
    setItem(k, v) { _store.set(k, String(v)); },
    removeItem(k) { _store.delete(k); },
    clear() { _store.clear(); },
    key(i) { return [..._store.keys()][i] ?? null; },
    get length() { return _store.size; }
  };
}

// ── Load store code ─────────────────────────────────────────────────────────
const storeCode = await readFile('src/app/mcp/mcp-store.js', 'utf8');
vm.runInThisContext(storeCode, { filename: 'mcp-store.js' });

const Store = globalThis.window.AgentMcpStore;
assert.ok(Store, 'AgentMcpStore should be exported');

// ── Helpers ─────────────────────────────────────────────────────────────────
function clearAll() {
  localStorage.clear();
}

function assertEqual(a, b, msg) {
  assert.strictEqual(a, b, msg);
}

// ── Test Groups ─────────────────────────────────────────────────────────────
const results = [];
const errors = [];

/**
 * Test runner wrapper.
 * @param {string} name - Test name
 * @param {Function} fn - Test function
 */
async function group(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  \u2713 ' + name);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    errors.push(err);
    console.log('  \u2717 ' + name);
    console.log('    ' + err.message);
  }
}

// ── Run Tests ───────────────────────────────────────────────────────────────
console.log('MCP Store Tests\n');

await group('loadServers returns empty when no data', () => {
  clearAll();
  const s = Store.loadServers();
  assert.ok(Array.isArray(s) && s.length === 0, 'should be empty');
});

await group('migrateV1 converts v1 shape to v2', () => {
  clearAll();
  const v1 = [
    { id: 'srv_a', url: 'http://localhost:3000', name: 'My Server', authHeader: 'Bearer abc', enabled: true }
  ];
  const { servers, backupKey } = Store.migrateV1(v1);
  assert.ok(Array.isArray(servers) && servers.length === 1, 'should have 1 server');
  const s = servers[0];
  assertEqual(s.transport, 'http', 'transport should be http');
  assertEqual(s.url, 'http://localhost:3000', 'url migrated');
  assertEqual(s.headers?.Authorization, 'Bearer abc', 'authHeader migrated to headers.Authorization');
  assertEqual(s.enabled, true, 'enabled preserved');
  assert.ok(backupKey && backupKey.startsWith('agent_mcp_servers_v1_backup_'), 'backup key generated');
});

await group('loadServers auto-migrates v1 and removes it', () => {
  clearAll();
  const v1 = JSON.stringify([
    { id: 'srv_1', url: 'http://a.com', name: 'A', enabled: true }
  ]);
  localStorage.setItem('agent_mcp_servers_v1', v1);
  const s = Store.loadServers();
  assert.ok(Array.isArray(s) && s.length === 1, 'should load migrated server');
  assertEqual(localStorage.getItem('agent_mcp_servers_v1'), null, 'v1 key should be removed');
  const v2 = JSON.parse(localStorage.getItem('agent_mcp_servers_v2') || '{}');
  assert.ok(v2.version === 2 && Array.isArray(v2.servers) && v2.servers.length === 1, 'v2 should have server');
});

await group('invalid v1 JSON is backed up and not lost', () => {
  clearAll();
  localStorage.setItem('agent_mcp_servers_v1', 'not-json');
  const s = Store.loadServers();
  assert.ok(Array.isArray(s) && s.length === 0, 'should return empty after bad json');
  assert.strictEqual(localStorage.getItem('agent_mcp_servers_v1'), null, 'v1 key should be removed');
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    keys.push(localStorage.key(i));
  }
  console.log('    debug keys after loadServers:', keys);
  const backupFound = keys.some(k => k && k.startsWith('agent_mcp_servers_v1_backup_'));
  assert.ok(backupFound, 'backup key should exist; keys=' + keys.join(', '));
});

await group('addServer round-trips through localStorage', () => {
  clearAll();
  const { id } = Store.addServer({ name: 'Test', url: 'http://test.local', enabled: true });
  assert.ok(typeof id === 'string' && id.startsWith('mcp_'), 'id is string starting with mcp_');
  const servers = Store.loadServers();
  assert.ok(servers.length === 1, 'one server stored');
  assertEqual(servers[0].name, 'Test', 'name preserved');
  assertEqual(servers[0].transport, 'http', 'default transport');
});

await group('updateServer patches fields', () => {
  clearAll();
  const { id } = Store.addServer({ name: 'Test', url: 'http://t', enabled: true });
  const createdAt = Store.loadServers()[0].createdAt;
  const ok = Store.updateServer(id, { name: 'Updated', enabled: false });
  assert.ok(ok, 'update returns true');
  const server = Store.loadServers()[0];
  assert.strictEqual(server.name, 'Updated', 'name updated');
  assert.strictEqual(server.enabled, false, 'enabled updated');
  assert.ok(server.updatedAt >= createdAt, 'updatedAt >= createdAt, was ' + server.updatedAt + ' vs ' + createdAt);
});

await group('removeServer deletes server', () => {
  clearAll();
  const { id } = Store.addServer({ name: 'Del', url: 'http://d' });
  assert.ok(Store.removeServer(id), 'remove returns true');
  assert.ok(Store.loadServers().length === 0, 'server removed');
  assert.ok(!Store.removeServer('missing'), 'remove missing returns false');
});

await group('setEnabled toggles', () => {
  clearAll();
  const { id } = Store.addServer({ name: 'En', url: 'http://e', enabled: true });
  Store.setEnabled(id, false);
  assertEqual(Store.loadServers()[0].enabled, false, 'disabled');
  Store.setEnabled(id, true);
  assertEqual(Store.loadServers()[0].enabled, true, 'enabled');
});

await group('duplicate v1 ids generate unique ids', () => {
  clearAll();
  const v1 = [
    { id: 'dup', url: 'http://a', name: 'A', enabled: true },
    { id: 'dup', url: 'http://b', name: 'B', enabled: true }
  ];
  const { servers } = Store.migrateV1(v1);
  assert.ok(servers.length === 2, 'two servers');
  assert.ok(servers[0].id !== servers[1].id, 'ids are distinct');
});

await group('slug generation is deterministic', () => {
  assertEqual(Store._slugify('Hello World'), 'hello_world', 'basic slug');
  assertEqual(Store._slugify('My-Server 2!'), 'my_server_2', 'special chars');
  assertEqual(Store._serverSlug({ name: 'Test', url: 'http://t' }), 'test', 'server slug from name');
  assertEqual(Store._serverSlug({ id: 'abc', command: 'cmd' }), 'cmd', 'slug from command fallback');
});

await group('feature flag defaults to enabled', () => {
  clearAll();
  assert.ok(Store.isEnabled(), 'default enabled');
  localStorage.setItem('agent_mcp_manager_enabled', 'false');
  assert.ok(!Store.isEnabled(), 'disabled after setting false');
});

await group('normalizeServer handles defaults', () => {
  const s = Store.normalizeServer({ id: 'x', name: 'N' });
  assertEqual(s.transport, 'http', 'default http');
  assertEqual(s.enabled, false, 'default false');
  assertEqual(s.name, 'N', 'name preserved');
});

// ── Summary ───────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} passed`);
if (errors.length) {
  process.exitCode = 1;
} else {
  console.log('All MCP store tests passed.\n');
}
