// src/tools/mcp-bridge.js
// Thin adapter: discovers tools from AgentMcpManager and registers into AgentTools.registry.
// Publishes: window.AgentMcpBridge

(() => {
  'use strict';

  const Manager = window.AgentMcpManager;
  const Store = window.AgentMcpStore;

  /**
   * Unregister all MCP tools for a given server.
   * @param {string} serverId
   * @returns {void}
   */
  function unregisterMcpTools(serverId) {
    const agentSkills = window.AgentTools;
    if (!agentSkills?.registry || !agentSkills?.toolGroups) return;
    const { registry, toolGroups } = agentSkills;

    const config = Store?.loadServers?.().find(s => s.id === serverId);
    if (!config) return;
    const slug = Store._serverSlug(config);
    const prefix = `mcp_${slug}_`;

    // Remove matching tools from registry
    for (const key of Object.keys(registry)) {
      if (key.startsWith(prefix)) delete registry[key];
    }
    // Remove matching group
    const groupKey = `mcp_${slug}`;
    delete toolGroups[groupKey];

    // Re-render tool groups if available
    if (typeof renderToolGroups === 'function') renderToolGroups();
  }

  /**
   * Discover and register MCP tools for all enabled servers.
   * @returns {Promise<void>}
   */
  async function discoverAndRegisterMcpTools() {
    if (!Manager || !Store) {
      console.warn('[MCP Bridge] Manager or Store not found; skipping MCP.');
      return;
    }
    if (!Store.isEnabled()) {
      console.log('[MCP Bridge] Feature flag disabled; skipping MCP.');
      return;
    }

    const agentSkills = window.AgentTools;
    if (!agentSkills?.registry || !agentSkills?.toolGroups || !agentSkills?.formatToolResult) {
      console.warn('[MCP Bridge] AgentTools not ready; skipping MCP.');
      return;
    }
    const { registry, toolGroups, formatToolResult } = agentSkills;

    const servers = Store.loadServers().filter(s => s.enabled);
    if (!servers.length) return;

    for (const server of servers) {
      const slug = Store._serverSlug(server);
      const groupKey = `mcp_${slug}`;

      try {
        // Initialize / connect if not already
        const status = Manager.getStatus(server.id);
        if (!status || status.state !== 'connected') {
          console.log(`[MCP Bridge] Connecting to ${server.name || server.url || server.id}...`);
          await Manager.connect(server.id);
        }

        const tools = await Manager.listTools(server.id);
        if (!tools.length) {
          console.log(`[MCP Bridge] No tools from ${server.name || server.id}`);
          continue;
        }

        // Apply filters
        const filter = server.toolFilter || { mode: 'all' };
        const isLocalhost = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(String(server.url || ''));
        // Default: remote = none (user must enable explicitly), localhost = all
        const effectiveMode = filter.mode || (isLocalhost ? 'all' : 'none');
        /** @type {Set<string>} */
        const allowSet = new Set((effectiveMode === 'include' && filter.names) ? filter.names.map(String) : []);

        if (!toolGroups[groupKey]) {
          toolGroups[groupKey] = { label: `MCP: ${server.name || slug}`, tools: [] };
        }
        // Start from an empty group each time we register (atomic replace)
        const previousGroup = toolGroups[groupKey];
        toolGroups[groupKey] = { label: previousGroup.label, tools: [] };

        for (const tool of tools) {
          const safeToolName = String(tool.name || '').replace(/[^a-z0-9_]/gi, '_');
          const toolName = Manager._safeToolName(slug, tool.name);
          if (registry[toolName]) {
            // Already exists; skip re-registration in this pass to avoid duplicate group entries
            continue;
          }

          // Filter by effective mode
          if (effectiveMode === 'none') continue;
          if (effectiveMode === 'include' && !allowSet.has(tool.name)) continue;

          const inputProps = tool.inputSchema?.properties || {};
          const sig = `${toolName}(${Object.keys(inputProps).join(', ')})`;

          const riskLevel = Manager._mapRisk?.(tool) || 'shared';

          registry[toolName] = {
            name: toolName,
            description: tool.description || `MCP tool from ${server.name || server.url || server.id}: ${tool.name}`,
            retries: 1,
            riskLevel,
            run: async (args = {}) => {
              const raw = await Manager.callTool(server.id, tool.name, args);
              // Normalize result to a string for the agent
              if (raw?.error) return formatToolResult(toolName, `[${toolName}] Error: ${raw.error}`);
              const text = (raw?.content || [])
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n') || JSON.stringify(raw);
              return formatToolResult(toolName, text);
            }
          };

          toolGroups[groupKey].tools.push({ name: toolName, signature: sig });

          // Default-enable newly registered MCP tools in the global enabledTools map
          const et = window.AgentState?.getEnabledTools?.() || window.enabledTools;
          if (typeof et === 'object' && et && !Object.prototype.hasOwnProperty.call(et, toolName)) {
            et[toolName] = true;
          }
        }

        console.log(`[MCP Bridge] Registered ${toolGroups[groupKey].tools.length} tool(s) from ${server.name || server.url || server.id}`);
      } catch (err) {
        console.warn(`[MCP Bridge] Could not reach ${server.url || server.id}: ${err.message}`);
      }
    }

    // Render tool groups
    if (typeof renderToolGroups === 'function') renderToolGroups();
  }

  window.AgentMcpBridge = {
    discoverAndRegisterMcpTools,
    unregisterMcpTools
  };
})();
