// src/app/llm/llm.js
// LLM routing, lane scheduling, timeout, retry, and main callLLM entry point.
// Provider implementations live in provider-*.js; shared utilities in llm-utils.js.

/** @type {AbortController|null} */
let activeLlmController = null;

/** @type {Object.<string, number>} */
const LLM_RATE_LIMIT_MS = {
  local: 250,
  ollama: 250,
  openrouter: 1200,
  cloud: 1200
};

/** @type {Object.<string, number>} */
const LLM_TIMEOUT_MS = {
  local: (window.CONSTANTS?.DEFAULT_TIMEOUT_MS_LOCAL || 120000),
  cloud: (window.CONSTANTS?.DEFAULT_TIMEOUT_MS_CLOUD || 45000),
  ollama: (window.CONSTANTS?.DEFAULT_TIMEOUT_MS_LOCAL || 120000),
  openrouter: (window.CONSTANTS?.DEFAULT_TIMEOUT_MS_LOCAL || 120000),
  control: 20000
};

/** @type {Object.<string, {chain: Promise, nextAt: number}>} */
const laneState = {
  local: { chain: Promise.resolve(), nextAt: 0 },
  cloud: { chain: Promise.resolve(), nextAt: 0 },
  openrouter: { chain: Promise.resolve(), nextAt: 0 },
  ollama: { chain: Promise.resolve(), nextAt: 0 }
};

// Half-open circuit breaker: after THRESHOLD consecutive failures a lane goes OPEN
// for RESET_MS, then allows one probe. Resets fully on success.
/** @type {number} */
const CIRCUIT_THRESHOLD = 3;
/** @type {number} */
const CIRCUIT_RESET_MS = 30000;
/** @type {Object.<string, {failures: number, openUntil: number}>} */
const circuitBreaker = {
  local:      { failures: 0, openUntil: 0 },
  cloud:      { failures: 0, openUntil: 0 },
  openrouter: { failures: 0, openUntil: 0 },
  ollama:     { failures: 0, openUntil: 0 }
};

/**
 * Check if a circuit breaker is open for a lane.
 * @param {string} lane - Lane name
 * @returns {boolean} True if circuit is open
 */
function isCircuitOpen(lane) {
  const cb = circuitBreaker[lane];
  if (!cb) return false;
  if (cb.openUntil > Date.now()) return true;
  if (cb.openUntil > 0) { cb.openUntil = 0; cb.failures = 0; } // half-open probe
  return false;
}
/**
 * Record a successful circuit breaker result.
 * @param {string} lane - Lane name
 * @returns {void}
 */
function recordCircuitSuccess(lane) {
  const cb = circuitBreaker[lane];
  if (cb) { cb.failures = 0; cb.openUntil = 0; }
}
/**
 * Record a circuit breaker failure.
 * @param {string} lane - Lane name
 * @returns {void}
 */
function recordCircuitFailure(lane) {
  const cb = circuitBreaker[lane];
  if (!cb) return;
  cb.failures++;
  if (cb.failures >= CIRCUIT_THRESHOLD) {
    cb.openUntil = Date.now() + CIRCUIT_RESET_MS;
    console.warn(`[LLM Circuit] Lane '${lane}' OPEN until ${new Date(cb.openUntil).toISOString()}`);
  }
}

/**
 * Execute a request on a specific lane with circuit breaker, rate limiting, and retry.
 * @param {string} lane - Lane name
 * @param {import('../../types/index.js').SessionMessage[]} msgs - Messages
 * @param {import('../../types/index.js').LlmCallOptions} options - Call options
 * @param {AbortSignal} [outerSignal] - Abort signal
 * @returns {Promise<import('../../types/index.js').LlmResponse>} LLM response
 */
