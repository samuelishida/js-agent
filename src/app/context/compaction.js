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

  function armTimeBasedMicrocompactForTurn() {
    return null;
  }

  function applyContextManagementPipeline({ ctxLimit } = {}) {
    const messages = Array.isArray(window.messages) ? window.messages : [];
    const limit = Number(ctxLimit || C().DEFAULT_CTX_LIMIT_CHARS || 128000);
    const tokenLimit = Math.floor(limit / CHAR_TOKEN_RATIO);
    const policy = C().CONTEXT_COMPACTION_POLICY || {};
    const charThreshold = Math.floor(limit * Number(policy.thresholdRatio || 0.82));
    const tokenThreshold = Math.floor(tokenLimit * Number(policy.thresholdRatio || 0.82));

    const charSize = ctxSize(messages);
    const tokenEst = ctxTokenEstimate(messages);
    if (charSize <= charThreshold && tokenEst <= tokenThreshold) return [];

    const compacted = microcompactToolResultMessages(messages, {
      keepRecent: Number(C().TOOL_RESULT_CONTEXT_BUDGET?.keepRecentResults || 8),
      clearOnly: true
    });

    if (!compacted.clearedCount) return [];

    window.messages = compacted.messages;
    if (window.sessionStats && typeof window.sessionStats === 'object') {
      window.sessionStats.resets = Number(window.sessionStats.resets || 0) + 1;
    }

    return [
      `Context manager compacted ${compacted.clearedCount} older tool result(s), saved ~${compacted.savedChars} chars (~${Math.ceil(compacted.savedChars / CHAR_TOKEN_RATIO)} tokens).`
    ];
  }

  window.AgentCompaction = {
    get runMaxOutputTokensRecoveryCount() { return runMaxOutputTokensRecoveryCount; },
    set runMaxOutputTokensRecoveryCount(value) {
      runMaxOutputTokensRecoveryCount = Math.max(0, Number(value || 0));
    },
    get runCompactedResultNoticeSignatures() { return runCompactedResultNoticeSignatures; },
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
    buildToolUseSummary,
    armTimeBasedMicrocompactForTurn,
    applyContextManagementPipeline
  };
})();
