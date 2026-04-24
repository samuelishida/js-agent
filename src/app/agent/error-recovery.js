// src/app/agent/error-recovery.js
// Error classification, recovery prompt building, and retry logic.

/**
 * @typedef {'max_output_tokens' | 'local_timeout' | 'ollama_crash' | 'ollama_incomplete' | 'rate_limit' | 'network' | 'unknown'} ErrorClass
 */

/**
 * Classify an LLM error into a recovery strategy.
 * @param {Error} error - The error to classify
 * @param {number} round - Current round number
 * @param {number} maxRounds - Maximum rounds
 * @returns {ErrorClass}
 */
function classifyLlmError(error, round, maxRounds) {
  if (window.AgentReplyAnalysis?.isMaxOutputTokenLikeError?.(error)) return 'max_output_tokens';
  if (error.message?.includes('LOCAL_TIMEOUT')) return 'local_timeout';
  if (error.code === 'OLLAMA_MODEL_CRASH') return 'ollama_crash';
  if (error.code === 'OLLAMA_INCOMPLETE_OUTPUT' || error.code === 'LOCAL_INCOMPLETE_OUTPUT') return 'ollama_incomplete';
  if (error.status === 429) return 'rate_limit';
  if (error.message?.includes('network') || error.message?.includes('fetch')) return 'network';
  return 'unknown';
}

/**
 * Build a recovery prompt for a classified error.
 * @param {ErrorClass} errorClass
 * @param {number} round
 * @param {number} retryCount
 * @returns {{ prompt: string, shouldRetry: boolean, maxTokensOverride?: number }}
 */
function buildRecoveryPrompt(errorClass, round, retryCount) {
  const cfg = window.CONSTANTS || {};
  switch (errorClass) {
    case 'max_output_tokens':
      return {
        prompt: 'Previous reply exceeded output token limits. Continue with a concise response under 220 words: either call the required tool(s) with complete args or provide a final answer grounded in current evidence.',
        shouldRetry: retryCount <= (cfg.MAX_OUTPUT_TOKEN_RECOVERY_ATTEMPTS || 3),
        maxTokensOverride: Math.max(512, (cfg.DEFAULT_MAX_TOKENS_LOCAL || 4096) - (retryCount * 280))
      };
    case 'local_timeout':
      return {
        prompt: 'Previous attempt timed out. Continue from the current context with a concise response: either call the required tool(s) with complete args or provide the final answer.',
        shouldRetry: retryCount <= 1
      };
    case 'ollama_crash':
      return {
        prompt: 'The previous model call crashed. Continue now with a shorter, focused response: call one tool with complete args, or provide a concise final answer.',
        shouldRetry: retryCount <= 1
      };
    case 'ollama_incomplete':
      return {
        prompt: '',
        shouldRetry: false
      };
    case 'rate_limit':
      return {
        prompt: 'Rate limit hit. Wait briefly, then continue with a concise response.',
        shouldRetry: retryCount <= 2
      };
    case 'network':
      return {
        prompt: 'Network error occurred. Continue with a concise response.',
        shouldRetry: retryCount <= 2
      };
    default:
      return {
        prompt: 'An error occurred. Continue with a concise response.',
        shouldRetry: false
      };
  }
}

/**
 * Determine if an error is retryable.
 * @param {Error} error
 * @param {number} round
 * @param {number} maxRounds
 * @returns {boolean}
 */
function shouldRetry(error, round, maxRounds) {
  if (round >= maxRounds) return false;
  const errorClass = classifyLlmError(error, round, maxRounds);
  const { shouldRetry: retryable } = buildRecoveryPrompt(errorClass, round, 0);
  return retryable;
}

/**
 * Apply recovery for a max-output-token error.
 * @param {Object} opts
 * @param {Error} opts.error
 * @param {number} opts.round
 * @param {number} opts.maxRounds
 * @param {SessionMessage[]} opts.messages
 * @returns {{ recovered: boolean, messages: SessionMessage[], notice?: string }}
 */
