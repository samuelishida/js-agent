// scripts/test-non-mcp-playwright.mjs
// Test that plain Playwright/browser requests don't trigger MCP nudge

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// ── Load round-controller ────────────────────────────────────────────────────
const rcCode = await readFile('src/app/agent/round-controller.js', 'utf8');

globalThis.window = {
  CONSTANTS: {
    MAX_CONSECUTIVE_NON_ACTION_ROUNDS: 6,
    NOTE_MAX_CHARS: 120
  },
  AgentTools: { registry: {} },
  AgentMcpManager: { getServers: () => [], getStatus: () => ({}) },
  AgentMcpBridge: { checkMcpCapability: null },
  AgentReplyAnalysis: {
    extractThinkingBlocks: () => [],
    thinkingIndicatesFinalAnswer: () => false
  },
  AgentCompaction: { preLlmContextCheck: null },
  enabledTools: {},
  AgentToolExecution: null,
  AgentRunGraph: null,
  AgentErrorRecovery: null,
  getMaxTokensForModel: null,
  callLLM: null,
  splitModelReply: null,
  getCtxLimit: null,
  throwIfStopRequested: () => {}
};

vm.runInThisContext(rcCode, { filename: 'round-controller.js' });

// ── Helpers ─────────────────────────────────────────────────────────────────
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

// ── Tests ───────────────────────────────────────────────────────────────────
console.log('Non-MCP Playwright Narration Tests\n');

const results = [];

results.push(await group('_userWantsMcp returns false for plain Playwright request', () => {
  const fn = globalThis.window._userWantsMcp || (typeof _userWantsMcp !== 'undefined' ? _userWantsMcp : null);
  assert.ok(fn, '_userWantsMcp exists');
  assert.strictEqual(fn('Take a browser screenshot of example.com'), false, 'browser screenshot not MCP');
  assert.strictEqual(fn('Use playwright to click the button'), false, 'playwright click not MCP');
  assert.strictEqual(fn('Navigate to google.com using browser automation'), false, 'browser automation not MCP');
}));

results.push(await group('_userWantsMcp returns true for explicit MCP request', () => {
  const fn = globalThis.window._userWantsMcp || (typeof _userWantsMcp !== 'undefined' ? _userWantsMcp : null);
  assert.strictEqual(fn('Use MCP to take a screenshot'), true, 'MCP screenshot');
  assert.strictEqual(fn('Call the MCP playwright server'), true, 'MCP playwright server');
  assert.strictEqual(fn('Via MCP, click the login button'), true, 'via MCP click');
  assert.strictEqual(fn('Use playwright MCP for navigation'), true, 'playwright MCP');
}));

results.push(await group('_wantsBrowserAutomation detects browser automation', () => {
  const fn = globalThis.window._wantsBrowserAutomation || (typeof _wantsBrowserAutomation !== 'undefined' ? _wantsBrowserAutomation : null);
  assert.ok(fn, '_wantsBrowserAutomation exists');
  assert.strictEqual(fn('Take a browser screenshot'), true, 'browser screenshot');
  assert.strictEqual(fn('Use playwright to click'), true, 'playwright click');
  assert.strictEqual(fn('Navigate using browser automation'), true, 'browser automation');
  assert.strictEqual(fn('Get page source'), true, 'page source');
  assert.strictEqual(fn('Search the web for news'), false, 'web search not browser automation');
}));

results.push(await group('_buildMcpNudge only for MCP requests', () => {
  const mcpNudge = globalThis.window._buildMcpNudge || (typeof _buildMcpNudge !== 'undefined' ? _buildMcpNudge : null);
  assert.ok(mcpNudge, '_buildMcpNudge exists');
  assert.strictEqual(mcpNudge('Use MCP screenshot', 1).includes('mcp_list_servers'), true, 'MCP nudge for MCP request');
  assert.strictEqual(mcpNudge('Take browser screenshot', 1), '', 'no MCP nudge for plain browser request');
}));

results.push(await group('_buildBrowserNudge only for non-MCP browser requests', () => {
  const browserNudge = globalThis.window._buildBrowserNudge || (typeof _buildBrowserNudge !== 'undefined' ? _buildBrowserNudge : null);
  assert.ok(browserNudge, '_buildBrowserNudge exists');
  assert.strictEqual(browserNudge('Take browser screenshot', 1).includes('local browser tools'), true, 'browser nudge for plain request');
  assert.strictEqual(browserNudge('Use MCP screenshot', 1), '', 'no browser nudge for MCP request');
}));

// ── Summary ─────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} passed`);
if (passed < total) {
  process.exitCode = 1;
} else {
  console.log('All non-MCP Playwright narration tests passed.\n');
}
