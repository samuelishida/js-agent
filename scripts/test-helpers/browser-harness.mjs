import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export function makeStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    clear() { map.clear(); },
    key(index) { return [...map.keys()][index] ?? null; },
    get length() { return map.size; },
    _dump() { return new Map(map); }
  };
}

export function createBrowserHarness(extra = {}) {
  const calls = [];
  const storage = extra.localStorage || makeStorage();
  const context = {
    console,
    URL,
    performance: { now: () => Date.now() },
    localStorage: storage,
    window: null,
    globalThis: null,
    document: extra.document || makeDocumentStub(),
    MutationObserver: extra.MutationObserver || class { observe() {} disconnect() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    fetch: extra.fetch || (async () => ({ ok: true, status: 200, text: async () => '{}' })),
    calls,
    assert,
    ...extra.globals
  };
  context.window = context;
  context.globalThis = context;
  return { context: vm.createContext(context), calls, storage };
}

export async function runScript(context, path) {
  const code = await readFile(path, 'utf8');
  vm.runInContext(code, context, { filename: path });
}

export async function runScripts(context, paths) {
  for (const path of paths) await runScript(context, path);
}

export function makeDocumentStub(initial = {}) {
  const elements = new Map(Object.entries(initial));
  function makeElement(id) {
    return {
      id,
      value: '',
      checked: false,
      textContent: '',
      innerHTML: '',
      style: { display: 'none' },
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener() {},
      removeEventListener() {}
    };
  }
  return {
    elements,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    addEventListener(event, cb) {
      if (event === 'DOMContentLoaded' && typeof cb === 'function') cb();
    },
    createElement: tag => makeElement(tag),
    body: makeElement('body')
  };
}

export async function test(name, fn, results) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

export function finish(results, label) {
  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  console.log(`\n${passed}/${total} passed`);
  if (passed !== total) {
    process.exitCode = 1;
  } else if (label) {
    console.log(`${label} passed.\n`);
  }
}
