// Behavior-level MCP routing and capability tests.

import assert from 'node:assert/strict';
import { createBrowserHarness, finish, runScripts, test } from './test-helpers/browser-harness.mjs';

const results = [];
console.log('MCP Routing Behavior Tests\n');

function makeFetch(toolMap) {
  const calls = [];
  const fetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body || '{}');
    calls.push(body);
    const serverUrl = body.serverUrl;
    const tools = toolMap[serverUrl] || [];
    let result = {};
    if (body.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', serverInfo: { name: serverUrl }, capabilities: { tools: {} } };
    } else if (body.method === 'tools/list') {
      result = { tools };
    } else if (body.method === 'tools/call') {
      result = { content: [{ type: 'text', text: `called:${body.params?.name}` }] };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result })
    };
  };
  fetch.calls = calls;
  return fetch;
}

async function setupMcp(toolMap) {
  const fetch = makeFetch(toolMap);
  const { context, storage } = createBrowserHarness({
    fetch,
    globals: {
      enabledTools: {},
      renderToolGroups: () => {},
      AgentState: { getEnabledTools: () => context.enabledTools },
      AgentTools: {
        registry: {},
        toolGroups: {},
        formatToolResult: (name, result) => `## ${name}\n${result}`
      }
    }
  });
  context.AgentState = { getEnabledTools: () => context.enabledTools };
  await runScripts(context, [
    'src/app/mcp/mcp-store.js',
    'src/app/mcp/mcp-http-transport.js',
    'src/app/mcp/mcp-manager.js',
    'src/tools/mcp-bridge.js'
  ]);
  return { context, storage, fetch };
}

await test('VS Code MCP registers diagnostics tool but no browser screenshot tool', async () => {
  const vscodeUrl = 'http://127.0.0.1:63221/sse';
  const { context } = await setupMcp({
    [vscodeUrl]: [{ name: 'code_checker', description: 'Retrieve diagnostics from VS Code language services' }]
  });
  context.AgentMcpStore.addServer({ name: 'VS Code', transport: 'sse', url: vscodeUrl, enabled: true });
  await context.AgentMcpManager.loadAndConnect();
  await context.AgentMcpBridge.discoverAndRegisterMcpTools();

  assert.ok(context.AgentTools.registry.mcp_vs_code_code_checker, 'code_checker should register exactly');
  assert.deepEqual(Array.from(context.AgentTools.toolGroups.mcp_vs_code.tools, t => t.name), ['mcp_vs_code_code_checker']);
  assert.ok(!Object.keys(context.AgentTools.registry).some(name => /screenshot|browser_take|navigate/i.test(name)));

  const output = await context.AgentTools.registry.mcp_list_tools.run({});
  assert.match(output, /## VS Code/);
  assert.match(output, /code_checker: Retrieve diagnostics/);
  assert.doesNotMatch(output, /browser_take_screenshot/);
}, results);

await test('Playwright MCP registers exact browser tools and calls through bridge', async () => {
  const pwUrl = 'http://127.0.0.1:63333/sse';
  const { context, fetch } = await setupMcp({
    [pwUrl]: [
      { name: 'browser_navigate', description: 'Navigate to a URL', inputSchema: { properties: { url: { type: 'string' } } } },
      { name: 'browser_take_screenshot', description: 'Take a page screenshot', inputSchema: { properties: { fullPage: { type: 'boolean' } } } }
    ]
  });
  context.AgentMcpStore.addServer({ name: 'Playwright', transport: 'sse', url: pwUrl, enabled: true });
  await context.AgentMcpManager.loadAndConnect();
  await context.AgentMcpBridge.discoverAndRegisterMcpTools();

  assert.deepEqual(Array.from(context.AgentTools.toolGroups.mcp_playwright.tools, t => t.name), [
    'mcp_playwright_browser_navigate',
    'mcp_playwright_browser_take_screenshot'
  ]);
  const result = await context.AgentTools.registry.mcp_playwright_browser_take_screenshot.run({ fullPage: true });
  assert.match(result, /called:browser_take_screenshot/);
  assert.ok(fetch.calls.some(call => call.method === 'tools/call' && call.params?.name === 'browser_take_screenshot'));
}, results);

await test('remote MCP tools are absent from registry and groups by default', async () => {
  const remoteUrl = 'http://10.0.0.1:3000/mcp';
  const { context } = await setupMcp({
    [remoteUrl]: [{ name: 'browser_take_screenshot', description: 'Take screenshot' }]
  });
  context.AgentMcpStore.addServer({ name: 'Remote', transport: 'http', url: remoteUrl, enabled: true });
  await context.AgentMcpManager.loadAndConnect();
  await context.AgentMcpBridge.discoverAndRegisterMcpTools();

  assert.ok(!context.AgentTools.registry.mcp_remote_browser_take_screenshot);
  assert.deepEqual(Array.from(context.AgentTools.toolGroups.mcp_remote?.tools || []), []);
}, results);

await test('persisted disabled MCP tool is not re-enabled by discovery', async () => {
  const pwUrl = 'http://127.0.0.1:63334/sse';
  const { context, storage } = await setupMcp({
    [pwUrl]: [{ name: 'browser_take_screenshot', description: 'Take screenshot' }]
  });
  storage.setItem('agent_enabled_tools', JSON.stringify({ mcp_playwright_browser_take_screenshot: false }));
  context.AgentMcpStore.addServer({ name: 'Playwright', transport: 'sse', url: pwUrl, enabled: true });
  await context.AgentMcpManager.loadAndConnect();
  await context.AgentMcpBridge.discoverAndRegisterMcpTools();

  assert.ok(context.AgentTools.registry.mcp_playwright_browser_take_screenshot);
  assert.equal(context.enabledTools.mcp_playwright_browser_take_screenshot, undefined);
}, results);

finish(results, 'MCP routing behavior tests');
