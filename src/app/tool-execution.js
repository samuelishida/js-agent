// ── Tool execution, batching, and filesystem guards ──
;(function() {
  const C = () => window.CONSTANTS || {};

  // ── Stable hashing / ID generation ──

  function stableHashText(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  function generateRunChainId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `chain_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function getActiveSessionIdSafe() {
    try {
      const session = typeof getActiveSession === 'function' ? getActiveSession() : null;
      return session?.id ? String(session.id) : 'session_unknown';
    } catch { return 'session_unknown'; }
  }

  // ── Tool result replacement persistence ──

  function getReplacementStorageKey() {
    const C = window.CONSTANTS || {};
    return `${C.TOOL_RESULT_REPLACEMENTS_STORAGE_KEY || 'agent_tool_result_replacements_v1'}:${getActiveSessionIdSafe()}`;
  }

  function loadPersistedToolResultReplacements() {
    try {
      const raw = sessionStorage.getItem(getReplacementStorageKey());
      const parsed = JSON.parse(raw || '[]');
      if (!Array.isArray(parsed)) return [];
      const maxStored = (window.CONSTANTS?.MAX_STORED_REPLACEMENTS || 300);
      const controlPattern = window.CONSTANTS?.INJECTION_PATTERNS?.CONTROL_CHANNEL_TAG_REGEX || /<tool_call\s*>|<system-reminder\s*>|\[SYSTEM\s+OVERRIDE\]/i;
      return parsed
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map(item => ({
          signature: String(item.signature || ''),
          replacement: String(item.replacement || ''),
          timestamp: String(item.timestamp || '')
        }))
        .filter(item => {
          if (!item.signature || !item.replacement) return false;
          return !controlPattern.test(item.replacement);
        })
        .slice(-maxStored);
    } catch { return []; }
  }

  function persistToolResultReplacementRecord(call, originalResult, replacement) {
    try {
      const signature = getToolCallSignature(call);
      const maxStored = (window.CONSTANTS?.MAX_STORED_REPLACEMENTS || 300);
      const existing = loadPersistedToolResultReplacements().filter(item => item.signature !== signature);
      existing.push({
        signature,
        tool: String(call?.tool || 'unknown'),
        originalHash: stableHashText(String(originalResult || '')),
        replacement: String(replacement || ''),
        timestamp: new Date().toISOString()
      });
      sessionStorage.setItem(getReplacementStorageKey(), JSON.stringify(existing.slice(-maxStored)));
    } catch {}
  }

  // ── Tool call normalization ──

  function normalizeToolArgs(args) {
    return args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  }

  function stableStringify(value, _depth = 0) {
    if (_depth > 12) return '"[deep]"';
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return '[' + value.map(item => stableStringify(item, _depth + 1)).join(',') + ']';
    if (typeof value === 'object') {
      const keys = Object.keys(value).sort();
      return '{' + keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key], _depth + 1)}`).join(',') + '}';
    }
    return JSON.stringify(String(value));
  }

  function getToolCallSignature(call) {
    return `${String(call?.tool || 'unknown')}:${stableStringify(call?.args || {})}`;
  }

  function getSemanticToolCallSignature(call) {
    const tool = String(call?.tool || '').trim();
    if (!tool) return 'unknown';
    if (tool !== 'web_search') return getToolCallSignature(call);

    const rawQuery = String(call?.args?.query || '').trim();
    const stopwords = window.CONSTANTS?.WEB_SEARCH_STOPWORDS || new Set(['de','da','do','das','dos','para','por','com','na','no','nas','nos','em','e','a','o']);
    const normalized = rawQuery
      .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(new RegExp(`\\b(${ [...stopwords].join('|') })\\b`, 'g'), ' ')
      .replace(/\s{2,}/g, ' ').trim();

    const tokens = [...new Set(normalized.split(/\s+/).filter(Boolean))].sort();
    return `${tool}:${tokens.join(' ') || normalized || rawQuery.toLowerCase()}`;
  }

  function normalizeToolCallObject(call) {
    if (!call?.tool) return null;
    const tool = String(call.tool || '').trim();
    if (!tool) return null;
    return { tool, args: normalizeToolArgs(call.args) };
  }

  function dedupeToolCalls(calls, maxCalls) {
    const limit = maxCalls || (window.CONSTANTS?.MAX_TOOL_CALLS_PER_REPLY || 5);
    const deduped = [];
    const seen = new Set();
    for (const call of calls) {
      const normalized = normalizeToolCallObject(call);
      if (!normalized) continue;
      const signature = getToolCallSignature(normalized);
      if (seen.has(signature)) continue;
      seen.add(signature);
      deduped.push(normalized);
      if (deduped.length >= limit) break;
    }
    return deduped;
  }

  // ── Path normalization and validation ──

  function normalizePathInput(value) {
    return String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '').trim();
  }

  function containsGlobPattern(value) {
    return /[*?[\]{}]/.test(String(value || ''));
  }

  function containsVulnerableUncPathLight(value) {
    const text = String(value || '');
    return text.startsWith('\\\\') || text.startsWith('//');
  }

  function hasSuspiciousWindowsPathPattern(value) {
    const text = String(value || '');
    if (!text) return false;
    const firstColon = text.indexOf(':');
    if (firstColon >= 0) {
      const secondColon = text.indexOf(':', firstColon + 1);
      if (secondColon !== -1) return true;
    }
    if (/~\d/.test(text)) return true;
    if (text.startsWith('\\\\?\\') || text.startsWith('\\\\.\\') || text.startsWith('//?/') || text.startsWith('//./')) return true;
    if (/[.\s]+$/.test(text)) return true;
    if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(text)) return true;
    if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(text)) return true;
    return false;
  }

  function isDangerousRemovalPath(pathValue) {
    const normalized = String(pathValue || '').replace(/[\\/]+/g, '/').trim();
    if (!normalized) return true;
    if (normalized === '*' || normalized.endsWith('/*')) return true;
    const withoutTrailingSlash = normalized === '/' ? normalized : normalized.replace(/\/$/, '');
    if (withoutTrailingSlash === '/') return true;
    if (/^[A-Za-z]:\/?$/.test(withoutTrailingSlash)) return true;
    const parent = withoutTrailingSlash.includes('/')
      ? withoutTrailingSlash.slice(0, withoutTrailingSlash.lastIndexOf('/')) || '/'
      : '';
    if (parent === '/') return true;
    if (/^[A-Za-z]:\/[^/]+$/.test(withoutTrailingSlash)) return true;
    return false;
  }

  // ── Filesystem guards ──

  function getFilesystemOperationType(toolName) {
    const tool = String(toolName || '').trim();
    const writeTools = new Set(['fs_write_file','file_write','write_file','file_edit','edit_file','fs_copy_file','fs_move_file','fs_delete_path','fs_rename_path','fs_mkdir','fs_touch','fs_save_upload']);
    if (writeTools.has(tool)) return 'write';
    if (tool === 'fs_download_file') return 'create';
    if (tool.startsWith('fs_') || tool === 'file_read' || tool === 'read_file' || tool === 'glob' || tool === 'grep') return 'read';
    return 'none';
  }

  function extractFilesystemPathsFromArgs(toolName, args = {}) {
    const tool = String(toolName || '').trim();
    const normalizedArgs = normalizeToolArgs(args);
    const values = [];
    const push = (name, value) => {
      const path = normalizePathInput(value);
      if (!path) return;
      values.push({ arg: name, path });
    };
    const generalKeys = ['path','filePath','sourcePath','destinationPath','new_path','newPath','root','directory'];
    for (const key of generalKeys) {
      if (Object.prototype.hasOwnProperty.call(normalizedArgs, key)) push(key, normalizedArgs[key]);
    }
    if (tool === 'fs_rename_path' && normalizedArgs.newName) {
      const sourcePath = normalizePathInput(normalizedArgs.path);
      const parent = sourcePath.replace(/[\\/]+/g, '/').split('/').slice(0, -1).join('/');
      const candidate = parent ? `${parent}/${normalizedArgs.newName}` : String(normalizedArgs.newName);
      push('newName', candidate);
    }
    return values;
  }

  function validateFilesystemCallGuard(call) {
    const operationType = getFilesystemOperationType(call?.tool);
    if (operationType === 'none') return { allowed: true };
    const paths = extractFilesystemPathsFromArgs(call?.tool, call?.args);
    if (!paths.length && operationType !== 'read') {
      return { allowed: false, reason: 'A valid filesystem path is required for this write operation.' };
    }
    for (const item of paths) {
      const path = item.path;
      if (containsVulnerableUncPathLight(path)) return { allowed: false, reason: `UNC network path '${path}' requires explicit manual approval.`, path };
      if (path.startsWith('~') && !/^~(?:\/|\\|$)/.test(path)) return { allowed: false, reason: `Tilde expansion variant in '${path}' requires manual approval.`, path };
      if (path.includes('$') || path.includes('%') || path.startsWith('=')) return { allowed: false, reason: `Shell expansion syntax in '${path}' requires manual approval.`, path };
      if (hasSuspiciousWindowsPathPattern(path)) return { allowed: false, reason: `Suspicious Windows path pattern detected in '${path}'.`, path };
      if ((operationType === 'write' || operationType === 'create') && containsGlobPattern(path)) return { allowed: false, reason: `Glob patterns are blocked for write operations ('${path}'). Use an exact path.`, path };
    }
    if (String(call?.tool || '') === 'fs_delete_path') {
      const target = normalizePathInput(call?.args?.path);
      if (isDangerousRemovalPath(target)) return { allowed: false, reason: `Refusing dangerous delete target '${target || '(empty)'}.`, path: target };
    }
    return { allowed: true };
  }

  // P3.1: Blast-radius confirmation gate
  function getToolRisk(tool) {
    const riskMap = { runtime_writeFile:'irreversible', runtime_editFile:'irreversible', runtime_multiEdit:'irreversible', runtime_deleteFile:'irreversible', runtime_renamePath:'irreversible', runtime_makeDirectory:'reversible', runtime_runTerminal:'shared', runtime_spawnAgent:'shared' };
    return riskMap[tool] || 'safe';
  }

  function requiresConfirmation(tool) {
    const risk = getToolRisk(tool);
    return risk === 'irreversible' || risk === 'shared';
  }

  let runPendingConfirmations = new Map();
  let runRiskApprovals = new Map();

  function needsUserConfirmation(call) {
    const { tool } = call;
    if (!requiresConfirmation(tool)) return false;
    const sig = getToolCallSignature(call);
    if (runRiskApprovals.has(sig)) return false;
    return true;
  }

  function injectConfirmationGate(call) {
    const { tool, args } = call;
    const risk = getToolRisk(tool);
    const sig = getToolCallSignature(call);
    if (needsUserConfirmation(call)) {
      const toolDesc = risk === 'irreversible' ? 'destructive (irreversible, affects files)' : 'shared resource (may affect other systems)';
      const msg = `[CONFIRMATION_REQUIRED] Tool '${tool}' is ${toolDesc}. Approve or reject before proceeding.\nArgs: ${JSON.stringify(args).slice(0, 200)}`;
      runPendingConfirmations.set(sig, { tool, args, risk, message: msg });
      return msg;
    }
    return '';
  }

  function approveConfirmation(toolSignature) {
    if (runPendingConfirmations.has(toolSignature)) {
      runPendingConfirmations.delete(toolSignature);
      runRiskApprovals.set(toolSignature, true);
      return true;
    }
    return false;
  }

  function resetConfirmationState() { runPendingConfirmations = new Map(); runRiskApprovals = new Map(); }

  // ── Tool execution metadata ──

  function getToolExecutionMeta(toolName) {
    const metaFromSkills = window.AgentSkills?.getToolExecutionMeta?.(toolName);
    if (metaFromSkills) return metaFromSkills;
    const name = String(toolName || '').trim();
    if (name === 'calc' || name === 'datetime') return { readOnly: true, concurrencySafe: true, destructive: false, riskLevel: 'normal' };
    return { readOnly: false, concurrencySafe: false, destructive: false, riskLevel: 'normal' };
  }

  function canRunToolConcurrently(call) {
    return !!getToolExecutionMeta(call?.tool).concurrencySafe;
  }

  // ── Path conflict detection ──

  function getToolPaths(call) {
    const { tool, args } = call;
    const dep = window.AgentSkillCore?.toolMeta?.TOOL_DEPENDENCY_META?.[tool];
    if (!dep) {
      const reads = new Set();
      const writes = new Set();
      if (args.path) reads.add(String(args.path));
      if (args.cwd) reads.add(String(args.cwd));
      if (args.root) reads.add(String(args.root));
      if (args.pattern) reads.add(`(glob)${String(args.pattern)}`);
      if (args.query) reads.add(`(query)${String(args.query).slice(0, 50)}`);
      const rootPath = args.root || args.projectRoot || null;
      const globPattern = args.pattern || args.globPattern || null;
      const searchQuery = args.query || args.search || null;
      return { reads, writes, root: rootPath, glob: globPattern, query: searchQuery };
    }
    const reads = new Set();
    const writes = new Set();
    for (const pathKey of (dep.reads || [])) {
      if (pathKey === '$path' && args.path) reads.add(String(args.path));
      else if (pathKey === '$cwd' && args.cwd) reads.add(String(args.cwd));
      else if (pathKey === '$root' && args.root) reads.add(String(args.root));
      else if (pathKey === '$glob' && args.pattern) reads.add(`(glob)${String(args.pattern)}`);
      else if (pathKey === '$query' && args.query) reads.add(`(query)${String(args.query).slice(0, 50)}`);
      else if (pathKey === '$paths' && Array.isArray(args.paths)) {
        for (const p of args.paths) { if (p) reads.add(String(p)); }
      }
    }
    for (const pathKey of (dep.writes || [])) {
      if (pathKey === '$path' && args.path) writes.add(String(args.path));
      else if (pathKey === '$paths' && Array.isArray(args.edits)) {
        for (const edit of args.edits) { if (edit.path) writes.add(String(edit.path)); }
      }
      else if (pathKey === '$cwd' && args.cwd) writes.add(String(args.cwd));
      else if (pathKey === '$root' && args.root) writes.add(String(args.root));
    }
    const rootPath = args.root || args.projectRoot || null;
    const globPattern = args.pattern || args.globPattern || null;
    const searchQuery = args.query || args.search || null;
    return { reads, writes, root: rootPath, glob: globPattern, query: searchQuery };
  }

  function hasPathConflict(call1, call2) {
    const p1 = getToolPaths(call1);
    const p2 = getToolPaths(call2);
    for (const w of p1.writes) { if (p2.reads.has(w) || p2.writes.has(w)) return true; }
    for (const w of p2.writes) { if (p1.reads.has(w) || p1.writes.has(w)) return true; }
    if (p1.root && p2.root && p1.root === p2.root) {
      if ((p1.writes.size > 0 || p2.writes.size > 0) && (p1.glob || p1.query || p2.glob || p2.query)) return true;
    }
    return false;
  }

  // ── P3.2: Read-before-write enforcement ──

  let runReadPaths = new Set();

  function trackReadPaths(call) {
    const { tool, args } = call;
    if (tool === 'runtime_readFile' && args.path) runReadPaths.add(String(args.path));
    else if (tool === 'runtime_listDir' && args.path) runReadPaths.add(String(args.path));
    else if (tool === 'runtime_glob' && args.pattern) runReadPaths.add(`(glob)${String(args.pattern)}`);
  }

  function checkReadBeforeWriteWarning(call) {
    const { tool, args } = call;
    const pathKey = args.path ? String(args.path) : null;
    if ((tool === 'runtime_writeFile' || tool === 'runtime_editFile') && pathKey && !runReadPaths.has(pathKey)) {
      return `⚠️  [READ-BEFORE-WRITE] You are about to write to '${pathKey}' but you have not read it in this session. Read the file first to verify the current content.`;
    }
    return '';
  }

  function resetReadBeforeWriteState() { runReadPaths = new Set(); }

  window.AgentConfirmation = {
    approve: approveConfirmation,
    pending: () => Array.from(runPendingConfirmations.values()),
    clearPending: () => runPendingConfirmations.clear()
  };

  // ── Batching ──

  function partitionToolCallBatches(calls) {
    const batches = [];
    for (const call of calls) {
      const concurrencySafe = canRunToolConcurrently(call);
      const lastBatch = batches[batches.length - 1];
      let canBatch = concurrencySafe && lastBatch?.concurrencySafe;
      if (canBatch && lastBatch) {
        for (const existing of lastBatch.calls) { if (hasPathConflict(call, existing)) { canBatch = false; break; } }
      }
      if (canBatch) lastBatch.calls.push(call);
      else batches.push({ concurrencySafe, calls: [call] });
    }
    return batches;
  }

  // ── Run state ──

  let runDisabledToolCalls = new Set();
  let runDisabledSemanticToolCalls = new Set();
  let runToolFailureCounts = new Map();
  let runFsRootExplored = false;
  let runSuccessfulToolCount = 0;
  let runLocalTimeoutStreak = 0;
  let runLastToolCallSignature = '';
  let runRepeatedToolCallCount = 0;
  let runToolCallTotalCounts = new Map();
  let runQueryTracking = null;
  let runToolCallRepairAttempts = new Set();

  function resetRunToolState() {
    runDisabledToolCalls = new Set();
    runDisabledSemanticToolCalls = new Set();
    runToolFailureCounts.clear();
    runFsRootExplored = false;
    runSuccessfulToolCount = 0;
    runLocalTimeoutStreak = 0;
    runLastToolCallSignature = '';
    runRepeatedToolCallCount = 0;
    runToolCallTotalCounts = new Map();
    runToolCallRepairAttempts = new Set();
    runQueryTracking = null;
    resetReadBeforeWriteState();
    resetConfirmationState();
  }

  // ── Execute single tool call ──

  function parseToolCallCompat(text) {
    const orchestrator = window.AgentOrchestrator;
    return orchestrator?.parseToolCall ? orchestrator.parseToolCall(text) : null;
  }

  function resolveToolCallFromModelReply(reply, rawReply) {
    const direct = parseToolCallCompat(reply);
    if (direct?.tool) return direct;
    const fromRaw = parseToolCallCompat(rawReply);
    if (fromRaw?.tool) return fromRaw;
    return null;
  }

  function resolveToolCallsFromModelReply(reply, rawReply) {
    const scanTarget = String(rawReply || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
    const blockMatches = scanTarget.match(/<tool_call>\s*[\s\S]*?<\/tool_call>/gi) || [];
    const parsedBlockCalls = blockMatches.map(block => parseToolCallCompat(block)).filter(call => !!call?.tool);
    if (parsedBlockCalls.length) return dedupeToolCalls(parsedBlockCalls);
    const fallbackCall = resolveToolCallFromModelReply(reply, scanTarget);
    return fallbackCall ? [fallbackCall] : [];
  }

  async function executeTool(call) {
    assertRuntimeReady();
    const { orchestrator } = getRuntimeModules();
    const { tool, args } = call;

    // Apply tool call steering
    if (typeof window.steerToolCall === 'function') window.steerToolCall(tool, args);

    const callSignature = getToolCallSignature(call);
    const semanticSignature = getSemanticToolCallSignature(call);

    if (runDisabledToolCalls.has(callSignature)) return `ERROR: tool call '${callSignature}' is temporarily disabled for this run after repeated failures.`;
    if (runDisabledSemanticToolCalls.has(semanticSignature)) return `ERROR: tool call '${tool}' was blocked to prevent repeated near-duplicate requests in this run.`;

    const executionMeta = getToolExecutionMeta(tool);

    const perms = window.AgentPermissions || {};
    if (perms.runPermissionMode === 'deny_write' && executionMeta.destructive) {
      const denial = { allowed: false, reason: `Permission mode '${perms.runPermissionMode}' blocks write-capable tools in this run.` };
      if (perms.registerPermissionDenial) perms.registerPermissionDenial(call, denial);
      runDisabledToolCalls.add(callSignature);
      return `ERROR: PERMISSION_DENIED: ${denial.reason}`;
    }

    const hookPermission = perms.evaluateToolPermissionHook ? await perms.evaluateToolPermissionHook(call, { callSignature, semanticSignature, executionMeta }) : { allowed: true, decided: false };

    if (perms.runPermissionMode === 'ask' && executionMeta.destructive && !hookPermission.decided) {
      const denial = { allowed: false, reason: `Permission mode '${perms.runPermissionMode}' requires explicit hook approval for write-capable tools.` };
      if (perms.registerPermissionDenial) perms.registerPermissionDenial(call, denial);
      return `ERROR: PERMISSION_DENIED: ${denial.reason}`;
    }

    if (!hookPermission.allowed) {
      if (perms.registerPermissionDenial) perms.registerPermissionDenial(call, hookPermission);
      runDisabledToolCalls.add(callSignature);
      return `ERROR: PERMISSION_DENIED: ${hookPermission.reason}`;
    }

    const filesystemGuard = validateFilesystemCallGuard(call);
    if (!filesystemGuard.allowed) {
      if (perms.registerPermissionDenial) perms.registerPermissionDenial(call, filesystemGuard);
      runDisabledToolCalls.add(callSignature);
      return `ERROR: PERMISSION_DENIED: ${filesystemGuard.reason}`;
    }

    if (!window.enabledTools?.[tool]) return `ERROR: tool '${tool}' is disabled in this environment.`;

    if (tool === 'calc') {
      const expr = String(args.expression || '').trim();
      if (!expr) return 'calc error: expression is required.';
      const ALLOWED_CALC = /^[\d\s+\-*/%.()e,^]+$|^(?:[\d\s+\-*/%.()e,^]|Math\.\w+)*$/;
      const DANGEROUS_CALC = /[{}\[\];=<>|&'"`:!@#$~\\]|\b(?:async|await|function|class|var|let|const|return|if|else|for|while|switch|case|break|continue|throw|catch|finally|eval|Function|constructor|prototype|__proto__|window|document|globalThis|process|require|import|export|module|this|Object|Array|Promise|fetch|XMLHttp)\b/i;
      const sanitizedExpr = expr.replace(/\^/g, '**');
      if (!ALLOWED_CALC.test(sanitizedExpr)) return 'calc error: expression contains disallowed characters or identifiers.';
      if (DANGEROUS_CALC.test(expr)) return 'calc error: expression contains unsupported or unsafe syntax.';
      try {
        const result = new Function('Math', `"use strict"; return (${sanitizedExpr})`)(Math);
        if (typeof result !== 'number' && typeof result !== 'bigint') return `calc error: expression did not return a number.`;
        return `${expr} = ${result}`;
      } catch (e) { return `calc error: ${e?.message || 'invalid expression'}`; }
    }

    if (tool === 'datetime') {
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      return `Current datetime: ${now.toISOString()}\nLocal: ${now.toLocaleString(undefined, { timeZone: tz, weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', timeZoneName:'short' })}\nTimezone: ${tz}`;
    }

    const cachedResult = typeof getCachedToolResult === 'function' ? getCachedToolResult(call) : null;
    if (cachedResult) return `${cachedResult}\n\n[cache hit]`;

    // Rate limiting check (AFTER cache so cached hits don't burn budget)
    const rateLimited = window.AgentRateLimiter?.isRateLimited?.(tool);
    if (rateLimited?.limited) {
      if (perms.registerPermissionDenial) perms.registerPermissionDenial(call, rateLimited);
      runDisabledToolCalls.add(callSignature);
      return `ERROR: RATE_LIMITED: Tool '${tool}' has exceeded its call limit. Please try again in ${rateLimited.resetTime}s.`;
    }

    const confirmationMsg = injectConfirmationGate(call);
    if (confirmationMsg) return confirmationMsg;

    const sandboxTools = new Set(['runtime_runTerminal', 'runtime_writeFile', 'runtime_editFile', 'fs_write_file', 'fs_delete_path']);
    const useSandbox = sandboxTools.has(tool) && window.AgentWorkers?.getSandboxWorker;
    let result;

    if (useSandbox) {
      try {
        const sandboxToolMap = {
          'runtime_runTerminal': 'run_terminal',
          'runtime_writeFile': 'fswritefile',
          'runtime_editFile': 'fswritefile',
          'fs_write_file': 'fswritefile',
          'fs_delete_path': 'fsdelete'
        };
        const sandboxResult = await window.AgentWorkers.executeSandboxed(sandboxToolMap[tool] || tool, args);
        result = typeof sandboxResult === 'string' ? sandboxResult : JSON.stringify(sandboxResult);
        result += '\n[sandboxed execution]';
      } catch (sandboxErr) {
        result = await orchestrator.executeSkill(call, {
          localBackend: window.localBackend,
          enabledTools: window.enabledTools,
          messages: window.messages,
          queryTracking: runQueryTracking,
          permissionMode: perms.runPermissionMode || 'default',
          sessionId: getActiveSessionIdSafe()
        });
        result = (typeof result === 'string' ? result : JSON.stringify(result)) + '\n[sandbox unavailable, executed in-process]';
      }
    } else {
      result = await orchestrator.executeSkill(call, {
        localBackend: window.localBackend,
        enabledTools: window.enabledTools,
        messages: window.messages,
        queryTracking: runQueryTracking,
        permissionMode: perms.runPermissionMode || 'default',
        sessionId: getActiveSessionIdSafe()
      });
    }

    trackReadPaths(call);

    // Sanitize file content output (prevent accidental code execution injection)
    const outputFileTools = new Set([
      'runtime_readFile', 'fs_read_file', 'file_read', 'read_file', 'fs_preview_file',
      'runtime_listDir', 'fs_list_dir', 'glob', 'fs_glob', 'fs_tree', 'fs_walk',
      'runtime_searchCode', 'fs_search_name', 'fs_search_content', 'fs_grep',
      'runtime_fileDiff', 'fs_stat', 'fs_exists'
    ]);
    if (outputFileTools.has(call?.tool) && typeof result === 'string') {
      let sanitized = result;
      sanitized = sanitized.replace(/<\/script/gi, '<\\/script');
      sanitized = sanitized.replace(/\beval\s*\(/g, 'eval/*sanitized*/(');
      sanitized = sanitized.replace(/\bnew\s+Function\s*\(/g, 'new Function/*sanitized*/(');
      result = sanitized;
    }

    const cacheableRuntimeResult = !executionMeta.destructive && !/^ERROR\b/i.test(result) && !(perms.isPermissionDeniedResult ? perms.isPermissionDeniedResult(result) : false);
    if (cacheableRuntimeResult) {
      if (typeof setCachedToolResult === 'function') setCachedToolResult(call, result);
    }
    return result;
  }

  // Expose publicly
  window.AgentToolExecution = {
    // exported state accessors
    get runDisabledToolCalls() { return runDisabledToolCalls; },
    get runDisabledSemanticToolCalls() { return runDisabledSemanticToolCalls; },
    get runToolFailureCounts() { return runToolFailureCounts; },
    get runFsRootExplored() { return runFsRootExplored; },
    set runFsRootExplored(v) { runFsRootExplored = v; },
    get runSuccessfulToolCount() { return runSuccessfulToolCount; },
    set runSuccessfulToolCount(v) { runSuccessfulToolCount = v; },
    get runLocalTimeoutStreak() { return runLocalTimeoutStreak; },
    set runLocalTimeoutStreak(v) { runLocalTimeoutStreak = v; },
    get runLastToolCallSignature() { return runLastToolCallSignature; },
    set runLastToolCallSignature(v) { runLastToolCallSignature = v; },
    get runRepeatedToolCallCount() { return runRepeatedToolCallCount; },
    set runRepeatedToolCallCount(v) { runRepeatedToolCallCount = v; },
    get runToolCallTotalCounts() { return runToolCallTotalCounts; },
    get runQueryTracking() { return runQueryTracking; },
    set runQueryTracking(v) { runQueryTracking = v; },
    get runToolCallRepairAttempts() { return runToolCallRepairAttempts; },
    // utility exports
    stableHashText, generateRunChainId, getActiveSessionIdSafe,
    getReplacementStorageKey, loadPersistedToolResultReplacements, persistToolResultReplacementRecord,
    normalizeToolArgs, stableStringify, getToolCallSignature, getSemanticToolCallSignature,
    normalizeToolCallObject, dedupeToolCalls,
    normalizePathInput, containsGlobPattern, containsVulnerableUncPathLight, hasSuspiciousWindowsPathPattern, isDangerousRemovalPath,
    getFilesystemOperationType, extractFilesystemPathsFromArgs, validateFilesystemCallGuard,
    getToolExecutionMeta, canRunToolConcurrently, getToolPaths, hasPathConflict,
    trackReadPaths, checkReadBeforeWriteWarning, resetReadBeforeWriteState,
    getToolRisk, requiresConfirmation, needsUserConfirmation, injectConfirmationGate, approveConfirmation,
    partitionToolCallBatches, resetRunToolState,
    resolveToolCallFromModelReply, resolveToolCallsFromModelReply, executeTool
  };
})();
