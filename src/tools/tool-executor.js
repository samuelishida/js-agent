// src/tools/tool-executor.js
// Tool execution: web/data/fs runtime wrappers, worker tasks, compat tools, path utilities.
// Reads from window.AgentToolModules, window.AgentToolBroadcast, window.AgentToolMemory.
// Publishes: window.AgentToolExecutor

const path = typeof require !== 'undefined' ? require('path') : null;
const fs = typeof require !== 'undefined' ? require('fs') : null;

(() => {
  'use strict';

  /** @type {string} */
  const TASKS_STORAGE_KEY = 'agent_tasks_v1';
  /** @type {string} */
  const TODOS_STORAGE_KEY = 'agent_todos_v1';
  /** @type {string} */
  const WORKER_RUNS_STORAGE_KEY = 'agent_worker_runs_v1';
  /** @type {number} */
  const WORKER_RUNS_LIMIT = 40;
  /** @type {Set<string>} */
  const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'csv', 'log', 'yml', 'yaml']);

  /**
   * Format a tool result.
   * @param {string} title - Tool name
   * @param {string} body - Result body
   * @returns {string} Formatted result
   */
  function formatToolResult(title, body) {
    return `## ${title}\n\n${body}`.trim();
  }

  /**
   * Get file extension.
   * @param {string} name - Filename
   * @returns {string} Extension
   */
  function getExtension(name) {
    return String(name || '').split('.').pop().toLowerCase();
  }

  /**
   * Check if file supports text preview.
   * @param {string} name - Filename
   * @returns {boolean} True if text previewable
   */
  function supportsTextPreview(name) {
    return TEXT_EXTENSIONS.has(getExtension(name));
  }

  /**
   * Check if filesystem access is supported.
   * @returns {boolean} True if supported
   */
  function supportsFsAccess() {
    return !!window.showDirectoryPicker;
  }

  /**
   * Assert filesystem access is available.
   * @returns {void}
   * @throws {Error} If not supported
   */
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

  /**
   * Strip agent tags from text.
   * @param {string} text - Raw text
   * @returns {string} Cleaned text
   */
  function stripAgentTags(text) {
    return String(text || '')
      .replace(/<tool_result[\s\S]*?<\/tool_result>/gi, ' ')
      .replace(/<initial_context>[\s\S]*?<\/initial_context>/gi, ' ')
      .replace(/<execution_steering>[\s\S]*?<\/execution_steering>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Extract query plan from message content.
   * @param {string} text - Message content
   * @returns {string} Extracted query or empty
   */
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

  /**
   * Check if text is a runtime control prompt.
   * @param {string} text - Text to check
   * @returns {boolean} True if control prompt
   */
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

  /**
   * Derive web search query from context.
   * @param {string} query - Direct query
   * @param {Object} [context={}] - Context with messages
   * @returns {string} Derived query
   */
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

  const state = window.AgentTools?.state || { roots: new Map(), defaultRootId: null, uploads: new Map(), attachments: new Map() };
  if (!state.attachments) state.attachments = new Map();

  const fsModuleFactory = window.AgentToolModules?.createFilesystemRuntime;
  const fsRuntime = typeof fsModuleFactory === 'function'
    ? fsModuleFactory({ state, formatToolResult, supportsFsAccess, supportsTextPreview })
    : {};

  const attModuleFactory = window.AgentToolModules?.createAttachmentRuntime;
  const attRuntime = typeof attModuleFactory === 'function'
    ? attModuleFactory({ state, formatToolResult })
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
  const appendTextFile = fsRuntime.appendTextFile || missingFsRuntime('appendTextFile');
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

  // ── Attachment runtime ─────────────────────────────────────────────────

  const attachmentList = attRuntime.attachmentList || (() => formatToolResult('attachment_list', '(not available)'));
  const attachmentPreview = attRuntime.attachmentPreview || (() => formatToolResult('attachment_preview', '(not available)'));
  const attachmentReadText = attRuntime.attachmentReadText || (() => formatToolResult('attachment_read_text', '(not available)'));
  const registerAttachments = attRuntime.registerAttachments || (() => {});

  // ── Artifact registry (lightweight, in-memory + localStorage fallback) ─────

  const ARTIFACTS_KEY = 'agent_artifacts_v1';
  const artifacts = new Map();

  function loadArtifacts() {
    try {
      const raw = JSON.parse(localStorage.getItem(ARTIFACTS_KEY) || '[]');
      if (Array.isArray(raw)) {
        for (const a of raw) { if (a?.id) artifacts.set(a.id, a); }
      }
    } catch {}
  }
  function saveArtifacts() {
    try {
      const arr = Array.from(artifacts.values()).slice(-200);
      localStorage.setItem(ARTIFACTS_KEY, JSON.stringify(arr));
    } catch {}
  }
  function registerArtifact({ id, name, mimeType, size, source, data, preview }) {
    const artifact = {
      id: String(id || `art_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
      name: String(name || 'artifact'),
      mimeType: String(mimeType || 'application/octet-stream'),
      size: Number(size) || 0,
      source: String(source || 'tool'),
      createdAt: new Date().toISOString(),
      data: String(data || ''),
      preview: String(preview || '').slice(0, 500)
    };
    artifacts.set(artifact.id, artifact);
    saveArtifacts();
    return artifact;
  }
  function getArtifact(id) { return artifacts.get(String(id || '')) || null; }
  function listArtifacts({ limit = 30 } = {}) {
    const arr = Array.from(artifacts.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return arr.slice(0, Math.max(1, Number(limit) || 30));
  }
  function resolveArtifactData(ref) {
    // ref can be artifactId, storageKey, or literal base64
    if (!ref) return null;
    const byId = artifacts.get(String(ref));
    if (byId) return byId.data || null;
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(String(ref));
      if (stored) return stored;
      const lastGen = localStorage.getItem('__last_generated_base64__');
      if (lastGen) return lastGen;
    }
    return null;
  }

  const GENERATED_MIME_BY_EXT = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    zip: 'application/zip',
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    txt: 'text/plain',
    bin: 'application/octet-stream'
  };

  function base64ToUint8Array(b64) {
    const binaryStr = atob(String(b64 || ''));
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    return bytes;
  }

  function safeDownloadName(name) {
    const base = String(name || '').replace(/^.*[\\/]/, '').trim();
    return base.replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_') || '';
  }

  function isScriptExtension(ext) {
    return /^(js|cjs|mjs)$/i.test(String(ext || ''));
  }

  function extensionOf(name) {
    const value = String(name || '').trim();
    const match = value.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  }

  function basenameWithoutExtension(name) {
    return safeDownloadName(name).replace(/\.[^.]+$/, '') || 'generated';
  }

  function inferGeneratedExtension(bytes, preferredName = '', scriptPath = '') {
    const preferredExt = extensionOf(preferredName);
    if (preferredExt && !isScriptExtension(preferredExt)) return preferredExt;

    if (bytes?.length >= 4) {
      if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
      if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpg';
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
      if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
        const hint = `${preferredName} ${scriptPath}`.toLowerCase();
        if (/\bdocx\b/.test(hint)) return 'docx';
        if (/\bxlsx\b/.test(hint)) return 'xlsx';
        if (/\bpptx\b/.test(hint)) return 'pptx';
        return 'zip';
      }
    }

    return 'bin';
  }

  function resolveGeneratedDownloadName({ outputFilename, scriptPath, bytes }) {
    const requested = safeDownloadName(outputFilename);
    const requestedExt = extensionOf(requested);
    const inferredExt = inferGeneratedExtension(bytes, requested, scriptPath);
    if (requested && requestedExt && !isScriptExtension(requestedExt)) return requested;

    const base = basenameWithoutExtension(requested || scriptPath || 'generated');
    return `${base}.${inferredExt}`;
  }

  loadArtifacts();

  window.AgentArtifacts = {
    register: (opts) => registerArtifact(opts),
    get: (id) => getArtifact(id),
    preview: (id) => {
      const a = getArtifact(id);
      return a ? { id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, preview: a.preview, createdAt: a.createdAt } : null;
    },
    readText: (id) => {
      const a = getArtifact(id);
      if (!a) return null;
      // If the artifact is base64 data, try to decode to text for text/* types
      if (a.data && /^text\//i.test(a.mimeType)) {
        try { return atob(a.data); } catch { return a.data; }
      }
      return a.preview || a.data || null;
    },
    download: (id, fallbackName = '') => {
      const a = getArtifact(id);
      if (!a?.data) return false;
      const ext = (a.name || fallbackName).split('.').pop()?.toLowerCase() || 'bin';
      const mime = GENERATED_MIME_BY_EXT?.[ext] || a.mimeType || 'application/octet-stream';
      const name = fallbackName || a.name || `artifact.${ext}`;
      if (window.ElectronFileSave?.isElectron?.()) {
        window.ElectronFileSave.saveGeneratedArtifact({ name, mimeType: mime, base64: a.data });
        return true;
      }
      const bytes = base64ToUint8Array(a.data);
      if (!bytes) return false;
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return true;
    },
    forget: (id) => { artifacts.delete(String(id)); saveArtifacts(); return true; },
    list: (opts) => listArtifacts(opts).map(a => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, preview: a.preview, createdAt: a.createdAt }))
  };

  // ── Compat runtime wrappers ──────────────────────────────────────────────

  async function callLocalCompatApi(path, payload = {}) {
    const headers = { 'Content-Type': 'application/json' };
    // Attach terminal auth token for /api/terminal requests
    if ((path === '/api/terminal' || path === '/api/terminal-files') && window.__terminalToken) {
      headers['Authorization'] = `Bearer ${window.__terminalToken}`;
    }
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
    try { return JSON.parse(text); } catch { return { ok: true, result: text }; }
  }

  async function runtimeReadFile(args = {}, context = {}) { return readLocalFile(deriveFilesystemPathArg(args, context, 'read_file')); }
  async function runtimeWriteFile(args = {}) { return writeTextFile({ path: args.path, content: args.content }); }
  async function runtimeAppendFile(args = {}) { return appendTextFile({ path: args.path, content: args.content }); }
  async function runtimeGenerateFile(args = {}) {
    const scriptPath = String(args.path || '').trim();
    const scriptContent = String(args.content || '');
    const storageKey = String(args.storageKey || '').trim();
    const cwd = String(args.cwd || '');
    const command = String(args.command || '').trim();
    const outputFilename = String(args.filename || '').trim();
    if (!scriptPath) throw new Error('runtime_generateFile requires path.');
    // Resolve content: explicit content > storageKey > no content (script on disk)
    let resolvedContent = scriptContent;
    if (!resolvedContent && storageKey) {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored) resolvedContent = stored;
      } catch { /* localStorage unavailable — fall through */ }
    }

    // Auto-fix: detect double-escaped newlines — model writes \\n in JSON which parses to
    // literal backslash-n chars (not actual newlines). Detect: no real newlines, but has \n sequences.
    if (resolvedContent && !resolvedContent.includes('\n') && resolvedContent.includes('\\n')) {
      // String-aware fix: replace \n outside single/double-quoted strings with actual newlines.
      // Preserve \n inside single/double-quoted strings (valid JS escape there).
      // In template literals, convert \n to actual newline (backtick strings are multiline-safe).
      const _BS = String.fromCharCode(92); // backslash
      const _NL = String.fromCharCode(10); // actual newline
      const _SQ = String.fromCharCode(39); // single quote
      const _DQ = String.fromCharCode(34); // double quote
      const _BT = String.fromCharCode(96); // backtick
      let fixed = ''; let si = 0; const src = resolvedContent;
      while (si < src.length) {
        const ch = src[si];
        if ((ch === _SQ || ch === _DQ) && (si === 0 || src[si - 1] !== _BS)) {
          const q = ch; fixed += ch; si++;
          while (si < src.length) {
            const sc = src[si];
            if (sc === _BS && si + 1 < src.length) { fixed += sc + src[si + 1]; si += 2; }
            else if (sc === q) { fixed += sc; si++; break; }
            else { fixed += sc; si++; }
          }
        } else if (ch === _BT) {
          fixed += ch; si++;
          while (si < src.length) {
            const sc = src[si];
            if (sc === _BS && si + 1 < src.length) {
              const nx = src[si + 1];
              if (nx === 'n') { fixed += _NL; si += 2; }
              else if (nx === 't') { fixed += '\t'; si += 2; }
              else { fixed += sc + nx; si += 2; }
            } else if (sc === _BT) { fixed += sc; si++; break; }
            else { fixed += sc; si++; }
          }
        } else if (ch === _BS && si + 1 < src.length && src[si + 1] === 'n') {
          fixed += _NL; si += 2;
        } else if (ch === _BS && si + 1 < src.length && src[si + 1] === 't') {
          fixed += '\t'; si += 2;
        } else { fixed += ch; si++; }
      }
      resolvedContent = fixed;
    }

    // Validate: runtime_generateFile expects a Node.js script, not plain text/markdown
    if (resolvedContent) {
      const looksLikeMarkdown = /^\s*#+\s/.test(resolvedContent) || /^\s*\*\s/.test(resolvedContent) || /^\s*-\s/.test(resolvedContent);
      const looksLikePlainText = !/\b(require\(|import\s|module\.exports|exports\.|const\s|let\s|var\s|function\s|async\s|=>|process\.)/.test(resolvedContent) && resolvedContent.length > 0;
      const hasJsExtension = /\.(js|cjs|mjs)$/i.test(scriptPath);
      if (looksLikeMarkdown || (looksLikePlainText && !hasJsExtension)) {
        return formatToolResult('runtime_generateFile', `HINT: runtime_generateFile needs a Node.js script with a .cjs extension. You passed plain text in a .pdf path — this is recoverable, just retry with the correct format!\n\nCorrect usage:\n  path: "agent-sandbox/gen.cjs"  ← MUST end in .cjs\n  content: "const PDFDocument = require('pdfkit');\\nconst doc = new PDFDocument();\\n// ... build PDF ...\\nprocess.stdout.write(doc.output());"\n  filename: "YVY_Environmental_Report.pdf"  ← desired download name\n\nTry again now with the corrected format.`);
      }
      // SECURITY: If content is a script, the execution path MUST have a JS extension.
      // Otherwise node will throw ERR_UNKNOWN_FILE_EXTENSION (e.g., node "report.pdf").
      if (!hasJsExtension) {
        return formatToolResult('runtime_generateFile', `HINT: The path must end in .cjs when providing script content. You passed "${scriptPath}" which would cause node to fail with ERR_UNKNOWN_FILE_EXTENSION.\n\nCorrect usage:\n  path: "agent-sandbox/gen.cjs"  ← MUST end in .cjs\n  filename: "${scriptPath}"  ← desired download name\n\nTry again now with the corrected format.`);
      }
    }

    const runCmd = command || `node "${scriptPath}"`;
    const payload = { command: runCmd, cwd, files: [] };
    if (resolvedContent) {
      // Encode script content as UTF-8 bytes → base64, so Unicode survives btoa
      // Use chunked encoding to avoid call stack overflow on large scripts
      let contentB64;
      if (typeof TextEncoder !== 'undefined') {
        const bytes = new TextEncoder().encode(resolvedContent);
        // Chunked btoa to avoid Maximum call stack size exceeded on large payloads
        const CHUNK = 8192;
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
          const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
          binary += String.fromCharCode.apply(null, slice);
        }
        contentB64 = btoa(binary);
      } else {
        contentB64 = btoa(encodeURIComponent(resolvedContent).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))));
      }
      payload.files.push({ path: scriptPath, content: contentB64, mode: 0o644 });
    }
    const result = await callLocalCompatApi('/api/terminal-files', payload);
    const rawOutput = String(result?.result || result?.output || '');
    // Extract base64 from STDOUT line in dev server output format.
    // Base64 may span multiple lines if the output is long.
    // Format: STDOUT: UEsDBAoAAAAA...\nSTDERR: (empty)
    const stdoutMatch = rawOutput.match(/STDOUT:\s*([A-Za-z0-9+/=\r\n]{40,}?)(?:\r?\nSTDERR:|$)/);
    const b64 = stdoutMatch ? stdoutMatch[1].replace(/[\r\n\s]/g, '') : '';
    if (b64) {
      // Save via Electron IPC (packaged) or browser Blob download.
      try {
        const bytes = base64ToUint8Array(b64);
        const downloadName = resolveGeneratedDownloadName({ outputFilename, scriptPath, bytes });
        const ext = extensionOf(downloadName) || 'bin';
        const mime = GENERATED_MIME_BY_EXT[ext] || 'application/octet-stream';
        const artifact = registerArtifact({
          id: `art_gen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: downloadName,
          mimeType: mime,
          size: bytes.length,
          source: 'runtime_generateFile',
          data: b64,
          preview: `Generated ${downloadName} (${bytes.length} bytes)`
        });
        return await saveGeneratedBytes({ artifact, bytes, b64, mime, downloadName, toolName: 'runtime_generateFile' });
      } catch (e) {
        // Fallback: save to localStorage + artifact registry
        try { localStorage.setItem('__last_generated_base64__', b64); } catch {}
        const fallbackName = resolveGeneratedDownloadName({ outputFilename, scriptPath, bytes: null });
        const fallbackExt = extensionOf(fallbackName) || 'bin';
        const artifact = registerArtifact({
          id: `art_gen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: fallbackName,
          mimeType: GENERATED_MIME_BY_EXT[fallbackExt] || 'application/octet-stream',
          size: Math.floor(b64.length * 0.75),
          source: 'runtime_generateFile',
          data: b64,
          preview: 'Base64 fallback (save failed)'
        });
        return formatToolResult('runtime_generateFile', `Artifact id: ${artifact.id}\n[Save failed: ${e.message}. Use fs_download_file(artifactId="${artifact.id}") or storageKey="__last_generated_base64__" to download.]`);
      }
    }
    // If node failed, make the error actionable instead of just dumping raw output
    if (!b64 && rawOutput) {
      // Detect SyntaxError — likely double-escaped newlines (model writes \\n instead of \n in JSON)
      if (/SyntaxError.*Invalid or unexpected token/i.test(rawOutput)) {
        const ext = extensionOf(outputFilename || scriptPath);
        if (['pdf', 'docx', 'xlsx', 'pptx', 'html', 'htm', 'svg', 'txt', 'zip'].includes(ext)) {
          return formatToolResult('runtime_generateFile', `HINT: Script SyntaxError for ${ext.toUpperCase()} output. Use runtime_generateArtifact instead — it accepts structured JSON and avoids script encoding issues entirely.\n\nExample:\n  runtime_generateArtifact(generator="pdf", filename="report.pdf", input={ title: "Report", sections: [{ children: [{ type: "heading", text: "Section", heading: 1 }, { type: "paragraph", text: "Content" }] }] })`);
        }
        return formatToolResult('runtime_generateFile', `HINT: Script SyntaxError. Most common cause: the content field had double-escaped newlines (\\\\n instead of \\n in JSON), which writes literal backslash-n chars between statements.\n\nFix: In the <tool_call> JSON, use \\n (ONE backslash) for newlines in the content string — never \\\\n.\n\nAlternatively, use runtime_generateArtifact for PDF/DOCX/XLSX/PPTX/HTML/ZIP which avoids this encoding issue entirely.`);
      }
      // Detect MODULE_NOT_FOUND
      if (/MODULE_NOT_FOUND|Cannot find module/i.test(rawOutput)) {
        const modMatch = rawOutput.match(/Cannot find module\s+'([^']+)'/i);
        const missing = modMatch ? modMatch[1] : 'unknown';
        return formatToolResult('runtime_generateFile', `HINT: Module "${missing}" is not installed. Use a library that IS available (pdfkit, docx, pptxgenjs, xlsx, pdf-lib).\n\nRewrite your script to use pdfkit (already installed) and try again.`);
      }
    }
    return formatToolResult('runtime_generateFile', rawOutput || 'Script executed.');
  }

  // ── runtime_generateArtifact (precompiled generators) ─────────────────────────────────────────────────────────────────────────────
  const SKILLS_RUNTIME_MANIFEST_FALLBACK = {
    generators: [
      { id: 'pdf', extensions: ['pdf'] },
      { id: 'docx', extensions: ['docx'] },
      { id: 'xlsx', extensions: ['xlsx'] },
      { id: 'pptx', extensions: ['pptx'] },
      { id: 'html', extensions: ['html', 'htm', 'svg', 'txt'] },
      { id: 'zip', extensions: ['zip'] }
    ]
  };

  async function loadSkillsRuntimeManifest() {
    try {
      const response = await fetch('src/skills/generated/runtime/manifest.json', { cache: 'no-store' });
      if (response.ok) return await response.json();
    } catch {}
    return SKILLS_RUNTIME_MANIFEST_FALLBACK;
  }

  function encodeUtf8Base64(text) {
    if (typeof TextEncoder !== 'undefined') {
      const bytes = new TextEncoder().encode(String(text || ''));
      const CHUNK = 8192;
      let binary = '';
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
        binary += String.fromCharCode.apply(null, slice);
      }
      return btoa(binary);
    }
    return btoa(unescape(encodeURIComponent(String(text || ''))));
  }

  async function saveGeneratedBytes({ artifact, bytes, b64, mime, downloadName, toolName }) {
    // Priority 1: Electron IPC
    if (window.ElectronFileSave?.isElectron?.()) {
      try {
        const r = await window.ElectronFileSave.saveGeneratedArtifact({ name: downloadName, mimeType: mime, base64: b64 });
        if (r?.mode === 'electron') {
          return formatToolResult(toolName, `✅ Saved ${artifact.name} (${artifact.size} bytes) to ${r.path}. Artifact id: ${artifact.id}`);
        }
      } catch (err) {
        console.warn(`[${toolName}] Electron save failed, trying next:`, err);
      }
    }

    // Priority 2: Authorized File System Access API folder
    if (state.roots.size > 0) {
      try {
        const rootId = state.defaultRootId || [...state.roots.keys()][0];
        const rootHandle = state.roots.get(rootId);
        const fileHandle = await rootHandle.getFileHandle(downloadName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(bytes);
        await writable.close();
        return formatToolResult(toolName, `✅ Saved ${artifact.name} (${artifact.size} bytes) to authorized folder "${rootId}/${downloadName}". Artifact id: ${artifact.id}`);
      } catch (folderErr) {
        console.warn(`[${toolName}] Authorized folder write failed, falling back to browser:`, folderErr);
      }
    }

    // Priority 3: Sandbox copy + browser blob download
    const sandboxPath = `agent-sandbox/${downloadName}`;
    let sandboxNote = '';
    try {
      await callLocalCompatApi('/api/terminal-files', {
        command: `echo "saved"`,
        cwd: '',
        files: [{ path: sandboxPath, content: b64, mode: 0o644 }]
      });
      sandboxNote = ` Saved copy to sandbox: ${sandboxPath}.`;
    } catch (sandboxErr) {
      console.warn(`[${toolName}] Sandbox save failed:`, sandboxErr);
    }

    try {
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (dlErr) {
      console.warn(`[${toolName}] Browser download failed:`, dlErr);
      return formatToolResult(toolName, `Artifact id: ${artifact.id}\n[Download failed: ${dlErr.message}.${sandboxNote} Use fs_download_file(artifactId="${artifact.id}") to retry.]`);
    }

    return formatToolResult(toolName, `✅ Generated ${artifact.name} (${artifact.size} bytes).${sandboxNote} Downloading via browser. Artifact id: ${artifact.id}`);
  }

  async function runtimeGenerateArtifact(args = {}) {
    const generator = String(args.generator || '').trim().toLowerCase();
    const filename = String(args.filename || '').trim();
    const input = args.input ?? {};

    if (!generator) {
      const unknownKeys = Object.keys(args).filter(k => !['generator','filename','input','options'].includes(k));
      const wrongNote = unknownKeys.length ? ` Unexpected args: ${unknownKeys.join(', ')}.` : '';
      throw new Error(
        `HINT: runtime_generateArtifact requires a "generator" field.${wrongNote}\n\n` +
        `Correct call format:\n` +
        `  runtime_generateArtifact(generator="docx", filename="report.docx", input={"title":"My Doc","sections":[{"children":[{"type":"heading","heading":1,"text":"Section Title"},{"type":"paragraph","text":"Body text here."}]}]})\n\n` +
        `Available generators: pdf | docx | xlsx | pptx | html | zip\n` +
        `  pdf   → report.pdf   — paragraphs, headings, tables, lists\n` +
        `  docx  → report.docx  — Word doc with rich formatting\n` +
        `  xlsx  → data.xlsx    — Excel with sheets, auto-column widths\n` +
        `  pptx  → deck.pptx   — PowerPoint with title slide + content slides\n` +
        `  html  → page.html   — Standalone HTML5 with optional CSS\n` +
        `  zip   → bundle.zip  — ZIP of multiple text/binary files\n\n` +
        `The "input" field is always a JSON object — never write a script. ` +
        `Call skill_load("file-generation") for full examples.`
      );
    }
    if (!filename) throw new Error('HINT: runtime_generateArtifact requires a "filename" field, e.g. filename="report.docx".');

    const manifest = await loadSkillsRuntimeManifest();
    const knownGenerators = new Set(manifest.generators.map(g => g.id.toLowerCase()));
    if (!knownGenerators.has(generator)) {
      throw new Error(`HINT: Unknown generator "${generator}". Available: ${Array.from(knownGenerators).join(', ')}`);
    }

    const ext = extensionOf(filename);
    const generatorInfo = manifest.generators.find(g => g.id.toLowerCase() === generator);
    const allowedExts = generatorInfo?.extensions || [];
    if (!allowedExts.includes(ext)) {
      throw new Error(`HINT: Filename "${filename}" has extension ".${ext}" but generator "${generator}" expects: ${allowedExts.join(', ')}`);
    }

    const randomId = Math.random().toString(36).slice(2, 10);
    const inputFile = `agent-sandbox/runtime-input-${randomId}.json`;
    const generatorBundlePath = `src/skills/generated/runtime/${generator}.cjs`;

    let inputJson;
    try {
      inputJson = JSON.stringify(input, null, 2);
    } catch (e) {
      throw new Error(`runtime_generateArtifact input must be JSON-serializable: ${e.message}`);
    }

    const payload = {
      command: `node "${generatorBundlePath}" "${inputFile}"`,
      cwd: '',
      files: [{ path: inputFile, content: encodeUtf8Base64(inputJson), mode: 0o644 }]
    };
    const result = await callLocalCompatApi('/api/terminal-files', payload);
    const rawOutput = String(result?.result || result?.output || '');

    // Extract base64 from STDOUT
    const stdoutMatch = rawOutput.match(/STDOUT:\s*([A-Za-z0-9+/=\r\n]{40,}?)(?:\r?\nSTDERR:|$)/);
    const b64 = stdoutMatch ? stdoutMatch[1].replace(/[\r\n\s]/g, '') : '';

    if (!b64) {
      if (/Cannot find module|MODULE_NOT_FOUND|ENOENT/i.test(rawOutput)) {
        throw new Error(`HINT: Generator bundle "${generator}" was not found or could not load. Run: npm run build:skills-runtime\n\n${rawOutput}`);
      }
      throw new Error(`HINT: Generator "${generator}" produced no output. Check stderr for errors.\n\n${rawOutput}`);
    }

    try {
      const bytes = base64ToUint8Array(b64);
      const downloadName = resolveGeneratedDownloadName({ outputFilename: filename, scriptPath: generatorBundlePath, bytes });
      const ext = extensionOf(downloadName) || 'bin';
      const mime = GENERATED_MIME_BY_EXT[ext] || 'application/octet-stream';
      const artifact = registerArtifact({
        id: `art_gen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: downloadName,
        mimeType: mime,
        size: bytes.length,
        source: 'runtime_generateArtifact',
        data: b64,
        preview: `Generated ${downloadName} (${bytes.length} bytes)`
      });
      return await saveGeneratedBytes({ artifact, bytes, b64, mime, downloadName, toolName: 'runtime_generateArtifact' });
    } catch (e) {
      try { localStorage.setItem('__last_generated_base64__', b64); } catch {}
      const fallbackName = resolveGeneratedDownloadName({ outputFilename: filename, scriptPath: generatorBundlePath, bytes: null });
      const fallbackExt = extensionOf(fallbackName) || 'bin';
      const artifact = registerArtifact({
        id: `art_gen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: fallbackName,
        mimeType: GENERATED_MIME_BY_EXT[fallbackExt] || 'application/octet-stream',
        size: Math.floor(b64.length * 0.75),
        source: 'runtime_generateArtifact',
        data: b64,
        preview: 'Base64 fallback (save failed)'
      });
      return formatToolResult('runtime_generateArtifact', `Artifact id: ${artifact.id}\n[Save failed: ${e.message}. Use fs_download_file(artifactId="${artifact.id}") or storageKey="__last_generated_base64__" to download.]`);
    }
  }

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

  // ── Skill tools (delegate to AgentSkillLoader) ──────────────────────────
  function skillSearch(args = {}) {
    const loader = window.AgentSkillLoader;
    if (!loader) throw new Error('Skill loader not available.');
    const results = loader.skillSearch(args.query || '');
    if (!results.length) return formatToolResult('skill_search', '(no matching skills)');
    const body = results.map((r, i) => `${i + 1}. **${r.name}** (score: ${r.score}) — ${r.description}`).join('\n');
    return formatToolResult('skill_search', body);
  }

  function skillLoad(args = {}) {
    const loader = window.AgentSkillLoader;
    if (!loader) throw new Error('Skill loader not available.');
    const name = String(args.name || '').trim();
    if (!name) throw new Error('skill_load requires name.');
    const skill = loader.skillLoad(name);
    if (!skill) return formatToolResult('skill_load', `Skill "${name}" not found. Use skill_search to discover available skills.`);
    const body = [
      `# ${skill.name}`,
      skill.description ? `**Description:** ${skill.description}` : '',
      '',
      skill.content
    ].filter(Boolean).join('\n');
    return formatToolResult('skill_load', body);
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
    runtimeAppendFile,
    runtimeGenerateFile,
    runtimeGenerateArtifact,
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
    runtimeSpawnAgent,
    // Attachment tools
    attachmentList,
    attachmentPreview,
    attachmentReadText,
    registerAttachments,
    // Artifact tools
    registerArtifact,
    getArtifact,
    listArtifacts,
    resolveArtifactData,
    // Skill tools
    skillSearch,
    skillLoad
  };
})();
