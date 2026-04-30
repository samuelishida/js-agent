// src/skills/skill-registry.js
// Skill registry: registration, lookup, listing, lazy loading, snapshot tools.
// Reads from window.AgentSkillModules, window.AgentSnapshot, window.AgentSkills (partial).
// Publishes: window.AgentSkillRegistry

(() => {
  'use strict';

  const LAZY_TOOLS = new Set([
    'weather_current', 'geo_current_location', 'clipboard_read', 'clipboard_write',
    'storage_list_keys', 'storage_get', 'storage_set',
    'notification_request_permission', 'notification_send',
    'tab_broadcast', 'tab_listen',
    'parse_json', 'parse_csv',
    'memory_write', 'memory_search', 'memory_list', 'tool_search',
    'snapshot_skill_catalog', 'task_create', 'task_get', 'task_list', 'task_update',
    'worker_batch', 'worker_list', 'worker_get',
    'todo_write', 'ask_user_question',
    'fs_upload_pick', 'fs_save_upload', 'fs_download_file',
    'fs_copy_file', 'fs_move_file', 'fs_rename_path', 'fs_mkdir', 'fs_touch',
    'fs_preview_file',
    'runtime_lsp', 'runtime_spawnAgent', 'runtime_todoWrite',
    'runtime_memoryRead', 'runtime_memoryWrite', 'runtime_getDiagnostics',
    'runtime_fileDiff'
  ]);
  const lazyLoaded = new Set();

  // Tracks first invocation of a tool for telemetry (does NOT defer loading —
  // realRun is already bound at registration time; rename to reflect actual behavior).
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

  function registerCompatTool(registry, skillGroups, { name, signature, description, run, retries = 1 }) {
    if (registry[name]) return;
    const actualRun = LAZY_TOOLS.has(name) ? makeLazyRunner(name, run) : run;
    registry[name] = { name, description, retries, run: actualRun };

    if (!skillGroups.runtime_compat) {
      skillGroups.runtime_compat = { label: 'Runtime Compat', tools: [] };
    }
    skillGroups.runtime_compat.tools.push({ name, signature });

    const et = window.AgentState?.getEnabledTools?.() || window.enabledTools;
    if (typeof et === 'object' && et && !Object.prototype.hasOwnProperty.call(et, name)) {
      et[name] = true;
    }
  }

  function registerSnapshotTools(registry, skillGroups, formatToolResult) {
    const snapshotApi = window.AgentSnapshot;
    const importedSkills = snapshotApi?.getBundledSkills?.() || [];
    if (!importedSkills.length) return;

    if (!skillGroups.snapshot) {
      skillGroups.snapshot = { label: 'Snapshot Skills', tools: [] };
    }

    for (const skill of importedSkills) {
      const toolName = snapshotApi?.toSnapshotToolName?.(skill.name)
        || `snapshot_skill_${String(skill.name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

      if (registry[toolName]) continue;

      registry[toolName] = {
        name: toolName,
        description: skill.description || skill.whenToUse || `Imported workflow: ${skill.name}`,
        retries: 1,
        run: async ({ include_prompt = true } = {}) => {
          const promptText = include_prompt ? String(skill.promptTemplate || '').trim() : '';
          const body = [
            `Imported skill: ${skill.name}`,
            skill.argumentHint ? `Arguments: ${skill.argumentHint}` : '',
            skill.description ? `Description: ${skill.description}` : '',
            skill.whenToUse ? `When to use: ${skill.whenToUse}` : '',
            promptText ? `\nPrompt template:\n${promptText}` : ''
          ].filter(Boolean).join('\n');

          return formatToolResult(toolName, body || `Imported skill metadata for ${skill.name}`);
        }
      };

      skillGroups.snapshot.tools.push({
        name: toolName,
        signature: `${toolName}(include_prompt?)`
      });

      if (typeof enabledTools === 'object' && enabledTools && !Object.prototype.hasOwnProperty.call(enabledTools, toolName)) {
        enabledTools[toolName] = true;
      }
    }
  }

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
    const snapshotMatches = snapshotApi?.searchBundledSkills?.({ query: terms, limit: max }) || [];

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

  async function snapshotSkillCatalog({ query = '', limit = 30 } = {}, formatToolResult) {
    const snapshotApi = window.AgentSnapshot;
    const formatted = snapshotApi?.formatSkillCatalogForTool?.({ query, limit });
    if (!formatted) {
      throw new Error('Snapshot skill catalog is unavailable. Run npm run build:snapshot first.');
    }
    return formatToolResult('snapshot_skill_catalog', formatted);
  }

  window.AgentSkillRegistry = {
    LAZY_TOOLS,
    makeLazyRunner,
    registerCompatTool,
    registerSnapshotTools,
    toolSearch,
    snapshotSkillCatalog
  };
})();