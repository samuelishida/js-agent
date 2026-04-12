function getToolRegex() {
  return getRuntimeModules().regex?.TOOL_BLOCK || /<tool_call>[\s\S]*?<\/tool_call>/gi;
}

function parseToolCall(text) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  return orchestrator.parseToolCall(text);
}

// ── Steering buffer ───────────────────────────────────────────────────────────
// Allows injecting mid-flight guidance via steer() or an external hook.
// The agent loop drains this buffer each iteration and injects messages as new
// User turns so the LLM sees them immediately.
const steeringBuffer = [];

function pushSteering(msg) {
  const text = String(msg || '').trim();
  if (text) steeringBuffer.push(text);
}

function drainSteering() {
  return steeringBuffer.splice(0, steeringBuffer.length);
}

function clearSteering() {
  const drained = drainSteering();
  const status = document.getElementById('steering-status');
  if (status) status.textContent = 'Steering buffer cleared.';
  return drained;
}

function sendSteering() {
  const input = document.getElementById('steering-input');
  const text = input.value.trim();
  if (text) {
    pushSteering(text);
    input.value = '';
    const status = document.getElementById('steering-status');
    if (status) status.textContent = `Injected: ${text}${text.length > 60 ? '…' : ''}`;
  }
}

// Expose globally so UI / external code can inject steering at runtime.
window.AgentSteering = {
  push: pushSteering,
  drain: drainSteering,
  clear: clearSteering,
  send: sendSteering
};

// ── Tool call steering / rewriting ────────────────────────────────────────────
// Intercepts and rewrites known-bad model-generated tool inputs BEFORE they
// reach the executor — a defence-in-depth layer on top of system-prompt rules.
function steerToolCall(toolName, args) {
  // Block catastrophic shell commands regardless of tool name.
  if (typeof args.command === 'string') {
    const cmd = args.command;

    // Block root filesystem deletions.
    if (/rm\s+(-rf?|\/s)\s+[/\\]($|\s)/i.test(cmd) ||
        /Remove-Item\s+[/\\]\s/i.test(cmd) ||
        /del\s+\/[sq]\s+[/\\]/i.test(cmd)) {
      args.command = 'echo BLOCKED: refusing to delete root filesystem';
      return;
    }

    // Block disk operations.
    if (/(?:format|fdisk|diskpart)\s/i.test(cmd)) {
      args.command = 'echo BLOCKED: disk operations not allowed';
      return;
    }
  }

  // Strip control-channel tags the model may have injected into string args,
  // preventing prompt injection through crafted filenames or query strings.
  const sanitizeStringArg = val => val
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<permission_denials[^>]*>[\s\S]*?<\/permission_denials>/gi, '')
    .trim();

  const stringsToSanitize = ['path', 'filePath', 'sourcePath', 'destinationPath', 'content', 'query', 'text'];
  for (const key of stringsToSanitize) {
    if (typeof args[key] === 'string') {
      args[key] = sanitizeStringArg(args[key]);
    }
  }
}

let stopRequested = false;
let runDisabledToolCalls = new Set();
let runDisabledSemanticToolCalls = new Set();
const runToolFailureCounts = new Map();
let runFsRootExplored = false;
let runSuccessfulToolCount = 0;
let runLocalTimeoutStreak = 0;
let runLastToolCallSignature = '';
let runRepeatedToolCallCount = 0;
let runToolCallTotalCounts = new Map();
let runCompactionState = {
  count: 0,
  consecutiveFailures: 0,
  lastCompactionRound: 0,
  lastBeforeSize: 0,
  lastAfterSize: 0
};
let runToolResultReplacementState = {
  replacements: new Map()
};
let runCompactedResultNoticeSignatures = new Set();
let runPermissionDenials = [];
let runPromptInjectionSignals = [];
let runToolUseSummaryState = {
  emitted: 0
};
let runTimeBasedMicrocompactState = {
  enabled: false,
  inactivityGapMs: 0
};
let runMaxOutputTokensRecoveryCount = 0;
let runToolCallRepairAttempts = new Set();
let runQueryTracking = null;
let runPermissionMode = 'default';

