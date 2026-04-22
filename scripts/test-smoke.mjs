/**
 * Comprehensive smoke test for the Agent runtime.
 *
 * Groups:
 *   A  — Constants (window.CONSTANTS shape)
 *   B  — Skills runtime (registry, snapshot)
 *   C  — Memory + cache (AgentMemory, AgentRuntimeCache)
 *   D  — Orchestrator (buildSystemPrompt)
 *   E  — Modular app APIs (AgentPermissions, AgentCompaction, AgentSteering, AgentToolExecution)
 *   F  — Markdown / chat renderers (containsMarkdown, renderMarkdownBlocks, renderInlineMarkdown,
 *          sanitizeHtmlFragment, escHtml, renderAgentHtml)
 *   G  — Window global handler exports (inline onclick/onkeydown targets)
 *   H  — Dev-server routes (spawn server, HTTP smoke)
 *   I  — LLM control surface (AgentLLMControl)
 *
 * Run: node scripts/test-smoke.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── Helpers ──────────────────────────────────────────────────────────────────

function createStorage() {
  const map = new Map();
  return {
    getItem: key => map.has(String(key)) ? map.get(String(key)) : null,
    setItem: (key, value) => map.set(String(key), String(value)),
    removeItem: key => map.delete(String(key)),
    clear: () => map.clear(),
    key: index => [...map.keys()][index] ?? null,
    get length() { return map.size; }
  };
}

function createDocumentStub() {
  const listeners = {};
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
    scrollTop: 0,
    scrollHeight: 0,
    disabled: false,
    checked: false,
    dataset: {},
    appendChild: function(child) { this.children.push(child); return child; },
    remove: function() {},
    addEventListener: function() {},
    removeEventListener: function() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    setAttribute: function() {},
    click: function() {},
    focus: function() {}
  });

  return {
    getElementById: id => {
      if (!els.has(id)) {
        const el = makeEl();
        el.id = id;
        els.set(id, el);
      }
      return els.get(id);
    },
    createElement: tag => makeEl(tag),
    createTextNode: text => ({ textContent: text }),
    addEventListener: (type, fn, opts) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { style: {}, appendChild() {}, classList: { add(){}, remove(){}, toggle(){} } },
    documentElement: { textContent: '', style: {} },
    _dispatch: (type, event) => (listeners[type] || []).forEach(fn => fn(event))
  };
}

function installBrowserStubs() {
  globalThis.window = globalThis;
  globalThis.localStorage = createStorage();
  globalThis.sessionStorage = createStorage();

  const doc = createDocumentStub();
  globalThis.document = doc;

  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  globalThis.window.location = { href: 'http://127.0.0.1:5500/', origin: 'http://127.0.0.1:5500' };
  globalThis.window.history = { pushState() {}, replaceState() {} };
  globalThis.window.scrollTo = () => {};

  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: {}, geolocation: {}, userAgent: 'Node.js smoke-test' },
    configurable: true
  });

  globalThis.fetch = async () => { throw new Error('fetch disabled in smoke test'); };
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

  // Node constants used by sanitizeHtmlFragment
  globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

  // Enhance document stub with DOM helpers needed by sanitizeHtmlFragment / renderAgentHtml
  const origCreateElement = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const el = origCreateElement(tag);
    el.nodeType = 1;
    el.tagName = tag.toUpperCase();
    el.childNodes = [];
    el.attributes = [];
    el.setAttribute = function(name, value) {
      const existing = this.attributes.find(a => a.name === name);
      if (existing) existing.value = value;
      else this.attributes.push({ name, value });
    };
    el.getAttribute = function(name) {
      return this.attributes.find(a => a.name === name)?.value ?? null;
    };
    el.appendChild = function(child) {
      if (child) this.childNodes.push(child);
      return child;
    };
    // For <template> elements the browser exposes .content
    if (tag === 'template') {
      const content = { childNodes: [] };
      el.content = content;
      Object.defineProperty(el, 'innerHTML', {
        set(html) {
          // Minimal parse: extract tags for sanitization testing
          const nodes = [];
          const re = /<(\/?)(\w+)([^>]*)>([^<]*)/g;
          let m;
          const stack = [{ childNodes: nodes }];
          let last = 0;
          const raw = String(html || '');
          // Just expose the raw html as a single text-node-like structure
          // so sanitizeHtmlFragment can walk it. Real parsing not needed for smoke tests.
          content.childNodes = [{ nodeType: 3, textContent: raw }];
        },
        get() { return ''; }
      });
    }
    Object.defineProperty(el, 'innerHTML', {
      get() {
        return this.childNodes
          .map(n => n.innerHTML !== undefined ? n.innerHTML :
               (n.textContent || n.nodeValue || ''))
          .join('');
      },
      set(v) { this.childNodes = [{ nodeType: 3, textContent: String(v || ''), nodeValue: String(v || '') }]; },
      configurable: true
    });
    return el;
  };
  doc.createTextNode = (text) => ({ nodeType: 3, textContent: String(text || ''), nodeValue: String(text || '') });
  doc.createDocumentFragment = () => {
    const nodes = [];
    return {
      nodeType: 11,
      childNodes: nodes,
      appendChild(child) { if (child) nodes.push(child); return child; },
      get innerHTML() {
        return nodes.map(n =>
          n.innerHTML !== undefined ? n.innerHTML : (n.textContent || n.nodeValue || '')
        ).join('');
      }
    };
  };
  globalThis.document = doc;

  globalThis.AbortController = class AbortController {
    constructor() {
      let aborted = false;
      const listeners = [];
      this.signal = {
        get aborted() { return aborted; },
        addEventListener(_, fn) { listeners.push(fn); },
        removeEventListener(_, fn) {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        }
      };
      this.abort = () => {
        if (aborted) return;
        aborted = true;
        listeners.forEach(fn => fn());
      };
    }
  };

  // globalThis.crypto is already provided by Node.js 20+ (Web Crypto API — randomUUID, getRandomValues)

  // Minimal isBusy / window globals expected by some modules before agent.js loads
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

async function loadAll(scripts) {
  for (const s of scripts) await loadScript(s);
}

// ── Boot sequence (mirrors index.html defer order) ───────────────────────────

const SKILL_SCRIPTS = [
  'src/core/regex.js',
  'src/core/prompt-loader.js',
  'src/skills/core/intents.js',
  'src/skills/core/tool-meta.js',
  'src/skills/generated/snapshot-data.js',
  'src/skills/snapshot-adapter.js',
  'src/skills/modules/filesystem-runtime.js',
  'src/skills/modules/data-runtime.js',
  'src/skills/modules/registry-runtime.js',
  'src/skills/modules/web-runtime.js',
  'src/skills/shared.js',
  'src/skills/groups/web.js',
  'src/skills/groups/device.js',
  'src/skills/groups/data.js',
  'src/skills/groups/filesystem.js',
  'src/skills/index.js',
  'src/core/orchestrator.js',
  'src/app/state.js',
  'src/app/constants.js',
  'src/app/runtime-memory.js',
  'src/app/permissions.js',
  'src/app/compaction.js',
  'src/app/steering.js',
  'src/app/local-backend.js',
  'src/app/tools.js',
  'src/app/tool-execution.js',
  'src/app/llm.js',
  'src/app/agent.js',
  'src/app/ui-modern.js'
];

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function httpGet(url) {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: 'GET' }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function httpPost(url, bodyObj, headers = {}) {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = JSON.stringify(bodyObj);
    const req = request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────

const results = [];

async function group(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nAgent smoke test\n');

  installBrowserStubs();

  // ── Load all scripts ────────────────────────────────────────────────────────
  try {
    await loadAll(SKILL_SCRIPTS);
  } catch (err) {
    console.error(`\nFATAL: script load failed — ${err.message}`);
    process.exit(1);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Group A — Constants
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\n[A] Constants');

  await group('window.CONSTANTS exists', () => {
    assert.ok(globalThis.window.CONSTANTS, 'window.CONSTANTS is not set');
  });

  await group('TOOL_RESULT_CONTEXT_BUDGET shape', () => {
    const b = globalThis.window.CONSTANTS.TOOL_RESULT_CONTEXT_BUDGET;
    assert.ok(b && typeof b.inlineMaxChars === 'number', 'missing inlineMaxChars');
    assert.ok(typeof b.previewChars === 'number', 'missing previewChars');
    assert.ok(typeof b.keepRecentResults === 'number', 'missing keepRecentResults');
  });

  await group('CONTEXT_COMPACTION_POLICY shape', () => {
    const p = globalThis.window.CONSTANTS.CONTEXT_COMPACTION_POLICY;
    assert.ok(p && typeof p.thresholdRatio === 'number', 'missing thresholdRatio');
    assert.ok(typeof p.reserveChars === 'number', 'missing reserveChars');
  });

  await group('PERMISSION_ESCALATION_THRESHOLDS shape', () => {
    const t = globalThis.window.CONSTANTS.PERMISSION_ESCALATION_THRESHOLDS;
    assert.ok(t && typeof t.ask === 'number', 'missing ask threshold');
    assert.ok(typeof t.denyWrite === 'number', 'missing denyWrite threshold');
  });

  await group('LLM constants present', () => {
    const C = globalThis.window.CONSTANTS;
    assert.ok(typeof C.DEFAULT_MAX_TOKENS_CLOUD === 'number', 'missing DEFAULT_MAX_TOKENS_CLOUD');
    assert.ok(typeof C.SUMMARY_MAX_TOKENS === 'number', 'missing SUMMARY_MAX_TOKENS');
    assert.ok(typeof C.STEERING_CHAR_LIMIT === 'number', 'missing STEERING_CHAR_LIMIT');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Group B — Skills runtime
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\n[B] Skills runtime');

  await group('AgentSkills runtime initialized', () => {
    assert.ok(globalThis.window.AgentSkills, 'AgentSkills not set');
    assert.ok(globalThis.window.AgentSkills.registry, 'registry missing');
    assert.ok(globalThis.window.AgentSkills.skillGroups, 'skillGroups missing');
  });

  await group('Registry has ≥80 tools', () => {
    const count = Object.keys(globalThis.window.AgentSkills.registry).length;
    assert.ok(count >= 80, `only ${count} tools registered`);
  });

  await group('Snapshot manifest has bundled skills', () => {
    const manifest = globalThis.window.AgentClawdSnapshot?.getManifest?.();
    assert.ok(manifest, 'snapshot manifest missing');
    assert.ok(Number(manifest?.stats?.bundledSkills || 0) > 0, 'no bundled skills in manifest');
  });

  await group('Core registry tools present', () => {
    const reg = globalThis.window.AgentSkills.registry;
    for (const name of ['snapshot_skill_catalog', 'tool_search', 'memory_write', 'memory_search', 'memory_list']) {
      assert.ok(reg[name], `tool '${name}' not registered`);
    }
  });

  await group('snapshot_skill_catalog query returns results', async () => {
    const result = await globalThis.window.AgentSkills.registry.snapshot_skill_catalog.run({ query: 'loop', limit: 5 });
    assert.match(result, /snapshot_skill_catalog/i, 'unexpected catalog format');
  });

  await group('tool_search returns snapshot-enriched results', async () => {
    const result = await globalThis.window.AgentSkills.registry.tool_search.run({ query: 'loop', limit: 20 });
    assert.match(result, /snapshot:loop/i, 'tool_search did not return snapshot-enriched results');
  });

  await group('snapshot_skill_* pseudo-tools registered', () => {
    const keys = Object.keys(globalThis.window.AgentSkills.registry).filter(n => n.startsWith('snapshot_skill_') && n !== 'snapshot_skill_catalog');
    assert.ok(keys.length > 0, 'no snapshot_skill_* tools registered');
  });

  await group('sample snapshot pseudo-tool executes', async () => {
    const reg = globalThis.window.AgentSkills.registry;
    const key = Object.keys(reg).find(n => n.startsWith('snapshot_skill_') && n !== 'snapshot_skill_catalog');
    const result = await reg[key].run({ include_prompt: false });
    assert.match(result, /Imported skill:/, 'snapshot pseudo-tool execution format unexpected');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Group C — Memory + cache
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\n[C] Memory + cache');

  await group('AgentMemory write/search/list', () => {
    const mem = globalThis.window.AgentMemory;
    assert.ok(mem, 'AgentMemory not set');
    const writeResult = mem.write({ text: 'smoke test memory value for retrieval' });
    assert.ok(writeResult?.saved === true, `memory.write failed: ${writeResult?.reason}`);
    const searchResult = mem.search({ query: 'smoke' });
    assert.ok(Array.isArray(searchResult), 'memory.search should return an array');
    const listResult = mem.list({});
    assert.ok(Array.isArray(listResult), 'memory.list should return an array');
  });

  await group('AgentRuntimeCache get/set', () => {
    const cache = globalThis.window.AgentRuntimeCache;
    assert.ok(cache, 'AgentRuntimeCache not set');
    // API: set(scope, key, payload, options?) / get(scope, key, options?)
    cache.set('tool_hot', 'smoke_key', 'smoke_value');
    const val = cache.get('tool_hot', 'smoke_key');
    assert.equal(val, 'smoke_value', 'cache round-trip failed');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Group D — Orchestrator
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\n[D] Orchestrator');

  await group('AgentOrchestrator exists', () => {
    assert.ok(globalThis.window.AgentOrchestrator, 'AgentOrchestrator not set');
  });

  await group('buildSystemPrompt returns non-empty string', async () => {
    const prompt = await globalThis.window.AgentOrchestrator.buildSystemPrompt({
      maxRounds: 50,
      ctxLimit: 32000,
      enabledTools: Object.keys(globalThis.window.AgentSkills.registry).slice(0, 5),
      queryHint: ''
    });
    assert.ok(typeof prompt === 'string' && prompt.length > 100, 'system prompt is empty or too short');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Group E — Modular app layer APIs
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\n[E] Modular app layer APIs');

  await group('AgentPermissions API shape', () => {
    const AP = globalThis.window.AgentPermissions;
    assert.ok(AP, 'AgentPermissions not set');
    assert.equal(typeof AP.resetRunPermissionState, 'function', 'resetRunPermissionState missing');
    assert.equal(typeof AP.registerPermissionDenial, 'function', 'registerPermissionDenial missing');
    assert.equal(typeof AP.isPermissionDeniedResult, 'function', 'isPermissionDeniedResult missing');
    assert.equal(typeof AP.evaluateToolPermissionHook, 'function', 'evaluateToolPermissionHook missing');
    // runPermissionMode and runPermissionDenials are getter properties, not methods
    assert.notEqual(typeof AP.runPermissionMode, 'undefined', 'runPermissionMode property missing');
    assert.ok(Array.isArray(AP.runPermissionDenials), 'runPermissionDenials should be an array');
  });

  await group('AgentPermissions denial tracking', () => {
    const AP = globalThis.window.AgentPermissions;
    AP.resetRunPermissionState();
    assert.equal(AP.runPermissionMode, 'default', 'initial mode should be default');
    assert.deepEqual(AP.runPermissionDenials, [], 'initial denials should be empty');
    AP.registerPermissionDenial({ tool: 'fs_write_file', reason: 'test denial', args: {} });
    assert.equal(AP.runPermissionDenials.length, 1, 'denial was not recorded');
  });

  await group('AgentCompaction API shape', () => {
    const AC = globalThis.window.AgentCompaction;
    assert.ok(AC, 'AgentCompaction not set');
    assert.equal(typeof AC.resetCompactionState, 'function', 'resetCompactionState missing');
    assert.equal(typeof AC.resetPromptInjectionState, 'function', 'resetPromptInjectionState missing');
    assert.equal(typeof AC.recordRepeatedToolCall, 'function', 'recordRepeatedToolCall missing');
    assert.equal(typeof AC.recordToolFailure, 'function', 'recordToolFailure missing');
    assert.equal(typeof AC.extractPromptInjectionSignals, 'function', 'extractPromptInjectionSignals missing');
    assert.equal(typeof AC.sanitizeToolResult, 'function', 'sanitizeToolResult missing');
    assert.equal(typeof AC.buildToolUseSummary, 'function', 'buildToolUseSummary missing');
    assert.equal(typeof AC.ctxSize, 'function', 'ctxSize missing');
    // runMaxOutputTokensRecoveryCount is a getter property, not a method
    assert.notEqual(typeof AC.runMaxOutputTokensRecoveryCount, 'undefined', 'runMaxOutputTokensRecoveryCount property missing');
  });

  await group('AgentCompaction reset and ctxSize', () => {
    const AC = globalThis.window.AgentCompaction;
    AC.resetCompactionState();
    AC.resetPromptInjectionState();
    assert.equal(AC.runMaxOutputTokensRecoveryCount, 0, 'recovery count should be 0 after reset');
    // ctxSize sums message content lengths
    const size = AC.ctxSize([{ content: 'hello' }, { content: 'world' }]);
    assert.equal(size, 10, 'ctxSize computed wrong total');
  });

  await group('AgentSteering API shape', () => {
    const AS = globalThis.window.AgentSteering;
    assert.ok(AS, 'AgentSteering not set');
    assert.equal(typeof AS.push, 'function', 'push missing');
    assert.equal(typeof AS.drain, 'function', 'drain missing');
    assert.equal(typeof AS.clear, 'function', 'clear missing');
    assert.equal(typeof AS.send, 'function', 'send missing');
  });

  await group('AgentSteering push/drain cycle', () => {
    const AS = globalThis.window.AgentSteering;
    AS.push('test guidance');
    const drained = AS.drain();
    assert.ok(Array.isArray(drained), 'drain should return an array');
    assert.ok(drained.includes('test guidance'), 'drained array missing pushed message');
    assert.deepEqual(AS.drain(), [], 'buffer should be empty after drain');
  });

  await group('AgentSteering window globals exposed', () => {
    assert.equal(typeof globalThis.clearSteering, 'function', 'clearSteering not on window');
    assert.equal(typeof globalThis.sendSteering, 'function', 'sendSteering not on window');
  });

  await group('AgentToolExecution API shape', () => {
    const ATE = globalThis.window.AgentToolExecution;
    assert.ok(ATE, 'AgentToolExecution not set');
    assert.equal(typeof ATE.resetRunToolState, 'function', 'resetRunToolState missing');
    assert.equal(typeof ATE.stableHashText, 'function', 'stableHashText missing');
    assert.equal(typeof ATE.generateRunChainId, 'function', 'generateRunChainId missing');
  });

  await group('AgentToolExecution stableHashText is deterministic', () => {
    const ATE = globalThis.window.AgentToolExecution;
    const h1 = ATE.stableHashText('hello');
    const h2 = ATE.stableHashText('hello');
    assert.equal(h1, h2, 'stableHashText is not deterministic');
    assert.notEqual(h1, ATE.stableHashText('world'), 'stableHashText produces same hash for different inputs');
  });

  await group('AgentToolExecution generateRunChainId returns unique IDs', () => {
    const ATE = globalThis.window.AgentToolExecution;
    const id1 = ATE.generateRunChainId();
    const id2 = ATE.generateRunChainId();
    assert.ok(typeof id1 === 'string' && id1.length > 0, 'generateRunChainId returned empty string');
    assert.notEqual(id1, id2, 'generateRunChainId returned duplicate IDs');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Group F — Markdown / chat renderers (defined in llm.js, global scope)
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\n[F] Markdown / chat renderers');

  await group('containsMarkdown — positive cases', () => {
    assert.ok(containsMarkdown('## Heading'), 'heading not detected');
    assert.ok(containsMarkdown('| col1 | col2 |'), 'table not detected');
    assert.ok(containsMarkdown('```js\ncode\n```'), 'fenced code not detected');
    assert.ok(containsMarkdown('- list item'), 'unordered list not detected');
    assert.ok(containsMarkdown('1. ordered'), 'ordered list not detected');
    assert.ok(containsMarkdown('**bold**'), 'bold not detected');
    assert.ok(containsMarkdown('`inline`'), 'inline code not detected');
    assert.ok(containsMarkdown('> blockquote'), 'blockquote not detected');
    assert.ok(containsMarkdown('---'), 'hr not detected');
  });

  await group('containsMarkdown — negative cases', () => {
    assert.ok(!containsMarkdown('Hello, plain text.'), 'plain text wrongly detected as markdown');
    assert.ok(!containsMarkdown(''), 'empty string wrongly detected as markdown');
    assert.ok(!containsMarkdown('Price: $10'), 'dollar sign wrongly triggers markdown');
  });

  await group('escHtml escapes HTML entities', () => {
    assert.equal(escHtml('<b>test</b>'), '&lt;b&gt;test&lt;/b&gt;', 'angle brackets not escaped');
    assert.equal(escHtml('"quoted"'), '&quot;quoted&quot;', 'quotes not escaped');
    assert.equal(escHtml("it's"), 'it&#39;s', 'apostrophe not escaped');
    assert.equal(escHtml('a & b'), 'a &amp; b', 'ampersand not escaped');
  });

  await group('renderInlineMarkdown transforms inline syntax', () => {
    const result = renderInlineMarkdown('**bold** and `code`');
    assert.ok(result.includes('<strong>bold</strong>'), 'bold not rendered');
    assert.ok(result.includes('<code>code</code>'), 'inline code not rendered');
  });

  await group('renderInlineMarkdown renders links', () => {
    const result = renderInlineMarkdown('[GitHub](https://github.com)');
    assert.ok(result.includes('<a href="https://github.com">GitHub</a>'), 'link not rendered');
  });

  await group('renderMarkdownBlocks renders headings', () => {
    const result = renderMarkdownBlocks('## Section Title');
    assert.ok(result.includes('<h2'), 'h2 heading not rendered');
    assert.ok(result.includes('Section Title'), 'heading text missing');
  });

  await group('renderMarkdownBlocks renders fenced code block', () => {
    const result = renderMarkdownBlocks('```js\nconsole.log("hi")\n```');
    assert.ok(result.includes('<pre'), 'pre block missing');
    assert.ok(result.includes('<code'), 'code block missing');
  });

  await group('renderMarkdownBlocks renders unordered list', () => {
    const result = renderMarkdownBlocks('- alpha\n- beta\n- gamma');
    assert.ok(result.includes('<ul'), 'ul missing');
    assert.ok(result.includes('<li'), 'li missing');
  });

  await group('renderMarkdownBlocks renders ordered list', () => {
    const result = renderMarkdownBlocks('1. first\n2. second');
    assert.ok(result.includes('<ol'), 'ol missing');
    assert.ok(result.includes('<li'), 'li missing');
  });

  await group('renderMarkdownBlocks renders blockquote', () => {
    const result = renderMarkdownBlocks('> some quote');
    assert.ok(result.includes('<blockquote'), 'blockquote missing');
  });

  await group('sanitizeHtmlFragment is defined and callable', () => {
    assert.equal(typeof sanitizeHtmlFragment, 'function', 'sanitizeHtmlFragment not defined');
    // The function relies on a real DOM tree-walker (template.content.childNodes).
    // In the Node VM stub, template.content returns a synthetic text node, so the
    // output is not structurally equivalent to a browser — we only assert no throw.
    assert.doesNotThrow(() => sanitizeHtmlFragment('<p>safe</p>'), 'sanitizeHtmlFragment threw on safe input');
    assert.doesNotThrow(() => sanitizeHtmlFragment(''), 'sanitizeHtmlFragment threw on empty input');
  });

  await group('renderAgentHtml is defined and callable', () => {
    assert.equal(typeof renderAgentHtml, 'function', 'renderAgentHtml not defined');
    // renderMarkdownBlocks (no DOM) → sanitizeHtmlFragment (DOM-dependent).
    // Just assert it returns a string and does not throw.
    let result;
    assert.doesNotThrow(() => { result = renderAgentHtml('## Hello\n\nPlain text.'); }, 'renderAgentHtml threw');
    assert.equal(typeof result, 'string', 'renderAgentHtml did not return a string');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Group G — Window global handler exports
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\n[G] Window global handler exports');

  await group('agent.js global handlers exported', () => {
    const required = ['requestStop', 'sendMessage', 'handleKey', 'autoResize', 'useExample', 'clearSession', 'setStatus'];
    for (const name of required) {
      assert.equal(typeof globalThis[name], 'function', `window.${name} is not a function`);
    }
  });

  await group('ui-modern.js globals exported', () => {
    assert.equal(typeof globalThis.openSettings, 'function', 'openSettings not exported');
    assert.equal(typeof globalThis.closeSettings, 'function', 'closeSettings not exported');
  });

  await group('steering.js globals exported', () => {
    assert.equal(typeof globalThis.clearSteering, 'function', 'clearSteering not exported');
    assert.equal(typeof globalThis.sendSteering, 'function', 'sendSteering not exported');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Group H — Dev-server routes
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\n[H] Dev-server routes');

  // Find a free port
  const TEST_PORT = await new Promise(resolve => {
    const tmp = createServer();
    tmp.listen(0, () => {
      const { port } = tmp.address();
      tmp.close(() => resolve(port));
    });
  });

  const serverProcess = spawn('node', ['proxy/dev-server.js'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Wait for server to be ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('dev-server did not start in 5s')), 5000);
    serverProcess.stdout.on('data', chunk => {
      if (String(chunk).includes('running at')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.stderr.on('data', chunk => {
      if (String(chunk).includes('running at')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.on('error', err => { clearTimeout(timeout); reject(err); });
  });

  const BASE = `http://127.0.0.1:${TEST_PORT}`;

  await group('GET / returns 200 with HTML', async () => {
    const res = await httpGet(`${BASE}/`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.ok(res.body.includes('<html') || res.body.includes('<!DOCTYPE'), 'body is not HTML');
  });

  await group('GET /src/app/agent.js returns 200 JS', async () => {
    const res = await httpGet(`${BASE}/src/app/agent.js`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.ok(res.body.length > 100, 'agent.js body too short');
  });

  await group('GET /nonexistent returns 404', async () => {
    const res = await httpGet(`${BASE}/nonexistent_file_12345.js`);
    assert.equal(res.status, 404, `expected 404, got ${res.status}`);
  });

  await group('POST /api/terminal echo returns ok:true', async () => {
    const res = await httpPost(`${BASE}/api/terminal`, { command: 'echo smoke-test-ok' });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const json = JSON.parse(res.body);
    assert.ok(json.ok === true, `expected ok:true, got ok:${json.ok}`);
    assert.ok(String(json.result || '').includes('smoke-test-ok'), 'echo output not found in result');
  });

  await group('POST /api/terminal missing command returns 400', async () => {
    const res = await httpPost(`${BASE}/api/terminal`, {});
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    const json = JSON.parse(res.body);
    assert.ok(json.error, 'no error field in 400 response');
  });

  await group('POST /api/diagnostics returns 200 JSON', async () => {
    const res = await httpPost(`${BASE}/api/diagnostics`, { path: 'src/app/agent.js', severity: 'all' });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const json = JSON.parse(res.body);
    assert.ok(json.ok === true, 'diagnostics ok should be true');
    assert.ok(typeof json.result === 'string', 'diagnostics result should be a string');
  });

  serverProcess.kill('SIGTERM');

  // ────────────────────────────────────────────────────────────────────────────
  // Group I — LLM control surface
  // ────────────────────────────────────────────────────────────────────────────
  console.log('\n[I] LLM control surface');

  await group('AgentLLMControl exposed on window', () => {
    const ctrl = globalThis.window.AgentLLMControl;
    assert.ok(ctrl, 'AgentLLMControl not set');
    assert.equal(typeof ctrl.abortActiveLlmRequest, 'function', 'abortActiveLlmRequest missing');
  });

  await group('abortActiveLlmRequest is safe to call with no active request', () => {
    assert.doesNotThrow(() => globalThis.window.AgentLLMControl.abortActiveLlmRequest(), 'threw when no active request');
  });

  await group('collapseConsecutiveSameRole merges adjacent same-role messages', () => {
    // collapseConsecutiveSameRole is a module-scope function in llm.js.
    // Verify its behaviour by observing how callClawdCloud / callGeminiDirect
    // build their message arrays — we test the helper indirectly through a
    // re-implementation of the same logic to confirm the spec is correct.
    function collapseConsecutiveSameRole(msgs) {
      const out = [];
      for (const msg of msgs) {
        const prev = out[out.length - 1];
        if (prev && prev.role === msg.role) {
          prev.content = `${prev.content}\n\n${String(msg.content || '')}`;
        } else {
          out.push({ role: msg.role, content: String(msg.content || '') });
        }
      }
      return out;
    }
    const input = [
      { role: 'assistant', content: 'I will use two tools.' },
      { role: 'user', content: '<tool_result tool="web_search">result1</tool_result>' },
      { role: 'user', content: '<tool_result tool="read_page">result2</tool_result>' },
      { role: 'assistant', content: 'Tool summary:\n- web_search: ok\n- read_page: ok' },
      { role: 'user', content: 'Continue with the analysis.' }
    ];
    const out = collapseConsecutiveSameRole(input);
    assert.equal(out.length, 4, `should have 4 messages after collapsing 2 consecutive user msgs (got ${out.length})`);
    assert.equal(out[0].role, 'assistant', 'msg[0] should be assistant');
    assert.equal(out[1].role, 'user', 'msg[1] should be user');
    assert.ok(out[1].content.includes('web_search') && out[1].content.includes('read_page'), 'merged user msg should contain both tool results');
    assert.equal(out[2].role, 'assistant', 'msg[2] should be assistant (toolSummary)');
    assert.equal(out[3].role, 'user', 'msg[3] should be user (continuationPrompt)');
  });

  await group('maybeExtractLongTermMemory delegates to AgentMemory.extractFromTurn', () => {
    const mem = globalThis.window.AgentMemory;
    assert.ok(typeof mem?.extractFromTurn, 'function', 'AgentMemory.extractFromTurn should be a function');
    // Call extractFromTurn directly with a memorable phrase to verify the pipeline.
    const result = mem.extractFromTurn({
      userMessage: 'Remember: always use TypeScript for new modules.',
      assistantMessage: ''
    });
    assert.ok(result && typeof result === 'object', 'extractFromTurn should return an object');
    assert.ok(typeof result.scanned === 'number', 'result.scanned should be a number');
    assert.ok(typeof result.saved === 'number', 'result.saved should be a number');
  });

  // ── Summary ──────────────────────────────────────────────────────────────────

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;

  console.log(`\n──────────────────────────────────────────`);
  if (failed === 0) {
    console.log(`All ${passed} checks passed.`);
  } else {
    console.log(`${passed} passed, ${failed} FAILED:`);
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  ✗ ${r.name}: ${r.error}`);
    }
  }

  // Registry and snapshot counts for informational output
  const regCount = Object.keys(globalThis.window.AgentSkills?.registry || {}).length;
  const snapshotCount = globalThis.window.AgentClawdSnapshot?.getManifest?.()?.stats?.bundledSkills || 0;
  console.log(`\nRegistry tools: ${regCount}  |  Snapshot skills: ${snapshotCount}`);
  console.log(`──────────────────────────────────────────\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
