// src/tools/mcp-bridge.js
// Thin adapter: discovers tools from AgentMcpManager and registers into AgentTools.registry.
// Publishes: window.AgentMcpBridge

(() => {
  'use strict';

  const Manager = window.AgentMcpManager;
  const Store = window.AgentMcpStore;
  const HttpTransport = window.AgentMcpHttpTransport;

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

    // Load persisted enabled tools so we can honor disabled state when default-enabling
    let persistedEnabled = {};
    try {
      const stored = localStorage.getItem('agent_enabled_tools');
      if (stored) persistedEnabled = JSON.parse(stored);
    } catch { /* ignore */ }

    // Always register meta tools (they're host-side and don't depend on servers)
    _registerMetaTools(registry, toolGroups, formatToolResult, persistedEnabled);

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
        const filter = server.toolFilter || {};
        const urlStr = String(server.url || '');
        const isLocalhost = (() => {
          if (server.transport === 'stdio') return true;
          try {
            return /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(new URL(urlStr).hostname);
          } catch (e) {
            return false;
          }
        })();
        // Default: remote = none (user must enable explicitly), localhost/stdio = all
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

          // Default-enable newly registered MCP tools unless user explicitly disabled them
          const et = window.AgentState?.getEnabledTools?.() || window.enabledTools;
          if (typeof et === 'object' && et && !Object.prototype.hasOwnProperty.call(et, toolName) && !Object.prototype.hasOwnProperty.call(persistedEnabled, toolName)) {
            et[toolName] = true;
          }
        }

        console.log(`[MCP Bridge] Registered ${toolGroups[groupKey].tools.length} tool(s) from ${server.name || server.url || server.id}`);
      } catch (err) {
        console.warn(`[MCP Bridge] Could not reach ${server.url || server.id}: ${err.message}`);
      }
    }

    // Sync legacy global for renderToolGroups
    if (window.AgentToolGroups !== toolGroups) {
      window.AgentToolGroups = toolGroups;
    }

    // Render tool groups
    if (typeof renderToolGroups === 'function') renderToolGroups();
  }

  /**
   * Classify an MCP tool by capability tags.
   * @param {object} tool
   * @returns {string[]}
   */
  function classifyMcpToolCapability(tool) {
    const n = String(tool?.name || '').toLowerCase();
    const d = String(tool?.description || '').toLowerCase();
    const tags = [];
    const has = (re) => re.test(n) || re.test(d);

    if (has(/browser|navigate|goto|visit|page/)) tags.push('browser');
    if (has(/screenshot|capture|snap|image.*page/)) tags.push('screenshot');
    if (has(/click|type|fill|input|form|interact|press/)) tags.push('navigation');
    if (has(/read|get|list|search|fetch|describe|info|status|query|find/)) tags.push('read');
    if (has(/write|edit|create|update|modify|save|append/)) tags.push('write');
    if (has(/check|lint|diagnose|validate|verify|test|scan/)) tags.push('diagnostics');
    if (has(/file|fs|path|dir|folder|filesystem/)) tags.push('filesystem');
    if (has(/exec|shell|command|run|spawn|terminal|bash/)) tags.push('exec');
    if (has(/git|commit|branch|diff|pull|push/)) tags.push('vcs');
    if (has(/memory|recall|remember|store/)) tags.push('memory');
    if (!tags.length) tags.push('unknown');
    return tags;
  }

  /**
   * Find MCP tools across servers by a capability tag.
   * @param {string} tag
   * @returns {Promise<Array<{ serverId: string, toolName: string, tags: string[], description: string }>>}
   */
  async function findMcpToolsByCapability(tag) {
    if (!Manager || !Store) return [];
    const out = [];
    const servers = Manager.getServers().filter(s => s.enabled);
    for (const server of servers) {
      const st = Manager.getStatus(server.id);
      if (st?.state !== 'connected') continue;
      try {
        const tools = await Manager.listTools(server.id);
        for (const t of tools) {
          const tags = classifyMcpToolCapability(t);
          if (tags.includes(tag)) {
            out.push({
              serverId: server.id,
              toolName: t.name,
              tags,
              description: t.description || ''
            });
          }
        }
      } catch { /* ignore */ }
    }
    return out;
  }

  /**
   * Check whether any MCP server exposes a specific capability.
   * @param {string} tag
   * @returns {Promise<{ available: boolean, matches: Array<{serverId:string,toolName:string}> }>}
   */
  async function checkMcpCapability(tag) {
    const matches = await findMcpToolsByCapability(tag);
    return { available: matches.length > 0, matches };
  }

  // Register meta MCP tools (always available, require confirmation via riskLevel)
  function _registerMetaTools(registry, toolGroups, formatToolResult, persistedEnabled) {
    const metaGroup = toolGroups['mcp_meta'] || { label: 'MCP Meta', tools: [] };
    toolGroups['mcp_meta'] = metaGroup;

    const metas = [
      {
        name: 'mcp_reload',
        sig: 'mcp_reload(serverId?)',
        desc: 'Reload a specific MCP server (or all if no id) to refresh its tool list.',
        run: async (args = {}) => {
          const sid = args?.serverId;
          if (sid) {
            await Manager.reloadServer(sid);
            return formatToolResult('mcp_reload', `Reloaded ${sid}`);
          }
          await Manager.reloadAll();
          return formatToolResult('mcp_reload', 'Reloaded all MCP servers');
        }
      },
      {
        name: 'mcp_list_servers',
        sig: 'mcp_list_servers()',
        desc: 'List all configured MCP servers with their status.',
        run: async () => {
          const servers = Manager.getServers();
          const lines = servers.map(s => {
            const st = Manager.getStatus(s.id);
            return `- ${s.name} (${s.transport}) [${s.enabled ? 'enabled' : 'disabled'}] state=${st?.state || 'unknown'}`;
          });
          return formatToolResult('mcp_list_servers', lines.join('\n') || 'No MCP servers configured.');
        }
      },
      {
        name: 'mcp_list_tools',
        sig: 'mcp_list_tools(serverId?)',
        desc: 'List available tools from a specific MCP server (or all).',
        run: async (args = {}) => {
          const sid = args?.serverId;
          if (sid) {
            const tools = await Manager.listTools(sid);
            return formatToolResult('mcp_list_tools', tools.map(t => `- ${t.name}: ${t.description || ''}`).join('\n'));
          }
          const servers = Manager.getServers().filter(s => s.enabled);
          const out = [];
          for (const s of servers) {
            const tools = await Manager.listTools(s.id);
            out.push(`## ${s.name}`);
            out.push(...tools.map(t => `- ${t.name}: ${t.description || ''}`));
          }
          return formatToolResult('mcp_list_tools', out.join('\n') || 'No tools found.');
        }
      },
      {
        name: 'mcp_list_resources',
        sig: 'mcp_list_resources(serverId?)',
        desc: 'List available resources from a specific MCP server (or all).',
        run: async (args = {}) => {
          const sid = args?.serverId;
          if (!sid) return formatToolResult('mcp_list_resources', 'serverId is required');
          const config = Manager.getServers().find(s => s.id === sid);
          if (!config) return formatToolResult('mcp_list_resources', `Server ${sid} not found`);
          const resources = await Manager.listResources(sid);
          return formatToolResult('mcp_list_resources', resources.map(r => `- ${r.uri}: ${r.name || ''}`).join('\n') || 'No resources.');
        }
      },
      {
        name: 'mcp_read_resource',
        sig: 'mcp_read_resource(serverId, uri)',
        desc: 'Read a resource URI from an MCP server.',
        run: async (args = {}) => {
          const sid = args?.serverId;
          const uri = args?.uri;
          if (!sid || !uri) return formatToolResult('mcp_read_resource', 'serverId and uri are required');
          const config = Manager.getServers().find(s => s.id === sid);
          if (!config) return formatToolResult('mcp_read_resource', `Server ${sid} not found`);
          const res = await Manager.readResource(sid, uri);
          if (res?.error) return formatToolResult('mcp_read_resource', `[Error] ${res.error}`);
          const text = (res?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n') || JSON.stringify(res);
          return formatToolResult('mcp_read_resource', text);
        }
      },
      {
        name: 'mcp_list_prompts',
        sig: 'mcp_list_prompts(serverId?)',
        desc: 'List available prompts from a specific MCP server (or all).',
        run: async (args = {}) => {
          const sid = args?.serverId;
          if (!sid) return formatToolResult('mcp_list_prompts', 'serverId is required');
          const config = Manager.getServers().find(s => s.id === sid);
          if (!config) return formatToolResult('mcp_list_prompts', `Server ${sid} not found`);
          const prompts = await Manager.listPrompts(sid);
          return formatToolResult('mcp_list_prompts', prompts.map(p => `- ${p.name}: ${p.description || ''}`).join('\n') || 'No prompts.');
        }
      },
      {
        name: 'mcp_find_tools',
        sig: 'mcp_find_tools(capability)',
        desc: 'Find MCP tools across all connected servers by capability tag (e.g., browser, screenshot, diagnostics). Returns a list of matching tools.',
        run: async (args = {}) => {
          const tag = String(args?.capability || '').toLowerCase().trim();
          if (!tag) return formatToolResult('mcp_find_tools', 'capability is required (e.g. browser, screenshot, diagnostics)');
          const matches = await findMcpToolsByCapability(tag);
          if (!matches.length) {
            const servers = Manager.getServers().filter(s => s.enabled);
            const names = servers.map(s => s.name).join(', ') || 'none';
            return formatToolResult('mcp_find_tools', `No tools tagged "${tag}" found among connected MCP servers (${names}).`);
          }
          const lines = matches.map(m => `- ${m.toolName} on ${m.serverId} [${m.tags.join(', ')}]: ${m.description}`);
          return formatToolResult('mcp_find_tools', lines.join('\n'));
        }
      },
      {
        name: 'mcp_get_prompt',
        sig: 'mcp_get_prompt(serverId, name, args?)',
        desc: 'Get a prompt template from an MCP server.',
        run: async (args = {}) => {
          const sid = args?.serverId;
          const name = args?.name;
          if (!sid || !name) return formatToolResult('mcp_get_prompt', 'serverId and name are required');
          const config = Manager.getServers().find(s => s.id === sid);
          if (!config) return formatToolResult('mcp_get_prompt', `Server ${sid} not found`);
          const res = await Manager.getPrompt(sid, name, args?.arguments || {});
          if (res?.error) return formatToolResult('mcp_get_prompt', `[Error] ${res.error}`);
          const text = (res?.messages || []).map(m => `${m.role}: ${m.content?.text || m.content || ''}`).join('\n') || JSON.stringify(res);
          return formatToolResult('mcp_get_prompt', text);
        }
      }
    ];

    for (const m of metas) {
      if (registry[m.name]) continue;
      registry[m.name] = {
        name: m.name,
        description: m.desc,
        retries: 1,
        riskLevel: 'irreversible',
        run: m.run
      };
      metaGroup.tools.push({ name: m.name, signature: m.sig });
      // Default-enable meta tools unless user explicitly disabled them
      const et = window.AgentState?.getEnabledTools?.() || window.enabledTools;
      if (typeof et === 'object' && et) {
        if (Object.prototype.hasOwnProperty.call(persistedEnabled, m.name)) {
          et[m.name] = !!persistedEnabled[m.name];
        } else if (!Object.prototype.hasOwnProperty.call(et, m.name)) {
          et[m.name] = true;
        }
      }
    }
  }

  window.AgentMcpBridge = {
    discoverAndRegisterMcpTools,
    unregisterMcpTools,
    classifyMcpToolCapability,
    findMcpToolsByCapability,
    checkMcpCapability
  };
})();
