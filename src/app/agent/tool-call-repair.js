// src/app/agent/tool-call-repair.js
// Malformed tool call detection and LLM-based repair.

/** @type {import('../../types/index.js').SessionMessage} */
var _SessionMessageRepair;

/** @type {Function} */
var extractPlannerOptimizedQueryFromMessages;
/** @type {Function} */
var looksLikeDeferredActionReply;
/** @type {Function} */
var looksLikeToolExecutionClaimWithoutCall;
/** @type {Function} */
var splitModelReply;

/**
 * Complete tool call arguments by recovering missing values from context.
 * @param {import('../../types/index.js').ToolCall} call - Tool call to complete
 * @param {Object} [opts]
 * @param {SessionMessage[]} [opts.messages=[]] - Recent messages for context
 * @param {string} [opts.userMessage=''] - Original user message
 * @returns {import('../../types/index.js').ToolCall|null} Completed call or null
 */
function completeToolCallArgs(call, { messages = [], userMessage = '' } = {}) {
  const TE = window.AgentToolExecution;
  const normalized = TE?.normalizeToolCallObject ? TE.normalizeToolCallObject(call) : null;
  if (!normalized) return null;

  if (normalized.tool === 'web_search' && !String(normalized.args?.query || '').trim()) {
    const recoveredQuery = extractPlannerOptimizedQueryFromMessages(messages) || String(userMessage || '').trim();
    if (recoveredQuery) {
      normalized.args = { ...normalized.args, query: recoveredQuery };
    }
  }

  // storage_set with empty key — recover from recent messages, or drop if fully empty
  if (normalized.tool === 'storage_set' && !String(normalized.args?.key || '').trim()) {
    const hasValue = String(normalized.args?.value ?? '').trim();
    if (!hasValue) {
      // Completely empty call (no key, no value) — drop to prevent repair loop.
      // The model will see no tool result and should self-correct next round.
      return null;
    }
    const recoveredKey = recoverStorageKeyFromMessages(messages);
    if (recoveredKey) {
      normalized.args = { ...normalized.args, key: recoveredKey };
    }
  }

  // fs_download_file with no content or path — recover base64 from recent runtime_generateFile
  if (normalized.tool === 'fs_download_file'
      && !String(normalized.args?.content || '').trim()
      && !String(normalized.args?.path || '').trim()) {
    const recovered = recoverDownloadContentFromMessages(messages);
    if (recovered.content) normalized.args = { ...normalized.args, content: recovered.content };
    if (recovered.filename) normalized.args = { ...normalized.args, filename: recovered.filename };
  }

  return normalized;
}

/**
 * Scan recent messages for a previously-used storage_set key.
 * Looks for: storage_set(key="..."), storage_set({"key":"..."}), or runtime_generateFile storageKey references.
 */
function recoverStorageKeyFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  // Walk backwards through messages looking for a storage_set key
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content = String(msg?.content || '');
    // Match storage_set result: "Saved some_key (N chars)"
    let m = content.match(/^## storage_set\b[^]*?\n\nSaved (\S+)\s/);
    if (m) return m[1];
    // Match storage_set(key="...") in tool_call blocks
    m = content.match(/storage_set\s*\(\s*\{[^}]*"key"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
    // Match runtime_generateFile storageKey reference
    m = content.match(/"storageKey"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return '';
}

/**
 * Scan recent messages for base64 content from runtime_generateFile output.
 * Returns { content, filename } if found.
 */
function recoverDownloadContentFromMessages(messages) {
  if (!Array.isArray(messages)) return {};
  // Walk backwards through messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content = String(msg?.content || '');
    // Match runtime_generateFile base64 output: "base64:AAAA..."
    let m = content.match(/base64:([A-Za-z0-9+/=]{40,})/);
    if (m) {
      // Try to find a filename from nearby context
      let filename = '';
      const fnMatch = content.match(/([^/\s"'\\]+\.[a-z]{3,5})/i);
      if (fnMatch) filename = fnMatch[1];
      return { content: m[1], filename };
    }
    // Match fs_download_file result for filename hint
    m = content.match(/Triggered browser download for (\S+)/);
    if (m && !content.includes('ERROR')) {
      return { content: '', filename: m[1] };
    }
  }
  return {};
}

/**
 * Check if a tool call repair should be attempted.
 * @param {Object} [opts]
 * @param {string} [opts.rawReply=''] - Raw model reply
 * @param {string} [opts.cleanReply=''] - Cleaned reply
 * @param {string[]} [opts.thinkingBlocks=[]] - Thinking blocks
 * @returns {boolean} True if repair should be attempted
 */
function shouldAttemptToolCallRepair({ rawReply = '', cleanReply = '', thinkingBlocks = [] } = {}) {
  const raw = String(rawReply || '').trim();
  const visible = String(cleanReply || '').trim();
  if (!raw) return false;

  const { regex, orchestrator } = getRuntimeModules();

  if (regex?.hasUnprocessedToolCall?.(raw)) return true;
  if (/\u003c\|tool_call\u003e|\u003ctool_call\b/i.test(raw) || /"tool"\s*:/i.test(raw)) return true;
  if (!visible && Array.isArray(thinkingBlocks) && thinkingBlocks.some(block => String(block || '').trim())) return true;
  if (looksLikeDeferredActionReply(visible)) return true;
  if (looksLikeToolExecutionClaimWithoutCall(visible)) return true;
  if (orchestrator?.hasReasoningLeak?.(visible)) return true;

  return false;
}

/**
 * Attempt to repair malformed tool calls via a repair LLM call.
 * @param {Object} [opts]
 * @param {string} [opts.userMessage=''] - User message
 * @param {string} [opts.rawReply=''] - Raw model reply
 * @param {SessionMessage[]} [opts.messages=[]] - Message history
 * @returns {Promise<{rawReply: string, parsedReply: any, reply: string, toolCalls: any[]}|null>} Repaired result
 */
async function attemptToolCallRepair({ userMessage = '', rawReply = '', messages = [] } = {}) {
  const TE = window.AgentToolExecution;
  const assistantReply = String(rawReply || '').trim();
  if (!assistantReply) return null;

  const hashText = TE?.stableHashText || (v => v);
  const repairSignature = hashText(`${userMessage}\n${assistantReply}`);
  if (TE?.runToolCallRepairAttempts?.has(repairSignature)) return null;
  TE?.runToolCallRepairAttempts?.add(repairSignature);

  const enabledToolNames = Object.entries(window.enabledTools || {}).filter(([, enabled]) => !!enabled).map(([name]) => name);
  const systemMessage = Array.isArray(messages) ? messages.find(message => message?.role === 'system') : null;
  const recentMessages = Array.isArray(messages) ? messages.filter(message => message?.role !== 'system').slice(-12) : [];

  const { orchestrator } = getRuntimeModules();
  const repairPrompt = await orchestrator.buildRepairPrompt({
    userMessage,
    previousReply: assistantReply,
    enabledTools: enabledToolNames
  });

  const cfg = window.CONSTANTS || {};
  const repairedRawReply = await callLLM([
    ...(systemMessage ? [systemMessage] : []),
    ...recentMessages,
    { role: 'assistant', content: assistantReply },
    { role: 'user', content: repairPrompt }
  ], {
    maxTokens: cfg.TOOL_CALL_REPAIR_MAX_TOKENS || 450,
    temperature: cfg.TOOL_CALL_REPAIR_TEMPERATURE || 0.1,
    timeoutMs: isLocalModeActive()
      ? (cfg.TOOL_CALL_REPAIR_TIMEOUT_MS_LOCAL || 70000)
      : (cfg.TOOL_CALL_REPAIR_TIMEOUT_MS_CLOUD || 22000),
    retries: isLocalModeActive()
      ? (cfg.TOOL_CALL_REPAIR_RETRIES_LOCAL || 0)
      : (cfg.TOOL_CALL_REPAIR_RETRIES_CLOUD || 1)
  });
  const repairedParsedReply = splitModelReply(repairedRawReply);
  const TE2 = window.AgentToolExecution;
  const repairedToolCalls = TE2?.dedupeToolCalls ? TE2.dedupeToolCalls(TE2.resolveToolCallsFromModelReply(repairedParsedReply.visible, repairedRawReply)) : [];

  return {
    rawReply: repairedRawReply,
    parsedReply: repairedParsedReply,
    reply: repairedParsedReply.visible,
    toolCalls: repairedToolCalls
  };
}

window.AgentToolCallRepair = { completeToolCallArgs, shouldAttemptToolCallRepair, attemptToolCallRepair };
