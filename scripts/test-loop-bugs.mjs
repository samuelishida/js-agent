// Behavior-level agent loop regression tests.

import assert from 'node:assert/strict';
import { createBrowserHarness, finish, runScripts, test } from './test-helpers/browser-harness.mjs';

function makeToolCall(tool, args = {}) {
  return `<tool_call>\n${JSON.stringify({ tool, args })}\n</tool_call>`;
}

function setupRoundHarness({ llmReplies = [] } = {}) {
  const executed = [];
  const notices = [];
  const messages = [];
  const { context } = createBrowserHarness({
    globals: {
      window: undefined,
      sessionStats: { tools: 0 },
      enabledTools: {
        mcp_list_servers: true,
        mcp_list_tools: true,
        mcp_playwright_browser_navigate: true,
        mcp_playwright_browser_take_screenshot: true,
        runtime_generateFile: true,
        skill_search: true,
        skill_load: true,
        tool_search: true
      },
      CONSTANTS: {
        DEFAULT_TIMEOUT_MS_CLOUD: 1000,
        DEFAULT_RETRIES_CLOUD: 0,
        DEFAULT_MAX_TOKENS_LOCAL: 2048,
        MAX_CONSECUTIVE_NON_ACTION_ROUNDS: 3
      },
      AgentLLMUtils: {},
      AgentCompaction: {
        recordRepeatedToolCall: () => ({ repeated: false }),
        recordToolFailure: () => ({ repeated: false }),
        sanitizeToolResult: value => String(value || ''),
        buildToolUseSummary: results => `[TOOL_USE_SUMMARY]\n${results.map(r => `${r.call.tool}: ${r.result}`).join('\n')}`,
        applyToolResultContextBudget: (_call, result) => result,
        applyContextManagementPipeline: ({ messages }) => ({ messages, notes: [] }),
        preLlmContextCheck: ({ messages }) => ({ messages, notes: [] }),
        extractPromptInjectionSignals: () => []
      },
      AgentPermissions: {
        isPermissionDeniedResult: () => false,
        runPermissionDenials: []
      },
      AgentTools: {
        registry: {
          mcp_list_servers: {},
          mcp_list_tools: {},
          mcp_playwright_browser_navigate: {},
          mcp_playwright_browser_take_screenshot: {},
          runtime_generateFile: {},
          skill_search: {},
          skill_load: {},
          tool_search: {}
        }
      },
      AgentMcpManager: { getServers: () => [{ id: 'vscode', name: 'VS Code' }] },
      AgentOrchestrator: {
        buildRepairPrompt: async () => 'repair prompt',
        buildRuntimeContinuationPrompt: () => ''
      },
      AgentRegex: {
        TOOL_BLOCK: /<tool_call(?:\s[^>]*>|>?)\s*[\s\S]*?<\/tool_call>/gi,
        hasUnprocessedToolCall: raw => /<tool_call/i.test(String(raw || '')),
        validateToolOutput: () => ({ valid: true, issues: [] })
      },
      AgentToolExecution: {
        runToolCallRepairAttempts: new Set(),
        runSuccessfulToolCount: 0,
        stableHashText: value => String(value),
        normalizeToolCallObject: call => call?.tool ? { tool: call.tool, args: call.args || {} } : null,
        dedupeToolCalls: calls => calls,
        resolveToolCallsFromModelReply: (_visible, raw) => {
          const out = [];
          const re = /<tool_call(?:\s[^>]*>|>?)\s*([\s\S]*?)<\/tool_call>/gi;
          let m;
          while ((m = re.exec(String(raw || ''))) !== null) {
            try { out.push(JSON.parse(m[1].trim())); } catch {}
          }
          return out;
        },
        partitionToolCallBatches: calls => [{ concurrencySafe: false, calls }],
        executeTool: async call => {
          executed.push(call);
          return `OK ${call.tool}`;
        },
        getToolCallSignature: call => `${call.tool}:${JSON.stringify(call.args || {})}`,
        checkReadBeforeWriteWarning: () => ''
      },
      getRuntimeModules: () => ({
        regex: context.AgentRegex,
        orchestrator: context.AgentOrchestrator,
        tools: context.AgentTools
      }),
      callLLM: async () => {
        if (!llmReplies.length) throw new Error('No LLM reply queued');
        return llmReplies.shift();
      },
      isLocalModeActive: () => false,
      getMaxTokensForModel: () => 2048,
      getCtxLimit: () => 32000,
      sleep: async () => {},
      throwIfStopRequested: () => {},
      showThinking: () => {},
      hideThinking: () => {},
      updateStats: () => {},
      setStatus: () => {},
      addNotice: notice => notices.push(notice),
      addMessage: (role, content) => messages.push({ role, content })
    }
  });
  return { context, executed, notices, messages };
}

