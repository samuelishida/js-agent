// src/tools/tool-executor.js
// Tool execution: web/data/fs runtime wrappers, worker tasks, compat tools, path utilities.
// Reads from window.AgentToolModules, window.AgentToolBroadcast, window.AgentToolMemory.
// Publishes: window.AgentToolExecutor

(() => {
  'use strict';

  const TASKS_STORAGE_KEY = 'agent_tasks_v1';
  const TODOS_STORAGE_KEY = 'agent_todos_v1';
  const WORKER_RUNS_STORAGE_KEY = 'agent_worker_runs_v1';
  const WORKER_RUNS_LIMIT = 40;
  const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'csv', 'log', 'yml', 'yaml']);

  function formatToolResult(title, body) {
    return `## ${title}\n\n${body}`.trim();
  }

  function getExtension(name) {
    return String(name || '').split('.').pop().toLowerCase();
  }

  function supportsTextPreview(name) {
    return TEXT_EXTENSIONS.has(getExtension(name));
  }

  function supportsFsAccess() {
    return !!window.showDirectoryPicker;
  }

  function assertFsAccess() {
    if (!supportsFsAccess()) {
      throw new Error('File System Access API is not supported in this browser.');
    }
  }

  function missingWebRuntime(name) {
    return async () => { throw new Error(`Web runtime unavailable: ${name}`); };
  }

  function missingDataRuntime(name) {
    return async () => { throw new Error(`Data runtime unavailable: ${name}`); };
  }

  function missingFsRuntime(name) {
    return async () => { throw new Error(`Filesystem runtime unavailable: ${name}`); };
  }

  // ── Text utilities ──────────────────────────────────────────────────────

  function stripAgentTags(text) {
    return String(text || '')
      .replace(/<tool_result[\s\S]*?<\/tool_result>/gi, ' ')
      .replace(/<initial_context>[\s\S]*?<\/initial_context>/gi, ' ')
      .replace(/<execution_steering>[\s\S]*?<\/execution_steering>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractQueryPlanFromMessageContent(text) {
    const raw = String(text || '');
    if (!raw) return '';
    const queryPlanBlocks = [...raw.matchAll(/<tool_result\s+tool="query_plan">\s*([\s\S]*?)\s*<\/tool_result>/gi)];
    for (let i = queryPlanBlocks.length - 1; i >= 0; i -= 1) {
      const block = String(queryPlanBlocks[i]?.[1] || '');
      const match = block.match(/(?:^|\n)query=([^\n]+)/i);
      if (match?.[1]) { const query = String(match[1]).trim(); if (query) return query; }
    }
    const plannerMatch = raw.match(/Planner optimized query:\s*"([^"]+)"/i);
    return String(plannerMatch?.[1] || '').trim();
  }

  function isRuntimeControlPrompt(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    return [
      /^No valid tool call or final answer was returned\./i,
      /^Your previous reply described a next action but did not execute it\./i,
      /^Your previous reply claimed a tool call already ran, but no valid <tool_result> block was present\./i,
      /^Previous reply exceeded output token limits\./i,
      /^Previous attempt timed out\./i,
      /^All proposed tool calls were blocked or invalid\b/i
    ].some(pattern => pattern.test(value));
  }

  function deriveWebSearchQuery(query, context = {}) {
    const direct = String(query || '').trim();
    if (direct) return direct;
    const history = Array.isArray(context?.messages) ? context.messages : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i];
      if (message?.role !== 'user') continue;
      const plannedQuery = extractQueryPlanFromMessageContent(message.content);
      if (plannedQuery) return plannedQuery.slice(0, 240);
      const candidate = stripAgentTags(message.content);
      if (isRuntimeControlPrompt(candidate)) continue;
      if (candidate) return candidate.slice(0, 240);
    }
    return '';
  }

  // ── Path utilities ──────────────────────────────────────────────────────

  function sanitizePathCandidate(candidate) {
    return String(candidate || '').trim().replace(/^['"`]+|['"`]+$/g, '').replace(/[),.;:!?]+$/g, '').trim();
  }

  function extractPathCandidates(text) {
    const value = String(text || '');
    if (!value) return [];
    const slashPattern = /(?:[A-Za-z]:\\[^\s"'`<>|]+|(?:\.{1,2}\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g;
    const filenamePattern = /\b[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}\b/g;
    const folderHintPattern = /\b(?:Agent|src|prompts|docs|assets|proxy|progress)\b/g;
    const matches = [
      ...(value.match(slashPattern) || []),
      ...(value.match(filenamePattern) || []),
      ...(value.match(folderHintPattern) || [])
    ];
    return [...new Set(matches.map(sanitizePathCandidate).filter(Boolean).filter(item => !/^https?:\/\//i.test(item)))];
  }

  function normalizeFilesystemArgs(args = {}) {
    const next = { ...args };
    const root = String(next.root || '').trim();
    const path = String(next.path || next.filePath || '').trim();
    if (!path && root) { next.path = root; return next; }
    if (path && root) {
      const normalizedPath = path.replace(/\\/g, '/');
      const normalizedRoot = root.replace(/\\/g, '/');
      const hasAbsolutePrefix = /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith('/');
      const alreadyScoped = normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`) || normalizedPath.toLowerCase() === normalizedRoot.toLowerCase();
      if (!hasAbsolutePrefix && !alreadyScoped) { next.path = `${root}/${path}`.replace(/\/+/g, '/'); return next; }
      next.path = path; return next;
    }
    if (path) { next.path = path; }
    return next;
  }

  const DEFAULT_FS_WALK_EXCLUDES = ['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.venv', 'venv', '.cache'];

  function hasOwnArg(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
  }

  function normalizeFsWalkArgs(args = {}, context = {}) {
    const scoped = deriveFilesystemPathArg(args, context, 'fs_walk');
    const next = { ...scoped };
    if (!hasOwnArg(args, 'maxDepth')) next.maxDepth = 3;
    if (!hasOwnArg(args, 'maxResults')) next.maxResults = 250;
    if (!hasOwnArg(args, 'includeFiles')) next.includeFiles = false;
    if (!hasOwnArg(args, 'includeDirectories')) next.includeDirectories = true;
    if (!hasOwnArg(args, 'maxOutputChars')) next.maxOutputChars = 12000;
    if (!hasOwnArg(args, 'includeHidden')) next.includeHidden = false;
    if (!hasOwnArg(args, 'excludeNames')) {
      const targetLeaf = String(next.path || '').replace(/\\/g, '/').split('/').filter(Boolean).pop()?.toLowerCase() || '';
      next.excludeNames = DEFAULT_FS_WALK_EXCLUDES.filter(name => name !== targetLeaf);
    }
    return next;
  }

  function deriveFilesystemPathArg(args = {}, context = {}, toolName = 'fs_tool') {
    const normalized = normalizeFilesystemArgs(args);
    const existing = String(normalized?.path || '').trim();
    if (existing) return { ...normalized, path: existing };
    const history = Array.isArray(context?.messages) ? context.messages : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i];
      if (message?.role !== 'user') continue;
      const text = stripAgentTags(message.content);
      const candidates = extractPathCandidates(text);
      if (!candidates.length) continue;
      const path = candidates[0];
      console.debug(`${toolName}: recovered missing path from context`, path);
      return { ...normalized, path };
    }
    return { ...normalized };
  }

  // ── Web runtime ─────────────────────────────────────────────────────────

  const webModuleFactory = window.AgentToolModules?.createWebRuntime;
  const webRuntime = typeof webModuleFactory === 'function'
    ? webModuleFactory({ formatToolResult, detectFxPair: (window.AgentToolCore?.intents?.detectFxPair || (() => null)), detectWeatherIntent: (window.AgentToolCore?.intents?.detectWeatherIntent || (() => false)), detectRecencyIntent: (window.AgentToolCore?.intents?.detectRecencyIntent || (() => false)), detectCodingIntent: (window.AgentToolCore?.intents?.detectCodingIntent || (() => false)), detectBiographicalFactIntent: (window.AgentToolCore?.intents?.detectBiographicalFactIntent || (() => false)) })
    : {};

  const runSearchTools = webRuntime.runSearchTools || missingWebRuntime('runSearchTools');
  const searchFxRate = webRuntime.searchFxRate || missingWebRuntime('searchFxRate');
  const fetchReadablePage = webRuntime.fetchReadablePage || missingWebRuntime('fetchReadablePage');
  const fetchHttpResource = webRuntime.fetchHttpResource || missingWebRuntime('fetchHttpResource');
  const extractLinks = webRuntime.extractLinks || missingWebRuntime('extractLinks');
  const getPageMetadata = webRuntime.getPageMetadata || missingWebRuntime('getPageMetadata');
  const getCurrentLocation = webRuntime.getCurrentLocation || missingWebRuntime('getCurrentLocation');
  const getCurrentWeather = webRuntime.getCurrentWeather || missingWebRuntime('getCurrentWeather');

  // ── Data runtime ────────────────────────────────────────────────────────

  const dataModuleFactory = window.AgentToolModules?.createDataRuntime;
  const dataRuntime = typeof dataModuleFactory === 'function'
    ? dataModuleFactory({ formatToolResult, TODOS_STORAGE_KEY, TASKS_STORAGE_KEY })
    : {};

  const parseJsonText = dataRuntime.parseJsonText || missingDataRuntime('parseJsonText');
  const parseCsvText = dataRuntime.parseCsvText || missingDataRuntime('parseCsvText');
  const clipboardRead = dataRuntime.clipboardRead || missingDataRuntime('clipboardRead');
  const clipboardWrite = dataRuntime.clipboardWrite || missingDataRuntime('clipboardWrite');
  const listStorageKeys = dataRuntime.listStorageKeys || missingDataRuntime('listStorageKeys');
  const storageGet = dataRuntime.storageGet || missingDataRuntime('storageGet');
  const storageSet = dataRuntime.storageSet || missingDataRuntime('storageSet');
  const todoWrite = dataRuntime.todoWrite || missingDataRuntime('todoWrite');
  const taskCreate = dataRuntime.taskCreate || missingDataRuntime('taskCreate');
  const taskGet = dataRuntime.taskGet || missingDataRuntime('taskGet');
  const taskList = dataRuntime.taskList || missingDataRuntime('taskList');
  const taskUpdate = dataRuntime.taskUpdate || missingDataRuntime('taskUpdate');
  const askUserQuestion = dataRuntime.askUserQuestion || missingDataRuntime('askUserQuestion');

  // ── Worker tasks ─────────────────────────────────────────────────────────

  function loadWorkerRuns() {
    try {
      const stored = JSON.parse(localStorage.getItem(WORKER_RUNS_STORAGE_KEY) || '[]');
      return Array.isArray(stored) ? stored : [];
    } catch { return []; }
  }

  function saveWorkerRuns(runs) {
    const normalized = Array.isArray(runs) ? runs.slice(0, WORKER_RUNS_LIMIT) : [];
    localStorage.setItem(WORKER_RUNS_STORAGE_KEY, JSON.stringify(normalized));
  }

  function getWorkerLlm() {
    const llm = typeof window.callLLM === 'function' ? window.callLLM : (typeof callLLM === 'function' ? callLLM : null);
    if (!llm) throw new Error('worker_batch requires the runtime LLM function to be available.');
    return llm;
  }

  function normalizeWorkerTasks(args = {}) {
    const source = Array.isArray(args.tasks) ? args.tasks : (Array.isArray(args.prompts) ? args.prompts : String(args.text || '').split(/\r?\n/));
    return source.map(item => String(item || '').trim()).filter(Boolean).slice(0, 10);
  }

  function buildWorkerContextSnippet(context = {}) {
    const history = Array.isArray(context?.messages) ? context.messages : [];
    const useful = history.filter(msg => msg && msg.role !== 'system').slice(-8)
      .map(msg => `${String(msg.role || 'user').toUpperCase()}: ${stripAgentTags(msg.content || '')}`).filter(Boolean);
    const joined = useful.join('\n').slice(0, 2400).trim();
    if (!joined) return '';
    return `Recent conversation context:\n${joined}`;
  }

  async function runWorkerTask({ workerId, goal, task, includeContext, contextSnippet, maxTokens, temperature }) {
    const llm = getWorkerLlm();
    const userPrompt = [
      goal ? `Overall goal: ${goal}` : '',
      `Worker ${workerId} task: ${task}`,
      includeContext && contextSnippet ? contextSnippet : '',
      'Return concise Markdown with: summary, concrete findings, and next action.'
    ].filter(Boolean).join('\n\n');

    const raw = await llm([
      { role: 'system', content: 'You are a focused autonomous worker. Execute only the assigned subtask and keep output concise.' },
      { role: 'user', content: userPrompt }
    ], { timeoutMs: 30000, retries: 1, maxTokens: Math.max(256, Number(maxTokens) || 900), temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2 });

    const parsed = typeof splitModelReply === 'function' ? splitModelReply(raw) : { visible: String(raw || '') };
    return String(parsed?.visible || raw || '').trim();
  }

  async function workerBatch(args = {}, context = {}) {
    const goal = String(args.goal || args.objective || '').trim();
    const tasks = normalizeWorkerTasks(args);
    if (!tasks.length && !goal) throw new Error('worker_batch requires at least one task or a goal.');

    const taskList = tasks.length ? tasks : [goal];
    const workerCount = Math.max(1, Math.min(4, Number(args.max_workers) || 3));
    const includeContext = args.include_context !== false;
    const contextSnippet = buildWorkerContextSnippet(context);
    const maxTokens = Number(args.max_tokens) || 900;
    const temperature = Number.isFinite(Number(args.temperature)) ? Number(args.temperature) : 0.2;
    const runId = `worker_run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const createdAt = new Date().toISOString();

    const workers = taskList.map((task, index) => ({ id: `w${index + 1}`, task, status: 'pending', output: '', error: '' }));

    for (let i = 0; i < workers.length; i += workerCount) {
      const chunk = workers.slice(i, i + workerCount);
      const settled = await Promise.allSettled(chunk.map(async worker => {
        const output = await runWorkerTask({ workerId: worker.id, goal, task: worker.task, includeContext, contextSnippet, maxTokens, temperature });
        return { workerId: worker.id, output };
      }));
      settled.forEach((item, offset) => {
        const worker = chunk[offset];
        if (!worker) return;
        if (item.status === 'fulfilled') { worker.status = 'done'; worker.output = String(item.value?.output || '').slice(0, 5000); return; }
        worker.status = 'failed'; worker.error = String(item.reason?.message || 'unknown worker failure').slice(0, 300);
      });
    }

    const done = workers.filter(w => w.status === 'done').length;
    const failed = workers.length - done;
    const runRecord = { id: runId, createdAt, goal, workerCount, done, failed, workers: workers.map(w => ({ id: w.id, task: w.task, status: w.status, output: w.output, error: w.error })) };
    const existing = loadWorkerRuns().filter(item => item?.id !== runId);
    existing.unshift(runRecord);
    saveWorkerRuns(existing);

    const lines = [`Run: ${runId}`, `Workers: ${workers.length}, Done: ${done}, Failed: ${failed}`, '', ...workers.map(w => `${w.id} | ${w.status.toUpperCase()} | ${w.task}`), '', 'Use worker_get(run_id) to inspect full outputs.'];
    return formatToolResult('worker_batch', lines.join('\n'));
  }

  async function workerList({ limit = 10 } = {}) {
    const max = Math.max(1, Math.min(40, Number(limit) || 10));
    const runs = loadWorkerRuns().slice(0, max);
    if (!runs.length) return formatToolResult('worker_list', '(no worker runs)');
    const body = runs.map((run, i) => `${i + 1}. ${run.id} | workers=${run.workerCount} | done=${run.done} | failed=${run.failed} | ${run.createdAt}`).join('\n');
    return formatToolResult('worker_list', body);
  }

  async function workerGet({ run_id, id }) {
    const target = String(run_id || id || '').trim();
    if (!target) throw new Error('worker_get requires run_id (or id).');
    const run = loadWorkerRuns().find(item => String(item?.id || '') === target);
    if (!run) throw new Error(`worker_get: run not found (${target}).`);
    const details = [`Run: ${run.id}`, `Created: ${run.createdAt}`, `Workers: ${run.workerCount}, Done: ${run.done}, Failed: ${run.failed}`, run.goal ? `Goal: ${run.goal}` : '', '', ...((Array.isArray(run.workers) ? run.workers : []).map(w => [`## ${w.id} (${w.status})`, `Task: ${w.task}`, w.error ? `Error: ${w.error}` : '', w.output ? `Output:\n${w.output}` : ''].filter(Boolean).join('\n')))].filter(Boolean).join('\n\n');
    return formatToolResult('worker_get', details.slice(0, 12000));
  }

  // ── FS runtime ──────────────────────────────────────────────────────────

  const state = window.AgentTools?.state || { roots: new Map(), defaultRootId: null, uploads: new Map() };

  const fsModuleFactory = window.AgentToolModules?.createFilesystemRuntime;
  const fsRuntime = typeof fsModuleFactory === 'function'
    ? fsModuleFactory({ state, formatToolResult, supportsFsAccess, supportsTextPreview })
    : {};

  const authorizeFolder = fsRuntime.authorizeFolder || missingFsRuntime('authorizeFolder');
  const listDirectory = fsRuntime.listDirectory || missingFsRuntime('listDirectory');
  const readLocalFile = fsRuntime.readLocalFile || missingFsRuntime('readLocalFile');
  const pickUpload = fsRuntime.pickUpload || missingFsRuntime('pickUpload');
  const downloadFile = fsRuntime.downloadFile || missingFsRuntime('downloadFile');
  const previewFile = fsRuntime.previewFile || missingFsRuntime('previewFile');
  const searchByName = fsRuntime.searchByName || missingFsRuntime('searchByName');
  const searchByContent = fsRuntime.searchByContent || missingFsRuntime('searchByContent');
  const globPaths = fsRuntime.globPaths || missingFsRuntime('globPaths');
  const grepPaths = fsRuntime.grepPaths || missingFsRuntime('grepPaths');
  const editLocalFile = fsRuntime.editLocalFile || missingFsRuntime('editLocalFile');
  const writeTextFile = fsRuntime.writeTextFile || missingFsRuntime('writeTextFile');
  const copyFile = fsRuntime.copyFile || missingFsRuntime('copyFile');
  const deletePath = fsRuntime.deletePath || missingFsRuntime('deletePath');
  const moveFile = fsRuntime.moveFile || missingFsRuntime('moveFile');
  const renamePath = fsRuntime.renamePath || missingFsRuntime('renamePath');
  const listRoots = fsRuntime.listRoots || missingFsRuntime('listRoots');
  const fileExists = fsRuntime.fileExists || missingFsRuntime('fileExists');
  const statPath = fsRuntime.statPath || missingFsRuntime('statPath');
  const makeDirectory = fsRuntime.makeDirectory || missingFsRuntime('makeDirectory');
  const touchFile = fsRuntime.touchFile || missingFsRuntime('touchFile');
  const directoryTree = fsRuntime.directoryTree || missingFsRuntime('directoryTree');
  const walkPaths = fsRuntime.walkPaths || missingFsRuntime('walkPaths');
  const savePickedUpload = fsRuntime.savePickedUpload || missingFsRuntime('savePickedUpload');
  const pickDirectory = fsRuntime.pickDirectory || missingFsRuntime('pickDirectory');
  const searchCode = fsRuntime.searchCode || missingFsRuntime('searchCode');
  const multiEditFiles = fsRuntime.multiEditFiles || missingFsRuntime('multiEditFiles');

  // ── Compat runtime wrappers ──────────────────────────────────────────────

  async function callLocalCompatApi(path, payload = {}) {
    const headers = { 'Content-Type': 'application/json' };
    // Attach terminal auth token for /api/terminal requests
    if (path === '/api/terminal' && window.__terminalToken) {
      headers['Authorization'] = `Bearer ${window.__terminalToken}`;
    }
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
    try { return JSON.parse(text); } catch { return { ok: true, result: text }; }
  }

  async function runtimeReadFile(args = {}, context = {}) { return readLocalFile(deriveFilesystemPathArg(args, context, 'read_file')); }
  async function runtimeWriteFile(args = {}) { return writeTextFile({ path: args.path, content: args.content }); }
  async function runtimeEditFile(args = {}) { return editLocalFile({ path: args.path, oldText: args.oldString ?? args.oldText, newText: args.newString ?? args.newText, replaceAll: args.replaceAll === true }); }
  async function runtimeMultiEdit(args = {}) { return multiEditFiles({ edits: Array.isArray(args.edits) ? args.edits : [] }); }
  async function runtimeListDir(args = {}, context = {}) { return listDirectory(deriveFilesystemPathArg(args, context, 'list_dir')); }
  async function runtimeGlob(args = {}) { return globPaths({ path: args.path, pattern: args.pattern, includeDirectories: args.includeDirectories, maxResults: args.maxResults }); }
  async function runtimeSearchCode(args = {}, context = {}) {
    const resolved = deriveFilesystemPathArg(args, context, 'search_code');
    return searchCode({ path: resolved.path, query: resolved.query, glob: resolved.glob, isRegex: resolved.isRegex, caseSensitive: resolved.caseSensitive, contextLines: resolved.contextLines, maxResults: resolved.maxResults });
  }
  async function runtimeRunTerminal({ command = '', cwd = '' } = {}) {
    const payload = await callLocalCompatApi('/api/terminal', { command: String(command || ''), cwd: String(cwd || '') });
    return formatToolResult('run_terminal', String(payload?.result || payload?.output || ''));
  }
  async function runtimeWebFetch({ url } = {}) { const text = await fetchReadablePage(String(url || '').trim()); return formatToolResult('web_fetch', text); }
  async function runtimeGetDiagnostics({ path = '', severity = 'all' } = {}) {
    try {
      const payload = await callLocalCompatApi('/api/diagnostics', { path: String(path || ''), severity: String(severity || 'all') });
      return formatToolResult('get_diagnostics', String(payload?.result || '(no diagnostics)'));
    } catch (error) { return formatToolResult('get_diagnostics', `Diagnostics endpoint unavailable in this browser runtime. ${String(error?.message || error)}`); }
  }
  async function runtimeTodoWrite(args = {}) { return todoWrite({ todos: args.todos, items: args.items, text: args.text }); }
  async function runtimeLsp(args = {}) {
    return formatToolResult('lsp', [`Requested action: ${String(args.action || '').trim() || '(missing)'}`, 'LSP semantic navigation is not available in the standalone browser runtime.', 'Use search_code, glob, and read_file as fallbacks.'].join('\n'));
  }
  async function runtimeFileDiff({ path, newContent } = {}) {
    try {
      const fsRt = window.AgentToolModules?.createFilesystemRuntime?.({ state: { roots: new Map(), defaultRootId: null }, formatToolResult, supportsFsAccess: () => !!window.showDirectoryPicker, supportsTextPreview: () => true });
      if (!fsRt?.fileDiff) throw new Error('File system runtime not available.');
      return await fsRt.fileDiff({ path, newContent });
    } catch (error) { return formatToolResult('runtime_fileDiff', `ERROR: ${error.message}`); }
  }
  async function runtimeSpawnAgent(args = {}, context = {}) {
    const task = String(args.task || '').trim();
    if (!task) throw new Error('spawn_agent requires task.');
    const output = await runWorkerTask({ workerId: 'sub1', goal: '', task, includeContext: true, contextSnippet: buildWorkerContextSnippet(context), maxTokens: Math.max(300, Number(args.maxTokens || 900)), temperature: 0.2 });
    return formatToolResult('runtime_spawnAgent', `Task: ${task}\n\n${output}`);
  }

  window.AgentToolExecutor = {
    formatToolResult,
    getExtension,
    supportsTextPreview,
    supportsFsAccess,
    assertFsAccess,
    stripAgentTags,
    extractQueryPlanFromMessageContent,
    isRuntimeControlPrompt,
    deriveWebSearchQuery,
    sanitizePathCandidate,
    extractPathCandidates,
    normalizeFilesystemArgs,
    hasOwnArg,
    normalizeFsWalkArgs,
    deriveFilesystemPathArg,
    DEFAULT_FS_WALK_EXCLUDES,
    // Web runtime
    runSearchTools,
    searchFxRate,
    fetchReadablePage,
    fetchHttpResource,
    extractLinks,
    getPageMetadata,
    getCurrentLocation,
    getCurrentWeather,
    // Data runtime
    parseJsonText,
    parseCsvText,
    clipboardRead,
    clipboardWrite,
    listStorageKeys,
    storageGet,
    storageSet,
    todoWrite,
    taskCreate,
    taskGet,
    taskList,
    taskUpdate,
    askUserQuestion,
    // Worker tasks
    loadWorkerRuns,
    saveWorkerRuns,
    getWorkerLlm,
    normalizeWorkerTasks,
    buildWorkerContextSnippet,
    runWorkerTask,
    workerBatch,
    workerList,
    workerGet,
    // FS runtime
    authorizeFolder,
    listDirectory,
    readLocalFile,
    pickUpload,
    downloadFile,
    previewFile,
    searchByName,
    searchByContent,
    globPaths,
    grepPaths,
    editLocalFile,
    writeTextFile,
    copyFile,
    deletePath,
    moveFile,
    renamePath,
    listRoots,
    fileExists,
    statPath,
    makeDirectory,
    touchFile,
    directoryTree,
    walkPaths,
    savePickedUpload,
    pickDirectory,
    searchCode,
    multiEditFiles,
    // Compat wrappers
    callLocalCompatApi,
    runtimeReadFile,
    runtimeWriteFile,
    runtimeEditFile,
    runtimeMultiEdit,
    runtimeListDir,
    runtimeGlob,
    runtimeSearchCode,
    runtimeRunTerminal,
    runtimeWebFetch,
    runtimeGetDiagnostics,
    runtimeTodoWrite,
    runtimeLsp,
    runtimeFileDiff,
    runtimeSpawnAgent
  };
})();