const TOOL_RESULT_CONTEXT_BUDGET = {
  inlineMaxChars: 6000,
  previewChars: 1800,
  keepRecentResults: 8
};
const CONTEXT_COMPACTION_POLICY = {
  thresholdRatio: 0.82,
  reserveChars: 4000,
  minRoundGap: 2,
  maxConsecutiveFailures: 3
};
const TIME_BASED_MICROCOMPACT_POLICY = {
  inactivityMs: 20 * 60 * 1000,
  keepRecentResults: 4
};
const PERMISSION_DENIAL_LIMIT = 30;
const PROMPT_INJECTION_SIGNAL_LIMIT = 40;
const MAX_CONSECUTIVE_NON_ACTION_ROUNDS = 6;
const TOOL_RESULT_REPLACEMENTS_STORAGE_KEY = 'agent_tool_result_replacements_v1';
const PERMISSION_ESCALATION_THRESHOLDS = {
  ask: 3,
  denyWrite: 6
};

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
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `chain_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function getActiveSessionIdSafe() {
  try {
    const session = typeof getActiveSession === 'function' ? getActiveSession() : null;
    return session?.id ? String(session.id) : 'session_unknown';
  } catch {
    return 'session_unknown';
  }
}

function getReplacementStorageKey() {
  return `${TOOL_RESULT_REPLACEMENTS_STORAGE_KEY}:${getActiveSessionIdSafe()}`;
}

function loadPersistedToolResultReplacements() {
  try {
    const raw = sessionStorage.getItem(getReplacementStorageKey());
    const parsed = JSON.parse(raw || '[]');
    // Reject if not an array (could be a tampered value from sessionStorage).
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item === 'object' && !Array.isArray(item))
      .map(item => ({
        // Coerce each field to string; reject any item whose signature or
        // replacement contains control-channel XML (injection guard).
        signature: String(item.signature || ''),
        replacement: String(item.replacement || ''),
        timestamp: String(item.timestamp || '')
      }))
      .filter(item => {
        if (!item.signature || !item.replacement) return false;
        // Do not restore a persisted replacement that itself contains injection
        // payloads — drop it so the original result is re-fetched clean.
        const injectionPattern = /<tool_call\s*>|<system-reminder\s*>|\[SYSTEM\s+OVERRIDE\]/i;
        return !injectionPattern.test(item.replacement);
      })
      .slice(-300);
  } catch {
    return [];
  }
}

function persistToolResultReplacementRecord(call, originalResult, replacement) {
  try {
    const signature = getToolCallSignature(call);
    const existing = loadPersistedToolResultReplacements().filter(item => item.signature !== signature);
    existing.push({
      signature,
      tool: String(call?.tool || 'unknown'),
      originalHash: stableHashText(String(originalResult || '')),
      replacement: String(replacement || ''),
      timestamp: new Date().toISOString()
    });
    sessionStorage.setItem(getReplacementStorageKey(), JSON.stringify(existing.slice(-300)));
  } catch {}
}

// Initialize hook registry once at module load.
// External code can subscribe via window.AgentHooks.on(event, callback).
const _agentHookRegistry = (() => {
  const reg = (window.AgentHooks && typeof window.AgentHooks === 'object') ? window.AgentHooks : {};
  if (!reg.__listeners || !(reg.__listeners instanceof Map)) reg.__listeners = new Map();
  if (typeof reg.on !== 'function') {
    reg.on = (eventName, callback) => {
      const event = String(eventName || '').trim();
      if (!event || typeof callback !== 'function') return;
      const listeners = reg.__listeners.get(event) || new Set();
      listeners.add(callback);
      reg.__listeners.set(event, listeners);
    };
  }
  if (typeof reg.off !== 'function') {
    reg.off = (eventName, callback) => {
      const event = String(eventName || '').trim();
      if (!event || typeof callback !== 'function') return;
      const listeners = reg.__listeners.get(event);
      listeners?.delete(callback);
      if (listeners && !listeners.size) reg.__listeners.delete(event);
    };
  }
  if (typeof reg.emit !== 'function') {
    reg.emit = (eventName, payload) => {
      const event = String(eventName || '').trim();
      if (!event) return;
      const listeners = reg.__listeners.get(event) || new Set();
      listeners.forEach(listener => { try { listener(payload); } catch {} });
    };
  }
  window.AgentHooks = reg;
  return reg;
})();

function emitAgentHook(eventName, payload = {}) {
  _agentHookRegistry.emit?.(eventName, payload);

  const directHook = _agentHookRegistry[eventName];
  if (typeof directHook === 'function') {
    try {
      directHook(payload);
    } catch {}
  }
}

async function evaluateToolPermissionHook(call, context = {}) {
  const hooks = _agentHookRegistry;
  const callback = typeof hooks.canUseTool === 'function'
    ? hooks.canUseTool
    : (typeof hooks.onCanUseTool === 'function' ? hooks.onCanUseTool : null);

  if (!callback) {
    return { allowed: true, decided: false };
  }

  try {
    const decision = await callback({
      call,
      context,
      queryTracking: runQueryTracking,
      permissionMode: runPermissionMode,
      denialCount: runPermissionDenials.length
    });

    if (decision === true) {
      return { allowed: true, decided: true };
    }

    if (decision === false) {
      return {
        allowed: false,
        decided: true,
        reason: 'Denied by runtime canUseTool hook.'
      };
    }

    if (decision && typeof decision === 'object') {
      if (decision.allow === false) {
        return {
          allowed: false,
          decided: true,
          reason: String(decision.reason || 'Denied by runtime canUseTool hook.'),
          path: String(decision.path || '')
        };
      }
      if (decision.allow === true) {
        return { allowed: true, decided: true };
      }
    }

    return { allowed: true, decided: false };
  } catch (error) {
    emitAgentHook('permission_hook_error', {
      tool: String(call?.tool || 'unknown'),
      message: String(error?.message || 'unknown hook error')
    });
    return { allowed: true, decided: false };
  }
}

function updateRunSessionContext(overrides = {}) {
  if (typeof getActiveSession !== 'function') return;
  const session = getActiveSession();
  if (!session) return;

  if (!session.context || typeof session.context !== 'object') {
    session.context = {};
  }

  session.context.permissionMode = String(overrides.permissionMode || runPermissionMode || 'default');
  const denialCount = overrides.permissionDenialsCount ?? runPermissionDenials.length ?? 0;
  session.context.permissionDenialsCount = Number(denialCount || 0);
  session.context.queryTracking = {
    ...(session.context.queryTracking || {}),
    ...(runQueryTracking || {}),
    ...(overrides.queryTracking || {})
  };

  if (overrides.lastPermissionDeniedAt) {
    session.context.lastPermissionDeniedAt = String(overrides.lastPermissionDeniedAt);
  }
}

function maybeEscalatePermissionMode() {
  const count = runPermissionDenials.length;

  if (count >= PERMISSION_ESCALATION_THRESHOLDS.denyWrite && runPermissionMode !== 'deny_write') {
    runPermissionMode = 'deny_write';
    addNotice('Permission escalation: switching to deny_write mode after repeated denials.');
    emitAgentHook('permission_mode_changed', {
      mode: runPermissionMode,
      reason: 'deny_threshold_reached',
      denialCount: count
    });
    updateRunSessionContext({ permissionMode: runPermissionMode });
    return;
  }

  if (count >= PERMISSION_ESCALATION_THRESHOLDS.ask && runPermissionMode === 'default') {
    runPermissionMode = 'ask';
    addNotice('Permission escalation: switching to ask mode after repeated denials.');
    emitAgentHook('permission_mode_changed', {
      mode: runPermissionMode,
      reason: 'ask_threshold_reached',
      denialCount: count
    });
    updateRunSessionContext({ permissionMode: runPermissionMode });
  }
}

function isMaxOutputTokenLikeError(error) {
  const message = String(error?.message || '');
  if (!message) return false;
  return /(max(?:imum)?\s*(?:output\s*)?tokens?|max_output_tokens|output token limit|too many output tokens|exceeded.*output|finish_reason\s*[:=]\s*"?length"?)/i.test(message);
}

function looksLikeDeferredActionReply(text) {
  const value = String(text || '').trim();
  if (!value) return false;

  const futureActionPattern = /\b(?:i\s+will|i'll|let me|i am going to|i'm going to|next[, ]+i(?:\s+will|'ll)?|i'll\s+(?:start|begin|now)|now\s+i(?:'ll|\s+will))\b/i;
  const actionVerbPattern = /\b(?:search|look up|check|verify|probe|inspect|browse|review|find|perform|run|try|investigate|list|listing|read|reading|fetch|fetching|scan|scanning|call|calling|execute|executing|start|starting|begin|beginning|map|mapping|gather|gathering|analyze|analyzing|collect|collecting|query|querying|load|loading|open|opening|access|accessing|retrieve|retrieving|walk|walking|traverse|traversing|explore|exploring|examine|examining|identify|identifying|inspect)\b/i;
  const finalityPattern = /\b(?:final answer|in summary|overall|therefore|the answer is|based on (?:the|current) (?:evidence|information))\b/i;

  return futureActionPattern.test(value) && actionVerbPattern.test(value) && !finalityPattern.test(value);
}

function looksLikeToolExecutionClaimWithoutCall(text) {
  const value = String(text || '').trim();
  if (!value) return false;

  const executionClaimPattern = /\b(?:i\s+(?:have|already)\s+(?:executed|called|run|performed)|(?:the\s+)?tool\s+call\s+(?:has\s+been\s+)?(?:executed|made|performed)|executed\s+the\s+necessary\s+tool\s+call|necessary\s+tool\s+call)\b/i;
  const waitingPattern = /\b(?:please\s+wait|wait\s+for\s+(?:the\s+)?tool\s+output|await(?:ing)?\s+tool\s+output|once\s+the\s+tool\s+output|after\s+tool\s+output|provide\s+the\s+final\s+answer\s+after\s+tool\s+output)\b/i;
  const finalityPattern = /\b(?:final answer|in summary|overall|therefore|the answer is|based on (?:the|current) (?:evidence|information))\b/i;

  return executionClaimPattern.test(value) && waitingPattern.test(value) && !finalityPattern.test(value);
}

function extractPlannerOptimizedQueryFromMessages(messages = []) {
  const recentUserMessages = Array.isArray(messages)
    ? messages.filter(message => message?.role === 'user').slice(-8).reverse()
    : [];

  for (const message of recentUserMessages) {
    const content = String(message?.content || '');
    const queryPlanBlocks = [...content.matchAll(/<tool_result\s+tool="query_plan">\s*([\s\S]*?)\s*<\/tool_result>/gi)];
    for (let i = queryPlanBlocks.length - 1; i >= 0; i -= 1) {
      const block = String(queryPlanBlocks[i]?.[1] || '');
      const directMatch = block.match(/(?:^|\n)query=([^\n]+)/i);
      if (directMatch?.[1]) {
        const query = String(directMatch[1]).trim();
        if (query) return query;
      }
    }

    const plannerMatch = content.match(/Planner optimized query:\s*"([^"]+)"/i);
    if (plannerMatch?.[1]) {
      const query = String(plannerMatch[1]).trim();
      if (query) return query;
    }
  }

  return '';
}

function completeToolCallArgs(call, { messages = [], userMessage = '' } = {}) {
  const normalized = normalizeToolCallObject(call);
  if (!normalized) return null;

  if (normalized.tool === 'web_search' && !String(normalized.args?.query || '').trim()) {
    const recoveredQuery = extractPlannerOptimizedQueryFromMessages(messages) || String(userMessage || '').trim();
    if (recoveredQuery) {
      normalized.args = {
        ...normalized.args,
        query: recoveredQuery
      };
    }
  }

  return normalized;
}

function shouldAttemptToolCallRepair({ rawReply = '', cleanReply = '', thinkingBlocks = [] } = {}) {
  const raw = String(rawReply || '').trim();
  const visible = String(cleanReply || '').trim();
  if (!raw) return false;

  const { regex, orchestrator } = getRuntimeModules();

  if (regex?.hasUnprocessedToolCall?.(raw)) return true;
  if (/<\|tool_call>|<tool_call\b/i.test(raw) || /"tool"\s*:/i.test(raw)) return true;
  if (!visible && Array.isArray(thinkingBlocks) && thinkingBlocks.some(block => String(block || '').trim())) return true;
  if (looksLikeDeferredActionReply(visible)) return true;
  if (looksLikeToolExecutionClaimWithoutCall(visible)) return true;
  if (orchestrator?.hasReasoningLeak?.(visible)) return true;

  return false;
}

async function attemptToolCallRepair({ userMessage = '', rawReply = '', messages = [] } = {}) {
  const assistantReply = String(rawReply || '').trim();
  if (!assistantReply) return null;

  const repairSignature = stableHashText(`${userMessage}\n${assistantReply}`);
  if (runToolCallRepairAttempts.has(repairSignature)) {
    return null;
  }
  runToolCallRepairAttempts.add(repairSignature);

  const enabledToolNames = Object.entries(enabledTools)
    .filter(([, enabled]) => !!enabled)
    .map(([name]) => name);
  const systemMessage = Array.isArray(messages)
    ? messages.find(message => message?.role === 'system')
    : null;
  const recentMessages = Array.isArray(messages)
    ? messages.filter(message => message?.role !== 'system').slice(-12)
    : [];
  const repairPrompt = await buildDirectAnswerRepairPrompt({
    userMessage,
    previousReply: assistantReply,
    enabledTools: enabledToolNames
  });

  const repairMessages = [
    ...(systemMessage ? [systemMessage] : []),
    ...recentMessages,
    { role: 'assistant', content: assistantReply },
    { role: 'user', content: repairPrompt }
  ];

  const repairedRawReply = await callLLM(repairMessages, {
    maxTokens: 450,
    temperature: 0.1,
    timeoutMs: isLocalModeActive() ? 70000 : 22000,
    retries: isLocalModeActive() ? 0 : 1
  });
  const repairedParsedReply = splitModelReply(repairedRawReply);
  const repairedToolCalls = dedupeToolCalls(resolveToolCallsFromModelReply(
    repairedParsedReply.visible,
    repairedRawReply
  ));

  return {
    rawReply: repairedRawReply,
    parsedReply: repairedParsedReply,
    reply: repairedParsedReply.visible,
    toolCalls: repairedToolCalls
  };
}

function getRuntimeScopedCache(scope, key) {
  return window.AgentRuntimeCache?.get?.(scope, key) ?? null;
}

function setRuntimeScopedCache(scope, key, payload, options = {}) {
  return !!window.AgentRuntimeCache?.set?.(scope, key, payload, options);
}

function buildToolResultDigest(toolName, text) {
  const payload = String(text || '');
  const head = payload.slice(0, 900).trimEnd();
  const tail = payload.length > 1600 ? payload.slice(-500).trimStart() : '';
  const signalLines = payload
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => /(error|warning|found|match|path|total|result|summary|status)/i.test(line))
    .slice(0, 8);

  const sections = [
    '[tool_result_compacted]',
    `Tool: ${toolName || 'unknown'}`,
    `Original chars: ${payload.length}`,
    '',
    'Head preview:',
    head || '(empty)',
    signalLines.length ? `\nSignal lines:\n${signalLines.join('\n')}` : ''
  ];

  if (tail) {
    sections.push('\nTail preview:', tail);
  }

  sections.push('\nUse narrower follow-up tool calls if full output is required.');
  return sections.join('\n').trim();
}

function extractToolResultPayload(content) {
  const match = String(content || '').match(/<tool_result([^>]*)>\s*([\s\S]*?)\s*<\/tool_result>/i);
  if (!match) return null;
  const attrs = String(match[1] || '');
  const tool = attrs.match(/tool="([^"]+)"/i)?.[1] || 'unknown';
  const body = String(match[2] || '');
  return { tool, body };
}

function maybeExtractLongTermMemory(userMessage, assistantMessage) {
  try {
    return window.AgentMemory?.extractFromTurn?.({
      userMessage,
      assistantMessage
    }) || null;
  } catch {
    return null;
  }
}

function setStopButtonState(running) {
  const stopBtn = document.getElementById('btn-stop');
  if (!stopBtn) return;
  stopBtn.disabled = !running;
  stopBtn.style.display = running ? 'flex' : 'none';
  const sendBtn = document.getElementById('btn-send');
  if (sendBtn) sendBtn.style.display = running ? 'none' : 'flex';
}

function requestStop() {
  if (!isBusy) return;
  stopRequested = true;
  setStatus('busy', 'stopping…');
  const inputStatus = document.getElementById('input-status');
  if (inputStatus) inputStatus.textContent = 'stopping…';
  window.AgentLLMControl?.abortActiveLlmRequest?.();
  // Abort any pending tab_listen Promises so they reject immediately.
  window.AgentSkills?.abortAllTabListeners?.('Run stopped by user.');
}

function throwIfStopRequested() {
  if (!stopRequested) return;
  const error = new Error('RUN_STOPPED');
  error.code = 'RUN_STOPPED';
  throw error;
}

function resetRunGuards() {
  runDisabledToolCalls = new Set();
  runDisabledSemanticToolCalls = new Set();
  runToolFailureCounts.clear();
  const persistedReplacements = loadPersistedToolResultReplacements();
  runToolResultReplacementState = {
    replacements: new Map(persistedReplacements.map(item => [item.signature, item.replacement]))
  };
  runCompactedResultNoticeSignatures = new Set();
  runFsRootExplored = false;
  runSuccessfulToolCount = 0;
  runLocalTimeoutStreak = 0;
  runLastToolCallSignature = '';
  runRepeatedToolCallCount = 0;
  runToolCallTotalCounts = new Map();
  runCompactionState = {
    count: 0,
    consecutiveFailures: 0,
    lastCompactionRound: 0,
    lastBeforeSize: 0,
    lastAfterSize: 0
  };
  runPermissionDenials = [];
  runPromptInjectionSignals = [];
  runToolUseSummaryState = { emitted: 0 };
  runTimeBasedMicrocompactState = {
    enabled: false,
    inactivityGapMs: 0
  };
  runMaxOutputTokensRecoveryCount = 0;
  runToolCallRepairAttempts = new Set();
  runQueryTracking = null;
  const sessionPermissionMode = typeof getActiveSession === 'function'
    ? getActiveSession()?.context?.permissionMode
    : 'default';
  runPermissionMode = String(sessionPermissionMode || 'default');
}

function getToolCallSignature(call) {
  return `${String(call?.tool || 'unknown')}:${stableStringify(call?.args || {})}`;
}

function getSemanticToolCallSignature(call) {
  const tool = String(call?.tool || '').trim();
  if (!tool) return 'unknown';

  if (tool !== 'web_search') {
    return getToolCallSignature(call);
  }

  const rawQuery = String(call?.args?.query || '').trim();
  const normalized = rawQuery
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(de|da|do|das|dos|para|por|com|na|no|nas|nos|em|e|a|o)\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const tokens = [...new Set(normalized.split(/\s+/).filter(Boolean))].sort();
  return `${tool}:${tokens.join(' ') || normalized || rawQuery.toLowerCase()}`;
}

function normalizeToolArgs(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
}

function stableStringify(value, _depth = 0) {
  // Guard against stack overflow from deeply nested or circular structures.
  if (_depth > 12) return '"[deep]"';

  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => stableStringify(item, _depth + 1)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key], _depth + 1)}`).join(',') + '}';
  }
  return JSON.stringify(String(value));
}