function executeLane(lane, msgs, options, outerSignal) {
  if (isCircuitOpen(lane)) {
    const err = new Error(`LLM lane '${lane}' temporarily unavailable (circuit open, resets in ${Math.ceil((circuitBreaker[lane]?.openUntil - Date.now()) / 1000)}s)`);
    err.code = 'CIRCUIT_OPEN';
    err.status = 503;
    return Promise.reject(err);
  }

  const timeoutMs = getTimeoutMs(lane, options);
  const minIntervalMs = getRateLimitMs(lane, options);
  const retries = Number.isInteger(options.retries)
    ? Math.max(0, options.retries)
    : (lane === 'local' || lane === 'ollama' ? 1 : 2);

  return scheduleLaneExecution(lane, minIntervalMs, outerSignal, async () => {
    return retryWithBackoff(async () => {
      return runWithTimeout(async signal => {
        if (lane === 'ollama') {
          console.debug(`[callLLM] Executing on OLLAMA lane at ${ollamaBackend.url}`);
          return window.AgentLLMProviderOllama?.callOllamaCloud(msgs, signal, options);
        }
        if (lane === 'openrouter') {
          console.debug(`[callLLM] Executing on OPENROUTER lane, model=${openrouterBackend.model}`);
          return window.AgentLLMProviderOpenRouter?.callOpenRouter(msgs, signal, options);
        }
        if (lane === 'local') {
          console.debug(`[callLLM] Executing on LOCAL lane at ${localBackend.url}`);
          return window.AgentLLMProviderLocal?.callLocal(msgs, signal, options);
        }
        console.debug('[callLLM] Executing on CLOUD lane');
        return callCloud(msgs, signal, options);
      }, { timeoutMs, parentSignal: outerSignal, laneLabel: lane });
    }, { retries, signal: outerSignal });
  }).then(result => {
    recordCircuitSuccess(lane);
    return result;
  }).catch(err => {
    if (!outerSignal?.aborted && err.name !== 'AbortError' && err.code !== 'CIRCUIT_OPEN' && err.code !== 'OLLAMA_OOM' && err.code !== 'OLLAMA_MODEL_CRASH' && err.code !== 'OLLAMA_INCOMPLETE_OUTPUT' && err.code !== 'LOCAL_INCOMPLETE_OUTPUT' && err.code !== 'GEMINI_NONSTOP') {
      recordCircuitFailure(lane);
    }
    throw err;
  });
}

/**
 * Delay for a given duration, abortable.
 * @param {number} ms - Milliseconds to delay
 * @param {AbortSignal} [signal] - Abort signal
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  const timeout = Math.max(0, Number(ms) || 0);
  if (!timeout) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => { cleanup(); resolve(); }, timeout);
    const onAbort = () => { clearTimeout(id); cleanup(); const error = new Error('Request aborted'); error.name = 'AbortError'; reject(error); };
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Check if an error is retryable.
 * @param {Error} error - Error object
 * @returns {boolean} True if retryable
 */
function isRetryableError(error) {
  return window.AgentLLMUtils?.isRetryableError?.(error) ?? false;
}

/**
 * Retry a function with exponential backoff.
 * @param {Function} fn - Function to retry
 * @param {Object} options - Retry options
 * @param {number} [options.retries=2] - Number of retries
 * @param {number} [options.baseDelayMs=700] - Base delay in ms
 * @param {AbortSignal} [options.signal] - Abort signal
 * @returns {Promise<any>} Function result
 */
async function retryWithBackoff(fn, { retries = 2, baseDelayMs = 700, signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) { const error = new Error('Request aborted'); error.name = 'AbortError'; throw error; }
    try { return await fn(attempt); }
    catch (error) {
      lastError = error;
      const canRetry = attempt < retries && isRetryableError(error);
      if (!canRetry) throw error;
      const jitter = Math.floor(Math.random() * 180);
      const backoff = Math.min(6000, baseDelayMs * (2 ** attempt) + jitter);
      await delay(backoff, signal);
    }
  }
  throw lastError;
}

/**
 * Determine the best lane for the current request.
 * @returns {{lane: string, error: string}} Lane and optional error
 */
