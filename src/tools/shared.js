// src/tools/shared.js
// Re-export hub: delegates to extracted tool modules.
// This file preserves the original window.AgentTools API while
// the actual logic lives in tool-registry.js, tool-planner.js,
// tool-preflight.js, tool-broadcast.js, tool-executor.js, tool-memory.js.
//
// Load order: tool modules must load BEFORE this file.

(() => {
  'use strict';

  const Planner = window.AgentToolPlanner || {};
  const Preflight = window.AgentToolPreflight || {};
  const Broadcast = window.AgentToolBroadcast || {};
  const Executor = window.AgentToolExecutor || {};
  const Memory = window.AgentToolMemory || {};
  const Registry = window.AgentToolRegistry || {};
  const GithubRuntimeFactory = window.AgentToolModules?.createGithubRuntime;

  // ── Shared state (used by fs runtime and preflight) ──────────────────────
  const state = { roots: new Map(), defaultRootId: null, uploads: new Map() };

  // ── Registry assembly ────────────────────────────────────────────────────
  const registryModuleFactory = window.AgentToolModules?.createRegistryRuntime;
  const registryRuntime = typeof registryModuleFactory === 'function'
    ? registryModuleFactory({
        web_search: (args = {}, context = {}) => {
          const recoveredQuery = Executor.deriveWebSearchQuery(args?.query, context);
          return Executor.runSearchTools(recoveredQuery);
        },
        web_fetch: args => Executor.fetchHttpResource(args),
        read_page: ({ url }) => Executor.fetchReadablePage(url).then(text => Executor.formatToolResult(`read_page ${url}`, text)),
        http_fetch: args => Executor.fetchHttpResource(args),
        extract_links: args => Executor.extractLinks(args),
        page_metadata: args => Executor.getPageMetadata(args),
        geo_current_location: () => Executor.getCurrentLocation(),
        weather_current: args => Executor.getCurrentWeather(args),
        clipboard_read: () => Executor.clipboardRead(),
        clipboard_write: args => Executor.clipboardWrite(args),
        storage_list_keys: () => Executor.listStorageKeys(),
        storage_get: args => Executor.storageGet(args),
        storage_set: args => Executor.storageSet(args),
        notification_request_permission: () => Broadcast.requestNotificationPermission(),
        notification_send: args => Broadcast.sendNotification(args),
        tab_broadcast: args => Broadcast.tabBroadcast(args),
        tab_listen: args => Broadcast.tabListen(args),
        fs_list_roots: () => Executor.listRoots(),
        fs_authorize_folder: () => Executor.authorizeFolder(),
        fs_pick_directory: () => Executor.pickDirectory(),
        fs_list_dir: (args, context = {}) => Executor.listDirectory(Executor.deriveFilesystemPathArg(args, context, 'fs_list_dir')),
        fs_tree: args => Executor.directoryTree(args),
        fs_walk: (args, context = {}) => Executor.walkPaths(Executor.normalizeFsWalkArgs(args, context)),
        fs_exists: args => Executor.fileExists(args),
        fs_stat: args => Executor.statPath(args),
        fs_read_file: (args, context = {}) => Executor.readLocalFile(Executor.deriveFilesystemPathArg(args, context, 'fs_read_file')),
        fs_preview_file: (args, context = {}) => Executor.previewFile(Executor.deriveFilesystemPathArg(args, context, 'fs_preview_file')),
        fs_search_name: (args, context = {}) => Executor.searchByName(Executor.deriveFilesystemPathArg(args, context, 'fs_search_name')),
        fs_search_content: (args, context = {}) => Executor.searchByContent(Executor.deriveFilesystemPathArg(args, context, 'fs_search_content')),
        fs_glob: args => Executor.globPaths(args),
        fs_grep: args => Executor.grepPaths(args),
        fs_upload_pick: () => Executor.pickUpload(),
        fs_save_upload: args => Executor.savePickedUpload(args),
        fs_download_file: args => Executor.downloadFile(args),
        fs_mkdir: args => Executor.makeDirectory(args),
        fs_touch: args => Executor.touchFile(args),
        fs_write_file: args => Executor.writeTextFile(args),
        fs_append_file: args => Executor.appendTextFile(args),
        runtime_generateFile: args => Executor.runtimeGenerateFile(args),
        fs_copy_file: args => Executor.copyFile(args),
        fs_move_file: args => Executor.moveFile(args),
        fs_delete_path: args => Executor.deletePath(args),
        fs_rename_path: args => Executor.renamePath(args),
        file_read: (args, context = {}) => Executor.readLocalFile(Executor.deriveFilesystemPathArg(args, context, 'file_read')),
        read_file: (args, context = {}) => Executor.readLocalFile(Executor.deriveFilesystemPathArg(args, context, 'read_file')),
        file_write: args => Executor.writeTextFile(args),
        write_file: args => Executor.writeTextFile(args),
        file_edit: args => Executor.editLocalFile(args),
        edit_file: args => Executor.editLocalFile(args),
        glob: args => Executor.globPaths(args),
        grep: args => Executor.grepPaths(args),
        parse_json: args => Executor.parseJsonText(args),
        parse_csv: args => Executor.parseCsvText(args),
        todo_write: args => Executor.todoWrite(args),
        task_create: args => Executor.taskCreate(args),
        task_get: args => Executor.taskGet(args),
        task_list: args => Executor.taskList(args),
        task_update: args => Executor.taskUpdate(args),
        worker_batch: (args, context = {}) => Executor.workerBatch(args, context),
        worker_list: args => Executor.workerList(args),
        worker_get: args => Executor.workerGet(args),
        ask_user_question: args => Executor.askUserQuestion(args),
        memory_write: args => Memory.memoryWrite(args),
        memory_search: args => Memory.memorySearch(args),
        memory_list: args => Memory.memoryList(args),
        tool_search: args => Registry.toolSearch(registry, args, Executor.formatToolResult),
        snapshot_tool_catalog: args => Registry.snapshotToolCatalog(args, Executor.formatToolResult)
      })
    : { registry: {}, toolGroups: {} };

  const registry = registryRuntime.registry || {};
  const toolGroups = registryRuntime.toolGroups || {};

  // ── Lazy loading ─────────────────────────────────────────────────────────
  const LAZY_TOOLS = Registry.LAZY_TOOLS || new Set();

  for (const toolName of Object.keys(registry)) {
    if (LAZY_TOOLS.has(toolName) && typeof registry[toolName]?.run === 'function') {
      registry[toolName].run = Registry.makeLazyRunner(toolName, registry[toolName].run);
    }
  }

  // ── Compat tool registration ─────────────────────────────────────────────
  const compatTools = [
    { name: 'runtime_readFile', signature: 'runtime_readFile(path, startLine?, endLine?)', description: 'Reads a file with optional 1-based line range.', run: Executor.runtimeReadFile },
    { name: 'runtime_writeFile', signature: 'runtime_writeFile(path, content)', description: 'Creates or overwrites a file with complete content.', run: Executor.runtimeWriteFile },
    { name: 'runtime_editFile', signature: 'runtime_editFile(path, oldString, newString, replaceAll?)', description: 'Performs a surgical string replacement in a file.', run: Executor.runtimeEditFile },
    { name: 'runtime_multiEdit', signature: 'runtime_multiEdit(edits[])', description: 'Applies multiple validated file edits atomically.', run: Executor.runtimeMultiEdit },
    { name: 'runtime_listDir', signature: 'runtime_listDir(path)', description: 'Lists files and directories.', run: Executor.runtimeListDir },
    { name: 'runtime_glob', signature: 'runtime_glob(pattern, exclude?)', description: 'Finds files matching a glob pattern.', run: Executor.runtimeGlob },
    { name: 'runtime_searchCode', signature: 'runtime_searchCode(query, glob?, isRegex?, caseSensitive?, contextLines?, maxResults?)', description: 'Searches code/text files with optional glob and context.', run: Executor.runtimeSearchCode },
    { name: 'runtime_runTerminal', signature: 'runtime_runTerminal(command, cwd?)', description: 'Runs a terminal command through the local dev server bridge.', run: Executor.runtimeRunTerminal },
    { name: 'runtime_generateFile', signature: 'runtime_generateFile(path, content?, cwd?, command?, storageKey?)', description: 'Writes a script to the dev server sandbox and executes it. Use for generating binary files (DOCX, PDF, PPTX, XLSX) server-side. If content is provided, the script is written first; if storageKey is provided, reads content from localStorage (avoids truncation for large scripts); if both omitted, the script must already exist on disk. The command arg overrides the default "node <path>". Always prefer this over runtime_runTerminal for file generation — no confirmation gate.', run: Executor.runtimeGenerateFile },
    { name: 'runtime_webFetch', signature: 'runtime_webFetch(url)', description: 'Fetches a URL and returns readable text.', run: Executor.runtimeWebFetch },
    { name: 'runtime_getDiagnostics', signature: 'runtime_getDiagnostics(path?, severity?)', description: 'Gets diagnostics from the local dev server bridge when available.', run: Executor.runtimeGetDiagnostics },
    { name: 'runtime_fileDiff', signature: 'runtime_fileDiff(path, newContent)', description: 'Computes a line-by-line diff of a file before editing.', run: Executor.runtimeFileDiff },
    { name: 'runtime_todoWrite', signature: 'runtime_todoWrite(todos)', description: 'Persists a structured todo list.', run: Executor.runtimeTodoWrite },
    { name: 'runtime_memoryRead', signature: 'runtime_memoryRead(scope?)', description: 'Reads compatibility memory with global/project scopes.', run: Memory.runtimeMemoryRead },
    { name: 'runtime_memoryWrite', signature: 'runtime_memoryWrite(topic?, content, replace?, scope?)', description: 'Writes compatibility memory with global/project scopes.', run: Memory.runtimeMemoryWrite },
    { name: 'runtime_lsp', signature: 'runtime_lsp(action, path?, line?, col?, query?)', description: 'LSP compatibility placeholder for the browser runtime.', run: Executor.runtimeLsp },
    { name: 'runtime_spawnAgent', signature: 'runtime_spawnAgent(task, tools?, maxIterations?)', description: 'Runs a focused sub-agent task using the worker runtime.', run: Executor.runtimeSpawnAgent }
  ];

  compatTools.forEach(tool => Registry.registerCompatTool(registry, toolGroups, tool));

  // ── GitHub tools ─────────────────────────────────────────────────────────
  if (typeof GithubRuntimeFactory === 'function') {
    const githubRuntime = GithubRuntimeFactory({ formatToolResult: Executor.formatToolResult });
    const githubToolDefs = [
      { name: 'github_search_code',  description: 'Search GitHub code across repositories.',                          run: githubRuntime.githubSearchCode },
      { name: 'github_get_pr',       description: 'Get pull request details and changed files.',                      run: githubRuntime.githubGetPr },
      { name: 'github_list_prs',     description: 'List pull requests for a repository.',                             run: githubRuntime.githubListPrs },
      { name: 'github_create_issue', description: 'Create a new GitHub issue.',                                       run: githubRuntime.githubCreateIssue },
      { name: 'github_get_file',     description: 'Read a file from a GitHub repository at a specific ref.',          run: githubRuntime.githubGetFile },
      { name: 'github_list_issues',  description: 'List issues for a repository, optionally filtered by label/state.', run: githubRuntime.githubListIssues }
    ];
    if (!toolGroups.github) toolGroups.github = { label: 'GitHub', tools: [] };
    for (const def of githubToolDefs) {
      if (!registry[def.name]) {
        registry[def.name] = { name: def.name, description: def.description, retries: 1, run: def.run };
        toolGroups.github.tools.push({ name: def.name, signature: `${def.name}(...)` });
      }
    }
  }

  // ── Snapshot tools ──────────────────────────────────────────────────────
  Registry.registerSnapshotTools(registry, toolGroups, Executor.formatToolResult);

  // ── Export ───────────────────────────────────────────────────────────────
  window.AgentTools = {
    state,
    registry,
    toolGroups,
    instanceId: Broadcast.instanceId,
    extractEntities: (window.AgentToolCore?.intents?.extractEntities || (() => ({ urls: [], currencies: [] }))),
    detectFxPair: (window.AgentToolCore?.intents?.detectFxPair || (() => null)),
    formatToolResult: Executor.formatToolResult,
    buildPreflightPlan: Preflight.buildPreflightPlan,
    runSearchTools: Executor.runSearchTools,
    fetchReadablePage: Executor.fetchReadablePage,
    getToolExecutionMeta: (window.AgentToolCore?.toolMeta?.getToolExecutionMeta || (() => ({ readOnly: false, concurrencySafe: false, destructive: false, riskLevel: 'elevated' }))),
    canRunToolConcurrently: (window.AgentToolCore?.toolMeta?.canRunToolConcurrently || (call => !!(window.AgentToolCore?.toolMeta?.getToolExecutionMeta?.(call?.tool)?.concurrencySafe))),
    buildInitialContext: Preflight.buildInitialContext,
    abortAllTabListeners: Broadcast.abortAllTabListeners
  };
})();