function normalizePathInput(value) {
  return String(value || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim();
}

function containsGlobPattern(value) {
  return /[*?[\]{}]/.test(String(value || ''));
}

function containsVulnerableUncPathLight(value) {
  const text = String(value || '');
  if (!text) return false;
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
  if (text.startsWith('\\\\?\\') || text.startsWith('\\\\.\\') || text.startsWith('//?/') || text.startsWith('//./')) {
    return true;
  }
  if (/[.\s]+$/.test(text)) return true;
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(text)) return true;
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(text)) return true;
  return false;
}

function isDangerousRemovalPath(pathValue) {
  const normalized = String(pathValue || '')
    .replace(/[\\/]+/g, '/')
    .trim();

  if (!normalized) return true;
  if (normalized === '*' || normalized.endsWith('/*')) return true;

  const withoutTrailingSlash = normalized === '/' ? normalized : normalized.replace(/\/$/, '');
  if (withoutTrailingSlash === '/') return true;
  if (/^[A-Za-z]:\/?$/.test(withoutTrailingSlash)) return true;

  const parent =
    withoutTrailingSlash.includes('/')
      ? withoutTrailingSlash.slice(0, withoutTrailingSlash.lastIndexOf('/')) || '/'
      : '';
  if (parent === '/') return true;
  if (/^[A-Za-z]:\/[^/]+$/.test(withoutTrailingSlash)) return true;

  return false;
}

function getFilesystemOperationType(toolName) {
  const tool = String(toolName || '').trim();
  const writeTools = new Set([
    'fs_write_file',
    'file_write',
    'write_file',
    'file_edit',
    'edit_file',
    'fs_copy_file',
    'fs_move_file',
    'fs_delete_path',
    'fs_rename_path',
    'fs_mkdir',
    'fs_touch',
    'fs_save_upload'
  ]);

  if (writeTools.has(tool)) return 'write';
  if (tool === 'fs_download_file') return 'create';
  if (tool.startsWith('fs_') || tool === 'file_read' || tool === 'read_file' || tool === 'glob' || tool === 'grep') {
    return 'read';
  }
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

  const generalKeys = [
    'path',
    'filePath',
    'sourcePath',
    'destinationPath',
    'new_path',
    'newPath',
    'root',
    'directory'
  ];

  for (const key of generalKeys) {
    if (Object.prototype.hasOwnProperty.call(normalizedArgs, key)) {
      push(key, normalizedArgs[key]);
    }
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
    return {
      allowed: false,
      reason: 'A valid filesystem path is required for this write operation.'
    };
  }

  for (const item of paths) {
    const path = item.path;

    if (containsVulnerableUncPathLight(path)) {
      return {
        allowed: false,
        reason: `UNC network path '${path}' requires explicit manual approval.`,
        path
      };
    }

    if (path.startsWith('~') && !/^~(?:\/|\\|$)/.test(path)) {
      return {
        allowed: false,
        reason: `Tilde expansion variant in '${path}' requires manual approval.`,
        path
      };
    }

    if (path.includes('$') || path.includes('%') || path.startsWith('=')) {
      return {
        allowed: false,
        reason: `Shell expansion syntax in '${path}' requires manual approval.`,
        path
      };
    }

    if (hasSuspiciousWindowsPathPattern(path)) {
      return {
        allowed: false,
        reason: `Suspicious Windows path pattern detected in '${path}'.`,
        path
      };
    }

    if ((operationType === 'write' || operationType === 'create') && containsGlobPattern(path)) {
      return {
        allowed: false,
        reason: `Glob patterns are blocked for write operations ('${path}'). Use an exact path.`,
        path
      };
    }
  }

  if (String(call?.tool || '') === 'fs_delete_path') {
    const target = normalizePathInput(call?.args?.path);
    if (isDangerousRemovalPath(target)) {
      return {
        allowed: false,
        reason: `Refusing dangerous delete target '${target || '(empty)'}'.`,
        path: target
      };
    }
  }

  return { allowed: true };
}

function registerPermissionDenial(call, decision) {
  const item = {
    tool: String(call?.tool || 'unknown'),
    args: normalizeToolArgs(call?.args),
    reason: String(decision?.reason || 'permission denied'),
    path: String(decision?.path || ''),
    timestamp: new Date().toISOString()
  };

  runPermissionDenials.push(item);
  if (runPermissionDenials.length > PERMISSION_DENIAL_LIMIT) {
    runPermissionDenials = runPermissionDenials.slice(-PERMISSION_DENIAL_LIMIT);
  }

  maybeEscalatePermissionMode();
  updateRunSessionContext({
    permissionDenialsCount: runPermissionDenials.length,
    lastPermissionDeniedAt: item.timestamp
  });
  emitAgentHook('permission_denied', {
    call,
    decision: item,
    denialCount: runPermissionDenials.length,
    permissionMode: runPermissionMode
  });
}

function isPermissionDeniedResult(result) {
  return /^ERROR:\s*PERMISSION_DENIED\b/i.test(String(result || ''));
}

function buildPermissionDenialContinuation() {
  if (!runPermissionDenials.length) return '';
  const recent = runPermissionDenials.slice(-3);
  const lines = recent.map((item, index) => {
    const pathPart = item.path ? ` path=${item.path}` : '';
    return `${index + 1}. ${item.tool}${pathPart} - ${item.reason}`;
  });
  return [
    '<permission_denials>',
    ...lines,
    '</permission_denials>',
    'Do not retry denied operations. Choose a safer in-scope path or a different tool.'
  ].join('\n');
}

function buildToolUseSummary(batchResults = []) {
  if (!Array.isArray(batchResults) || !batchResults.length) return '';

  const lines = [];
  let errors = 0;
  for (const item of batchResults) {
    const call = item?.call || {};
    const tool = String(call.tool || 'unknown');
    let result = String(item?.result || '');
    const ok = !/^ERROR\b/i.test(result);
    if (!ok) errors += 1;
    const preview = sanitizeToolResult(result).replace(/\s+/g, ' ').trim().slice(0, 120);
    lines.push(`- ${tool}: ${ok ? 'ok' : 'error'}${preview ? ` (${preview})` : ''}`);
  }

  const successCount = Math.max(0, batchResults.length - errors);
  runToolUseSummaryState.emitted += 1;
  return [
    '[TOOL_USE_SUMMARY]',
    `Batch: ${runToolUseSummaryState.emitted}`,
    `Tools: ${batchResults.length}, Success: ${successCount}, Errors: ${errors}`,
    ...lines.slice(0, 6)
  ].join('\n');
}

// Sanitize tool result text before it enters the message history.
// Strips control-channel XML and role-override markers that could mislead
// the LLM into treating injected data as authoritative agent instructions.
function sanitizeToolResult(text) {
  const raw = String(text || '');
  return raw
    // Remove exact control-channel tags the agent itself emits.
    .replace(/<tool_call\s*>[\s\S]*?<\/tool_call\s*>/gi, '[tool_call content removed by injection guard]')
    .replace(/<system-reminder\s*>[\s\S]*?<\/system-reminder\s*>/gi, '[system-reminder removed by injection guard]')
    .replace(/<permission_denials\s*>[\s\S]*?<\/permission_denials\s*>/gi, '[permission_denials removed by injection guard]')
    // Neutralize role-override markers.
    .replace(/\[(?:SYSTEM|ASSISTANT|USER)\s+OVERRIDE\]/gi, '[OVERRIDE_BLOCKED]')
    .replace(/\bNEW\s+SYSTEM\s+PROMPT\b/gi, '[BLOCKED]');
}

function extractPromptInjectionSignals(toolCall, result) {
  const text = String(result || '');
  if (!text || /^ERROR\b/i.test(text)) return [];

  const sample = text.slice(0, 12000);
  const findings = [];
  const toolName = String(toolCall?.tool || 'tool');

  const rules = [
    {
      pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts?|rules?)/i,
      label: 'Instruction override attempt detected'
    },
    {
      pattern: /(?:reveal|show|print|leak)\s+(?:the\s+)?(?:system\s+prompt|hidden\s+prompt|developer\s+message)/i,
      label: 'Prompt exfiltration language detected'
    },
    {
      pattern: /(?:you are now|act as|pretend to be)\s+(?:a\s+)?(?:system|developer|root|jailbroken)/i,
      label: 'Role hijacking language detected'
    },
    {
      pattern: /(?:disable|bypass|override).{0,40}(?:safety|guardrail|policy|restrictions?)/i,
      label: 'Safety bypass language detected'
    },
    {
      // Tightened: require COMPLETE tag matches to avoid false positives on nested content
      pattern: /<tool_call\s*>.*?<\/tool_call\s*>|<system-reminder\s*>.*?<\/system-reminder\s*>|<permission_denials\s*>.*?<\/permission_denials\s*>|\[TOOL_USE_SUMMARY\]/i,
      label: 'Control-channel tag injection detected in tool output'
    },
    {
      // New: detect attempts to override the assistant role directly in content.
      pattern: /\[(?:SYSTEM|ASSISTANT|USER)\s+OVERRIDE\]|\bNEW\s+SYSTEM\s+PROMPT\b/i,
      label: 'Role/system override marker detected in tool output'
    },
    {
      // New: detect encoded or obfuscated injection attempts.
      pattern: /(?:base64|hex|rot13|url.?encod).{0,30}(?:decode|convert).{0,40}(?:instruct|prompt|command)/i,
      label: 'Encoded instruction injection pattern detected'
    }
  ];

  for (const rule of rules) {
    if (rule.pattern.test(sample)) {
      findings.push(`${toolName}: ${rule.label}`);
    }
  }

  return findings;
}

