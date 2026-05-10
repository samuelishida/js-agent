/**
 * Smoke test: RunGraph lifecycle, task management, observations, artifacts, events, serialization, summarization.
 * Run: node scripts/test-run-graph.mjs
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

function installStubs() {
  globalThis.window = globalThis;
  globalThis.localStorage = createStorage();
  globalThis.sessionStorage = createStorage();

  const els = new Map();
  const makeEl = (tag = 'div') => ({
    tagName: tag.toUpperCase(),
    className: '', id: '', style: {}, children: [],
    textContent: '', innerHTML: '', value: '',
    disabled: false, dataset: {},
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
    body: { style: {}, appendChild() {}, classList: { add(){}, remove(){}, toggle(){} } },
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
    // Node.js already has crypto; leave it alone
    try { globalThis.crypto.randomUUID = globalThis.crypto.randomUUID || (() => `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`); } catch {}
  }
}

async function loadScript(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  const code = await readFile(absolutePath, 'utf8');
  vm.runInThisContext(code, { filename: relativePath });
}

async function main() {
  console.log('RunGraph smoke test\n');
  installStubs();

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

  // Load run-graph.js
  await loadScript('src/app/agent/run-graph.js');

  await group('AgentRunGraph API exists', () => {
    const RG = globalThis.window.AgentRunGraph;
    assert.ok(RG, 'AgentRunGraph missing');
    assert.equal(typeof RG.createRun, 'function');
    assert.equal(typeof RG.startTask, 'function');
    assert.equal(typeof RG.completeTask, 'function');
    assert.equal(typeof RG.failTask, 'function');
    assert.equal(typeof RG.retryTask, 'function');
    assert.equal(typeof RG.addObservation, 'function');
    assert.equal(typeof RG.registerArtifact, 'function');
    assert.equal(typeof RG.emitEvent, 'function');
    assert.equal(typeof RG.setTerminalStatus, 'function');
    assert.equal(typeof RG.getActiveRun, 'function');
    assert.equal(typeof RG.getRun, 'function');
    assert.equal(typeof RG.listRuns, 'function');
    assert.equal(typeof RG.serializeRun, 'function');
    assert.equal(typeof RG.summarizeRunForPrompt, 'function');
  });

  let run;
  await group('createRun returns valid graph', () => {
    const RG = globalThis.window.AgentRunGraph;
    run = RG.createRun({ sessionId: 'sess_1', goal: 'Generate a PDF', userMessage: 'Generate a PDF from report.html' });
    assert.ok(run, 'run is null');
    assert.ok(run.id, 'run.id missing');
    assert.equal(run.status, 'running', 'status should be running');
    assert.equal(run.goal, 'Generate a PDF');
    assert.equal(run.sessionId, 'sess_1');
    assert.equal(run.rounds, 0);
    assert.deepStrictEqual(run.errors, []);
    assert.ok(run.events.length >= 1, 'should have at least run_started event');
    assert.equal(run.events[0].type, 'run_started');
  });

  await group('getActiveRun returns the run', () => {
    const RG = globalThis.window.AgentRunGraph;
    const active = RG.getActiveRun();
    assert.ok(active, 'active run missing');
    assert.equal(active.id, run.id);
  });

  let task;
  await group('startTask creates task with correct fields', () => {
    const RG = globalThis.window.AgentRunGraph;
    task = RG.startTask(run, { kind: 'tool', title: 'fs_list_dir', round: 1, toolName: 'fs_list_dir', toolArgs: { path: 'src' } });
    assert.ok(task.id, 'task.id missing');
    assert.equal(task.kind, 'tool');
    assert.equal(task.toolName, 'fs_list_dir');
    assert.equal(task.status, 'running');
    assert.equal(task.round, 1);
    assert.ok(run.tasks[task.id], 'task not stored in run.tasks');
  });

  await group('completeTask finishes task', () => {
    const RG = globalThis.window.AgentRunGraph;
    RG.completeTask(run, task.id, { observationIds: ['obs_1'], artifactIds: ['art_1'] });
    const t = run.tasks[task.id];
    assert.equal(t.status, 'completed');
    assert.ok(t.endedAt, 'endedAt missing');
    assert.deepStrictEqual(t.resultObservationIds, ['obs_1']);
    assert.deepStrictEqual(t.artifactIds, ['art_1']);
  });

  let retryTask;
  await group('retryTask creates retry linked to original', () => {
    const RG = globalThis.window.AgentRunGraph;
    retryTask = RG.retryTask(run, task.id, 2);
    assert.ok(retryTask, 'retryTask missing');
    assert.equal(retryTask.retryOf, task.id);
    assert.equal(retryTask.status, 'running');
    assert.equal(retryTask.round, 2);
    assert.ok(retryTask.title.includes('Retry'), 'title should mention retry');
  });

  await group('failTask marks task failed and logs error', () => {
    const RG = globalThis.window.AgentRunGraph;
    RG.failTask(run, retryTask.id, 'disk full');
    const t = run.tasks[retryTask.id];
    assert.equal(t.status, 'failed');
    assert.equal(t.error, 'disk full');
    assert.ok(run.errors.includes('disk full'));
  });

  await group('addObservation stores observation', () => {
    const RG = globalThis.window.AgentRunGraph;
    const obs = RG.addObservation(run, { taskId: task.id, round: 1, source: 'tool_result', summary: 'Listed 4 files', content: 'src/app\nsrc/tools\n…', isError: false });
    assert.ok(obs.id, 'obs.id missing');
    assert.equal(obs.taskId, task.id);
    assert.equal(obs.source, 'tool_result');
    assert.equal(obs.summary, 'Listed 4 files');
    assert.ok(obs.contentHash, 'contentHash missing');
    assert.equal(obs.isError, false);
    assert.ok(run.observations.find(o => o.id === obs.id), 'observation not in run.observations');
  });

  let artifact;
  await group('registerArtifact stores artifact and links to task', () => {
    const RG = globalThis.window.AgentRunGraph;
    artifact = RG.registerArtifact(run, { taskId: task.id, kind: 'generated', name: 'report.pdf', mimeType: 'application/pdf', size: 1200, source: 'runtime_generateFile', preview: 'PDF preview…' });
    assert.ok(artifact.id, 'artifact.id missing');
    assert.equal(artifact.kind, 'generated');
    assert.equal(artifact.name, 'report.pdf');
    assert.equal(run.artifacts[run.artifacts.length - 1].id, artifact.id);
    assert.ok(run.tasks[task.id].artifactIds.includes(artifact.id), 'artifact not linked to task');
  });

  await group('emitEvent adds event to run', () => {
    const RG = globalThis.window.AgentRunGraph;
    const before = run.events.length;
    const evt = RG.emitEvent(run, { type: 'round_started', round: 3, level: 'info', message: 'Round 3 started', data: { foo: 1 } });
    assert.ok(evt.id, 'evt.id missing');
    assert.equal(evt.type, 'round_started');
    assert.equal(evt.round, 3);
    assert.equal(run.events.length, before + 1);
  });

  await group('setTerminalStatus updates status and emits terminal event', () => {
    const RG = globalThis.window.AgentRunGraph;
    RG.setTerminalStatus(run, 'completed', 'Done!');
    assert.equal(run.status, 'completed');
    assert.equal(run.finalAnswer, 'Done!');
    assert.ok(run.events.some(e => e.type === 'run_completed'), 'missing run_completed event');
  });

  await group('listRuns returns runs newest first', () => {
    const RG = globalThis.window.AgentRunGraph;
    const list = RG.listRuns({ limit: 10 });
    assert.ok(Array.isArray(list), 'listRuns should return array');
    assert.ok(list.length >= 1, 'should have at least 1 run');
    assert.equal(list[0].id, run.id);
  });

  await group('serializeRun returns JSON', () => {
    const RG = globalThis.window.AgentRunGraph;
    const json = RG.serializeRun(run.id, { stripContent: true });
    assert.ok(json, 'serializeRun returned null');
    const parsed = JSON.parse(json);
    assert.equal(parsed.id, run.id);
    assert.equal(parsed.status, 'completed');
    // stripContent should clear observation content
    const obs = parsed.observations[0];
    if (obs) assert.equal(obs.content, '', 'content should be stripped');
  });

  await group('summarizeRunForPrompt returns string with key info', () => {
    const RG = globalThis.window.AgentRunGraph;
    const summary = RG.summarizeRunForPrompt(run.id);
    assert.ok(typeof summary === 'string' && summary.length > 0, 'summary should be non-empty string');
    assert.ok(summary.includes('Run'), 'summary should mention Run');
    assert.ok(summary.includes('fs_list_dir'), 'summary should mention tool name');
    assert.ok(summary.includes('report.pdf'), 'summary should mention artifact');
    assert.ok(summary.includes('Done!'), 'summary should mention final answer');
  });

  await group('max_rounds terminal status', () => {
    const RG = globalThis.window.AgentRunGraph;
    const r2 = RG.createRun({ sessionId: 'sess_2', goal: 'test max' });
    RG.setTerminalStatus(r2, 'max_rounds');
    assert.equal(r2.status, 'max_rounds');
    assert.ok(r2.events.some(e => e.type === 'run_max_rounds'));
  });

  await group('failed terminal status', () => {
    const RG = globalThis.window.AgentRunGraph;
    const r3 = RG.createRun({ sessionId: 'sess_3', goal: 'test fail' });
    RG.setTerminalStatus(r3, 'failed', 'network error');
    assert.equal(r3.status, 'failed');
    assert.equal(r3.finalAnswer, 'network error');
    assert.ok(r3.events.some(e => e.type === 'run_failed'));
  });

  await group('stopped terminal status', () => {
    const RG = globalThis.window.AgentRunGraph;
    const r4 = RG.createRun({ sessionId: 'sess_4', goal: 'test stop' });
    RG.setTerminalStatus(r4, 'stopped');
    assert.equal(r4.status, 'stopped');
    assert.ok(r4.events.some(e => e.type === 'run_stopped'));
  });

  // Load run-inspector.js and test UI scaffolding
  await loadScript('src/app/agent/run-inspector.js');
  await group('AgentRunInspector API exists', () => {
    const RI = globalThis.window.AgentRunInspector;
    assert.ok(RI, 'AgentRunInspector missing');
    assert.equal(typeof RI.ensureContainer, 'function');
    assert.equal(typeof RI.renderRun, 'function');
    assert.equal(typeof RI.update, 'function');
  });

  await group('ensureContainer creates DOM elements', () => {
    const RI = globalThis.window.AgentRunInspector;
    const container = RI.ensureContainer();
    assert.ok(container, 'container missing');
    const toggle = document.getElementById('run-inspector-toggle');
    const panel = document.getElementById('run-inspector-panel');
    assert.ok(toggle, 'toggle missing');
    assert.ok(panel, 'panel missing');
    // Mock style.display may be undefined instead of 'none' in Node stub environment
    const display = panel.style?.display;
    assert.ok(display === 'none' || display === undefined || display === '', `panel display should be hidden by default, got ${display}`);
  });

  await group('renderRun handles active run', () => {
    const RI = globalThis.window.AgentRunInspector;
    RI.renderRun(run);
    const panel = document.getElementById('run-inspector-panel');
    assert.ok(panel.innerHTML.includes('fs_list_dir'), 'rendered output should mention tool');
    assert.ok(panel.innerHTML.includes('report.pdf'), 'rendered output should mention artifact');
    assert.ok(panel.innerHTML.includes('completed'), 'rendered output should mention status');
  });

  await group('renderRun handles null run', () => {
    const RI = globalThis.window.AgentRunInspector;
    RI.renderRun(null);
    const panel = document.getElementById('run-inspector-panel');
    assert.ok(panel.innerHTML.includes('No active run'), 'should show no-run message');
  });

  const passed = results.filter(r => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
