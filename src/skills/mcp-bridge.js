// src/skills/mcp-bridge.js
// Discovers tools from configured MCP servers and registers them into AgentSkills.registry.
// Call discoverAndRegisterMcpTools() after AgentSkills is initialized.
// Publishes: window.AgentMcpBridge

(() => {
  'use strict';

  async function discoverAndRegisterMcpTools() {
    const mcpClient = window.AgentMcpClient;
    if (!mcpClient) return;

    const servers = mcpClient.loadMcpServers().filter(s => s.enabled && s.url);
    if (!servers.length) return;

    const agentSkills = window.AgentSkills;
    if (!agentSkills?.registry || !agentSkills?.skillGroups || !agentSkills?.formatToolResult) return;

    const { registry, skillGroups, formatToolResult } = agentSkills;

    for (const server of servers) {
      const serverSlug = String(server.name || server.url)
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const groupKey = `mcp_${serverSlug}`;

      try {
        await mcpClient.initializeServer(server);
        const tools = await mcpClient.listTools(server);
        if (!tools.length) continue;

        if (!skillGroups[groupKey]) {
          skillGroups[groupKey] = { label: `MCP: ${server.name || serverSlug}`, tools: [] };
        }

        for (const tool of tools) {
          const safeToolName = String(tool.name || '').replace(/[^a-z0-9_]/gi, '_');
          const toolName = `mcp_${serverSlug}_${safeToolName}`;
          if (registry[toolName]) continue;

          const inputProps = tool.inputSchema?.properties || {};
          const sig = `${toolName}(${Object.keys(inputProps).join(', ')})`;

          registry[toolName] = {
            name: toolName,
            description: tool.description || `MCP tool from ${server.name || server.url}: ${tool.name}`,
            retries: 1,
            run: async (args = {}) => {
              const result = await mcpClient.callTool(server, tool.name, args);
              return formatToolResult(toolName, result);
            }
          };

          skillGroups[groupKey].tools.push({ name: toolName, signature: sig });
        }

        console.log(`[MCP] Registered ${tools.length} tool(s) from ${server.name || server.url}`);
      } catch (err) {
        console.warn(`[MCP] Could not reach ${server.url}: ${err.message}`);
      }
    }
  }

  window.AgentMcpBridge = {
    discoverAndRegisterMcpTools
  };
})();