function registerPromptInjectionSignals(signals = []) {
  if (!Array.isArray(signals) || !signals.length) return;

  const merged = [...runPromptInjectionSignals, ...signals]
    .map(item => String(item || '').trim())
    .filter(Boolean);

  runPromptInjectionSignals = [...new Set(merged)].slice(-PROMPT_INJECTION_SIGNAL_LIMIT);
}

function recordToolFailure(call, result) {
  if (!/^ERROR\b/i.test(String(result || ''))) {
    return { repeated: false, count: 0 };
  }

  const signature = String(result || '')
    .replace(/\s+/g, ' ')
    .replace(/\d+/g, '#')
    .slice(0, 180);

  const key = `${call.tool}::${signature}`;
  const count = (runToolFailureCounts.get(key) || 0) + 1;
  runToolFailureCounts.set(key, count);

  if (count >= 2) {
    runDisabledToolCalls.add(getToolCallSignature(call));
    return { repeated: true, count };
  }

  return { repeated: false, count };
}

function canAttemptCompaction(round, currentSize, ctxLimit) {
  if (runCompactionState.consecutiveFailures >= CONTEXT_COMPACTION_POLICY.maxConsecutiveFailures) return false;
  if (round - runCompactionState.lastCompactionRound < CONTEXT_COMPACTION_POLICY.minRoundGap) return false;
  const threshold = Math.max(
    Math.floor(ctxLimit * CONTEXT_COMPACTION_POLICY.thresholdRatio),
    Math.max(1, ctxLimit - CONTEXT_COMPACTION_POLICY.reserveChars)
  );
  if (currentSize < threshold) return false;
  return true;
}

function registerCompactionSuccess(round, beforeSize, afterSize) {
  runCompactionState.count += 1;
  runCompactionState.consecutiveFailures = 0;
  runCompactionState.lastCompactionRound = round;
  runCompactionState.lastBeforeSize = beforeSize;
  runCompactionState.lastAfterSize = afterSize;

  if (typeof getActiveSession === 'function') {
    const session = getActiveSession();
    if (session) {
      if (!session.context || typeof session.context !== 'object') {
        session.context = { compactions: 0, lastCompactedAt: null };
      }
      session.context.compactions = Number(session.context.compactions || 0) + 1;
      session.context.lastCompactedAt = new Date().toISOString();
      if (typeof scheduleSaveSessions === 'function') {
        scheduleSaveSessions();
      }
    }
  }
}

function registerCompactionFailure(round) {
  runCompactionState.consecutiveFailures += 1;
  runCompactionState.lastCompactionRound = round;
}

function recordRepeatedToolCall(call) {
  const signature = getSemanticToolCallSignature(call);

  // Track total appearances this run to catch alternating 2-tool loops (A,B,A,B,...).
  const totalCount = (runToolCallTotalCounts.get(signature) || 0) + 1;
  runToolCallTotalCounts.set(signature, totalCount);

  // Track consecutive identical calls.
  if (signature === runLastToolCallSignature) {
    runRepeatedToolCallCount += 1;
  } else {
    runLastToolCallSignature = signature;
    runRepeatedToolCallCount = 1;
  }

  // Block at ≥3 consecutive identical calls OR ≥4 total calls for the same signature.
  if (runRepeatedToolCallCount >= 3 || totalCount >= 4) {
    runDisabledSemanticToolCalls.add(signature);
    return { repeated: true, count: runRepeatedToolCallCount, totalCount, signature };
  }

  return { repeated: false, count: runRepeatedToolCallCount, totalCount, signature };
}

function getTurnLlmCallOptions() {
  const recoverySteps = Math.max(0, Number(runMaxOutputTokensRecoveryCount) || 0);
  const maxTokens = isLocalModeActive()
    ? Math.max(512, 1900 - (recoverySteps * 280))
    : Math.max(512, 2200 - (recoverySteps * 320));

  if (isLocalModeActive()) {
    return { timeoutMs: 120000, retries: 0, maxTokens };
  }
  return { timeoutMs: 35000, retries: 2, maxTokens };
}

function resolveToolCallFromModelReply(reply, rawReply) {
  const direct = parseToolCall(reply);
  if (direct?.tool) return direct;

  const fromRaw = parseToolCall(rawReply);
  if (fromRaw?.tool) return fromRaw;

  return null;
}

function normalizeToolCallObject(call) {
  if (!call?.tool) return null;
  const tool = String(call.tool || '').trim();
  if (!tool) return null;
  return { tool, args: normalizeToolArgs(call.args) };
}

function dedupeToolCalls(calls, maxCalls = 5) {
  const deduped = [];
  const seen = new Set();

  for (const call of calls) {
    const normalized = normalizeToolCallObject(call);
    if (!normalized) continue;
    const signature = getToolCallSignature(normalized);
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(normalized);
    if (deduped.length >= maxCalls) break;
  }

  return deduped;
}

function resolveToolCallsFromModelReply(reply, rawReply) {
  // Strip thinking blocks before scanning for tool calls so that tool calls
  // the model only "considered" inside <think> are never executed.
  const scanTarget = String(rawReply || '').replace(/<think>[\s\S]*?<\/think>/gi, '');

  const blockMatches = scanTarget
    .match(/<tool_call>\s*[\s\S]*?<\/tool_call>/gi) || [];

  const parsedBlockCalls = blockMatches
    .map(block => parseToolCall(block))
    .filter(call => !!call?.tool);

  if (parsedBlockCalls.length) {
    return dedupeToolCalls(parsedBlockCalls);
  }

  const fallbackCall = resolveToolCallFromModelReply(reply, scanTarget);
  return fallbackCall ? [fallbackCall] : [];
}

function getToolExecutionMeta(toolName) {
  const metaFromSkills = window.AgentSkills?.getToolExecutionMeta?.(toolName);
  if (metaFromSkills) return metaFromSkills;

  const name = String(toolName || '').trim();
  if (name === 'calc' || name === 'datetime') {
    return { readOnly: true, concurrencySafe: true, destructive: false, riskLevel: 'normal' };
  }

  return { readOnly: false, concurrencySafe: false, destructive: false, riskLevel: 'normal' };
}

function canRunToolConcurrently(call) {
  const meta = getToolExecutionMeta(call?.tool);
  return !!meta.concurrencySafe;
}

function partitionToolCallBatches(calls) {
  const batches = [];

  for (const call of calls) {
    const concurrencySafe = canRunToolConcurrently(call);
    const lastBatch = batches[batches.length - 1];

    if (concurrencySafe && lastBatch?.concurrencySafe) {
      lastBatch.calls.push(call);
      continue;
    }

    batches.push({ concurrencySafe, calls: [call] });
  }

  return batches;
}

async function executeTool(call) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  const { tool, args } = call;

  // Apply tool call steering: rewrite known-bad patterns before execution.
  steerToolCall(tool, args);

  const callSignature = getToolCallSignature(call);
  const semanticSignature = getSemanticToolCallSignature(call);

  if (runDisabledToolCalls.has(callSignature)) {
    return `ERROR: tool call '${callSignature}' is temporarily disabled for this run after repeated failures.`;
  }

  if (runDisabledSemanticToolCalls.has(semanticSignature)) {
    return `ERROR: tool call '${tool}' was blocked to prevent repeated near-duplicate requests in this run.`;
  }

  const executionMeta = getToolExecutionMeta(tool);
  if (runPermissionMode === 'deny_write' && executionMeta.destructive) {
    const denial = {
      allowed: false,
      reason: `Permission mode '${runPermissionMode}' blocks write-capable tools in this run.`
    };
    registerPermissionDenial(call, denial);
    runDisabledToolCalls.add(callSignature);
    return `ERROR: PERMISSION_DENIED: ${denial.reason}`;
  }

  const hookPermission = await evaluateToolPermissionHook(call, {
    callSignature,
    semanticSignature,
    executionMeta
  });

  if (runPermissionMode === 'ask' && executionMeta.destructive && !hookPermission.decided) {
    const denial = {
      allowed: false,
      reason: `Permission mode '${runPermissionMode}' requires explicit hook approval for write-capable tools.`
    };
    registerPermissionDenial(call, denial);
    return `ERROR: PERMISSION_DENIED: ${denial.reason}`;
  }

  if (!hookPermission.allowed) {
    registerPermissionDenial(call, hookPermission);
    runDisabledToolCalls.add(callSignature);
    return `ERROR: PERMISSION_DENIED: ${hookPermission.reason}`;
  }

  const filesystemGuard = validateFilesystemCallGuard(call);
  if (!filesystemGuard.allowed) {
    registerPermissionDenial(call, filesystemGuard);
    runDisabledToolCalls.add(callSignature);
    return `ERROR: PERMISSION_DENIED: ${filesystemGuard.reason}`;
  }

  if (!enabledTools[tool]) {
    return `ERROR: tool '${tool}' is disabled in this environment.`;
  }

  if (tool === 'calc') {
    const expr = String(args.expression || '').trim();
    if (!expr) {
      return 'calc error: expression is required.';
    }

    // Allowlist: only permit numeric literals, arithmetic ops, parens, spaces,
    // Math.* functions, and Math constants. Everything else is rejected.
    const ALLOWED_CALC = /^[\d\s+\-*/%.()e,^]+$|^(?:[\d\s+\-*/%.()e,^]|Math\.\w+)*$/;
    const DANGEROUS_CALC = /[{}\[\];=<>|&'"`:!@#$~\\]|\b(?:async|await|function|class|var|let|const|return|if|else|for|while|switch|case|break|continue|throw|catch|finally|eval|Function|constructor|prototype|__proto__|window|document|globalThis|process|require|import|export|module|this|Object|Array|Promise|fetch|XMLHttp)\b/i;

    // Replace ^ with ** for exponentiation (common user expectation).
    const sanitizedExpr = expr.replace(/\^/g, '**');

    if (!ALLOWED_CALC.test(sanitizedExpr)) {
      return 'calc error: expression contains disallowed characters or identifiers.';
    }

    if (DANGEROUS_CALC.test(expr)) {
      return 'calc error: expression contains unsupported or unsafe syntax.';
    }

    try {
      // Scope is intentionally empty — Math is the only global allowed.
      const result = new Function('Math', `"use strict"; return (${sanitizedExpr})`)(Math);
      if (typeof result !== 'number' && typeof result !== 'bigint') {
        return `calc error: expression did not return a number.`;
      }
      return `${expr} = ${result}`;
    } catch (e) {
      return `calc error: ${e?.message || 'invalid expression'}`;
    }
  }

  if (tool === 'datetime') {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return `Current datetime: ${now.toISOString()}\nLocal: ${now.toLocaleString(undefined, { timeZone: tz, weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', timeZoneName:'short' })}\nTimezone: ${tz}`;
  }

  const cachedResult = getCachedToolResult(call);
  if (cachedResult) {
    return `${cachedResult}\n\n[cache hit]`;
  }

  const runtimeHotCache = getRuntimeScopedCache('tool_hot', callSignature);
  if (runtimeHotCache) {
    return `${runtimeHotCache}\n\n[cache hit/runtime]`;
  }

  const result = await orchestrator.executeSkill(call, {
    localBackend,
    enabledTools,
    messages,
    queryTracking: runQueryTracking,
    permissionMode: runPermissionMode,
    sessionId: getActiveSessionIdSafe()
  });

  const cacheableRuntimeResult =
    !executionMeta.destructive &&
    !isPermissionDeniedResult(result) &&
    !/^ERROR\b/i.test(result);

  if (cacheableRuntimeResult) {
    setCachedToolResult(call, result);
    setRuntimeScopedCache('tool_hot', callSignature, result, {
      ttlMs: executionMeta.readOnly ? 10 * 60 * 1000 : 60 * 1000,
      maxEntries: executionMeta.readOnly ? 500 : 120,
      maxBytes: 2_000_000
    });
  }
  return result;
}