async function loadRound(context) {
  await runScripts(context, [
    'src/app/reply-analysis.js',
    'src/app/agent/tool-call-repair.js',
    'src/app/agent/round-controller.js'
  ]);
}

const results = [];
console.log('Agent Loop Behavior Tests\n');

await test('repair narration with no tool calls continues instead of finalizing', async () => {
  const h = setupRoundHarness({
    llmReplies: [
      'I will check the available MCP tools first.',
      'I will inspect the MCP servers now.'
    ]
  });
  await loadRound(h.context);
  const result = await h.context.AgentRoundController.executeRound({
    userMessage: 'ss of yvy.app.br via playwright mcp go',
    messages: [{ role: 'user', content: 'ss of yvy.app.br via playwright mcp go' }],
    round: 1,
    maxRounds: 5,
    delay: 0,
    consecutiveNonActionRounds: 0
  });
  assert.equal(result.finalAnswer, false);
  assert.equal(result.shouldContinue, true);
  assert.equal(h.executed.length, 0, 'no fallback tool should execute');
  assert.match(result.messages.at(-1).content, /mcp_list_servers|mcp_list_tools/i);
}, results);

await test('strict MCP request blocks local runtime_generateFile fallback', async () => {
  const h = setupRoundHarness({
    llmReplies: [makeToolCall('runtime_generateFile', { path: 'agent-sandbox/ss.cjs', filename: 'ss.png' })]
  });
  await loadRound(h.context);
  const result = await h.context.AgentRoundController.executeRound({
    userMessage: 'ss of yvy.app.br via playwright mcp go',
    messages: [{ role: 'user', content: 'ss of yvy.app.br via playwright mcp go' }],
    round: 1,
    maxRounds: 5,
    delay: 0,
    consecutiveNonActionRounds: 0
  });
  assert.equal(result.finalAnswer, false);
  assert.equal(result.shouldContinue, true);
  assert.equal(h.executed.length, 0, 'runtime_generateFile must not execute for strict MCP request');
  assert.ok(h.notices.some(n => /Blocked non-MCP fallback/i.test(n)), 'missing strict MCP block notice');
}, results);

await test('strict MCP request allows real MCP Playwright tools', async () => {
  const h = setupRoundHarness({
    llmReplies: [
      makeToolCall('mcp_playwright_browser_navigate', { url: 'https://yvy.app.br' })
      + '\n'
      + makeToolCall('mcp_playwright_browser_take_screenshot', { fullPage: true })
    ]
  });
  await loadRound(h.context);
  const result = await h.context.AgentRoundController.executeRound({
    userMessage: 'ss of yvy.app.br via playwright mcp go',
    messages: [{ role: 'user', content: 'ss of yvy.app.br via playwright mcp go' }],
    round: 1,
    maxRounds: 5,
    delay: 0,
    consecutiveNonActionRounds: 0
  });
  assert.equal(result.finalAnswer, false);
  assert.deepEqual(h.executed.map(c => c.tool), [
    'mcp_playwright_browser_navigate',
    'mcp_playwright_browser_take_screenshot'
  ]);
  assert.ok(!h.executed.some(c => c.tool === 'runtime_generateFile'));
}, results);

await test('non-MCP Playwright request can use local runtime_generateFile fallback', async () => {
  const h = setupRoundHarness({
    llmReplies: [makeToolCall('runtime_generateFile', { path: 'agent-sandbox/ss.cjs', filename: 'ss.png' })]
  });
  await loadRound(h.context);
  const result = await h.context.AgentRoundController.executeRound({
    userMessage: 'take a screenshot of yvy.app.br with Playwright',
    messages: [{ role: 'user', content: 'take a screenshot of yvy.app.br with Playwright' }],
    round: 1,
    maxRounds: 5,
    delay: 0,
    consecutiveNonActionRounds: 0
  });
  assert.equal(result.finalAnswer, false);
  assert.deepEqual(h.executed.map(c => c.tool), ['runtime_generateFile']);
}, results);

finish(results, 'Agent loop behavior tests');