function getLaneForRequest() {
  if (typeof ollamaBackend !== 'undefined' && ollamaBackend.enabled) {
    console.debug(`[LLM Route] ollamaBackend.enabled=true, url='${ollamaBackend.url}' → lane='ollama'`);
    return { lane: 'ollama', error: '' };
  }
  if (typeof openrouterBackend !== 'undefined' && openrouterBackend.enabled) {
    const hasKey = !!String(openrouterBackend.apiKey || '').trim();
    if (hasKey) {
      console.debug(`[LLM Route] openrouterBackend.enabled=true, model='${openrouterBackend.model}' → lane='openrouter'`);
      return { lane: 'openrouter', error: '' };
    }
    console.debug(`[LLM Route] openrouterBackend.enabled=true but no API key → lane='cloud'`);
    return { lane: 'cloud', error: 'OpenRouter enabled but no API key set.' };
  }
  if (localBackend.enabled) {
    const localUrlState = window.AgentLLMUtils?.validateAndNormalizeLocalUrl
      ? window.AgentLLMUtils.validateAndNormalizeLocalUrl(localBackend.url)
      : { valid: false, reason: 'missing validator' };
    if (!localUrlState.valid) {
      const isEmptyUrl = !String(localBackend.url || '').trim();
      console.debug(`[LLM Route] localBackend.enabled=true, url invalid (${localUrlState.reason})${isEmptyUrl ? ', falling back to cloud' : ''}`);
      if (isEmptyUrl) return { lane: 'cloud', error: '' };
      return { lane: 'local', error: `Local LLM configuration error: ${localUrlState.reason}` };
    }
    if (localBackend.url !== localUrlState.url) {
      localBackend.url = localUrlState.url;
      localStorage.setItem('agent_local_backend_url', localBackend.url);
    }
    console.debug(`[LLM Route] localBackend.enabled=true, url=✓ → lane='local'`);
    return { lane: 'local', error: '' };
  }
  console.debug(`[LLM Route] localBackend.enabled=false, url=${localBackend.url ? '✓' : '✗'} → lane='cloud'`);
  return { lane: 'cloud', error: '' };
}

/**
 * Get rate limit interval for a lane.
 * @param {string} lane - Lane name
 * @param {import('../../types/index.js').LlmCallOptions} [options] - Call options
 * @returns {number} Rate limit in ms
 */
function getRateLimitMs(lane, options = {}) {
  const configured = Number(options.minIntervalMs);
  if (Number.isFinite(configured) && configured >= 0) return Math.max(0, configured);
  return LLM_RATE_LIMIT_MS[lane] || LLM_RATE_LIMIT_MS.cloud;
}

/**
 * Get timeout for a lane.
 * @param {string} lane - Lane name
 * @param {import('../../types/index.js').LlmCallOptions} [options] - Call options
 * @returns {number} Timeout in ms
 */
function getTimeoutMs(lane, options = {}) {
  const configured = Number(options.timeoutMs);
  if (Number.isFinite(configured) && configured > 0) {
    return (lane === 'local' || lane === 'ollama' || lane === 'openrouter') ? Math.max(8000, configured) : Math.max(1000, configured);
  }
  const maxTokens = Number(options.maxTokens) || 0;
  const isControlCall = maxTokens > 0 && maxTokens <= 300;
  if (isControlCall) return LLM_TIMEOUT_MS.control;
  return LLM_TIMEOUT_MS[lane] || LLM_TIMEOUT_MS.cloud;
}

/**
 * Schedule execution on a lane with rate limiting.
 * @param {string} lane - Lane name
 * @param {number} minIntervalMs - Minimum interval between requests
 * @param {AbortSignal} signal - Abort signal
 * @param {Function} work - Work function
 * @returns {Promise<any>} Work result
 */
async function scheduleLaneExecution(lane, minIntervalMs, signal, work) {
  const state = laneState[lane] || laneState.cloud;
  const previous = state.chain.catch(() => undefined);
  let release;
  state.chain = new Promise(resolve => { release = resolve; });

  const waitForPrevious = () => {
    if (!signal) return previous;
    if (signal.aborted) { const error = new Error('Request aborted'); error.name = 'AbortError'; return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const onAbort = () => { cleanup(); const error = new Error('Request aborted'); error.name = 'AbortError'; reject(error); };
      const cleanup = () => { signal.removeEventListener('abort', onAbort); };
      signal.addEventListener('abort', onAbort, { once: true });
      previous.then(() => { cleanup(); resolve(); }).catch(error => { cleanup(); reject(error); });
    });
  };

  try {
    await waitForPrevious();
    const waitMs = Math.max(0, state.nextAt - Date.now());
    if (waitMs > 0) await delay(waitMs, signal);
    state.nextAt = Date.now() + Math.max(0, minIntervalMs || 0);
    return await work();
  } finally {
    release();
  }
}

async function runWithTimeout(task, { timeoutMs, parentSignal, laneLabel }) {
  const controller = new AbortController();
  let timedOut = false;
  const relayAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', relayAbort, { once: true });
  }
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await task(controller.signal);
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`LLM timeout after ${timeoutMs}ms (${laneLabel})`);
      timeoutError.code = 'LLM_TIMEOUT';
      timeoutError.status = 408;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', relayAbort);
  }
}