// -- CONTEXT SIZE + SUMMARIZE --------------------------------------------------
function ctxSize(msgs) {
  return msgs.reduce((n, m) => n + (m.content || '').length, 0);
}

function updateCtxBar() {
  const size = ctxSize(messages);
  const limit = getCtxLimit();
  const pct = Math.min(100, (size / limit) * 100);
  const bar = document.getElementById('ctx-bar');
  const label = document.getElementById('ctx-pct');
  if (bar) {
    bar.style.width = pct + '%';
    bar.classList.toggle('warn', pct > 60 && pct <= 85);
    bar.classList.toggle('danger', pct > 85);
  }
  if (label) label.textContent = pct.toFixed(1) + '%';
}

function notifyIfHidden(summary) {
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window)) return;
  if (window.Notification.permission !== 'granted') return;

  try {
    new window.Notification('JS Agent', {
      body: String(summary || 'Task complete.').slice(0, 120),
      tag: 'agent-run-finished',
      silent: false
    });
  } catch (error) {
    console.warn('Notification failed:', error?.message || error);
  }
}

function formatCompactSummaryOutput(summary) {
  let text = String(summary || '').trim();
  if (!text) return '';

  text = text.replace(/<analysis>[\s\S]*?<\/analysis>/i, '').trim();
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) {
    text = String(summaryMatch[1] || '').trim();
  }

  text = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*Summary:\s*/i, '')
    .trim();

  return text;
}

function buildCompactBoundaryMarker(meta = {}) {
  const timestamp = new Date().toISOString();
  const parts = [`[COMPACT_BOUNDARY]`, timestamp];
  if (meta?.reason) parts.push(`Reason: ${meta.reason}`);
  if (meta?.savedChars) parts.push(`Saved chars: ${meta.savedChars}`);
  return parts.join('\n');
}

async function summarizeContext(userQuery) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  addNotice('Context limit reached (' + ctxSize(messages).toLocaleString() + ' chars). Compressing via LLM.');
  sessionStats.resets++;
  updateStats();

  const hist = messages
    .filter(m => m.role !== 'system')
    .map(m => `[${m.role.toUpperCase()}]: ${sanitizeToolResult(m.content)}`)
    .join('\n\n');

  const summaryCacheKey = `${stableHashText(hist)}:${stableHashText(userQuery)}`;
  const cachedSummaryText = getRuntimeScopedCache('context_summary', summaryCacheKey);
  if (cachedSummaryText) {
    const sysMsgFromCache = messages.find(m => m.role === 'system') ?? { role: 'system', content: '' };
    return [
      sysMsgFromCache,
      { role: 'assistant', subtype: 'compact_boundary', content: buildCompactBoundaryMarker({ reason: 'cached_summary' }) },
      { role: 'assistant', content: `[SUMMARISED CONTEXT]\n${String(cachedSummaryText)}` },
      { role: 'user', content: userQuery }
    ];
  }

  const prompt = await orchestrator.buildSummaryPrompt(hist, userQuery);

  const sysMsg = messages.find(m => m.role === 'system') ?? { role: 'system', content: '' };
  const summary = await callLLM([
    sysMsg,
    { role: 'user', content: prompt }
  ], { maxTokens: 700, temperature: 0.2, timeoutMs: 28000, retries: 1 });

  const summaryText = String(summary || '').trim();
  const looksLikeErrorJson = /^\{[\s\S]*"error"\s*:/i.test(summaryText);
  const looksLikeEndpointError = /Unexpected endpoint or method|no compatible endpoint|Local LLM:/i.test(summaryText);
  if (
    !summaryText ||
    looksLikeErrorJson ||
    looksLikeEndpointError ||
    /<tool_call>[\s\S]*?<\/tool_call>/i.test(summaryText)
  ) {
    throw new Error('Summarization returned an invalid backend payload.');
  }

  const formattedSummary = formatCompactSummaryOutput(summaryText);
  if (!formattedSummary) {
    throw new Error('Summarization output was empty after formatting.');
  }

  setRuntimeScopedCache('context_summary', summaryCacheKey, formattedSummary, {
    ttlMs: 6 * 60 * 60 * 1000,
    maxEntries: 200,
    maxBytes: 1_500_000
  });

  const compactBoundary = buildCompactBoundaryMarker({ reason: 'llm_summary' });

  return [
    sysMsg,
    { role: 'assistant', subtype: 'compact_boundary', content: compactBoundary },
    { role: 'assistant', content: `[SUMMARISED CONTEXT]\n${formattedSummary}` },
    { role: 'user', content: userQuery }
  ];
}

function fallbackCompressContext(userQuery) {
  const sysMsg = messages.find(m => m.role === 'system') || { role: 'system', content: '' };
  const tail = messages.filter(m => m.role !== 'system').slice(-8);

  if (!tail.length || tail[tail.length - 1].role !== 'user') {
    tail.push({ role: 'user', content: userQuery });
  }

  return [sysMsg, ...tail];
}

function applyToolResultContextBudget(call, result) {
  const text = String(result || '');
  if (!text) return text;

  const signature = getToolCallSignature(call);
  const existingReplacement = runToolResultReplacementState.replacements.get(signature);
  if (existingReplacement !== undefined) {
    return existingReplacement;
  }

  if (/^ERROR\b/i.test(text) || text.length <= TOOL_RESULT_CONTEXT_BUDGET.inlineMaxChars) {
    return text;
  }

  const digestKey = `${call?.tool || 'unknown'}:${stableHashText(text)}`;
  const cachedDigest = getRuntimeScopedCache('tool_result_digest', digestKey);
  const compacted = cachedDigest || buildToolResultDigest(call?.tool || 'unknown', text);

  if (!cachedDigest) {
    setRuntimeScopedCache('tool_result_digest', digestKey, compacted, {
      ttlMs: 24 * 60 * 60 * 1000,
      maxEntries: 800,
      maxBytes: 2_000_000
    });
  }

  // Keep an archive copy for a short window so the loop can still recover details if needed.
  setRuntimeScopedCache('tool_result_archive', `${signature}:${digestKey}`, text.slice(0, 40000), {
    ttlMs: 24 * 60 * 60 * 1000,
    maxEntries: 300,
    maxBytes: 3_000_000
  });

  runToolResultReplacementState.replacements.set(signature, compacted);
  persistToolResultReplacementRecord(call, text, compacted);
  return compacted;
}

function microcompactToolResultMessages(msgs, options = {}) {
  const keepRecent = Math.max(
    1,
    Number(options.keepRecent ?? TOOL_RESULT_CONTEXT_BUDGET.keepRecentResults) || TOOL_RESULT_CONTEXT_BUDGET.keepRecentResults
  );
  const clearOnly = options.clearOnly === true;
  const clearedNotice = String(options.clearedNotice || '[Old tool result content cleared by microcompact]');
  const compactedNotice = String(options.compactedNotice || '[Old tool result compacted by microcompact]');
  const toolResultIndexes = [];
  for (let i = 0; i < msgs.length; i += 1) {
    const msg = msgs[i];
    if (msg?.role !== 'user') continue;
    if (!String(msg?.content || '').includes('<tool_result')) continue;
    toolResultIndexes.push(i);
  }

  if (toolResultIndexes.length <= keepRecent) {
    return { messages: msgs, clearedCount: 0, savedChars: 0 };
  }

  const keepSet = new Set(toolResultIndexes.slice(-Math.max(1, keepRecent)));
  const next = [...msgs];
  let clearedCount = 0;
  let savedChars = 0;

  for (const index of toolResultIndexes) {
    if (keepSet.has(index)) continue;

    const original = String(msgs[index]?.content || '');
    if (original.includes(clearedNotice) || original.includes(compactedNotice)) continue;

    const extracted = extractToolResultPayload(original);
    if (!extracted) continue;

    if (clearOnly) {
      const compacted = `<tool_result tool="${extracted.tool}">\n${clearedNotice}\n</tool_result>`;
      if (compacted === original) continue;
      clearedCount += 1;
      savedChars += Math.max(0, original.length - compacted.length);
      next[index] = { ...msgs[index], content: compacted };
      continue;
    }

    const digestKey = `${extracted.tool}:${stableHashText(extracted.body)}`;
    const digest = getRuntimeScopedCache('tool_result_digest', digestKey)
      || buildToolResultDigest(extracted.tool, extracted.body);

    if (!getRuntimeScopedCache('tool_result_digest', digestKey)) {
      setRuntimeScopedCache('tool_result_digest', digestKey, digest, {
        ttlMs: 24 * 60 * 60 * 1000,
        maxEntries: 800,
        maxBytes: 2_000_000
      });
    }

    const compacted = `<tool_result tool="${extracted.tool}">\n${compactedNotice}\n${digest}\n</tool_result>`;

    if (compacted === original) continue;
    clearedCount += 1;
    savedChars += Math.max(0, original.length - compacted.length);
    next[index] = { ...msgs[index], content: compacted };
  }

  return { messages: next, clearedCount, savedChars };
}

