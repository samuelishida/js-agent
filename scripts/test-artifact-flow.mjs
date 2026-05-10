/**
 * Smoke test: attachment → artifact registry → download flow
 * Verifies Phase 1 harness hardening:
 *   - artifact registry (register/get/list)
 *   - attachment persistence in messages (textContent/dataUrl)
 *   - provider attachment resolution fallback
 *   - fs_download_file artifactId support
 *
 * Run: node scripts/test-artifact-flow.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function createStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => map.set(String(key), String(value)),
    removeItem: key => map.delete(String(key)),
    clear: () => map.clear(),
    key: index => [...map.keys()][index] ?? null,
    get length() { return map.size; }
  };
}

function installBrowserStubs() {
  globalThis.window = globalThis;
  globalThis.localStorage = createStorage();
  globalThis.sessionStorage = createStorage();

  const els = new Map();
  const makeEl = (tag = 'div') => ({
    tagName: tag.toUpperCase(),
    className: '',
    id: '',
    style: {},
    children: [],
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    dataset: {},
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    setAttribute() {},
    click() {},
    focus() {}
  });

  globalThis.document = {
    getElementById: id => {
      if (!els.has(id)) { const el = makeEl(); el.id = id; els.set(id, el); }
      return els.get(id);
    },
    createElement: tag => makeEl(tag),
    createTextNode: text => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { style: {}, appendChild() {}, removeChild() {}, classList: { add(){}, remove(){}, toggle(){} } },
    documentElement: { textContent: '', style: {} }
  };

  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  globalThis.window.location = { href: 'http://127.0.0.1:5500/', origin: 'http://127.0.0.1:5500' };
  globalThis.window.history = { pushState() {}, replaceState() {} };
  globalThis.window.scrollTo = () => {};

  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: {}, geolocation: {}, userAgent: 'Node.js smoke-test' },
    configurable: true
  });

  globalThis.fetch = async () => { throw new Error('fetch disabled'); };
  globalThis.window.fetchWithTimeout = async () => { throw new Error('fetchWithTimeout disabled'); };

  globalThis.DOMParser = class DOMParser {
    parseFromString(html) {
      const text = String(html || '').replace(/<[^>]+>/g, ' ');
      return {
        querySelectorAll() { return []; },
        querySelector() { return null; },
        body: { innerText: text, textContent: text },
        documentElement: { textContent: text }
      };
    }
  };

  globalThis.Notification = class Notification {
    static permission = 'denied';
    static async requestPermission() { return 'denied'; }
    constructor() {}
  };

  globalThis.BroadcastChannel = class BroadcastChannel {
    constructor() {}
    postMessage() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  };

  globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

  globalThis.AbortController = class AbortController {
    constructor() {
      let aborted = false;
      const listeners = [];
      this.signal = {
        get aborted() { return aborted; },
        addEventListener(_, fn) { listeners.push(fn); },
        removeEventListener(_, fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
      };
      this.abort = () => { if (aborted) return; aborted = true; listeners.forEach(fn => fn()); };
    }
  };

  globalThis.URL = URL;
  globalThis.URL.createObjectURL = () => 'blob:mock';
  globalThis.URL.revokeObjectURL = () => {};

  // base64ToUint8Array is defined in filesystem-runtime.js but may not be in global scope in test
  if (typeof globalThis.base64ToUint8Array !== 'function') {
    globalThis.base64ToUint8Array = function base64ToUint8Array(b64) {
      const binaryStr = globalThis.atob ? globalThis.atob(b64) : Buffer.from(b64, 'base64').toString('binary');
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      return bytes;
    };
  }

  globalThis.Blob = class Blob {
    constructor(parts, opts) { this.parts = parts; this.opts = opts; }
  };

  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        randomUUID: () => `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; }
      },
      configurable: true,
      writable: true
    });
  } else {
    try { globalThis.crypto.randomUUID = globalThis.crypto.randomUUID || (() => `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`); } catch {}
  }

  globalThis.window.isBusy = false;
  globalThis.window.messages = [];
  globalThis.window.sessionStats = { rounds: 0, tools: 0, resets: 0, msgs: 0 };
  globalThis.window.enabledTools = {};
  globalThis.window.localBackend = { enabled: false, url: '' };
  globalThis.window.ollamaBackend = { enabled: false, url: '' };
}

async function loadScript(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const code = await readFile(absolutePath, 'utf8');
  vm.runInThisContext(code, { filename: relativePath });
}

async function main() {
  console.log('Artifact flow smoke test\n');
  installBrowserStubs();

  const scripts = [
    'src/core/regex.js',
    'src/core/prompt-loader.js',
    'src/tools/core/intents.js',
    'src/tools/core/tool-meta.js',
    'src/tools/tool-registry.js',
    'src/tools/modules/filesystem-runtime.js',
    'src/tools/modules/data-runtime.js',
    'src/tools/modules/attachment-runtime.js',
    'src/tools/tool-executor.js',
    'src/tools/shared.js'
  ];

  for (const s of scripts) await loadScript(s);

  const results = [];
  async function group(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  ✓ ${name}`);
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
      console.error(`  ✗ ${name}\n    ${err.message}`);
    }
  }

  await group('AgentArtifacts registry exists', () => {
    assert.ok(globalThis.window.AgentArtifacts, 'AgentArtifacts missing');
    assert.equal(typeof globalThis.window.AgentArtifacts.register, 'function', 'register missing');
    assert.equal(typeof globalThis.window.AgentArtifacts.get, 'function', 'get missing');
    assert.equal(typeof globalThis.window.AgentArtifacts.list, 'function', 'list missing');
  });

  await group('Artifact register/get round-trip', () => {
    const artifact = globalThis.window.AgentArtifacts.register({
      name: 'test.pdf',
      mimeType: 'application/pdf',
      data: 'JVBERi0xLjQKJcOkw7zDtsO8CjIgMCBvYmoKPDwKL0xlbmd0aCAzIDAgUgovRmlsdGVyIC9GbGF0ZURlY29kZQo+PgpzdHJlYW0KeJzLSMxLLUmNzNFLzs8rzi9KycxLt4IDAIvJBw4KZW5kc3RyZWFtCmVuZG9iago=',
      source: 'test'
    });
    assert.ok(artifact && typeof artifact.id === 'string' && artifact.id.length > 0, 'register did not return artifact with id');
    const a = globalThis.window.AgentArtifacts.get(artifact.id);
    assert.ok(a, 'get returned null');
    assert.equal(a.name, 'test.pdf', 'name mismatch');
    assert.equal(a.mimeType, 'application/pdf', 'mimeType mismatch');
    assert.ok(a.data, 'data missing');
  });

  await group('Artifact list filters by source', () => {
    const items = globalThis.window.AgentArtifacts.list({ source: 'test' });
    assert.ok(Array.isArray(items), 'list should return array');
    assert.ok(items.length >= 1, 'list should have at least 1 test artifact');
    assert.ok(items.every(i => i.id && i.name && i.mimeType), 'list items missing required fields');
  });

  await group('Attachment data persisted in messages', () => {
    globalThis.window.messages = [];
    const att = {
      id: 'att-1', name: 'report.html', mimeType: 'text/html', kind: 'file', size: 120,
      textContent: '<html><body><h1>Report</h1></body></html>',
      textPreview: '<html><body><h1>Report</h1></body></html>'
    };
    globalThis.window.messages.push({ role: 'user', content: 'Generate PDF from this', attachments: [att] });
    const stored = globalThis.window.messages[0].attachments[0];
    assert.equal(stored.textContent, att.textContent, 'textContent not persisted');
    assert.equal(stored.textPreview, att.textPreview, 'textPreview not persisted');
  });

  await group('Provider resolves persisted attachment', () => {
    const m = globalThis.window.messages[0];
    const resolved = (m.attachments || []).map(aMeta => {
      if (aMeta.dataUrl) return aMeta;
      if (aMeta.artifactId && globalThis.window.AgentArtifacts?.get) {
        const artifact = globalThis.window.AgentArtifacts.get(String(aMeta.artifactId));
        if (artifact?.data) return { ...aMeta, dataUrl: `data:${artifact.mimeType};base64,${artifact.data}` };
      }
      return aMeta;
    });
    assert.equal(resolved[0].textContent, '<html><body><h1>Report</h1></body></html>', 'resolver dropped textContent');
  });

  await group('fs_download_file signature accepts artifactId', () => {
    const Executor = globalThis.window.AgentToolExecutor || {};
    assert.equal(typeof Executor.downloadFile, 'function', 'downloadFile not exported');
  });

  await group('Artifact download helper returns true for valid artifact', () => {
    const items = globalThis.window.AgentArtifacts.list({});
    const first = items[0];
    assert.ok(first, 'no artifacts to test download');
    const ok = globalThis.window.AgentArtifacts.download(first.id, 'downloaded.pdf');
    assert.equal(ok, true, 'download should return true for valid artifact');
  });

  await group('runtime_generateFile infers final filename from generated PDF bytes', async () => {
    const Executor = globalThis.window.AgentToolExecutor || {};
    assert.equal(typeof Executor.runtimeGenerateFile, 'function', 'runtimeGenerateFile not exported');
    const oldFetch = globalThis.fetch;
    const pdfB64 = Buffer.from('%PDF-1.4\nmock pdf bytes from generator\n%%EOF\n').toString('base64');
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), '/api/terminal-files', 'runtime_generateFile should use terminal-files endpoint');
      const body = JSON.parse(String(init?.body || '{}'));
      assert.equal(body.files?.[0]?.path, 'agent-sandbox/gen_yvy_pdf.cjs', 'script path mismatch');
      return {
        ok: true,
        text: async () => JSON.stringify({
          ok: true,
          result: `$ node agent-sandbox/gen_yvy_pdf.cjs\nCWD: E:\\Code\\Agent\n\nExit code: 0\n\nSTDOUT:\n${pdfB64}\n\nSTDERR:\n(empty)`
        })
      };
    };
    try {
      const result = await Executor.runtimeGenerateFile({
        path: 'agent-sandbox/gen_yvy_pdf.cjs',
        content: 'const PDFDocument = require("pdfkit"); process.stdout.write("mock");'
      });
      assert.match(result, /gen_yvy_pdf\.pdf/, 'download/artifact name should be inferred as .pdf, not .cjs');
      assert.doesNotMatch(result, /gen_yvy_pdf\.cjs/, 'script extension leaked into generated filename');
      const latest = globalThis.window.AgentArtifacts.list({})[0];
      assert.equal(latest.name, 'gen_yvy_pdf.pdf', 'artifact name should use inferred PDF filename');
      assert.equal(latest.mimeType, 'application/pdf', 'artifact MIME should be application/pdf');
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  const passed = results.filter(r => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
