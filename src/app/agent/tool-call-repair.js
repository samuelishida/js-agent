// src/app/agent/tool-call-repair.js
// Malformed tool call detection and LLM-based repair.

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

  return normalized;
}

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
