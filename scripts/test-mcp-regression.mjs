// scripts/test-mcp-regression.mjs
// MCP regression tests: settings globals, manager store sync, bridge/toolgroup wiring.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function fileContains(file, ...needles) {
  const code = await readFile(file, 'utf8');
  for (const n of needles) {
    if (!code.includes(n)) throw new Error(`${file} missing: ${n}`);
  }
}

function log(label) { console.log(`  ${label}: OK`); }

// ── 1. Settings UI exports all inline handler globals ──────────────────────
{
  await fileContains('src/app/ui/settings-mcp.js',
    'window.renderMcpToolsDrawer = renderMcpToolsDrawer',
    'window.onToggleTool = onToggleTool',
    'window.onEnableAllTools = onEnableAllTools',
    'window.onDisableAllTools = onDisableAllTools'
  );
  log('settings-mcp.js exports required globals');
}

// ── 2. MCP Manager syncServersFromStore used in key methods ────────────────
{
  await fileContains('src/app/mcp/mcp-manager.js',
    'function syncServersFromStore()',
    'syncServersFromStore();',
    'throw new Error(`Server ${serverId} not found`);'
  );
  log('mcp-manager.js syncServersFromStore + connect errors');
}

// ── 3. Bridge loads persisted enabled tools and syncs AgentToolGroups ──────
{
  await fileContains('src/tools/mcp-bridge.js',
    "localStorage.getItem('agent_enabled_tools')",
    "persistedEnabled = JSON.parse(stored)",
    'window.AgentToolGroups = toolGroups;'
  );
  log('mcp-bridge.js persists + syncs groups');
}

// ── 4. tools.js renderToolGroups reads AgentTools.toolGroups as source ─────
{
  await fileContains('src/app/ui/tools.js',
    "const src = window.AgentTools?.toolGroups || window.AgentToolGroups || {};"
  );
  log('tools.js renderToolGroups reads AgentTools.toolGroups');
}

// ── 5. orchestrator.js session guidance includes MCP discovery hint ──────────
{
  await fileContains('src/core/orchestrator.js',
    'mcp_list_servers and mcp_list_tools before emitting the tool call.'
  );
  log('orchestrator.js MCP discovery guidance');
}

// ── 6. system.md includes MCP meta tool guidance ────────────────────────────
{
  await fileContains('prompts/system.md',
    'mcp_list_servers()',
    'mcp_list_tools(serverId?)'
  );
  log('system.md MCP meta tool guidance');
}

// ── 7. round-controller.js passes repaired.rawReply into handleNoToolCalls ───
{
  await fileContains('src/app/agent/round-controller.js',
    'rawReply: repaired?.rawReply || rawReply,',
    'function _userWantsMcp(userMessage)',
    'function _buildMcpNudge(userMessage, consecutiveNonActionRounds)'
  );
  log('round-controller.js repaired rawReply + MCP nudge');
}

console.log('\nAll MCP regression checks passed');
process.exit(0);
