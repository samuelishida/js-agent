import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

if (!globalThis.window) globalThis.window = {};

const _store = new Map();
globalThis.localStorage = {
  getItem(k) { return _store.get(k) ?? null; },
  setItem(k, v) { _store.set(k, String(v)); },
  removeItem(k) { _store.delete(k); },
  clear() { _store.clear(); },
  key(i) { return [..._store.keys()][i] ?? null; },
  get length() { return _store.size; }
};

const storeCode = await readFile('src/app/mcp/mcp-store.js', 'utf8');
vm.runInThisContext(storeCode, { filename: 'mcp-store.js' });

const Store = globalThis.window.AgentMcpStore;

// simulate the failing test
localStorage.clear();
console.log('before setItem v1, keys:', [..._store.keys()]);
localStorage.setItem('agent_mcp_servers_v1', 'not-json');
console.log('after setItem v1, keys:', [..._store.keys()]);

const s = Store.loadServers();
console.log('after loadServers, keys:', [..._store.keys()]);
console.log('localStorage.length:', localStorage.length);
for (let i = 0; i < localStorage.length; i++) {
  console.log('key:', localStorage.key(i));
}

console.log('servers array:', s);
console.log('typeof localStorage in test:', typeof localStorage);
