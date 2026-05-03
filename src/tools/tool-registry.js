// src/tools/tool-registry.js
// Tool registry: registration, lookup, listing, lazy loading, snapshot tools.
// Reads from window.AgentToolModules, window.AgentSnapshot, window.AgentTools (partial).
// Publishes: window.AgentToolRegistry

(() => {
  'use strict';

  /** @type {Set<string>} */
  const LAZY_TOOLS = new Set([
    'weather_current', 'geo_current_location', 'clipboard_read', 'clipboard_write',
    'storage_list_keys', 'storage_get', 'storage_set',
    'notification_request_permission', 'notification_send',
    'tab_broadcast', 'tab_listen',
    'parse_json', 'parse_csv',
    'memory_write', 'memory_search', 'memory_list', 'tool_search',
    'snapshot_tool_catalog', 'task_create', 'task_get', 'task_list', 'task_update',
    'worker_batch', 'worker_list', 'worker_get',
    'todo_write', 'ask_user_question',
    'fs_upload_pick', 'fs_save_upload', 'fs_download_file',
    'fs_copy_file', 'fs_move_file', 'fs_rename_path', 'fs_mkdir', 'fs_touch',
    'fs_preview_file',
    'runtime_lsp', 'runtime_spawnAgent', 'runtime_todoWrite',
    'runtime_memoryRead', 'runtime_memoryWrite', 'runtime_getDiagnostics',
    'runtime_fileDiff',
    'skill_search', 'skill_load'
  ]);
  /** @type {Set<string>} */
  const lazyLoaded = new Set();

  /**
   * Create a lazy runner that tracks first invocation.
   * @param {string} name - Tool name
   * @param {Function} realRun - Actual run function
   * @returns {Function} Tracked run function
   */
  function makeLazyRunner(name, realRun) {
    let invoked = false;
    return async function trackedRun(args, context) {
      if (!invoked) {
        invoked = true;
        lazyLoaded.add(name);
      }
      return realRun(args, context);
    };
  }

  /**
   * Register a compat tool.
   * @param {Object} registry - Tool registry
   * @param {Object} toolGroups - Tool groups
   * @param {Object} tool - Tool definition
   * @param {string} tool.name - Tool name
   * @param {string} tool.signature - Tool signature
   * @param {string} tool.description - Tool description
   * @param {Function} tool.run - Run function
   * @param {number} [tool.retries=1] - Retry count
   * @returns {void}
   */
  function registerCompatTool(registry, toolGroups, { name, signature, description, run, retries = 1 }) {
    if (registry[name]) return;
    const actualRun = LAZY_TOOLS.has(name) ? makeLazyRunner(name, run) : run;
    registry[name] = { name, description, retries, run: actualRun };

    if (!toolGroups.runtime_compat) {
      toolGroups.runtime_compat = { label: 'Runtime Compat', tools: [] };
    }
    toolGroups.runtime_compat.tools.push({ name, signature });

    const et = window.AgentState?.getEnabledTools?.() || window.enabledTools;
    if (typeof et === 'object' && et && !Object.prototype.hasOwnProperty.call(et, name)) {
      et[name] = true;
    }
  }

  /**
   * Register snapshot tools from AgentSnapshot.
   * @param {Object} registry - Tool registry
   * @param {Object} toolGroups - Tool groups
   * @param {Function} formatToolResult - Result formatter
   * @returns {void}
   */
  function registerSnapshotTools(registry, toolGroups, formatToolResult) {
    const snapshotApi = window.AgentSnapshot;
    const importedTools = snapshotApi?.getBundledTools?.() || [];
    if (!importedTools.length) return;

    if (!toolGroups.snapshot) {
      toolGroups.snapshot = { label: 'Snapshot Tools', tools: [] };
    }

    for (const item of importedTools) {
      const toolName = snapshotApi?.toSnapshotToolName?.(item.name)
        || `snapshot_tool_${String(item.name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

      if (registry[toolName]) continue;

      registry[toolName] = {
        name: toolName,
        description: item.description || item.whenToUse || `Imported workflow: ${item.name}`,
        retries: 1,
        run: async ({ include_prompt = true } = {}) => {
          const promptText = include_prompt ? String(item.promptTemplate || '').trim() : '';
          const body = [
            `Imported tool: ${item.name}`,
            item.argumentHint ? `Arguments: ${item.argumentHint}` : '',
            item.description ? `Description: ${item.description}` : '',
            item.whenToUse ? `When to use: ${item.whenToUse}` : '',
            promptText ? `\nPrompt template:\n${promptText}` : ''
          ].filter(Boolean).join('\n');

          return formatToolResult(toolName, body || `Imported tool metadata for ${item.name}`);
        }
      };

      toolGroups.snapshot.tools.push({
        name: toolName,
        signature: `${toolName}(include_prompt?)`
      });

      if (typeof enabledTools === 'object' && enabledTools && !Object.prototype.hasOwnProperty.call(enabledTools, toolName)) {
        enabledTools[toolName] = true;
      }
    }
  }

  /**
   * Search tools by query.
   * @param {Object} registry - Tool registry
   * @param {Object} opts - Options
   * @param {string} [opts.query=''] - Search query
   * @param {number} [opts.limit=30] - Result limit
   * @param {Function} formatToolResult - Result formatter
   * @returns {Promise<string>} Search results
   */
  async function toolSearch(registry, { query = '', limit = 30 }, formatToolResult) {
    const terms = String(query || '').toLowerCase().trim();
    const max = Math.max(1, Math.min(200, Number(limit) || 30));
    const entries = Object.values(registry || {});
    const runtimeMatches = entries.filter(item => {
      if (!terms) return true;
      const hay = `${item.name || ''} ${item.description || ''}`.toLowerCase();
      return hay.includes(terms);
    });

    const snapshotApi = window.AgentSnapshot;
    const snapshotMatches = snapshotApi?.searchBundledTools?.({ query: terms, limit: max }) || [];

    const matches = [
      ...runtimeMatches.map(item => ({ name: item.name, description: item.description || 'no description' })),
      ...snapshotMatches.map(item => ({ name: `snapshot:${item.name}`, description: item.description || item.whenToUse || 'imported skill' }))
    ].slice(0, max);

    return formatToolResult(
      'tool_search',
      matches.length
        ? matches.map((item, index) => `${index + 1}. ${item.name} — ${item.description || 'no description'}`).join('\n')
        : '(no matching tools)'
    );
  }

  /**
   * Get snapshot tool catalog.
   * @param {Object} [opts={}] - Options
   * @param {string} [opts.query=''] - Filter query
   * @param {number} [opts.limit=30] - Result limit
   * @param {Function} formatToolResult - Result formatter
   * @returns {Promise<string>} Catalog
   */
  async function snapshotToolCatalog({ query = '', limit = 30 } = {}, formatToolResult) {
    const snapshotApi = window.AgentSnapshot;
    const formatted = snapshotApi?.formatToolCatalogForTool?.({ query, limit });
    if (!formatted) {
      throw new Error('Snapshot skill catalog is unavailable. Run npm run build:snapshot first.');
    }
    return formatToolResult('snapshot_tool_catalog', formatted);
  }

  window.AgentToolRegistry = {
    LAZY_TOOLS,
    makeLazyRunner,
    registerCompatTool,
    registerSnapshotTools,
    toolSearch,
    snapshotToolCatalog
  };
})();