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
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    get length() {
      return map.size;
    }
  };
}

function installBrowserStubs() {
  globalThis.window = globalThis;
  globalThis.localStorage = createStorage();
  globalThis.sessionStorage = createStorage();
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: {}
    },
    configurable: true
  });

  globalThis.fetch = async () => {
    throw new Error('fetch disabled in smoke test');
  };
  globalThis.window.fetchWithTimeout = async () => {
    throw new Error('fetchWithTimeout disabled in smoke test');
  };

  globalThis.DOMParser = class DOMParser {
    parseFromString(html) {
      const text = String(html || '').replace(/<[^>]+>/g, ' ');
      return {
        querySelectorAll() {
          return [];
        },
        querySelector() {
          return null;
        },
        body: {
          innerText: text,
          textContent: text
        },
        documentElement: {
          textContent: text
        }
      };
    }
  };

  globalThis.Notification = class Notification {
    static permission = 'denied';

    static async requestPermission() {
      return 'denied';
    }

    constructor() {}
  };
}

async function loadScript(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const code = await readFile(absolutePath, 'utf8');
  vm.runInThisContext(code, { filename: relativePath });
}

async function main() {
  installBrowserStubs();

  const toolScripts = [
    'src/app/context/runtime-memory.js',
    'src/tools/core/intents.js',
    'src/tools/core/tool-meta.js',
    'src/tools/generated/snapshot-data.js',
    'src/tools/snapshot-adapter.js',
    'src/tools/modules/filesystem-runtime.js',
    'src/tools/modules/data-runtime.js',
    'src/tools/modules/registry-runtime.js',
    'src/tools/modules/web-runtime.js',
    'src/tools/tool-broadcast.js',
    'src/tools/tool-planner.js',
    'src/tools/tool-preflight.js',
    'src/tools/tool-executor.js',
    'src/tools/tool-memory.js',
    'src/tools/tool-registry.js',
    'src/tools/shared.js'
  ];

  for (const script of toolScripts) {
    await loadScript(script);
  }

  const runtime = globalThis.window.AgentTools;
  assert.ok(runtime, 'AgentTools runtime was not initialized');
  assert.ok(runtime.registry, 'tools registry is missing');
  assert.ok(runtime.toolGroups, 'tool groups are missing');

  const registry = runtime.registry;
  const snapshotManifest = globalThis.window.AgentClawdSnapshot?.getManifest?.();
  assert.ok(snapshotManifest, 'snapshot manifest is missing');
  assert.ok(
    Number(snapshotManifest?.stats?.bundledTools || 0) > 0,
    'snapshot manifest has no bundled tools'
  );

  assert.ok(registry.snapshot_tool_catalog, 'snapshot_tool_catalog tool is missing');
  assert.ok(registry.tool_search, 'tool_search tool is missing');
  assert.ok(registry.memory_write, 'memory_write tool is missing');
  assert.ok(registry.memory_search, 'memory_search tool is missing');
  assert.ok(registry.memory_list, 'memory_list tool is missing');

  const catalogResult = await registry.snapshot_tool_catalog.run({ query: 'loop', limit: 5 });
  assert.match(catalogResult, /snapshot_tool_catalog/i, 'catalog tool returned unexpected format');
  assert.match(catalogResult, /loop|batch|remember/i, 'catalog tool did not return expected snapshot tool data');

  const searchResult = await registry.tool_search.run({ query: 'loop', limit: 20 });
  assert.match(searchResult, /snapshot:loop/i, 'tool_search did not include snapshot-enriched results');

  const snapshotTools = Object.keys(registry).filter(
    name => name.startsWith('snapshot_tool_') && name !== 'snapshot_tool_catalog'
  );
  assert.ok(snapshotTools.length > 0, 'no snapshot_tool_* tools were registered');

  const sampleTool = snapshotTools.includes('snapshot_tool_loop')
    ? 'snapshot_tool_loop'
    : snapshotTools[0];
  const sampleResult = await registry[sampleTool].run({ include_prompt: false });
  assert.match(sampleResult, /Imported tool:/, 'snapshot pseudo-tool execution failed');

  const writeMemoryResult = await registry.memory_write.run({
    text: 'From now on, prefer concise bullet answers for release notes.',
    tags: ['style', 'preferences'],
    importance: 0.8
  });
  assert.match(writeMemoryResult, /Saved memory|Updated existing memory/i, 'memory_write failed');

  const memorySearchResult = await registry.memory_search.run({ query: 'concise bullet answers', limit: 5 });
  assert.match(memorySearchResult, /concise bullet answers/i, 'memory_search failed to retrieve stored memory');

  const memoryListResult = await registry.memory_list.run({ limit: 5 });
  assert.match(memoryListResult, /preferences|concise bullet answers/i, 'memory_list failed');

  const runtimeCache = globalThis.window.AgentRuntimeCache;
  assert.ok(runtimeCache, 'runtime cache module missing');
  runtimeCache.set('context_summary', 'smoke:key', 'cached summary text', { ttlMs: 30000 });
  const cachedSummary = runtimeCache.get('context_summary', 'smoke:key');
  assert.equal(cachedSummary, 'cached summary text', 'runtime scoped cache get/set failed');

  globalThis.window.AgentRegex = {
    extractToolCall() {
      return null;
    },
    looksLikeReasoningLeak() {
      return false;
    },
    validateSkillOutput() {
      return { valid: true, issues: [] };
    }
  };
  globalThis.window.AgentPrompts = {
    async load() {
      return 'policy';
    },
    async loadRendered(_, vars) {
      return vars?.tools_list || 'Available tools: (none)';
    }
  };

  await loadScript('src/core/orchestrator.js');
  const prompt = await globalThis.window.AgentOrchestrator.buildSystemPrompt({
    userMessage: 'test imported tools',
    maxRounds: 4,
    ctxLimit: 32000,
    enabledTools: ['tool_search', 'snapshot_tool_catalog']
  });
  assert.match(prompt, /Available tools/i, 'orchestrator prompt is missing tool list');

  process.stdout.write(
    [
      'Skills smoke test passed.',
      `- registry tools: ${Object.keys(registry).length}`,
      `- snapshot pseudo-tools: ${snapshotTools.length}`,
      `- bundled skills in manifest: ${snapshotManifest.stats.bundledTools}`
    ].join('\n') + '\n'
  );
}

main().catch(error => {
  process.stderr.write(`Skills smoke test failed: ${error.message}\n`);
  process.exitCode = 1;
});