function armTimeBasedMicrocompactForTurn() {
  runTimeBasedMicrocompactState = {
    enabled: false,
    inactivityGapMs: 0
  };

  if (typeof getActiveSession !== 'function') return;
  const session = getActiveSession();
  const updatedAt = session?.updatedAt;
  const last = updatedAt ? Date.parse(String(updatedAt)) : NaN;
  if (!Number.isFinite(last)) return;

  const gapMs = Date.now() - last;
  if (gapMs < TIME_BASED_MICROCOMPACT_POLICY.inactivityMs) return;

  runTimeBasedMicrocompactState = {
    enabled: true,
    inactivityGapMs: gapMs
  };
}

async function applyContextManagementPipeline({ round, userMessage, ctxLimit }) {
  const compactionNotes = [];
  const microcompactOptions = runTimeBasedMicrocompactState.enabled
    ? {
        keepRecent: TIME_BASED_MICROCOMPACT_POLICY.keepRecentResults,
        clearOnly: true,
        clearedNotice: '[Old tool result content cleared after inactivity]'
      }
    : {};

  const microcompact = microcompactToolResultMessages(messages, microcompactOptions);
  if (microcompact.clearedCount > 0) {
    messages = microcompact.messages;
    if (runTimeBasedMicrocompactState.enabled) {
      const gapMinutes = Math.round(runTimeBasedMicrocompactState.inactivityGapMs / 60000);
      addNotice(`Context manager: cleared ${microcompact.clearedCount} stale tool result(s) after ${gapMinutes}m inactivity, saved ~${microcompact.savedChars} chars.`);
      compactionNotes.push(`Cleared ${microcompact.clearedCount} stale tool result(s) after ${gapMinutes}m inactivity.`);
      runTimeBasedMicrocompactState.enabled = false;
    } else {
      addNotice(`Context manager: cleared ${microcompact.clearedCount} older tool result(s), saved ~${microcompact.savedChars} chars.`);
      compactionNotes.push(`Cleared ${microcompact.clearedCount} older tool result(s) to reduce context pressure.`);
    }
  } else if (runTimeBasedMicrocompactState.enabled) {
    runTimeBasedMicrocompactState.enabled = false;
  }

  const currentCtxSize = ctxSize(messages);
  if (currentCtxSize <= ctxLimit) {
    return compactionNotes;
  }

  if (!canAttemptCompaction(round, currentCtxSize, ctxLimit)) {
    addNotice('Context near limit, but compaction is cooling down after recent attempts/failures.');
    compactionNotes.push('Context remained high but compaction was deferred due cooldown/failure guard.');
    return compactionNotes;
  }

  emitAgentHook('pre_compact', {
    round,
    currentSize: currentCtxSize,
    ctxLimit,
    queryTracking: runQueryTracking
  });

  try {
    const beforeSize = currentCtxSize;
    messages = await summarizeContext(userMessage);
    const afterSize = ctxSize(messages);

    // If summarization does not reduce enough, fall back to deterministic tail compression.
    if (afterSize >= (beforeSize * 0.9)) {
      addNotice('LLM summarization reduction was small; applying deterministic tail compression.');
      messages = fallbackCompressContext(userMessage);
      compactionNotes.push('LLM summarization reduction was small; applied deterministic tail compression.');
    }

    const finalSize = ctxSize(messages);
    registerCompactionSuccess(round, beforeSize, finalSize);
    compactionNotes.push(`Compacted context from ${beforeSize} to ${finalSize} chars.`);
    emitAgentHook('post_compact', {
      round,
      beforeSize,
      afterSize: finalSize,
      savedChars: Math.max(0, beforeSize - finalSize),
      queryTracking: runQueryTracking
    });
  } catch (e) {
    registerCompactionFailure(round);
    addNotice(`? Summarization failed: ${e.message}`);
    messages = fallbackCompressContext(userMessage);
    addNotice('Applied fallback context compression without LLM.');
    compactionNotes.push(`Summarization failed (${e.message}); applied fallback context compression.`);
    if (runCompactionState.consecutiveFailures >= CONTEXT_COMPACTION_POLICY.maxConsecutiveFailures) {
      addNotice('Compaction disabled for this run after repeated failures.');
      compactionNotes.push('Compaction disabled for this run after repeated failures.');
    }
    emitAgentHook('compact_error', {
      round,
      message: String(e?.message || 'unknown compaction error'),
      queryTracking: runQueryTracking
    });
  }

  return compactionNotes;
}