function applyMaxOutputTokenRecovery({ error, round, maxRounds, messages }) {
  const Comp = window.AgentCompaction;
  const cfg = window.CONSTANTS || {};
  const retryCount = (Comp?.runMaxOutputTokensRecoveryCount || 0) + 1;

  if (retryCount > (cfg.MAX_OUTPUT_TOKEN_RECOVERY_ATTEMPTS || 3)) {
    return { recovered: false, messages };
  }

  if (Comp) Comp.runMaxOutputTokensRecoveryCount = retryCount;

  let updatedMessages = messages;
  if (retryCount >= 2 && Comp?.microcompactToolResultMessages) {
    const tightened = Comp.microcompactToolResultMessages(messages, {
      keepRecent: 4,
      clearOnly: true,
      clearedNotice: '[Older tool result content cleared after output-limit recovery]'
    });
    if (tightened.clearedCount > 0) {
      updatedMessages = tightened.messages;
    }
  }

  const { prompt } = buildRecoveryPrompt('max_output_tokens', round, retryCount);
  updatedMessages.push({ role: 'user', content: prompt });

  return {
    recovered: true,
    messages: updatedMessages,
    notice: `Model output limit reached on round ${round}. Recovery attempt ${retryCount}/${cfg.MAX_OUTPUT_TOKEN_RECOVERY_ATTEMPTS || 3} with stricter brevity.`
  };
}

/**
 * Apply recovery for a local timeout error.
 * @param {Object} opts
 * @param {Error} opts.error
 * @param {number} opts.round
 * @param {number} opts.maxRounds
 * @param {SessionMessage[]} opts.messages
 * @returns {{ recovered: boolean, messages: SessionMessage[], notice?: string }}
 */
function applyLocalTimeoutRecovery({ error, round, maxRounds, messages }) {
  const TE = window.AgentToolExecution;
  const streak = (TE?.runLocalTimeoutStreak || 0) + 1;
  if (TE) TE.runLocalTimeoutStreak = streak;

  if (streak > 1) {
    return { recovered: false, messages };
  }

  const { prompt } = buildRecoveryPrompt('local_timeout', round, streak);
  const updatedMessages = [...messages, { role: 'user', content: prompt }];

  return {
    recovered: true,
    messages: updatedMessages,
    notice: `Local model timed out on round ${round}. Retrying once with concise continuation guidance.`
  };
}

/**
 * Apply recovery for an Ollama model crash.
 * @param {Object} opts
 * @param {Error} opts.error
 * @param {number} opts.round
 * @param {number} opts.maxRounds
 * @param {SessionMessage[]} opts.messages
 * @returns {{ recovered: boolean, messages: SessionMessage[], notice?: string }}
 */
function applyOllamaCrashRecovery({ error, round, maxRounds, messages }) {
  const { prompt } = buildRecoveryPrompt('ollama_crash', round, 1);
  const updatedMessages = [...messages, { role: 'user', content: prompt }];

  return {
    recovered: true,
    messages: updatedMessages,
    notice: 'Model crashed (EOF). Retrying with a compact continuation prompt.'
  };
}

/**
 * Apply the appropriate recovery strategy for an error.
 * @param {Object} opts
 * @param {Error} opts.error
 * @param {number} opts.round
 * @param {number} opts.maxRounds
 * @param {SessionMessage[]} opts.messages
 * @returns {{ recovered: boolean, messages: SessionMessage[], notice?: string, fatal?: boolean }}
 */
function applyErrorRecovery({ error, round, maxRounds, messages }) {
  const errorClass = classifyLlmError(error, round, maxRounds);

  if (errorClass === 'ollama_incomplete') {
    return { recovered: false, messages, fatal: true };
  }

  if (errorClass === 'max_output_tokens') {
    return applyMaxOutputTokenRecovery({ error, round, maxRounds, messages });
  }

  if (errorClass === 'local_timeout') {
    return applyLocalTimeoutRecovery({ error, round, maxRounds, messages });
  }

  if (errorClass === 'ollama_crash') {
    return applyOllamaCrashRecovery({ error, round, maxRounds, messages });
  }

  return { recovered: false, messages };
}

window.AgentErrorRecovery = {
  classifyLlmError,
  buildRecoveryPrompt,
  shouldRetry,
  applyErrorRecovery,
  applyMaxOutputTokenRecovery,
  applyLocalTimeoutRecovery,
  applyOllamaCrashRecovery
};
