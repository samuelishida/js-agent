// Behavior-level tests for MCP settings UI wiring.

import assert from 'node:assert/strict';
import { createBrowserHarness, finish, makeDocumentStub, runScript, test } from './test-helpers/browser-harness.mjs';

const results = [];
console.log('MCP Settings Behavior Tests\n');

function setupSettings() {
  const servers = [];
  const connected = [];
  const doc = makeDocumentStub({
    'mcp-server-list': { innerHTML: '', style: {}, addEventListener() {} },
    'mcp-add-name': { value: '', textContent: '', style: {}, addEventListener() {} },
    'mcp-add-transport': { value: 'http', textContent: '', style: {}, addEventListener() {} },
    'mcp-add-url': { value: '', textContent: '', style: {}, addEventListener() {} },
    'mcp-add-command': { value: '', textContent: '', style: {}, addEventListener() {} },
    'mcp-add-args': { value: '', textContent: '', style: {}, addEventListener() {} },
    'mcp-add-enabled': { checked: true, style: {}, addEventListener() {} },
    'mcp-add-error': { textContent: '', style: {}, addEventListener() {} },
    'mcp-add-url-group': { style: { display: '' }, addEventListener() {} },
    'mcp-add-cmd-group': { style: { display: 'none' }, addEventListener() {} },
    'mcp-add-args-group': { style: { display: 'none' }, addEventListener() {} },
    'mcp-add-server-form': { style: { display: 'block' }, addEventListener() {} },
    'mcp-show-add-btn': { textContent: '', style: {}, addEventListener() {} },
    'settings-modal': { style: { display: 'none' }, addEventListener() {} }
  });
  const { context } = createBrowserHarness({
    document: doc,
    globals: {
      confirm: () => true,
      AgentMcpStore: {
        loadServers: () => servers.slice(),
        addServer: cfg => {
          const id = `mcp_${servers.length + 1}`;
          servers.push({ id, ...cfg });
          return { id };
        },
        removeServer: id => {
          const idx = servers.findIndex(s => s.id === id);
          if (idx >= 0) servers.splice(idx, 1);
        },
        setEnabled: (id, enabled) => {
          const s = servers.find(item => item.id === id);
          if (s) s.enabled = enabled;
        }
      },
      AgentMcpManager: {
        connect: async id => { connected.push(id); },
        disconnect: () => {},
        subscribe: () => () => {},
        getStatus: () => ({ state: 'idle' }),
        listTools: async () => [],
        setToolFilter: () => true
      },
      AgentMcpBridge: {
        unregisterMcpTools: () => {},
        discoverAndRegisterMcpTools: async () => {}
      }
    }
  });
  return { context, doc, servers, connected };
}

await test('settings exports all inline handler globals', async () => {
  const { context } = setupSettings();
  await runScript(context, 'src/app/ui/settings-mcp.js');
  for (const name of [
    'renderMcpToolsDrawer',
    'onToggleTool',
    'onEnableAllTools',
    'onDisableAllTools',
    'renderMcpResourcesDrawer',
    'renderMcpPromptsDrawer',
    'onUrlBlur'
  ]) {
    assert.equal(typeof context[name], 'function', `${name} should be exported`);
  }
}, results);

await test('/sse URL auto-selects SSE transport on blur', async () => {
  const { context, doc } = setupSettings();
  await runScript(context, 'src/app/ui/settings-mcp.js');
  doc.getElementById('mcp-add-transport').value = 'http';
  doc.getElementById('mcp-add-url').value = 'http://127.0.0.1:63221/sse';
  context.onUrlBlur();
  assert.equal(doc.getElementById('mcp-add-transport').value, 'sse');
}, results);

await test('HTTP transport rejects /sse URL with actionable validation', async () => {
  const { context, doc } = setupSettings();
  await runScript(context, 'src/app/ui/settings-mcp.js');
  doc.getElementById('mcp-add-name').value = 'VS Code';
  doc.getElementById('mcp-add-transport').value = 'http';
  doc.getElementById('mcp-add-url').value = 'http://127.0.0.1:63221/sse';
  context.onAddServerSubmit({ preventDefault() {} });
  assert.match(doc.getElementById('mcp-add-error').textContent, /select SSE transport/i);
}, results);

await test('adding enabled SSE server immediately asks manager to connect', async () => {
  const { context, doc, servers, connected } = setupSettings();
  await runScript(context, 'src/app/ui/settings-mcp.js');
  doc.getElementById('mcp-add-name').value = 'VS Code';
  doc.getElementById('mcp-add-transport').value = 'sse';
  doc.getElementById('mcp-add-url').value = 'http://127.0.0.1:63221/sse';
  doc.getElementById('mcp-add-enabled').checked = true;
  context.onAddServerSubmit({ preventDefault() {} });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].transport, 'sse');
  assert.deepEqual(connected, ['mcp_1']);
}, results);

finish(results, 'MCP settings behavior tests');