// -- AGENTIC LOOP --------------------------------------------------------------
async function agentLoop(userMessage) {
  assertRuntimeReady();
  throwIfStopRequested();
  const { skills, orchestrator } = getRuntimeModules();
  const MAX_ROUNDS = getMaxRounds();
  const CTX_LIMIT  = getCtxLimit();
  const delay      = getDelay();
  runQueryTracking = {
    chainId: generateRunChainId(),
    startedAt: new Date().toISOString()
  };
  updateRunSessionContext({ queryTracking: runQueryTracking });
  emitAgentHook('session_start', {
    queryTracking: runQueryTracking,
    userMessage: String(userMessage || '')
  });

  armTimeBasedMicrocompactForTurn();
  const enrichedMessage = await skills.buildInitialContext(userMessage, { messages });
  const memoryContextBlock = window.AgentMemory?.buildContextBlock?.(userMessage, messages) || '';
  const turnInputMessage = memoryContextBlock
    ? `${memoryContextBlock}\n\n${enrichedMessage}`
    : enrichedMessage;
  throwIfStopRequested();

  // Init messages for this turn
  const sysPrompt = await buildSystemPrompt(userMessage);
  const unresolvedPlaceholders = sysPrompt.match(/\{\{[^}]+\}\}/g);
  if (unresolvedPlaceholders) {
    throw new Error(`System prompt has unresolved template placeholders: ${unresolvedPlaceholders.join(', ')}`);
  }
  messages = [
    { role: 'system', content: sysPrompt },
    ...messages.filter(m => m.role !== 'system').slice(-20), // keep last 20 non-system
    { role: 'user', content: turnInputMessage }
  ];

  let round = 0;
  let consecutiveNonActionRounds = 0;
  sessionStats.msgs++;

  while (round < MAX_ROUNDS) {
    throwIfStopRequested();
    round++;
    sessionStats.rounds++;
    updateStats();

    setStatus('busy', `round ${round}/${MAX_ROUNDS}`);
    showThinking(`round ${round}/${MAX_ROUNDS}`);

    // Drain steering buffer — inject any mid-session guidance from user.
    const steeredMessages = drainSteering();
    if (steeredMessages.length) {
      const combined = steeredMessages.join('\n\n');
      messages.push({
        role: 'user',
        content: `[USER STEERING — mid-session guidance, follow immediately]\n${combined}`
      });
      addNotice(`Steering injected: ${combined.slice(0, 120)}${combined.length > 120 ? '…' : ''}`);
    }

    if (delay > 0) await sleep(delay);
    throwIfStopRequested();

    let rawReply;
    let parsedReply;
    let reply;
    try {
      rawReply = await callLLM(messages, getTurnLlmCallOptions());
      throwIfStopRequested();
      parsedReply = splitModelReply(rawReply);
      reply = parsedReply.visible;
      runLocalTimeoutStreak = 0;
    } catch (e) {
      hideThinking();
      // Let the outer sendMessage handler deal with user-initiated stops.
      if (e?.code === 'RUN_STOPPED' || e?.name === 'AbortError') throw e;

      if (isMaxOutputTokenLikeError(e) && round < MAX_ROUNDS) {
        runMaxOutputTokensRecoveryCount += 1;
        if (runMaxOutputTokensRecoveryCount <= 3) {
          const retryCount = runMaxOutputTokensRecoveryCount;
          addNotice(`Model output limit reached on round ${round}. Recovery attempt ${retryCount}/3 with stricter brevity.`);

          if (retryCount >= 2) {
            const tightened = microcompactToolResultMessages(messages, {
              keepRecent: 4,
              clearOnly: true,
              clearedNotice: '[Older tool result content cleared after output-limit recovery]'
            });
            if (tightened.clearedCount > 0) {
              messages = tightened.messages;
              addNotice(`Recovery compacted ${tightened.clearedCount} older tool result(s), saved ~${tightened.savedChars} chars.`);
            }
          }

          messages.push({
            role: 'user',
            content: 'Previous reply exceeded output token limits. Continue with a concise response under 220 words: either call the required tool(s) with complete args or provide a final answer grounded in current evidence.'
          });
          updateCtxBar();
          continue;
        }
      }

      if (isLocalModeActive() && /timeout/i.test(String(e?.message || '')) && round < MAX_ROUNDS) {
        runLocalTimeoutStreak += 1;
        if (runLocalTimeoutStreak <= 1) {
          addNotice(`Local model timed out on round ${round}. Retrying once with concise continuation guidance.`);
          messages.push({
            role: 'user',
            content: 'Previous attempt timed out. Continue from the current context with a concise response: either call the required tool(s) with complete args or provide the final answer.'
          });
          updateCtxBar();
          continue;
        }
      }
      addMessage('error', `LLM error: ${e.message}`, round);
      setStatus('error', 'api error');
      return;
    }

    hideThinking();

    // Parse for tool call(s)
    let toolCalls = resolveToolCallsFromModelReply(reply, rawReply);
    throwIfStopRequested();

    if (!toolCalls.length) {
      const cleanReply = reply.replace(getToolRegex(), '').trim();
      if (shouldAttemptToolCallRepair({
        rawReply,
        cleanReply,
        thinkingBlocks: parsedReply?.thinkingBlocks
      })) {
        try {
          const repaired = await attemptToolCallRepair({ userMessage, rawReply: rawReply || reply, messages });
          throwIfStopRequested();
          if (repaired?.rawReply) {
            rawReply = repaired.rawReply;
            parsedReply = repaired.parsedReply;
            reply = repaired.reply;
            toolCalls = repaired.toolCalls;

            if (toolCalls.length) {
              addNotice(`Repair pass normalized malformed output into valid tool call(s): ${toolCalls.map(call => call.tool).join(', ')}.`);
            } else if (String(reply || '').trim()) {
              addNotice('Repair pass normalized malformed output into a contract-compliant reply.');
            }
          }
        } catch (error) {
          if (error?.code === 'RUN_STOPPED' || error?.name === 'AbortError') throw error;
          addNotice(`Repair pass failed: ${error?.message || 'unknown error'}`);
        }
      }
    }

    if (!toolCalls.length) {
      const cleanReply = reply.replace(getToolRegex(), '').trim();

      if (!cleanReply) {
        consecutiveNonActionRounds++;
        if (consecutiveNonActionRounds >= MAX_CONSECUTIVE_NON_ACTION_ROUNDS) {
          addMessage('error', `Model returned empty output ${consecutiveNonActionRounds} times in a row — stopping to avoid burning rounds. Try a different model or rephrase your prompt.`, round);
          syncSessionState();
          setStatus('ok', `stopped after ${round} round${round > 1 ? 's' : ''}`);
          updateCtxBar();
          return;
        }
        messages.push({ role: 'assistant', content: rawReply || reply });
        messages.push({
          role: 'user',
          content: 'No valid tool call or final answer was returned. Continue now: call one or more tools with complete args, or provide a complete final answer.'
        });
        addNotice('Model returned empty output. Requesting continuation.');
        updateCtxBar();
        continue;
      }

      if (looksLikeDeferredActionReply(cleanReply)) {
        consecutiveNonActionRounds++;
        if (consecutiveNonActionRounds >= MAX_CONSECUTIVE_NON_ACTION_ROUNDS) {
          addMessage('error', `Model narrated instead of acting ${consecutiveNonActionRounds} times in a row — stopping to avoid burning rounds. Try a different model or rephrase your prompt.`, round);
          syncSessionState();
          setStatus('ok', `stopped after ${round} round${round > 1 ? 's' : ''}`);
          updateCtxBar();
          return;
        }
        messages.push({ role: 'assistant', content: rawReply || cleanReply });
        messages.push({
          role: 'user',
          content: 'Your previous reply described a next action but did not execute it. Continue now without narration: call one or more tools with complete args, or provide the final answer if no tool is needed.'
        });
        addNotice('Model narrated a next step without making a tool call. Requesting direct continuation.');
        updateCtxBar();
        continue;
      }

      if (looksLikeToolExecutionClaimWithoutCall(cleanReply)) {
        consecutiveNonActionRounds++;
        if (consecutiveNonActionRounds >= MAX_CONSECUTIVE_NON_ACTION_ROUNDS) {
          addMessage('error', `Model claimed tool execution without a tool call ${consecutiveNonActionRounds} times in a row — stopping to avoid burning rounds. Try a different model or rephrase your prompt.`, round);
          syncSessionState();
          setStatus('ok', `stopped after ${round} round${round > 1 ? 's' : ''}`);
          updateCtxBar();
          return;
        }
        messages.push({ role: 'assistant', content: rawReply || cleanReply });
        messages.push({
          role: 'user',
          content: 'Your previous reply claimed a tool call already ran, but no valid <tool_call> block was present. Continue now with exactly one of these: (1) emit one or more valid tool calls with complete args, or (2) provide the complete final answer. Do not ask to wait for tool output.'
        });
        addNotice('Model claimed tool execution without emitting a tool call. Requesting strict continuation.');
        updateCtxBar();
        continue;
      }

      let finalMarkdown = cleanReply;
      throwIfStopRequested();

      addMessage('agent', finalMarkdown, round, false, false, parsedReply.thinkingBlocks);
      messages.push({ role: 'assistant', content: finalMarkdown });
      const memoryDelta = maybeExtractLongTermMemory(userMessage, finalMarkdown);
      if (memoryDelta?.saved) {
        addNotice(`Memory manager: stored ${memoryDelta.saved} durable memory item(s).`);
      }
      // Async post-turn work: extract session-level memories via hook if available.
      void Promise.resolve().then(() => {
        try {
          window.AgentMemory?.onTurnComplete?.({ userMessage, assistantMessage: finalMarkdown, messages });
        } catch { /* fire-and-forget */ }
      });
      // Clear steering status after turn completes
      const statusEl = document.getElementById('steering-status');
      if (statusEl) statusEl.textContent = '';
      syncSessionState();
      setStatus('ok', `done in ${round} round${round>1?'s':''}`);
      notifyIfHidden(finalMarkdown);
      updateCtxBar();
      return;
    }

    const validToolCalls = [];
    const blockedToolReasons = [];

    for (const candidateCall of toolCalls) {
      const normalizedCandidate = completeToolCallArgs(candidateCall, { messages, userMessage });
      if (!normalizedCandidate) continue;

      const repeatState = recordRepeatedToolCall(normalizedCandidate);
      if (repeatState.repeated) {
        blockedToolReasons.push(`repeated loop detected for ${repeatState.signature}`);
        addNotice(`Blocked repeated tool-call loop: ${repeatState.signature}`);
        continue;
      }

      validToolCalls.push(normalizedCandidate);
    }

    if (!validToolCalls.length) {
      messages.push({ role: 'assistant', content: rawReply || reply });
      messages.push({
        role: 'user',
        content: `All proposed tool calls were blocked or invalid (${blockedToolReasons.join('; ') || 'no valid call'}). Do not repeat them. Choose different valid tools with complete args or provide a final answer.`
      });
      updateCtxBar();
      continue;
    }

    // Tool call(s) detected — reset non-action streak
    consecutiveNonActionRounds = 0;
    const toolContent = String(reply || '').replace(/<tool_call>\s*[\s\S]*?<\/tool_call>/gi, '').trim();
    if (toolContent) {
      addMessage('agent', toolContent, round, false, false, []);
    }

    messages.push({ role: 'assistant', content: rawReply || reply });

    for (const toolCall of validToolCalls) {
      sessionStats.tools++;
      updateStats();
      addMessage('tool', `? ${toolCall.tool}(${JSON.stringify(toolCall.args)})`, round, true);
    }

    const batches = partitionToolCallBatches(validToolCalls);
    const roundToolSummaryChunks = [];
    const roundPromptInjectionNotes = [];
    let roundSawPermissionDenied = false;

    for (const batch of batches) {
      throwIfStopRequested();

      let batchResults = [];
      if (batch.concurrencySafe && batch.calls.length > 1) {
        showThinking(`executing ${batch.calls.length} read-only tools…`);
        if (delay > 0) await sleep(Math.min(250, delay));
        batchResults = await Promise.all(batch.calls.map(async call => {
          try {
            const result = await executeTool(call);
            return { call, result };
          } catch (error) {
            return { call, result: `ERROR executing ${call.tool}: ${error?.message || 'unknown failure'}` };
          }
        }));
        hideThinking();
      } else {
        for (const call of batch.calls) {
          showThinking(`executing ${call.tool}…`);
          if (delay > 0) await sleep(delay * 0.5);
          let result;
          try {
            result = await executeTool(call);
          } catch (error) {
            result = `ERROR executing ${call.tool}: ${error?.message || 'unknown failure'}`;
          }
          hideThinking();
          batchResults.push({ call, result });
        }
      }

      let sawPermissionDenied = false;
      for (const { call: toolCall, result } of batchResults) {
        throwIfStopRequested();
        addMessage('tool', `? ${result}`, round, false, true);

        if (!/^ERROR\b/i.test(String(result || ''))) {
          runSuccessfulToolCount += 1;
        }

        if (toolCall.tool === 'fs_list_dir' && !/^ERROR\b/i.test(String(result || ''))) {
          runFsRootExplored = true;
        }

        const failureState = recordToolFailure(toolCall, result);
        if (isPermissionDeniedResult(result)) {
          sawPermissionDenied = true;
          addNotice(`Permission guard blocked ${toolCall.tool}. The loop will pivot to a different approach.`);
        }

        const promptInjectionSignals = extractPromptInjectionSignals(toolCall, result);
        if (promptInjectionSignals.length) {
          registerPromptInjectionSignals(promptInjectionSignals);
          for (const signal of promptInjectionSignals) {
            if (!roundPromptInjectionNotes.includes(signal)) {
              roundPromptInjectionNotes.push(signal);
            }
          }
          addNotice(`Prompt injection guard flagged suspicious output from ${toolCall.tool}.`);
        }

        const contextSafeResult = applyToolResultContextBudget(toolCall, result);
        if (contextSafeResult !== String(result || '')) {
          const signature = getToolCallSignature(toolCall);
          if (!runCompactedResultNoticeSignatures.has(signature)) {
            runCompactedResultNoticeSignatures.add(signature);
            addNotice(`Context manager compacted a large ${toolCall.tool} result before storing it in history.`);
          }
        }

        const safeResult = sanitizeToolResult(contextSafeResult);
        messages.push({ role: 'user', content: `<tool_result tool="${toolCall.tool}">\n${safeResult}\n</tool_result>` });

        if (failureState.repeated) {
          messages.push({
            role: 'user',
            content: `Previous tool call failed repeatedly (${getToolCallSignature(toolCall)}). Do not repeat it. Choose a different tool or provide a final answer with available evidence.`
          });
          addNotice(`Repeated failure on ${getToolCallSignature(toolCall)}. Disabled this call pattern for this run.`);
        }
      }

      const toolSummary = buildToolUseSummary(batchResults);
      if (toolSummary) {
        messages.push({ role: 'assistant', content: toolSummary });
        roundToolSummaryChunks.push(toolSummary);
      }

      roundSawPermissionDenied = roundSawPermissionDenied || sawPermissionDenied;
    }

    const compactionNotes = await applyContextManagementPipeline({ round, userMessage, ctxLimit: CTX_LIMIT });

    const continuationPrompt = orchestrator.buildRuntimeContinuationPrompt({
      toolSummary: roundToolSummaryChunks.join('\n\n'),
      permissionDenials: roundSawPermissionDenied ? runPermissionDenials.slice(-3) : [],
      compactionNotes,
      promptInjectionNotes: roundPromptInjectionNotes
    });

    if (continuationPrompt) {
      messages.push({ role: 'user', content: continuationPrompt });
    }

    syncSessionState();
    updateCtxBar();
  }

  // Exhausted rounds — force final answer
  addNotice('max_rounds (' + MAX_ROUNDS + ') reached. Forcing final answer.');
  const noEvidenceWarning = runSuccessfulToolCount === 0
    ? 'No successful tool evidence was gathered in this run. Do not fabricate facts; clearly state uncertainty and what could not be verified.'
    : 'Use only the verified tool evidence already gathered in this run.';
  const denialWarning = runPermissionDenials.length
    ? `Permission denials occurred for some attempted actions (${runPermissionDenials.slice(-2).map(item => item.tool).join(', ')}). Respect those constraints in the final answer.`
    : '';
  messages.push({
    role: 'user',
    content: `Answer now with what you know so far. Return the final answer in Markdown only. ${noEvidenceWarning} ${denialWarning}`.trim()
  });
  showThinking('forcing final answer…');
  try {
    throwIfStopRequested();
    const finalReply = await callLLM(messages, getTurnLlmCallOptions());
    throwIfStopRequested();
    const parsedFinalReply = splitModelReply(finalReply);
    const finalMarkdown = parsedFinalReply.visible.replace(getToolRegex(), '').trim();
    throwIfStopRequested();

    hideThinking();
    addMessage('agent', finalMarkdown, MAX_ROUNDS, false, false, parsedFinalReply.thinkingBlocks);
    messages.push({ role: 'assistant', content: finalReply });
    const memoryDelta = maybeExtractLongTermMemory(userMessage, finalMarkdown);
    if (memoryDelta?.saved) {
      addNotice(`Memory manager: stored ${memoryDelta.saved} durable memory item(s).`);
    }
    void Promise.resolve().then(() => {
      try {
        window.AgentMemory?.onTurnComplete?.({ userMessage, assistantMessage: finalMarkdown, messages });
      } catch { /* fire-and-forget */ }
    });
    syncSessionState();
    setStatus('ok', 'response limit reached');
    notifyIfHidden(finalMarkdown || 'Response ready. Check the latest result.');
  } catch (e) {
    hideThinking();
    if (e?.code === 'RUN_STOPPED' || e?.name === 'AbortError') {
      setStatus('ok', 'stopped');
      updateCtxBar();
      return;
    }
    addMessage('error', `Final answer failed: ${e.message}`, MAX_ROUNDS);
    setStatus('error', 'final answer failed');
  }
  updateCtxBar();
}

