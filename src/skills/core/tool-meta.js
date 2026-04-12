(() => {
  const root = (window.AgentSkillCore = window.AgentSkillCore || {});

  const SAFE_CLASSIFIED_TOOLS = new Set([
    'web_search',
    'web_fetch',
    'read_page',
    'http_fetch',
    'extract_links',
    'page_metadata',
    'datetime',
    'geo_current_location',
    'weather_current',
    'parse_json',
    'parse_csv',
    'fs_list_roots',
    'fs_authorize_folder',
    'fs_list_dir',
    'fs_read_file',
    'fs_preview_file',
    'fs_search_name',
    'fs_search_content',
    'fs_glob',
    'fs_grep',
    'fs_tree',
    'fs_exists',
    'fs_stat',
    'file_read',
    'read_file',
    'glob',
    'grep',
    'task_get',
    'task_list',
    'worker_list',
    'worker_get',
    'memory_search',
    'memory_list',
    'tool_search',
    'snapshot_skill_catalog',
    'clawd_readFile',
    'clawd_listDir',
    'clawd_glob',
    'clawd_searchCode',
    'clawd_webFetch',
    'clawd_getDiagnostics',
    'clawd_memoryRead',
    'clawd_lsp'
  ]);

  const WRITE_CLASSIFIED_TOOLS = new Set([
    'clipboard_write',
    'storage_set',
    'notification_send',
    'tab_broadcast',
    'fs_write_file',
    'fs_copy_file',
    'fs_move_file',
    'fs_delete_path',
    'fs_rename_path',
    'fs_mkdir',
    'fs_touch',
    'fs_save_upload',
    'fs_download_file',
    'file_write',
    'write_file',
    'file_edit',
    'edit_file',
    'todo_write',
    'task_create',
    'task_update',
    'memory_write',
    'clawd_writeFile',
    'clawd_editFile',
    'clawd_multiEdit',
    'clawd_runTerminal',
    'clawd_todoWrite',
    'clawd_memoryWrite',
    'clawd_spawnAgent'
  ]);

  const NON_CONCURRENT_TOOLS = new Set([
    'tab_listen',
    'fs_authorize_folder',
    'fs_pick_directory',
    'fs_write_file',
    'fs_copy_file',
    'fs_move_file',
    'fs_delete_path',
    'fs_rename_path',
    'fs_mkdir',
    'fs_touch',
    'fs_save_upload',
    'fs_download_file',
    'file_write',
    'write_file',
    'file_edit',
    'edit_file',
    'todo_write',
    'task_create',
    'task_update',
    'worker_batch',
    'ask_user_question',
    'clawd_writeFile',
    'clawd_editFile',
    'clawd_multiEdit',
    'clawd_runTerminal',
    'clawd_todoWrite',
    'clawd_memoryWrite',
    'clawd_spawnAgent'
  ]);

  const BUILTIN_EXECUTION_META = {
    calc: { readOnly: true, concurrencySafe: true, destructive: false, riskLevel: 'normal' },
    datetime: { readOnly: true, concurrencySafe: true, destructive: false, riskLevel: 'normal' }
  };

  function classifyRecommendedTools(tools) {
    const safe = [];
    const write = [];
    const other = [];

    for (const tool of tools) {
      if (SAFE_CLASSIFIED_TOOLS.has(tool)) safe.push(tool);
      else if (WRITE_CLASSIFIED_TOOLS.has(tool)) write.push(tool);
      else other.push(tool);
    }

    return {
      safe,
      write,
      other,
      riskLevel: write.length ? 'elevated' : 'normal'
    };
  }

  function getToolExecutionMeta(toolName) {
    const name = String(toolName || '').trim();
    if (!name) {
      return {
        readOnly: false,
        concurrencySafe: false,
        destructive: false,
        riskLevel: 'elevated'
      };
    }

    if (BUILTIN_EXECUTION_META[name]) {
      return BUILTIN_EXECUTION_META[name];
    }

    const isWrite = WRITE_CLASSIFIED_TOOLS.has(name);
    const isSafe = SAFE_CLASSIFIED_TOOLS.has(name);
    const isFilesystemTool = name.startsWith('fs_');
    const isConcurrentCandidate = !isWrite && !NON_CONCURRENT_TOOLS.has(name) && !isFilesystemTool;

    return {
      readOnly: !isWrite,
      concurrencySafe: isConcurrentCandidate,
      destructive: isWrite,
      riskLevel: isWrite ? 'elevated' : (isSafe ? 'normal' : 'normal')
    };
  }

  function canRunToolConcurrently(call) {
    const meta = getToolExecutionMeta(call?.tool);
    return !!meta.concurrencySafe;
  }

  root.toolMeta = {
    SAFE_CLASSIFIED_TOOLS,
    WRITE_CLASSIFIED_TOOLS,
    NON_CONCURRENT_TOOLS,
    BUILTIN_EXECUTION_META,
    classifyRecommendedTools,
    getToolExecutionMeta,
    canRunToolConcurrently
  };
})();
