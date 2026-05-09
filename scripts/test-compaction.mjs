// scripts/test-compaction.mjs
// Unit tests for compaction.js pure pipeline and token estimation.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile('src/app/context/compaction.js', 'utf8');

// Minimal browser globals
if (!globalThis.window) globalThis.window = {};

// Stub AgentRuntimeCache
if (!globalThis.window.AgentRuntimeCache) {
  globalThis.window.AgentRuntimeCache = {
    set(scope, key, payload) { return true; },
    get(scope, key) { return null; },
    delete(scope, key) { return true; },
    clearScope(scope) {}
  };
}

// Stub AgentToolExecution
if (!globalThis.window.AgentToolExecution) {
  globalThis.window.AgentToolExecution = {
    getToolCallSignature(call) {
      const args = call?.args || {};
      return `${call?.tool || 'unknown'}:${JSON.stringify(Object.keys(args).sort().reduce((o,k)=>(o[k]=args[k],o),{}))}`;
    },
    runSuccessfulToolCount: 0
  };
}

if (!globalThis.window.AgentPermissions) {
  globalThis.window.AgentPermissions = {};
}

if (!globalThis.window.CONSTANTS) {
  globalThis.window.CONSTANTS = {
    DEFAULT_CTX_LIMIT_TOKENS: 32000,
    TOOL_RESULT_CONTEXT_BUDGET: { inlineMaxChars: 20000, previewChars: 5000, keepRecentResults: 8 },
    CONTEXT_COMPACTION_POLICY: { thresholdRatio: 0.82, minRoundGap: 2 },
    TIME_BASED_MICROCOMPACT_POLICY: { inactivityMs: 1200000, keepRecentResults: 4 }
  };
}

// Inject a minimal addNotice if not present
if (typeof globalThis.addNotice !== 'function') {
  globalThis.addNotice = (msg) => { console.log(`[notice] ${msg}`); };
}

vm.runInThisContext(code, { filename: 'compaction.js' });
const Comp = globalThis.window.AgentCompaction;
assert.ok(Comp, 'AgentCompaction should be exported');

// ── Token estimation ──────────────────────────────────────────────────────
{
  const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(20);
  const est = Comp.estimateTokens(base64);
  const min = Math.ceil(base64.length / 3.5);
  assert.ok(est >= min, `base64 tokens ${est} should be >= floor(${base64.length}/3.5) = ${min}`);
  console.log(`  token estimate base64: ${est} >= ${min}`);
}

{
  const json = JSON.stringify({ a: 1, b: [1,2,3,4,5], c: { d: "x".repeat(200) } });
  const est = Comp.estimateTokens(json);
  const min = Math.ceil(json.length / 3.5);
  assert.ok(est >= min, `json tokens ${est} should be >= floor(${json.length}/3.5) = ${min}`);
  console.log(`  token estimate json: ${est} >= ${min}`);
}

{
  const code = `function x(){return 42;}`.repeat(50);
  const est = Comp.estimateTokens(code);
  const min = Math.ceil(code.length / 3.5);
  assert.ok(est >= min, `code tokens ${est} should be >= floor(${code.length}/3.5) = ${min}`);
  console.log(`  token estimate code: ${est} >= ${min}`);
}

// ── Microcompact tool results ────────────────────────────────────────────
{
  const messages = [
    { role: 'user', content: 'query' },
    { role: 'assistant', content: '<tool_call>foo</tool_call>' },
    { role: 'tool', name: 'fs_list_dir', content: 'a\nb\nc\n'.repeat(500) },
    { role: 'tool', name: 'fs_read_file', content: 'x'.repeat(3000) },
    { role: 'tool', name: 'fs_stat', content: 'ok' }
  ];

  const result = Comp.microcompactToolResultMessages(messages, { keepRecent: 2 });
  assert.ok(result.messages.length === messages.length, 'length unchanged');
  assert.ok(result.clearedCount === 1, 'cleared 1 old tool result');
  assert.ok(result.savedChars > 0, 'saved chars > 0');

  const compactedText = result.messages[2].content;
  assert.ok(/\[tool_result digest=/.test(compactedText), 'digest marker present');
  assert.ok(compactedText.includes('fs_list_dir'), 'tool name preserved in digest');
  console.log(`  microcompact: ${result.clearedCount} cleared, ${result.savedChars} saved chars`);
}

// ── applyContextManagementPipeline returns smaller messages ─────────────
{
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' }
  ];
  // Fill messages beyond soft threshold
  const limit = 32000;
  const softChars = Math.floor(limit * 3.5 * 0.82);
  while (Comp.ctxSize(messages) < softChars + 1000) {
    messages.push({ role: 'tool', name: 'fs_read_file', content: 'x'.repeat(8000) });
  }

  const before = Comp.ctxSize(messages);
  const { messages: compacted, notes, stats } = Comp.applyContextManagementPipeline({ messages, round: 3, ctxLimit: limit });
  const after = Comp.ctxSize(compacted);

  assert.ok(Array.isArray(compacted), 'returns messages array');
  assert.ok(Array.isArray(notes), 'returns notes array');
  assert.ok(stats.tier !== 'none', 'tier is not none');
  assert.ok(after < before, `compacted ${after} < ${before}`);
  console.log(`  pipeline: tier=${stats.tier}, before=${before}, after=${after}, savedTokens=${stats.savedTokens}`);
}

// ── Pure: calling twice with same array does NOT reuse reference ──────────
{
  const messages = [
    { role: 'system', content: 'sys' }
  ];
  const limit = 32000;
  const softChars = Math.floor(limit * 3.5 * 0.82);
  while (Comp.ctxSize(messages) < softChars + 500) {
    messages.push({ role: 'tool', name: 'test_tool', content: 'data'.repeat(2000) });
  }

  const r1 = Comp.applyContextManagementPipeline({ messages, round: 1, ctxLimit: limit, preLlm: true });
  const r2 = Comp.applyContextManagementPipeline({ messages, round: 1, ctxLimit: limit, preLlm: true });
  assert.ok(r1.messages !== r2.messages, 'two calls do not return same reference');
  assert.ok(r1.messages !== messages, 'result is not same reference as input');
  console.log('  pure: no reference reuse');
}

// ── preLlmContextCheck returns compacted messages ──────────────────────────
{
  const messages = [
    { role: 'system', content: 'sys' }
  ];
  const limit = 32000;
  const hardChars = Math.floor(limit * 3.5 * 0.97);
  while (Comp.ctxSize(messages) < hardChars + 500) {
    messages.push({ role: 'tool', name: 'test_tool', content: 'a'.repeat(6000) });
  }

  const { messages: preLlmCompacted, notes } = Comp.preLlmContextCheck({ messages, round: 5, ctxLimit: limit });
  assert.ok(Array.isArray(preLlmCompacted), 'preLlm returns messages array');
  assert.ok(Comp.ctxSize(preLlmCompacted) <= Comp.ctxSize(messages), 'preLlm does not increase size');
  console.log('  preLlmContextCheck: returns compacted array');
}

console.log('All compaction tests passed');
process.exit(0);