// -- UI HELPERS ----------------------------------------------------------------
let thinkingEl = null;

function showThinking(label) {
  hideThinking();
  const el = document.createElement('div');
  el.className = 'thinking';
  el.id = 'thinking';
  el.innerHTML = `
    <div class="thinking-dots">
      <div class="dot"></div><div class="dot"></div><div class="dot"></div>
    </div>
    <span class="thinking-label">${escHtml(String(label || ''))}</span>`;
  const container = document.getElementById('messages') || document.getElementById('chat');
  container.appendChild(el);
  scrollBottom();
}

function hideThinking() {
  const el = document.getElementById('thinking');
  if (el) el.remove();
}

function addMessage(role, content, round, isCall=false, isResult=false, hiddenThinking=[]) {
  document.getElementById('empty')?.remove();

  const wrap = document.createElement('div');

  if (role === 'user') {
    wrap.className = 'msg user';
    const bubble = document.createElement('div');
    bubble.className = 'msg-content';
    bubble.textContent = String(content || '');
    wrap.appendChild(bubble);
  } else if (role === 'agent') {
    wrap.className = 'msg assistant';
    const bubble = document.createElement('div');
    bubble.className = 'msg-content html-body';
    bubble.innerHTML = renderAgentHtml(content);
    wrap.appendChild(bubble);
    if (hiddenThinking.length) {
      const details = document.createElement('details');
      details.className = 'thinking-details';
      const summary = document.createElement('summary');
      summary.textContent = `Thinking (${hiddenThinking.length})`;
      details.appendChild(summary);
      const pre = document.createElement('pre');
      pre.className = 'thinking-pre';
      pre.textContent = hiddenThinking.join('\n\n---\n\n');
      details.appendChild(pre);
      wrap.appendChild(details);
    }
  } else {
    // tool, error, system — monospace pill style
    const cssRole = role === 'error' ? 'msg-error' : role === 'tool' ? 'msg-tool' : 'msg-system';
    wrap.className = `msg assistant ${cssRole}`;
    const bubble = document.createElement('div');
    bubble.className = 'msg-content msg-content-mono';
    const meta = [];
    if (round) meta.push(`R${round}`);
    if (isCall) meta.push('call');
    if (isResult) meta.push('result');
    if (meta.length) {
      const badge = document.createElement('span');
      badge.className = 'msg-meta-badge';
      badge.textContent = meta.join(' · ');
      bubble.appendChild(badge);
    }
    const text = document.createElement('span');
    text.textContent = String(content || '');
    bubble.appendChild(text);
    wrap.appendChild(bubble);
  }

  const container = document.getElementById('messages') || document.getElementById('chat');
  container.appendChild(wrap);
  scrollBottom();
}

function addNotice(text) {
  const el = document.createElement('div');
  el.className = 'ctx-notice';
  el.textContent = text;
  const container = document.getElementById('messages') || document.getElementById('chat');
  container.appendChild(el);
  scrollBottom();
}

function setStatus(state, label) {
  // topbar inline status
  const topbarStatus = document.getElementById('topbar-status');
  if (topbarStatus) topbarStatus.textContent = label;
  // topbar badge
  const badge = document.getElementById('badge-status');
  if (badge) badge.textContent = label;
  // legacy badge-status-dot (no-op if gone)
  const dot = document.getElementById('badge-status-dot');
  if (dot) dot.innerHTML = `<span class="status-dot ${state}"></span>&nbsp;${label}`;
}

function updateStats() {
  const rounds = document.getElementById('stat-rounds');
  if (rounds) rounds.textContent = sessionStats.rounds;
  const tools = document.getElementById('stat-tools');
  if (tools) tools.textContent = sessionStats.tools;
  const resets = document.getElementById('stat-resets');
  if (resets) resets.textContent = sessionStats.resets;
  const msgs = document.getElementById('stat-msgs');
  if (msgs) msgs.textContent = sessionStats.msgs;
}

function scrollBottom() {
  const chat = document.getElementById('chat');
  if (chat) chat.scrollTop = chat.scrollHeight;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let extensionChannelWarningShown = false;

function installUnhandledRejectionGuard() {
  if (window.__agentUnhandledRejectionGuardInstalled) return;
  window.__agentUnhandledRejectionGuardInstalled = true;

  window.addEventListener('unhandledrejection', event => {
    const message = String(event?.reason?.message || event?.reason || '');
    const isExtensionChannelClose = /A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received/i.test(message);
    if (!isExtensionChannelClose) return;

    event.preventDefault();
    if (extensionChannelWarningShown) return;
    extensionChannelWarningShown = true;
    addNotice('Ignored extension async response warning from browser message channel.');
  });
}

// -- SEND ----------------------------------------------------------------------
async function sendMessage() {
  if (isBusy) return;
  if (!runtimeReady()) {
    addMessage('error', 'Agent bootstrap failed: required modules were not loaded.', null);
    return;
  }
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;

  if (!isLocalModeActive()) {
    const cloudReadiness = typeof getCloudReadiness === 'function'
      ? getCloudReadiness()
      : { ready: canUseCloud(), reason: 'Cloud provider is not ready.' };
    if (!cloudReadiness.ready) {
      addMessage('error', cloudReadiness.reason || 'Cloud provider is not ready.', null);
      return;
    }
  } else if (typeof isOllamaReady === 'function') {
    const ollamaReadiness = isOllamaReady();
    if (!ollamaReadiness.ready) {
      addMessage('error', ollamaReadiness.reason, null);
      return;
    }
  }

  input.value = '';
  autoResize(input);
  isBusy = true;
  stopRequested = false;
  resetRunGuards();
  broadcastBusyState(true);
  const sendBtn = document.getElementById('btn-send');
  if (sendBtn) sendBtn.disabled = true;
  setStopButtonState(true);
  const inputStatus = document.getElementById('input-status');
  if (inputStatus) inputStatus.textContent = 'processing…';

  // Title the session from the first user message before addMessage modifies it.
  const curSession = getActiveSession() || createSession(text);
  if (!curSession.messages?.length) {
    curSession.title = makeSessionTitle(text);
  }
  addMessage('user', text, null);
  saveSessions();
  renderSessionList();

  try {
    await agentLoop(text);
  } catch (e) {
    hideThinking();
    if (e?.code === 'RUN_STOPPED' || e?.name === 'AbortError') {
      addNotice('Run stopped by user.');
      setStatus('ok', 'stopped');
    } else {
      addMessage('error', e.message, null);
      setStatus('error', 'error');
    }
    syncSessionState();
  } finally {
    isBusy = false;
    broadcastBusyState(false);
    if (sendBtn) sendBtn.disabled = false;
    setStopButtonState(false);
    if (inputStatus) inputStatus.textContent = `${sessionStats.msgs} message${sessionStats.msgs!==1?'s':''} sent`;
    input.focus();
  }
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function useExample(btn) {
  const input = document.getElementById('msg-input');
  input.value = btn.textContent;
  autoResize(input);
  input.focus();
}

function clearSession() {
  createSession();
  resetLiveSessionState();
  updateStats();
  updateCtxBar();
  renderChatFromMessages();
  renderSessionList();
  setStatus('ok', 'idle');
}

// -- INIT ----------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  installUnhandledRejectionGuard();
  applySidebarState();
  window.addEventListener('resize', handleResponsiveSidebar);

  // Restore persisted slider values before updateBadge() reads them.
  const sliderDefs = [
    { id: 'sl-rounds', valId: 'val-rounds', key: 'agent_sl_rounds' },
    { id: 'sl-ctx',    valId: 'val-ctx',    key: 'agent_sl_ctx'    },
    { id: 'sl-delay',  valId: 'val-delay',  key: 'agent_sl_delay'  }
  ];
  for (const def of sliderDefs) {
    try {
      const stored = localStorage.getItem(def.key);
      if (stored !== null) {
        const sl = document.getElementById(def.id);
        const vl = document.getElementById(def.valId);
        if (sl) sl.value = stored;
        if (vl) vl.textContent = stored;
      }
    } catch { /* private browsing / quota — ignore */ }
  }

  updateBadge();
  updateStats();
  updateCtxBar();

  if (!runtimeReady()) {
    setStatus('error', 'bootstrap failed');
    addNotice('ERROR: required modules did not load. Check the browser console and reload the page.');
    return;
  }

  chatSessions = loadSessions();
  initCacheSync();
  initBusySync();
  updateFileAccessStatus();
  loadGithubTokenStatus();
  if (typeof loadCloudModelSelection === 'function') {
    loadCloudModelSelection();
  }
  if (typeof loadOllamaBackendState === 'function') {
    loadOllamaBackendState();
  }
  if (!chatSessions.length) createSession();
  if (!getActiveSession()) activeSessionId = chatSessions[0]?.id || createSession().id;
  renderSessionList();
  if (typeof loadPersistedEnabledTools === 'function') loadPersistedEnabledTools();
  renderToolGroups();
  activateSession(activeSessionId);
  if (apiKey) {
    document.getElementById('api-key').value = apiKey;
    setStatus('ok', 'key set');
  }
  if (localBackend.url) {
    document.getElementById('local-url').value = localBackend.url;
    if (localBackend.model) {
      const sel = document.getElementById('local-model-select');
      sel.innerHTML = `<option value="${localBackend.model}">${localBackend.model}</option>`;
      sel.value = localBackend.model;
      document.getElementById('local-model-row').style.display = 'block';

      // Add change listener to update badge when model changes
      sel?.addEventListener('change', function() {
        const model = this.value;
        if (model) {
          localBackend.model = model;
          localStorage.setItem('agent_local_backend_model', model);
          // Update badge if visible
          updateModelBadgeForLocal(model);
          updateBadge();
        }
      });
    }
    if (localBackend.enabled) {
      _activateLocal(true);
    }
  }
  // Auto-probe local backends on load
  probeLocal().catch(error => {
    const message = String(error?.message || 'probe failed');
    console.warn('[Local Probe] startup probe failed:', message);
    addNotice(`Startup local probe failed: ${message}`);
  });
  window.addEventListener('beforeunload', flushSaveSessions);
  setStopButtonState(false);
});