function abortActiveLlmRequest() {
  if (!activeLlmController) return;
  activeLlmController.abort();
}

function getSelectedCloudModel() {
  const modelSelect = document.getElementById('model-select');
  return String(modelSelect?.value || '').trim();
}

function parseCloudProviderModel(rawModel) {
  const model = String(rawModel || '').trim();
  if (!model) return { provider: 'gemini', model: 'gemini-2.5-flash' };
  const prefixed = model.match(/^(gemini|openai|clawd|azure|ollama)\/(.+)$/i);
  if (prefixed) {
    const provider = String(prefixed[1] || '').toLowerCase();
    return { provider, model: String(prefixed[2] || '').trim() };
  }
  return { provider: 'gemini', model };
}

async function callCloud(msgs, signal, options = {}) {
  const selected = parseCloudProviderModel(getSelectedCloudModel());
  const provider = String(options.provider || selected.provider || 'gemini').toLowerCase();
  const model = String(options.model || selected.model || '').trim();

  if (!localBackend.enabled) {
    const badgeModel = document.getElementById('topbar-model');
    if (badgeModel) badgeModel.textContent = provider === 'gemini' ? model : `${provider}/${model}`;
  }

  if (provider === 'openai') return window.AgentLLMProviderOpenAI?.callOpenAiCloud(msgs, signal, options, model);
  if (provider === 'clawd') return window.AgentLLMProviderClawd?.callClawdCloud(msgs, signal, options, model);
  if (provider === 'azure') return window.AgentLLMProviderAzure?.callAzureOpenAiCloud(msgs, signal, options, model);
  if (provider === 'ollama') return window.AgentLLMProviderOllama?.callOllamaCloud(msgs, signal, options, model);
  return window.AgentLLMProviderGemini?.callGeminiDirect(msgs, signal, options, model);
}

async function callLLM(msgs, options = {}) {
  if (activeLlmController) activeLlmController.abort();
  activeLlmController = new AbortController();
  const { signal: outerSignal } = activeLlmController;
  const route = getLaneForRequest();
  if (route.error) {
    const configError = new Error(route.error);
    configError.code = 'LOCAL_CONFIG_INVALID';
    throw configError;
  }
  const lane = route.lane;
  console.debug(`[callLLM] Selected lane: ${lane}`);

  const inflightKey = window.AgentLLMUtils?.getInflightKey
    ? window.AgentLLMUtils.getInflightKey(msgs, options)
    : `${options.model || 'default'}:${msgs.length}`;
  const execute = () => executeLane(lane, msgs, options, outerSignal);
  try {
    const dedupFn = window.AgentLLMUtils?.dedupInflight;
    return await (dedupFn ? dedupFn(inflightKey, execute) : execute());
  } finally {
    if (activeLlmController?.signal === outerSignal) activeLlmController = null;
  }
}

window.AgentLLMControl = {
  abortActiveLlmRequest,
  setStreamingCallback: cb => { window.AgentLLMUtils && (window.AgentLLMUtils.streamingCallback = cb); },
  isIncompleteOrGarbageOutput: (...args) => window.AgentLLMUtils?.isIncompleteOrGarbageOutput?.(...args),
  collapseConsecutiveSameRole: (...args) => window.AgentLLMUtils?.collapseConsecutiveSameRole?.(...args),
  parseSSEChunk: (...args) => window.AgentLLMUtils?.parseSSEChunk?.(...args),
  readOllamaNativeStream: (...args) => window.AgentLLMUtils?.readOllamaNativeStream?.(...args),
  readStreamingResponse: (...args) => window.AgentLLMUtils?.readStreamingResponse?.(...args),
  dedupInflight: (...args) => window.AgentLLMUtils?.dedupInflight?.(...args),
  getInflightKey: (...args) => window.AgentLLMUtils?.getInflightKey?.(...args),
  isRetryableError,
  validateAndNormalizeLocalUrl: (...args) => window.AgentLLMUtils?.validateAndNormalizeLocalUrl?.(...args),
  buildLocalEndpointUrl: (...args) => window.AgentLLMUtils?.buildLocalEndpointUrl?.(...args),
  extractTextFromLocalContent: (...args) => window.AgentLLMUtils?.extractTextFromLocalContent?.(...args),
  normalizeFunctionCallsToXml: (...args) => window.AgentLLMUtils?.normalizeFunctionCallsToXml?.(...args)
};
