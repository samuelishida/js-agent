// scripts/test-memory.mjs
// Unit tests for memory relevance, cache invalidation, and extraction.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile('src/app/context/runtime-memory.js', 'utf8');

if (!globalThis.window) globalThis.window = {};

if (!globalThis.window.CONSTANTS) {
  globalThis.window.CONSTANTS = {};
}

// Stub localStorage
const _store = new Map();
globalThis.localStorage = {
  getItem(k) { return _store.get(k) || null; },
  setItem(k, v) { _store.set(k, String(v)); },
  removeItem(k) { _store.delete(k); },
  clear() { _store.clear(); }
};

if (!globalThis.window.AgentRuntimeCache) {
  const buckets = {};
  globalThis.window.AgentRuntimeCache = {
    set(scope, key, payload) {
      if (!buckets[scope]) buckets[scope] = {};
      buckets[scope][key] = { payload, timestamp: Date.now() };
      return true;
    },
    get(scope, key) {
      const b = buckets[scope];
      if (!b || !b[key]) return null;
      return b[key].payload;
    },
    delete(scope, key) {
      const b = buckets[scope];
      if (!b) return false;
      delete b[key];
      return true;
    },
    clearScope(scope) {
      delete buckets[scope];
    }
  };
}

vm.runInThisContext(code, { filename: 'runtime-memory.js' });

const Mem = globalThis.window.AgentMemory;
assert.ok(Mem, 'AgentMemory should be exported');
const Cache = globalThis.window.AgentRuntimeCache;
assert.ok(Cache, 'AgentRuntimeCache should be exported');

// ── Helper to clear all memory state ──────────────────────────────────────
function clearAll() {
  localStorage.removeItem('agent_long_term_memory_v1');
  localStorage.removeItem('agent_runtime_cache_v1');
  Cache.clearScope('memory_retrieval');
}

// ── Relevance: unrelated query returns no overlap results ─────────────────
{
  clearAll();
  Mem.write({ text: 'My name is Samuel and I use React', tags: ['profile'], importance: 0.8 });
  Mem.write({ text: 'The project uses TypeScript and Express', tags: ['project'], importance: 0.7 });

  const results = Mem.search({ query: 'quantum physics astronomy', limit: 5 });
  assert.equal(results.length, 0, 'unrelated query should return zero results');
  console.log('  relevance unrelated: 0 results');
}

// ── Relevance: matching query returns result ──────────────────────────────
{
  clearAll();
  Mem.write({ text: 'My name is Samuel and I use React', tags: ['profile'], importance: 0.8 });

  const results = Mem.search({ query: 'what is my name', limit: 5 });
  assert.ok(results.length > 0, 'matching query should return results');
  assert.ok(results[0].text.includes('Samuel'), 'top result should contain Samuel');
  console.log(`  relevance matching: ${results.length} results`);
}

// ── Cache hit after first search ──────────────────────────────────────────
{
  clearAll();
  Mem.write({ text: 'Project uses Node.js and Prisma', tags: ['tech'], importance: 0.6 });

  const r1 = Mem.search({ query: 'nodejs database', limit: 5 });
  const r2 = Mem.search({ query: 'nodejs database', limit: 5 });
  assert.equal(r1.length, r2.length, 'cache hit returns same count');
  assert.equal(r1[0]?.text, r2[0]?.text, 'cache hit returns same top result');
  console.log('  cache hit: consistent');
}

// ── Write invalidates cache ───────────────────────────────────────────────
{
  clearAll();
  Mem.write({ text: 'Project uses Node.js and Prisma', tags: ['tech'], importance: 0.6 });

  const r1 = Mem.search({ query: 'orm library', limit: 5 });
  Mem.write({ text: 'Also using Drizzle ORM instead of Prisma', tags: ['tech'], importance: 0.6 });
  const r2 = Mem.search({ query: 'orm library', limit: 5 });

  assert.ok(r2.some(e => e.text.includes('Drizzle')), 'new write appears after invalidation');
  console.log('  cache invalidation: new memory visible');
}

// ── Extraction only from user message ───────────────────────────────────
{
  clearAll();
  const delta = Mem.extractFromTurn({
    userMessage: "My name is Samuel. I prefer dark mode.",
    assistantMessage: "I will always remember to use light mode from now on."
  });

  assert.ok(delta.saved >= 1, 'extracts from user message');
  assert.ok(delta.scanned >= 1, 'scanned user message');

  // With assistant extraction disabled, assistant text is not scanned
  const allMemories = Mem.list({ limit: 50 });
  const assistantPreference = allMemories.find(e => e.text.includes('light mode'));
  assert.ok(!assistantPreference, 'assistant text not extracted by default');
  console.log(`  extraction: ${delta.saved} saved from user only`);
}

// ── Empty query list flow: returns results by recency ─────────────────────
{
  clearAll();
  Mem.write({ text: 'Remember to check the build pipeline', tags: ['todo'], importance: 0.5 });
  Mem.write({ text: 'Project uses Vite and Tailwind', tags: ['tech'], importance: 0.6 });

  const results = Mem.list({ limit: 5 });
  assert.ok(results.length >= 2, 'list returns recent memories');
  console.log(`  list flow: ${results.length} memories`);
}

console.log('All memory tests passed');
process.exit(0);
