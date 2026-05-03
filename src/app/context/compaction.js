// ── Compaction compatibility layer ───────────────────────────────────────────
// Keeps the extracted compaction boundary while publishing a browser-friendly
// window API for the current plain-script runtime.
;(function() {
  /** @type {Function} */
  const C = () => window.CONSTANTS || {};

  /** @type {number} */
  let runMaxOutputTokensRecoveryCount = 0;
  /** @type {Set<string>} */
  let runCompactedResultNoticeSignatures = new Set();
  /** @type {Map<string, number>} */
  let repeatedToolCallCounts = new Map();
  /** @type {Map<string, number>} */
  let toolFailureCounts = new Map();
  /** @type {string[]} */
  let promptInjectionSignals = [];
  /** @type {number} */
  let lastCompactionRound = 0;
  /** @type {number} */
  let lastPreLlmCompactionRound = 0;
  /** @type {number} */
  let timeBasedMicrocompactArmedAt = 0;

  /** @type {number} */
  const CHAR_TOKEN_RATIO = 3.5;

  /**
   * Estimate token count from text.
   * @param {string|string[]} text - Text to estimate
   * @returns {number} Estimated tokens
   */
  function estimateTokens(text) {
    if (Array.isArray(text)) {
      return text.reduce((sum, part) => sum + estimateTokens(part?.text || part), 0);
    }
    if (typeof text !== 'string' || !text) return 0;
    const wsTokens = text.split(/\s+/).filter(Boolean).length;
    const punctTokens = (text.match(/[^\w\s]/g) || []).length;
    const lineBreaks = (text.match(/\n/g) || []).length;
    return Math.ceil(wsTokens * 1.3 + punctTokens * 0.5 + lineBreaks * 0.3);
  }

  /**
   * Calculate context size in characters.
   * @param {import('../../types/index.js').SessionMessage[]} [messages=[]] - Messages
   * @returns {number} Character count
   */
  function ctxSize(messages = []) {
    return (Array.isArray(messages) ? messages : [])
      .reduce((total, message) => total + String(message?.content || '').length, 0);
  }

  /**
   * Estimate token count for a message array.
   * @param {import('../../types/index.js').SessionMessage[]} [messages=[]] - Messages
   * @returns {number} Estimated tokens
   */
  function ctxTokenEstimate(messages = []) {
    return (Array.isArray(messages) ? messages : [])
      .reduce((total, message) => total + estimateTokens(message?.content), 0);
  }

  /**
   * Reset compaction state for a new run.
   * @returns {void}
   */
  function resetCompactionState() {
    runMaxOutputTokensRecoveryCount = 0;
    runCompactedResultNoticeSignatures = new Set();
    repeatedToolCallCounts = new Map();
    toolFailureCounts = new Map();
    lastCompactionRound = 0;
    lastPreLlmCompactionRound = 0;
    timeBasedMicrocompactArmedAt = 0;
  }

  /**
   * Reset prompt injection state.
   * @returns {void}
   */
  function resetPromptInjectionState() {
    promptInjectionSignals = [];
  }

  /**
   * Get a deterministic signature for a tool call.
   * @param {import('../../types/index.js').ToolCall} call - Tool call
   * @returns {string} Signature string
   */
  function getCallSignature(call) {
    const TE = window.AgentToolExecution;
    if (TE?.getToolCallSignature) return TE.getToolCallSignature(call);
    const args = call?.args || {};
    const sortedKeys = Object.keys(args).sort();
    const stableArgs = '{' + sortedKeys.map(k => `${JSON.stringify(k)}:${JSON.stringify(args[k])}`).join(',') + '}';
    return `${String(call?.tool || 'unknown')}:${stableArgs}`;
  }

  /**
   * Record a repeated tool call.
   * @param {import('../../types/index.js').ToolCall} call - Tool call
   * @returns {{signature: string, count: number, repeated: boolean}} Repeat state
   */
  function recordRepeatedToolCall(call) {
    const signature = getCallSignature(call);
    const nextCount = Number(repeatedToolCallCounts.get(signature) || 0) + 1;
    repeatedToolCallCounts.set(signature, nextCount);
    return {
      signature,
      count: nextCount,
      repeated: nextCount >= 3
    };
  }

  /**
   * Record a tool failure.
   * @param {import('../../types/index.js').ToolCall} call - Tool call
   * @param {string} result - Tool result
   * @returns {{signature: string, count: number, repeated: boolean}} Failure state
   */
  function recordToolFailure(call, result) {
    const signature = getCallSignature(call);
    if (/^ERROR\b/i.test(String(result || ''))) {
      const nextCount = Number(toolFailureCounts.get(signature) || 0) + 1;
      toolFailureCounts.set(signature, nextCount);
      return {
        signature,
        count: nextCount,
        repeated: nextCount >= 2
      };
    }

    toolFailureCounts.delete(signature);
    return {
      signature,
      count: 0,
      repeated: false
    };
  }

  /**
   * Extract prompt injection signals from a tool result.
   * @param {import('../../types/index.js').ToolCall} toolCall - Tool call
   * @param {string} result - Tool result
   * @returns {string[]} Detected signals
   */
  function extractPromptInjectionSignals(toolCall, result) {
    const signals = [];
    const text = String(result || '');
    const patterns = C().INJECTION_PATTERNS || {};
    const controlPattern = patterns.CONTROL_CHANNEL_TAG_REGEX || /<tool_call\s*>|<system-reminder\s*>|\[SYSTEM\s+OVERRIDE\]/i;

    if (controlPattern.test(text)) {
      signals.push(`Prompt injection guard: ${String(toolCall?.tool || 'tool')} returned control-channel content.`);
    }

    // Detect natural-language prompt-injection attempts in tool results
    const nlPatterns = C().INJECTION_PATTERNS?.NL_INJECTION_PATTERNS || [];
    for (const re of nlPatterns) {
      if (re.test(text)) {
        signals.push(`Prompt injection guard: ${String(toolCall?.tool || 'tool')} returned possible natural-language injection attempt.`);
        break; // one signal per tool result is enough
      }
    }

    return signals;
  }

  /**
   * Register prompt injection signals.
   * @param {string[]} [signals=[]] - Signals to register
   * @returns {string[]} Registered signals
   */
  function registerPromptInjectionSignals(signals = []) {
    for (const signal of Array.isArray(signals) ? signals : []) {
      const text = String(signal || '').trim();
      if (text) promptInjectionSignals.push(text);
    }
    const limit = Number(C().PROMPT_INJECTION_SIGNAL_LIMIT || 40);
    if (promptInjectionSignals.length > limit) {
      promptInjectionSignals = promptInjectionSignals.slice(-limit);
    }
    return promptInjectionSignals.slice();
  }

  /**
   * Sanitize a tool result by stripping injection tags.
   * @param {string} result - Raw result
   * @returns {string} Sanitized result
   */
  function sanitizeToolResult(result) {
    const text = String(result || '');
    const patterns = C().INJECTION_PATTERNS || {};
    return text
      .replace(patterns.INJECTION_TAG_STRIP_REGEX || /<tool_call>[\s\S]*?<\/tool_call>/gi, '')
      .replace(patterns.REMINDER_TAG_STRIP_REGEX || /<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
      .replace(patterns.DENIAL_TAG_STRIP_REGEX || /<permission_denials[^>]*>[\s\S]*?<\/permission_denials>/gi, '')
      .trim();
  }

  /**
   * Apply context budget to a tool result.
   * @param {import('../../types/index.js').ToolCall} toolCall - Tool call
   * @param {string} result - Tool result
   * @returns {string} Compacted result
   */
  function applyToolResultContextBudget(toolCall, result) {
    const text = sanitizeToolResult(result);
    const budget = C().TOOL_RESULT_CONTEXT_BUDGET || {};
    const inlineMaxChars = Number(budget.inlineMaxChars || 20000);
    const previewChars = Number(budget.previewChars || 5000);

    if (text.length <= inlineMaxChars) return text;

    // For search tools, be more conservative with compaction
    const toolName = String(toolCall?.tool || '').toLowerCase();
    const isSearchTool = /search|query|lookup|retrieve|web_fetch|read_page/.test(toolName);
    
    // Search tools get more characters preserved; other tools get standard treatment
    const effectivePreview = isSearchTool ? Math.min(previewChars * 1.5, inlineMaxChars * 0.75) : previewChars;

    const maxHeadTail = Math.floor(text.length / 2);
    const headLen = Math.min(effectivePreview, maxHeadTail);
    const tailLen = Math.min(effectivePreview, text.length - headLen);
    const head = text.slice(0, headLen);
    const tail = text.slice(-tailLen);
    const omitted = text.length - (head.length + tail.length);
    if (omitted <= 0) return text;
    return `${head}\n\n[${String(toolCall?.tool || 'tool')} result compacted; omitted ${omitted} chars]\n\n${tail}`;
  }

  /**
   * Microcompact tool result messages to preserve context.
   * @param {import('../../types/index.js').SessionMessage[]} [messages=[]] - Messages
   * @param {Object} [options] - Options
   * @param {number} [options.keepRecent] - Number of recent results to keep
   * @param {boolean} [options.clearOnly] - Only clear, don't compact
   * @param {string} [options.clearedNotice] - Notice text
   * @returns {{messages: import('../../types/index.js').SessionMessage[], clearedCount: number, savedChars: number}} Compaction result
   */
  function microcompactToolResultMessages(messages = [], options = {}) {
    const keepRecent = Math.max(0, Number(options.keepRecent || 0));
    const clearOnly = !!options.clearOnly;
    const clearedNotice = String(
      options.clearedNotice ||
      '[Older tool result content compacted to preserve context]'
    );
    const source = Array.isArray(messages) ? messages : [];
    const indices = [];

    source.forEach((message, index) => {
      const isToolResult = (message?.role === 'user' && /<tool_result\b/i.test(String(message.content || '')))
        || message?.role === 'tool';
      if (isToolResult) {
        indices.push(index);
      }
    });

    if (indices.length <= keepRecent) {
      return {
        messages: source,
        clearedCount: 0,
        savedChars: 0
      };
    }

    let clearedCount = 0;
    let savedChars = 0;
    const keepStart = indices.length - keepRecent;
    const nextMessages = source.map((message, index) => {
      const toolResultPosition = indices.indexOf(index);
      if (toolResultPosition === -1 || toolResultPosition >= keepStart) return message;

      const original = String(message?.content || '');
      const replacement = clearOnly
        ? (message.role === 'tool' ? clearedNotice : `<tool_result tool="compacted">\n${clearedNotice}\n</tool_result>`)
        : clearedNotice;
      if (original === replacement) return message;

      clearedCount += 1;
      savedChars += Math.max(0, original.length - replacement.length);
      return { ...message, content: replacement };
    });

    return { messages: nextMessages, clearedCount, savedChars };
  }

  /**
   * Build a summary of tool use from batch results.
   * @param {import('../../types/index.js').BatchResult[]} [batchResults=[]] - Batch results
   * @returns {string} Summary text
   */
  function buildToolUseSummary(batchResults = []) {
    const lines = (Array.isArray(batchResults) ? batchResults : []).map(({ call, result }) => {
      const tool = String(call?.tool || 'tool');
      const outcome = /^ERROR\b/i.test(String(result || '')) ? 'error' : 'ok';
      return `- ${tool}: ${outcome}`;
    });
    if (!lines.length) return '';
    return `Tool summary:\n${lines.join('\n')}`;
  }

  /**
   * Arm time-based microcompact for the current turn.
   * Called at the start of each agent loop. If enough time has passed
   * since the last arm, schedules a microcompact after a delay.
   * @returns {number|null} Armed timestamp or null
   */
  function armTimeBasedMicrocompactForTurn() {
    const policy = C().TIME_BASED_MICROCOMPACT_POLICY || {};
    const inactivityMs = Number(policy.inactivityMs || 20 * 60 * 1000);
    const now = Date.now();

    // If already armed recently, skip
    if (timeBasedMicrocompactArmedAt && (now - timeBasedMicrocompactArmedAt) < inactivityMs) {
      return timeBasedMicrocompactArmedAt;
    }

    timeBasedMicrocompactArmedAt = now;

    // Schedule a microcompact after the inactivity window
    setTimeout(() => {
      const messages = Array.isArray(window.messages) ? window.messages : [];
      const compacted = microcompactToolResultMessages(messages, {
        keepRecent: Number(policy.keepRecentResults || 4),
        clearOnly: true
      });
      if (compacted.clearedCount > 0) {
        window.messages = compacted.messages;
        if (window.sessionStats && typeof window.sessionStats === 'object') {
          window.sessionStats.resets = Number(window.sessionStats.resets || 0) + 1;
        }
        if (typeof addNotice === 'function') {
          addNotice(`Time-based microcompact: cleared ${compacted.clearedCount} older tool result(s), saved ~${compacted.savedChars} chars.`);
        }
      }
    }, inactivityMs);

    return timeBasedMicrocompactArmedAt;
  }

  /**
   * Compact non-tool messages (assistant/user) by summarizing older ones.
   * Keeps system prompt + recent N messages intact.
   * @param {import('../../types/index.js').SessionMessage[]} messages - Messages
   * @param {number} keepRecent - Number of recent messages to keep
   * @returns {{messages: import('../../types/index.js').SessionMessage[], compactedCount: number, savedChars: number}}
   */
  function compactNonToolMessages(messages, keepRecent) {
    const source = Array.isArray(messages) ? messages : [];
    const keepCount = Math.max(2, Number(keepRecent || 6));

    // Find non-tool, non-system messages
    const compactable = [];
    source.forEach((msg, idx) => {
      if (msg.role === 'system') return;
      if (msg.role === 'tool') return;
      if (/<tool_result\b/i.test(String(msg.content || ''))) return;
      compactable.push({ idx, msg });
    });

    if (compactable.length <= keepCount) {
      return { messages: source, compactedCount: 0, savedChars: 0 };
    }

    const keepStart = compactable.length - keepCount;
    let compactedCount = 0;
    let savedChars = 0;

    const nextMessages = source.map((msg, idx) => {
      const pos = compactable.findIndex(c => c.idx === idx);
      if (pos === -1 || pos >= keepStart) return msg;

      const original = String(msg.content || '');
      // Truncate to first 200 chars + summary marker
      const truncated = original.slice(0, 200).replace(/\n/g, ' ').trim();
      const replacement = `[compacted ${msg.role} message] ${truncated}…`;
      if (original.length <= replacement.length) return msg;

      compactedCount++;
      savedChars += Math.max(0, original.length - replacement.length);
      return { ...msg, content: replacement };
    });

    return { messages: nextMessages, compactedCount, savedChars };
  }

  /**
   * Apply the full context management pipeline.
   * Uses multi-tier thresholds:
   *   - SOFT (82%): compact older tool results only
   *   - HARD (92%): compact older tool results + non-tool messages
   *   - CRITICAL (97%): aggressive compaction of everything
   * Respects minRoundGap to avoid compacting every round.
   *
   * @param {Object} [opts]
   * @param {number} [opts.round] - Current round number
   * @param {number} [opts.ctxLimit] - Context limit in chars
   * @param {boolean} [opts.preLlm] - Whether this is a pre-LLM check
   * @returns {string[]} Compaction notes
   */
  function applyContextManagementPipeline({ round, ctxLimit, preLlm } = {}) {
    const messages = Array.isArray(window.messages) ? window.messages : [];
    const limit = Number(ctxLimit || C().DEFAULT_CTX_LIMIT_CHARS || 128000);
    const tokenLimit = Math.floor(limit / CHAR_TOKEN_RATIO);
    const policy = C().CONTEXT_COMPACTION_POLICY || {};

    const charSize = ctxSize(messages);
    const tokenEst = ctxTokenEstimate(messages);

    // Multi-tier thresholds
    const softRatio = Number(policy.thresholdRatio || 0.82);
    const hardRatio = Math.min(0.97, softRatio + 0.10);
    const criticalRatio = Math.min(0.99, softRatio + 0.15);

    const softCharThreshold = Math.floor(limit * softRatio);
    const hardCharThreshold = Math.floor(limit * hardRatio);
    const criticalCharThreshold = Math.floor(limit * criticalRatio);
    const softTokenThreshold = Math.floor(tokenLimit * softRatio);
    const hardTokenThreshold = Math.floor(tokenLimit * hardRatio);
    const criticalTokenThreshold = Math.floor(tokenLimit * criticalRatio);

    // Determine tier
    let tier = 'none';
    if (charSize >= criticalCharThreshold || tokenEst >= criticalTokenThreshold) {
      tier = 'critical';
    } else if (charSize >= hardCharThreshold || tokenEst >= hardTokenThreshold) {
      tier = 'hard';
    } else if (charSize >= softCharThreshold || tokenEst >= softTokenThreshold) {
      tier = 'soft';
    }

    if (tier === 'none') return [];

    // Respect minRoundGap for soft tier (but not for hard/critical or pre-LLM)
    const minGap = Number(policy.minRoundGap || 2);
    const currentRound = Number(round || 0);
    const targetLastRound = preLlm ? lastPreLlmCompactionRound : lastCompactionRound;

    if (tier === 'soft' && !preLlm && currentRound - targetLastRound < minGap) {
      return [];
    }

    const notes = [];
    let totalCleared = 0;
    let totalSaved = 0;

    // Always compact tool results first
    const toolKeepRecent = tier === 'critical'
      ? Math.max(2, Math.floor(Number(C().TOOL_RESULT_CONTEXT_BUDGET?.keepRecentResults || 8) / 3))
      : tier === 'hard'
        ? Math.max(3, Math.floor(Number(C().TOOL_RESULT_CONTEXT_BUDGET?.keepRecentResults || 8) / 2))
        : Number(C().TOOL_RESULT_CONTEXT_BUDGET?.keepRecentResults || 8);

    const toolCompacted = microcompactToolResultMessages(messages, {
      keepRecent: toolKeepRecent,
      clearOnly: true
    });

    let workingMessages = toolCompacted.messages;
    totalCleared += toolCompacted.clearedCount;
    totalSaved += toolCompacted.savedChars;

    if (toolCompacted.clearedCount) {
      notes.push(`Compacted ${toolCompacted.clearedCount} older tool result(s) (tier: ${tier}).`);
    }

    // For hard/critical tiers, also compact non-tool messages
    if (tier === 'hard' || tier === 'critical') {
      const nonToolKeep = tier === 'critical' ? 3 : 5;
      const nonToolCompacted = compactNonToolMessages(workingMessages, nonToolKeep);
      workingMessages = nonToolCompacted.messages;
      totalCleared += nonToolCompacted.compactedCount;
      totalSaved += nonToolCompacted.savedChars;

      if (nonToolCompacted.compactedCount) {
        notes.push(`Compacted ${nonToolCompacted.compactedCount} older conversation message(s) (tier: ${tier}).`);
      }
    }

    // For critical tier, also truncate remaining large tool results
    if (tier === 'critical') {
      const budget = C().TOOL_RESULT_CONTEXT_BUDGET || {};
      const criticalMaxChars = Math.floor(Number(budget.inlineMaxChars || 20000) / 4);
      let truncCount = 0;
      workingMessages = workingMessages.map(msg => {
        if (msg.role !== 'tool' && !/<tool_result\b/i.test(String(msg.content || ''))) return msg;
        const original = String(msg.content || '');
        if (original.length <= criticalMaxChars) return msg;
        truncCount++;
        return { ...msg, content: original.slice(0, criticalMaxChars) + `\n\n[truncated ${original.length - criticalMaxChars} chars — critical compaction]` };
      });
      if (truncCount) {
        notes.push(`Truncated ${truncCount} large tool result(s) to ${criticalMaxChars} chars (tier: critical).`);
      }
    }

    if (!totalCleared && tier !== 'critical') return [];

    window.messages = workingMessages;
    if (window.sessionStats && typeof window.sessionStats === 'object') {
      window.sessionStats.resets = Number(window.sessionStats.resets || 0) + 1;
    }

    // Update last compaction round
    if (preLlm) {
      lastPreLlmCompactionRound = currentRound;
    } else {
      lastCompactionRound = currentRound;
    }

    const savedTokens = Math.ceil(totalSaved / CHAR_TOKEN_RATIO);
    notes.push(`Total saved: ~${totalSaved} chars (~${savedTokens} tokens).`);

    return notes;
  }

  /**
   * Pre-LLM context check — called before sending messages to the LLM.
   * If context is over the hard threshold, compacts aggressively to
   * prevent Ollama from silently truncating.
   *
   * @param {Object} [opts]
   * @param {number} [opts.round] - Current round
   * @param {number} [opts.ctxLimit] - Context limit
   * @returns {string[]} Compaction notes
   */
  function preLlmContextCheck({ round, ctxLimit } = {}) {
    const messages = Array.isArray(window.messages) ? window.messages : [];
    const limit = Number(ctxLimit || C().DEFAULT_CTX_LIMIT_CHARS || 128000);
    const policy = C().CONTEXT_COMPACTION_POLICY || {};
    const hardRatio = Math.min(0.97, Number(policy.thresholdRatio || 0.82) + 0.10);

    const charSize = ctxSize(messages);
    const hardThreshold = Math.floor(limit * hardRatio);

    if (charSize < hardThreshold) return [];

    // Force compaction even if minRoundGap hasn't elapsed
    return applyContextManagementPipeline({ round, ctxLimit, preLlm: true });
  }

  window.AgentCompaction = {
    get runMaxOutputTokensRecoveryCount() { return runMaxOutputTokensRecoveryCount; },
    set runMaxOutputTokensRecoveryCount(value) {
      runMaxOutputTokensRecoveryCount = Math.max(0, Number(value || 0));
    },
    get runCompactedResultNoticeSignatures() { return runCompactedResultNoticeSignatures; },
    get lastCompactionRound() { return lastCompactionRound; },
    get lastPreLlmCompactionRound() { return lastPreLlmCompactionRound; },
    ctxSize,
    ctxTokenEstimate,
    estimateTokens,
    resetCompactionState,
    resetPromptInjectionState,
    recordRepeatedToolCall,
    recordToolFailure,
    extractPromptInjectionSignals,
    registerPromptInjectionSignals,
    sanitizeToolResult,
    applyToolResultContextBudget,
    microcompactToolResultMessages,
    compactNonToolMessages,
    buildToolUseSummary,
    armTimeBasedMicrocompactForTurn,
    applyContextManagementPipeline,
    preLlmContextCheck
  };
})();
