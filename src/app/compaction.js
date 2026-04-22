// ── Compaction compatibility layer ───────────────────────────────────────────
// Keeps the extracted compaction boundary while publishing a browser-friendly
// window API for the current plain-script runtime.
;(function() {
  const C = () => window.CONSTANTS || {};

  let runMaxOutputTokensRecoveryCount = 0;
  let runCompactedResultNoticeSignatures = new Set();
  let repeatedToolCallCounts = new Map();
  let toolFailureCounts = new Map();
  let promptInjectionSignals = [];

  function ctxSize(messages = []) {
    return (Array.isArray(messages) ? messages : [])
      .reduce((total, message) => total + String(message?.content || '').length, 0);
  }

  function resetCompactionState() {
    runMaxOutputTokensRecoveryCount = 0;
    runCompactedResultNoticeSignatures = new Set();
    repeatedToolCallCounts = new Map();
    toolFailureCounts = new Map();
  }

  function resetPromptInjectionState() {
    promptInjectionSignals = [];
  }

  function getCallSignature(call) {
    const TE = window.AgentToolExecution;
    if (TE?.getSemanticToolCallSignature) return TE.getSemanticToolCallSignature(call);
    return `${String(call?.tool || 'unknown')}:${JSON.stringify(call?.args || {})}`;
  }

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

  function sanitizeToolResult(result) {
    const text = String(result || '');
    const patterns = C().INJECTION_PATTERNS || {};
    return text
      .replace(patterns.INJECTION_TAG_STRIP_REGEX || /<tool_call>[\s\S]*?<\/tool_call>/gi, '')
      .replace(patterns.REMINDER_TAG_STRIP_REGEX || /<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
      .replace(patterns.DENIAL_TAG_STRIP_REGEX || /<permission_denials[^>]*>[\s\S]*?<\/permission_denials>/gi, '')
      .trim();
  }

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

    const head = text.slice(0, effectivePreview);
    const tail = text.slice(-effectivePreview);
    const omitted = text.length - (head.length + tail.length);
    return `${head}\n\n[${String(toolCall?.tool || 'tool')} result compacted; omitted ${omitted} chars]\n\n${tail}`;
  }

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
      if (message?.role === 'user' && /<tool_result\b/i.test(String(message.content || ''))) {
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
        ? `<tool_result tool="compacted">\n${clearedNotice}\n</tool_result>`
        : clearedNotice;
      if (original === replacement) return message;

      clearedCount += 1;
      savedChars += Math.max(0, original.length - replacement.length);
      return { ...message, content: replacement };
    });

    return { messages: nextMessages, clearedCount, savedChars };
  }

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

  async function applyContextManagementPipeline({ ctxLimit } = {}) {
    const messages = Array.isArray(window.messages) ? window.messages : [];
    const limit = Number(ctxLimit || C().DEFAULT_CTX_LIMIT_CHARS || 32000);
    const policy = C().CONTEXT_COMPACTION_POLICY || {};
    const threshold = Math.floor(limit * Number(policy.thresholdRatio || 0.82));

    if (ctxSize(messages) <= threshold) return [];

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
      `Context manager compacted ${compacted.clearedCount} older tool result(s), saved ~${compacted.savedChars} chars.`
    ];
  }

  window.AgentCompaction = {
    get runMaxOutputTokensRecoveryCount() { return runMaxOutputTokensRecoveryCount; },
    set runMaxOutputTokensRecoveryCount(value) {
      runMaxOutputTokensRecoveryCount = Math.max(0, Number(value || 0));
    },
    get runCompactedResultNoticeSignatures() { return runCompactedResultNoticeSignatures; },
    ctxSize,
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
