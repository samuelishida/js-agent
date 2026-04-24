let activeLlmController = null;

const LLM_RATE_LIMIT_MS = {
  local: 250,
  ollama: 250,
  cloud: 1200
};

const LLM_TIMEOUT_MS = {
  local: (window.CONSTANTS?.DEFAULT_TIMEOUT_MS_LOCAL || 120000),
  cloud: (window.CONSTANTS?.DEFAULT_TIMEOUT_MS_CLOUD || 45000),
  ollama: (window.CONSTANTS?.DEFAULT_TIMEOUT_MS_LOCAL || 120000),
  control: 20000
};

const LLM_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isIncompleteOrGarbageOutput(content, finishReason) {
  if (finishReason === null || finishReason === 'length') return true;
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed) return true;
  const bare = trimmed.replace(/\s+/g, '');
  let closingCount = 0;
  for (let i = 0; i < bare.length && i < 80; i++) {
    const ch = bare[i];
    if (ch === '}' || ch === ')' || ch === ']') closingCount++;
    else break;
  }
  if (closingCount >= 3 && closingCount === bare.length) return true;
  const nonWhitespace = bare.replace(/[})\]]/g, '');
  if (bare.length > 6 && bare.length <= 80 && nonWhitespace.length === 0) return true;
  if (bare.length > 6 && bare.length <= 200) {
    const uniqueChars = new Set(bare);
    if (uniqueChars.size <= 3 && (uniqueChars.has('}') || uniqueChars.has(')') || uniqueChars.has(']'))) return true;
  }
  return false;
}

let streamingCallback = null;

function setStreamingCallback(cb) { streamingCallback = cb; }

function parseSSEChunk(chunk) {
  const lines = chunk.split('\n');
  const events = [];
  for (const line of lines) {
    if (!line.startsWith('data: ') && !line.startsWith('data:')) continue;
    const data = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
    if (data.trim() === '[DONE]') { events.push({ done: true }); continue; }
    try { events.push({ done: false, parsed: JSON.parse(data) }); } catch {}
  }
  return events;
}

async function readOllamaNativeStream(response, onChunk) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let fullContent = '';
  let fullReasoning = '';
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.error) {
            const msg = String(obj.error?.message || obj.error || 'Ollama streaming error').slice(0, 200);
            if (/^EOF$/i.test(msg.trim())) {
              console.warn('[readOllamaNativeStream] stream ended with EOF error - returning accumulated content');
              if (!fullContent && fullReasoning) {
                return '<think>\n' + fullReasoning + '\n</think>';
              }
            }
            const err = new Error(msg);
            throw err;
          }
          const delta = obj.message?.content || '';
          const reasoning = obj.message?.reasoning || obj.message?.reasoning_content || '';
          if (delta) {
            fullContent += delta;
            if (onChunk) onChunk(delta, fullContent);
          }
          if (reasoning) {
            fullReasoning += reasoning;
          }
          if (obj.done) { reader.cancel(); return fullContent; }
        } catch (e) {
          if (e.message && !e.message.includes('JSON')) throw e;
        }
      }
    }
    if (buffer.trim()) {
      try {
        const obj = JSON.parse(buffer.trim());
        if (obj.message?.content) fullContent += obj.message.content;
        if (obj.message?.reasoning || obj.message?.reasoning_content) {
          fullReasoning += (obj.message.reasoning || obj.message.reasoning_content);
        }
        if (obj.done) return fullContent;
      } catch {}
    }
  } finally { reader.releaseLock(); }
  if (fullReasoning && !fullContent) {
    return '<think>\n' + fullReasoning + '\n</think>';
  }
  return fullContent;
}

async function readStreamingResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let fullContent = '';
  let fullReasoning = '';
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const events = parseSSEChunk(chunk);
        for (const event of events) {
          if (event.done) {
            reader.cancel();
            if (!fullContent && fullReasoning) return '<tool_call>think>\n' + fullReasoning + '\n</think>';
            return fullContent;
          }
          const deltaObj = event.parsed?.choices?.[0]?.delta;
          const delta = deltaObj?.content || '';
          const reasoning = deltaObj?.reasoning || deltaObj?.reasoning_content || '';
          if (delta) {
            fullContent += delta;
            if (streamingCallback) streamingCallback(delta, fullContent);
          }
          if (reasoning) {
            fullReasoning += reasoning;
          }
        }
      }
    }
  } finally { reader.releaseLock(); }
  if (!fullContent && fullReasoning) {
    return '<think>\n' + fullReasoning + '\n</think>';
  }
  return fullContent;
}

const laneState = {
  local: { chain: Promise.resolve(), nextAt: 0 },
  cloud: { chain: Promise.resolve(), nextAt: 0 },
  openrouter: { chain: Promise.resolve(), nextAt: 0 },
  // Ollama gets its own queue so it doesn't share rate-limit state with cloud calls.
  ollama: { chain: Promise.resolve(), nextAt: 0 }
};

function executeLane(lane, msgs, options, outerSignal) {
  const timeoutMs = getTimeoutMs(lane, options);
  const minIntervalMs = getRateLimitMs(lane, options);
  const retries = Number.isInteger(options.retries)
    ? Math.max(0, options.retries)
    : (lane === 'local' ? 1 : 2);

  return scheduleLaneExecution(lane, minIntervalMs, outerSignal, async () => {
    return retryWithBackoff(async () => {
      return runWithTimeout(async signal => {
        if (lane === 'ollama') {
          console.debug(`[callLLM] Executing on OLLAMA lane at ${ollamaBackend.url}`);
          return callOllamaCloud(msgs, signal, options);
        }
        if (lane === 'openrouter') {
          console.debug(`[callLLM] Executing on OPENROUTER lane, model=${openrouterBackend.model}`);
          return callOpenRouter(msgs, signal, options);
        }
        if (lane === 'local') {
          console.debug(`[callLLM] Executing on LOCAL lane at ${localBackend.url}`);
          return callLocal(msgs, signal, options);
        }
        console.debug('[callLLM] Executing on CLOUD lane');
        return callCloud(msgs, signal, options);
      }, { timeoutMs, parentSignal: outerSignal, laneLabel: lane });
    }, { retries, signal: outerSignal });
  });
}

function delay(ms, signal) {
  const timeout = Math.max(0, Number(ms) || 0);
  if (!timeout) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      cleanup();
      resolve();
    }, timeout);

    const onAbort = () => {
      clearTimeout(id);
      cleanup();
      const error = new Error('Request aborted');
      error.name = 'AbortError';
      reject(error);
    };

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function isRetryableError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return false;
  if (error.code === 'OLLAMA_CLOUD_CORS_BLOCKED' || error.code === 'OLLAMA_PROXY_NOT_CONFIGURED') {
    return false;
  }

  const message = String(error.message || '');

  // Ollama "EOF" on 500 is a non-retryable model inference failure (usually
  // caused by sending unsupported parameters like tools: to a local model).
  // Retrying identical request will produce the same error.
  if (/EOF.*api_erro|api_erro.*EOF/i.test(message)) {
    return false;
  }

  // Incomplete/garbage model output — model crashed or OOM'd. Retry will hit same issue.
  if (error.code === 'OLLAMA_INCOMPLETE_OUTPUT' || error.code === 'LOCAL_INCOMPLETE_OUTPUT' || error.code === 'OLLAMA_MODEL_CRASH') {
    return false;
  }

  const status = Number(error.status);
  if (LLM_RETRY_STATUSES.has(status)) return true;

  if (/\b(408|425|429|500|502|503|504)\b/.test(message)) return true;
  if (/(timeout|timed out|network|failed to fetch|rate limit|temporarily unavailable|overloaded)/i.test(message)) {
    return true;
  }

  return false;
}

async function retryWithBackoff(fn, { retries = 2, baseDelayMs = 700, signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      const error = new Error('Request aborted');
      error.name = 'AbortError';
      throw error;
    }

    try {
      return await fn(attempt);
    } catch (error) {
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

function validateAndNormalizeLocalUrl(rawUrl) {
  const original = String(rawUrl || '').trim();
  if (!original) {
    return { valid: false, url: '', reason: 'local backend URL is empty' };
  }

  // Reject non-http(s) schemes (ftp:, javascript:, data:, etc.)
  // but allow bare hostnames like "localhost:11434" which look like schemes but aren't.
  const schemeMatch = original.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (schemeMatch && !/^https?:/i.test(schemeMatch[1])) {
    // Check if this is actually a scheme (has //) or just a port (like localhost:11434)
    if (!/^https?:\/\//i.test(original) && /\/\//.test(original)) {
      return { valid: false, url: '', reason: 'local backend URL must start with http:// or https://' };
    }
    if (/^(ftp|javascript|data|vbscript|file|mailto|tel):/i.test(original)) {
      return { valid: false, url: '', reason: 'local backend URL must start with http:// or https://' };
    }
  }

  let candidate = original;
  if (!/^https?:\/\//i.test(candidate) && /^[^\s]+$/.test(candidate)) {
    candidate = `http://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, url: '', reason: 'local backend URL must start with http:// or https://' };
    }

    const hostname = String(parsed.hostname || '').toLowerCase();
    if (!hostname) {
      return { valid: false, url: '', reason: 'local backend URL is missing a host' };
    }

    if (hostname === 'localhos') {
      return { valid: false, url: '', reason: 'local backend host appears misspelled (did you mean localhost?)' };
    }

    const normalizedPath = String(parsed.pathname || '').replace(/\/+$|^\s+|\s+$/g, '');
    const normalized = `${parsed.origin}${normalizedPath}`.replace(/\/+$/, '');

    return {
      valid: true,
      url: normalized
    };
  } catch {
    return { valid: false, url: '', reason: 'local backend URL is not a valid URL' };
  }
}

function buildLocalEndpointUrl(baseUrl, relativePath) {
  if (!String(baseUrl || '').trim()) return '';
  const normalizedBase = String(baseUrl || '').replace(/\/+$/, '') + '/';
  const trimmedPath = String(relativePath || '').replace(/^\/+/, '');
  try {
    return new URL(trimmedPath, normalizedBase).toString();
  } catch {
    return normalizedBase + trimmedPath;
  }
}

function extractTextFromLocalContent(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const text = value
      .map(part => extractTextFromLocalContent(part))
      .filter(Boolean)
      .join('');

    return text;
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (typeof value.response === 'string') return value.response;
  if (typeof value.output_text === 'string') return value.output_text;
  if (typeof value.completion === 'string') return value.completion;

  if (Array.isArray(value.content)) {
    return extractTextFromLocalContent(value.content);
  }

  if (Array.isArray(value.output)) {
    return extractTextFromLocalContent(value.output);
  }

  if (value.message && typeof value.message === 'object') {
    return extractTextFromLocalContent(value.message);
  }

  return '';
}

function extractLocalReasoningText(data) {
  const reasoningCandidates = [
    data?.choices?.[0]?.message?.thinking,
    data?.choices?.[0]?.message?.reasoning,
    data?.choices?.[0]?.message?.reasoning_content,
    data?.choices?.[0]?.thinking,
    data?.choices?.[0]?.reasoning,
    data?.choices?.[0]?.reasoning_content,
    data?.message?.thinking,
    data?.message?.reasoning,
    data?.message?.reasoning_content,
    data?.thinking,
    data?.reasoning,
    data?.reasoning_content
  ];

  for (const candidate of reasoningCandidates) {
    const text = extractTextFromLocalContent(candidate);
    if (String(text || '').trim()) return text;
  }

  return '';
}

function summarizeLocalPayloadShape(data) {
  if (!data || typeof data !== 'object') return `payload:${typeof data}`;

  const topKeys = Object.keys(data).slice(0, 8).join(',');
  const messageKeys = (data.message && typeof data.message === 'object')
    ? Object.keys(data.message).slice(0, 8).join(',')
    : '';
  const choiceMessage = data.choices?.[0]?.message;
  const choiceMessageKeys = (choiceMessage && typeof choiceMessage === 'object')
    ? Object.keys(choiceMessage).slice(0, 8).join(',')
    : '';

  return [
    topKeys ? `keys=${topKeys}` : '',
    messageKeys ? `message=${messageKeys}` : '',
    choiceMessageKeys ? `choice.message=${choiceMessageKeys}` : ''
  ].filter(Boolean).join(' | ') || 'empty-object';
}

// Converts an OpenAI-style tool_calls array (from function-calling API responses)
// into <tool_call> XML blocks that the agent's regex parser understands.
// Handles model quirks:
//  - glm-5.1: encodes full {tool,args} JSON in function.name, arguments is "{}"
//  - standard: function.name is the tool name, function.arguments is the args JSON string
//  - alias: function.name JSON may use "name"+"parameters" instead of "tool"+"args"
function normalizeFunctionCallsToXml(toolCallsArr) {
  if (!Array.isArray(toolCallsArr) || !toolCallsArr.length) return '';
  const blocks = toolCallsArr.map(tc => {
    const fn = tc?.function;
    if (!fn) return '';

    // Try parsing function.name as JSON (glm-5.1 quirk and similar)
    let nameJson = null;
    try { nameJson = JSON.parse(fn.name); } catch { /* not JSON — normal */ }
    if (nameJson && typeof nameJson === 'object') {
      const toolName = nameJson.tool || nameJson.name || null;
      if (toolName) {
        const args = nameJson.args ?? nameJson.parameters ?? nameJson.input ?? nameJson.arguments ?? {};
        return `<tool_call>\n${JSON.stringify({ tool: String(toolName), args: args || {}, ...(tc.id ? { id: tc.id } : {}) })}\n</tool_call>`;
      }
    }

    // Standard OpenAI function-calling: name = tool name, arguments = JSON string
    const toolName = String(fn.name || '').trim();
    if (!toolName) return '';
    let args = {};
    try { args = JSON.parse(fn.arguments || '{}'); } catch { /* malformed args */ }
    // arguments may itself use alias keys (parameters/input) — normalise them.
    const argsVal = args.args ?? args.parameters ?? args.input ?? args.inputs ?? args.arguments ?? args;
    return `<tool_call>\n${JSON.stringify({ tool: toolName, args: argsVal, ...(tc.id ? { id: tc.id } : {}) })}\n</tool_call>`;
  }).filter(Boolean);

  if (!blocks.length) return '';
  console.debug(`[LLM] normalizeFunctionCallsToXml: converted ${blocks.length} tool_call(s)`);
  return blocks.join('\n');
}

function extractLocalVisibleReply(data) {
  // Check for native function-calling format FIRST — before any content fallback.
  // Some models return both prose in content AND tool_calls; tool_calls must win.
  const toolCallsArr = data?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(toolCallsArr) && toolCallsArr.length) {
    const xml = normalizeFunctionCallsToXml(toolCallsArr);
    if (xml) return { text: xml, hiddenReasoningOnly: false };
  }

  const visibleCandidates = [
    data?.choices?.[0]?.message?.content,
    data?.choices?.[0]?.message,
    data?.choices?.[0]?.delta?.content,
    data?.choices?.[0]?.text,
    data?.message?.content,
    data?.message,
    data?.message?.text,
    data?.response,
    data?.content,
    data?.text,
    data?.completion,
    data?.output_text,
    data?.output,
    data?.output?.text,
    data?.result
  ];

  for (const candidate of visibleCandidates) {
    const text = extractTextFromLocalContent(candidate);
    if (String(text || '').trim()) {
      const finishReason = data?.choices?.[0]?.finish_reason ?? data?.finish_reason ?? undefined;
      if (isIncompleteOrGarbageOutput(text, finishReason)) {
        const garbageError = new Error(
          finishReason === 'length'
            ? `Local model output was truncated (finish_reason: length). Try reducing context size or using a smaller model.`
            : finishReason === null
              ? `Local model returned incomplete response (finish_reason: null). The model may have crashed.`
              : `Local model returned garbage output. The model may be unstable.`
        );
        garbageError.status = 500;
        garbageError.code = 'LOCAL_INCOMPLETE_OUTPUT';
        throw garbageError;
      }
      return {
        text,
        hiddenReasoningOnly: false
      };
    }
  }

  const hasHiddenReasoning = !!String(extractLocalReasoningText(data) || '').trim();
  return {
    text: '',
    hiddenReasoningOnly: hasHiddenReasoning
  };
}

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
    const localUrlState = validateAndNormalizeLocalUrl(localBackend.url);
    if (!localUrlState.valid) {
      const isEmptyUrl = !String(localBackend.url || '').trim();
      console.debug(`[LLM Route] localBackend.enabled=true, url invalid (${localUrlState.reason})${isEmptyUrl ? ', falling back to cloud' : ''}`);
      if (isEmptyUrl) {
        return { lane: 'cloud', error: '' };
      }
      return {
        lane: 'local',
        error: `Local LLM configuration error: ${localUrlState.reason}`
      };
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

function getRateLimitMs(lane, options = {}) {
  const configured = Number(options.minIntervalMs);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.max(0, configured);
  }
  return LLM_RATE_LIMIT_MS[lane] || LLM_RATE_LIMIT_MS.cloud;
}

function getTimeoutMs(lane, options = {}) {
  const configured = Number(options.timeoutMs);
  if (Number.isFinite(configured) && configured > 0) {
    return (lane === 'local' || lane === 'ollama') ? Math.max(8000, configured) : Math.max(1000, configured);
  }

  const maxTokens = Number(options.maxTokens) || 0;
  const isControlCall = maxTokens > 0 && maxTokens <= 300;
  if (isControlCall) return LLM_TIMEOUT_MS.control;
  return LLM_TIMEOUT_MS[lane] || LLM_TIMEOUT_MS.cloud;
}

async function scheduleLaneExecution(lane, minIntervalMs, signal, work) {
  const state = laneState[lane] || laneState.cloud;
  const previous = state.chain.catch(() => undefined);
  let release;
  state.chain = new Promise(resolve => { release = resolve; });

  const waitForPrevious = () => {
    if (!signal) return previous;
    if (signal.aborted) {
      const error = new Error('Request aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        reject(error);
      };

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      previous.then(() => {
        cleanup();
        resolve();
      }).catch(error => {
        cleanup();
        reject(error);
      });
    });
  };

  try {
    await waitForPrevious();

    const waitMs = Math.max(0, state.nextAt - Date.now());
    if (waitMs > 0) {
      await delay(waitMs, signal);
    }

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

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

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
    return {
      provider,
      model: String(prefixed[2] || '').trim()
    };
  }

  return { provider: 'gemini', model };
}

function buildOpenAiStyleMessages(msgs) {
  return msgs.map(m => {
    let content = String(m.content || '');
    // Strip <think>...</think> blocks before sending to the API so reasoning
    // from previous turns is never re-sent as part of the conversation history.
    // Use the same inner-to-outer loop as splitModelReply to handle nesting.
    let prev;
    do {
      prev = content;
      content = content.replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi, '');
    } while (content !== prev);
    content = content.trim();

    if (m.role === 'tool') {
      // Only preserve role:'tool' when a real tool_call_id exists (native FC mode).
      // Without one the model used XML tool calling, so downgrade to role:'user'
      // wrapped in <tool_result> tags — accepted by all providers including OpenAI/Azure
      // which reject empty tool_call_id on messages that follow non-FC assistant turns.
      if (m.tool_call_id) {
        return { role: 'tool', tool_call_id: m.tool_call_id, content };
      }
      return { role: 'user', content: `<tool_result${m.name ? ` tool="${m.name}"` : ''}>\n${content}\n</tool_result>` };
    }
    return {
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content
    };
  });
}

// Some providers require strictly alternating user/assistant roles.
// When multiple tool results arrive as separate user messages, merge consecutive
// same-role entries so no two adjacent messages share the same role.
// Spreads the full message object so tool_call_id and other fields are preserved.
function collapseConsecutiveSameRole(msgs) {
  const out = [];
  for (const msg of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role && msg.role !== 'tool') {
      prev.content = `${prev.content}\n\n${String(msg.content || '')}`;
    } else {
      out.push({ ...msg, content: String(msg.content || '') });
    }
  }
  return out;
}

async function callCloud(msgs, signal, options = {}) {
  const selected = parseCloudProviderModel(getSelectedCloudModel());
  const provider = String(options.provider || selected.provider || 'gemini').toLowerCase();
  const model = String(options.model || selected.model || '').trim();

  if (!localBackend.enabled) {
    const badgeModel = document.getElementById('topbar-model');
    if (badgeModel) {
      badgeModel.textContent = provider === 'gemini'
        ? model
        : `${provider}/${model}`;
    }
  }

  if (provider === 'openai') return callOpenAiCloud(msgs, signal, options, model);
  if (provider === 'clawd') return callClawdCloud(msgs, signal, options, model);
  if (provider === 'azure') return callAzureOpenAiCloud(msgs, signal, options, model);
  if (provider === 'ollama') return callOllamaCloud(msgs, signal, options, model);
  return callGeminiDirect(msgs, signal, options, model);
}

async function callOpenRouter(msgs, signal, options = {}) {
  const apiKey = String(openrouterBackend?.apiKey || '').trim();
  const model = String(openrouterBackend?.model || 'openai/gpt-oss-120b:free').trim();
  if (!apiKey) throw new Error('OpenRouter API key not configured');

  const maxTokens = Math.max(512, Number(options.maxTokens) || 4096);
  const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.7;

  const body = {
    model,
    messages: msgs.map(m => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: String(m.content || '')
    })),
    max_tokens: maxTokens,
    temperature,
    stream: false
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': window.location.origin,
      'X-Title': 'JS Agent'
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();

  // Check for native tool_calls before falling back to content
  const toolCalls = data?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length) {
    const xml = normalizeFunctionCallsToXml(toolCalls);
    if (xml) return xml;
  }

  return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
}

// Markdown/HTML rendering functions moved to ui-render.js:
// containsMarkdown, looksLikeHtmlFragment, escapeInlineHtml, renderInlineMarkdown,
// renderMarkdownBlocks, sanitizeUrl, sanitizeHtmlFragment, renderAgentHtml

// extractThinkingBlocks, normalizeVisibleModelText, splitModelReply
// moved to reply-analysis.js — available as window.* globals

// The following rendering functions have been moved to ui-render.js:
// looksLikeHtmlFragment, containsMarkdown, escapeInlineHtml, renderInlineMarkdown,
// renderMarkdownBlocks, sanitizeUrl, sanitizeHtmlFragment, renderAgentHtml, SAFE_HTML_TAGS, SAFE_HTML_ATTRS
// They are available as window.* globals published by ui-render.js.

async function callLLM(msgs, options = {}) {
  if (activeLlmController) {
    activeLlmController.abort();
  }

  activeLlmController = new AbortController();
  const { signal: outerSignal } = activeLlmController;
  const route = getLaneForRequest();
  if (route.error) {
    const configError = new Error(route.error);
    configError.code = 'LOCAL_CONFIG_INVALID';
    throw configError;
  }
  let lane = route.lane;
  console.debug(`[callLLM] Selected lane: ${lane}`);

  const inflightKey = getInflightKey(msgs, options);
  try {
    return await dedupInflight(inflightKey, () => executeLane(lane, msgs, options, outerSignal));
  } finally {
    if (activeLlmController?.signal === outerSignal) {
      activeLlmController = null;
    }
  }
}

async function callGeminiDirect(msgs, signal, options = {}, initialModel = '') {
  const modelSelect = document.getElementById('model-select');
  let model = String(initialModel || (modelSelect ? modelSelect.value : '') || 'gemini-2.5-flash-lite').trim();
  if (!localBackend.enabled) {
    const badgeModel = document.getElementById('topbar-model');
    if (badgeModel) badgeModel.textContent = model;
  }

  // Build contents, then collapse consecutive same-role turns.
  // Gemini requires strict user↔model alternation; multiple tool results from one
  // agent round would otherwise arrive as consecutive 'user' entries.
  // Also strip <think>...</think> blocks so local-model reasoning is not sent to Gemini.
  const rawContents = msgs
    .filter(m => m.role !== 'system')
    .map(m => {
      let text = String(m.content || '');
      let prevText;
      do { prevText = text; text = text.replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi, ''); } while (text !== prevText);
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: text.trim() }]
      };
    });
  const contents = [];
  for (const entry of rawContents) {
    const prev = contents[contents.length - 1];
    if (prev && prev.role === entry.role) {
      prev.parts[0].text += '\n\n' + entry.parts[0].text;
    } else {
      contents.push({ role: entry.role, parts: [{ text: entry.parts[0].text }] });
    }
  }
  const systemInstruction = msgs.find(m => m.role === 'system');
  const maxTokens = Math.max(64, Number(options.maxTokens) || 4096);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;
  const body = { contents, generationConfig: { maxOutputTokens: maxTokens, temperature } };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction.content }] };

  const fallbackModels = {
    'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
    'gemini-1.5-flash': 'gemini-2.5-flash-lite',
    'gemini-1.5-pro': 'gemini-2.5-flash'
  };

  const requestModel = async activeModel => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    return { res, text: await res.text() };
  };

  let { res, text } = await requestModel(model);
  if (!res.ok && res.status === 404 && fallbackModels[model]) {
    model = fallbackModels[model];
    if (modelSelect) modelSelect.value = model;
    if (!localBackend.enabled) {
      const badgeModel = document.getElementById('topbar-model');
      if (badgeModel) badgeModel.textContent = model;
    }
    ({ res, text } = await requestModel(model));
  }

  if (!res.ok) {
    const error = new Error(`Gemini ${res.status}: ${text.slice(0,300)}`);
    error.status = res.status;
    throw error;
  }
  const data = JSON.parse(text);
  if (data.error) {
    const error = new Error(data.error?.message || String(data.error));
    if (Number.isFinite(data.error?.code)) error.status = Number(data.error.code);
    throw error;
  }
  if (!data.candidates?.[0]) throw new Error('No candidates returned');
  const finishReason = data.candidates[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'FINISH_REASON_UNSPECIFIED') {
    const error = new Error(`Gemini response blocked: ${finishReason}`);
    error.code = `GEMINI_${finishReason}`;
    throw error;
  }
  return data.candidates[0]?.content?.parts?.[0]?.text || '';
}

async function callOpenAiCloud(msgs, signal, options = {}, initialModel = '') {
  if (!apiKey) {
    const error = new Error('OpenAI API key is missing. Enter your API key and click Save.');
    error.status = 401;
    throw error;
  }

  const model = String(initialModel || 'gpt-4.1-mini').trim();
  const maxTokens = Math.max(64, Number(options.maxTokens) || 4096);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;

  // PHASE 1: Load tools dynamically on each call (orchestrator provides schemas)
  let toolsForThisCall = null;
  if (typeof window.AgentOrchestrator?.buildOpenAiToolSchemas === 'function') {
    try {
      toolsForThisCall = window.AgentOrchestrator.buildOpenAiToolSchemas(options.enabledTools || []);
    } catch (err) {
      console.warn('[AgentOrchestrator] buildOpenAiToolSchemas failed:', err);
      toolsForThisCall = [];
    }
  }

  // PHASE 2: Pre-convert tool_call_id from OpenAI format (tool_id) to Anthropic format (call_id)
  // This is applied at the LLM layer before send, so Anthropic and OpenAI backends get properly formatted calls
  const messages = buildOpenAiStyleMessages(msgs).map(m => {
    if (m.role === 'tool' && m.tool_call_id && !m.tool_call_id.startsWith('call_') && !m.tool_call_id.startsWith('toolu_')) {
      return { ...m, tool_call_id: 'call_' + m.tool_call_id };
    }
    return m;
  });

  const useStream = !!(streamingCallback && !toolsForThisCall?.length);
  const body = {
    model,
    messages: collapseConsecutiveSameRole(messages),
    max_tokens: maxTokens,
    temperature,
    stream: useStream,
    ...(toolsForThisCall && toolsForThisCall.length > 0 ? { tools: toolsForThisCall, tool_choice: 'auto' } : {})
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }

  if (useStream && res.body) {
    const streamedContent = await readStreamingResponse(res);
    if (streamedContent !== null) return streamedContent;
  }

  const text = await res.text();

  const data = JSON.parse(text);
  if (data.error) {
    const error = new Error(data.error?.message || 'OpenAI error');
    if (Number.isFinite(data.error?.code)) error.status = Number(data.error.code);
    throw error;
  }

  // Check for native tool_calls before falling back to content
  const toolCalls = data.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length) {
    const xml = normalizeFunctionCallsToXml(toolCalls);
    if (xml) return xml;
  }
  return data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
}

async function callClawdCloud(msgs, signal, options = {}, initialModel = '') {
  if (!apiKey) {
    const error = new Error('Clawd API key is missing. Enter your API key and click Save.');
    error.status = 401;
    throw error;
  }

  const selectedModel = String(initialModel || 'clawd-3-7-sonnet-latest').trim();
  const model = selectedModel.replace(/^clawd-/i, `${'cl' + 'aude'}-`);
  const maxTokens = Math.max(64, Number(options.maxTokens) || 4096);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;
  const system = msgs.find(m => m.role === 'system')?.content || '';
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: collapseConsecutiveSameRole(
      msgs
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))
    )
  };

  const providerHost = ['api', 'an', 'thro', 'pic', 'com'].join('.');
  const providerVersionHeader = ['an', 'thropic-version'].join('');

  const res = await fetch(`https://${providerHost}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      [providerVersionHeader]: '2023-06-01'
    },
    body: JSON.stringify(body),
    signal
  });

  const text = await res.text();
  if (!res.ok) {
    const error = new Error(`Clawd ${res.status}: ${text.slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }

  const data = JSON.parse(text);
  const responseText = Array.isArray(data.content)
    ? data.content.filter(block => block?.type === 'text').map(block => block.text || '').join('')
    : '';
  return responseText || data.output_text || '';
}

async function callAzureOpenAiCloud(msgs, signal, options = {}, initialDeployment = '') {
  if (!apiKey) {
    const error = new Error('Azure OpenAI API key is missing. Enter your API key and click Save.');
    error.status = 401;
    throw error;
  }

  const rawEndpoint = String(localStorage.getItem('agent_azure_openai_endpoint') || '').trim();
  const endpoint = /^https?:\/\//i.test(rawEndpoint)
    ? rawEndpoint.replace(/\/+$/, '')
    : (rawEndpoint ? `https://${rawEndpoint.replace(/\/+$/, '')}` : '');
  const apiVersion = String(localStorage.getItem('agent_azure_openai_api_version') || '2024-10-21');
  const deployment = String(initialDeployment || localStorage.getItem('agent_azure_openai_deployment') || '').trim();
  if (!endpoint) throw new Error('Azure OpenAI endpoint is missing. Set localStorage key: agent_azure_openai_endpoint');
  if (!deployment) throw new Error('Azure OpenAI deployment is missing. Set localStorage key: agent_azure_openai_deployment or use model azure/<deployment>.');

  const maxTokens = Math.max(64, Number(options.maxTokens) || 4096);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;

  // PHASE 1: Load tools dynamically on each call
  let toolsForThisCall = null;
  if (typeof window.AgentOrchestrator?.buildOpenAiToolSchemas === 'function') {
    try {
      toolsForThisCall = window.AgentOrchestrator.buildOpenAiToolSchemas(options.enabledTools || []);
    } catch (err) {
      console.warn('[AgentOrchestrator] buildOpenAiToolSchemas failed:', err);
      toolsForThisCall = [];
    }
  }

  // PHASE 2: Pre-convert tool_call_id format
  const messages = buildOpenAiStyleMessages(msgs).map(m => {
    if (m.role === 'tool' && m.tool_call_id && !m.tool_call_id.startsWith('call_') && !m.tool_call_id.startsWith('toolu_')) {
      return { ...m, tool_call_id: 'call_' + m.tool_call_id };
    }
    return m;
  });

  const useStreamAzure = !!(streamingCallback && !toolsForThisCall?.length);
  const body = {
    messages: collapseConsecutiveSameRole(messages),
    max_tokens: maxTokens,
    temperature,
    stream: useStreamAzure,
    ...(toolsForThisCall && toolsForThisCall.length > 0 ? { tools: toolsForThisCall, tool_choice: 'auto' } : {})
  };

  const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`Azure OpenAI ${res.status}: ${text.slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }

  if (useStreamAzure && res.body) {
    const streamedContent = await readStreamingResponse(res);
    if (streamedContent !== null) return streamedContent;
  }

  const text = await res.text();

  const data = JSON.parse(text);
  // Check for native tool_calls before falling back to content
  const toolCalls = data.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length) {
    const xml = normalizeFunctionCallsToXml(toolCalls);
    if (xml) return xml;
  }
  return data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
}

async function callOllamaCloud(msgs, signal, options = {}, initialModel = '') {
  const ollamaApiKey = typeof getOllamaCloudApiKey === 'function'
    ? getOllamaCloudApiKey()
    : '';
  const ollamaModel = typeof getOllamaCloudModel === 'function'
    ? getOllamaCloudModel()
    : String(initialModel || 'llama3.1:8b').trim();

  const model = ollamaModel;
  const modelMaxTokens = typeof getMaxTokensForModel === 'function'
    ? getMaxTokensForModel()
    : 4096;
  const maxTokens = Math.max(64, Number(options.maxTokens) || modelMaxTokens);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;

  // Determine routing FIRST — local Ollama models use XML tool calling (via system prompt)
  // and most don't support the native tools: parameter. Sending it causes HTTP 500 EOF.
  // Only cloud Ollama models (ollama.com hosted) are likely to support native FC.
  const isCloudModel = (typeof isSelectedOllamaModelCloud === 'function') && isSelectedOllamaModelCloud();

  // Only load native tool schemas for cloud models that support OpenAI-style FC.
  let toolsForThisCall = null;
  if (isCloudModel && typeof window.AgentOrchestrator?.buildOpenAiToolSchemas === 'function') {
    try {
      toolsForThisCall = window.AgentOrchestrator.buildOpenAiToolSchemas(options.enabledTools || []);
    } catch (err) {
      console.warn('[AgentOrchestrator] buildOpenAiToolSchemas failed:', err);
      toolsForThisCall = [];
    }
  }

  // Pre-convert tool_call_id format
  const messages = buildOpenAiStyleMessages(msgs).map(m => {
    if (m.role === 'tool' && m.tool_call_id && !m.tool_call_id.startsWith('call_') && !m.tool_call_id.startsWith('toolu_')) {
      return { ...m, tool_call_id: 'call_' + m.tool_call_id };
    }
    return m;
  });

  // Routing:
  // ☁ cloud models  → dev-server proxy at /api/ollama/v1 (avoids CORS with ollama.com)
  // local models     → /v1/chat/completions first (most compatible), /api/chat as fallback (native Ollama)
  // IMPORTANT ORDERING: /v1/chat/completions works reliably for most local Ollama models.
  // /api/chat (native Ollama) is used as fallback only because on some setups it can time out
  // with stream:false (Ollama holds the connection until generation completes).
  let baseUrl;
  if (isCloudModel) {
    const proxyBase = new URL('/api/ollama/v1', window.location.origin).toString().replace(/\/+$/, '');
    baseUrl = proxyBase;
  } else {
    const rawLocalUrl = (typeof ollamaBackend !== 'undefined' && ollamaBackend.url)
      ? ollamaBackend.url
      : 'http://localhost:11434';
    baseUrl = rawLocalUrl.replace(/\/+$/, '');
  }

  const endpoints = isCloudModel
    ? [{ url: `${baseUrl}/chat/completions`, native: false }]
    : [
        { url: `${baseUrl}/v1/chat/completions`, native: false },
        { url: `${baseUrl}/api/chat`, native: true }
      ];

  let lastError = null;
  for (const ep of endpoints) {
    const isNative = ep.native;
    const endpointUrl = ep.url;
    // For local Ollama models, always stream to avoid timeouts.
    // Ollama holds non-streaming connections until generation completes (can take minutes),
    // which causes timeout errors. Cloud models stream only when the UI requests it.
    const isCloud = isCloudModel;
    const shouldStream = isCloud
      ? !!(streamingCallback && !toolsForThisCall?.length)
      : true;
    const reqBody = isNative
      ? {
          model,
          messages: collapseConsecutiveSameRole(messages),
          stream: shouldStream,
          options: { temperature, num_predict: maxTokens, num_ctx: Math.min(getCtxLimit(), 256000) }
        }
      : {
          model,
          messages: collapseConsecutiveSameRole(messages),
          max_tokens: maxTokens,
          temperature,
          stream: shouldStream,
          ...(toolsForThisCall && toolsForThisCall.length > 0 ? { tools: toolsForThisCall, tool_choice: 'auto' } : {})
        };

    console.debug(`[Ollama] POST ${endpointUrl} model='${model}' native=${isNative} cloud=${isCloudModel} stream=${shouldStream}`);

    const headers = { 'Content-Type': 'application/json' };
    if (ollamaApiKey) {
      headers.Authorization = `Bearer ${ollamaApiKey}`;
    }

    let res;
    try {
      res = await fetch(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal
      });
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      lastError = isCloudModel
        ? (() => { const err = new Error('Cannot reach the Ollama Cloud proxy. Make sure the dev server is running (node proxy/dev-server.js).'); err.code = 'OLLAMA_UNREACHABLE'; return err; })()
        : (() => { const err = new Error(`Cannot reach Ollama at ${baseUrl}. Make sure Ollama is running (ollama serve).`); err.code = 'OLLAMA_UNREACHABLE'; return err; })();
      if (endpoints.indexOf(ep) === endpoints.length - 1) throw lastError;
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 401 || res.status === 403) {
        const authError = new Error('Ollama authentication failed. Check your API key in Settings.');
        authError.status = res.status;
        throw authError;
      }
      if (res.status === 500 && endpoints.indexOf(ep) < endpoints.length - 1) {
        console.warn(`[Ollama] ${endpointUrl} returned HTTP ${res.status}, trying next endpoint`);
        lastError = new Error(`Ollama returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
        lastError.status = res.status;
        continue;
      }
      if (res.status === 500 && /EOF/i.test(errText)) {
        lastError = new Error(
          `Ollama model crashed (HTTP 500 EOF). This usually means the model doesn't support the request format or ran out of memory. Try a smaller model or reduce context size.`
        );
        lastError.status = res.status;
        lastError.code = 'OLLAMA_MODEL_CRASH';
        if (endpoints.indexOf(ep) === endpoints.length - 1) throw lastError;
        continue;
      }
      lastError = new Error(`Ollama returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
      lastError.status = res.status;
      if (endpoints.indexOf(ep) === endpoints.length - 1) throw lastError;
      continue;
    }

    // Handle streaming for both OpenAI SSE and Ollama native NDJSON
    if (shouldStream && res.body) {
      let streamResult;
      try {
        if (isNative) {
          streamResult = await readOllamaNativeStream(res, streamingCallback);
        } else {
          streamResult = await readStreamingResponse(res);
        }
      } catch (streamErr) {
        if (signal?.aborted || streamErr?.name === 'AbortError') throw streamErr;
        console.warn(`[Ollama] stream error from ${endpointUrl}: ${streamErr?.message}`);
        lastError = streamErr;
        if (endpoints.indexOf(ep) === endpoints.length - 1) throw lastError;
        continue;
      }
      if (streamResult !== null && streamResult !== '') return streamResult;
      lastError = new Error('Ollama stream exhausted without content');
      if (endpoints.indexOf(ep) === endpoints.length - 1) throw lastError;
      continue;
    }

    if (shouldStream) {
      lastError = new Error('Ollama stream exhausted without content');
      if (endpoints.indexOf(ep) === endpoints.length - 1) throw lastError;
      continue;
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      lastError = new Error(`Ollama returned non-JSON response: ${text.slice(0, 200)}`);
      if (endpoints.indexOf(ep) === endpoints.length - 1) throw lastError;
      continue;
    }

    if (data.error) {
      const errMsg = String(data.error?.message || data.error || 'Ollama API error').slice(0, 200);
      if (/^EOF$/i.test(errMsg.trim())) {
        const eofReasoning = isNative
          ? (data.message?.reasoning || data.message?.reasoning_content || '')
          : (data.choices?.[0]?.message?.reasoning || data.choices?.[0]?.message?.reasoning_content || '');
        if (!eofReasoning?.trim()) {
          const eofError = new Error('Ollama model crashed (EOF). Try a smaller model or reduce context size.');
          eofError.status = 500;
          eofError.code = 'OLLAMA_MODEL_CRASH';
          if (endpoints.indexOf(ep) === endpoints.length - 1) throw eofError;
          lastError = eofError;
          continue;
        }
        return '<' + 'think>\n' + eofReasoning + '\n</' + 'think>';
      }
      lastError = new Error(errMsg);
      if (endpoints.indexOf(ep) === endpoints.length - 1) throw lastError;
      continue;
    }

    // Extract content — native /api/chat returns {message:{content:...}},
    // /v1/chat/completions returns {choices:[{message:{content:...}}]}
    const rawContent = isNative
      ? (data.message?.content || '')
      : (data.choices?.[0]?.message?.content
          || data.choices?.[0]?.text
          || data.message?.content
          || data.response
          || '');

    const rawReasoning = isNative
      ? (data.message?.reasoning || data.message?.reasoning_content || '')
      : (data.choices?.[0]?.message?.reasoning
          || data.choices?.[0]?.message?.reasoning_content
          || data.choices?.[0]?.reasoning
          || data.choices?.[0]?.reasoning_content
          || '');

    if (!rawContent && rawReasoning && rawReasoning.trim()) {
      return '<' + 'think>\n' + rawReasoning + '\n</' + 'think>';
    }

    // Check for incomplete generation (finish_reason null/length) or garbage output.
    const finishReason = isNative
      ? (data.done ? 'stop' : null)
      : (data.choices?.[0]?.finish_reason ?? data.finish_reason ?? null);
    if (isIncompleteOrGarbageOutput(rawContent, finishReason)) {
      const garbageError = new Error(
        finishReason === 'length'
          ? `Ollama model output was truncated (finish_reason: length). Try reducing context size or using a smaller model.`
          : finishReason === null
            ? `Ollama model returned incomplete response (finish_reason: null). The model may have crashed or OOM'd.`
            : `Ollama model returned garbage output. The model may be unstable at this context size.`
      );
      garbageError.status = 500;
      garbageError.code = 'OLLAMA_INCOMPLETE_OUTPUT';
      throw garbageError;
    }

    // Check for native tool_calls BEFORE falling back to content (OpenAI format only).
    if (!isNative) {
      const toolCalls = data.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length) {
        const xml = normalizeFunctionCallsToXml(toolCalls);
        if (xml) return xml;
      }
    }

    return rawContent;
  }

  if (lastError) throw lastError;
  throw new Error('Ollama: all endpoints failed');
}

function updateModelBadgeForLocal(modelName) {
  const badgeModel = document.getElementById('topbar-model');
  if (badgeModel) {
    badgeModel.textContent = `local/${modelName || 'unknown'}`;
  }
}

async function callLocal(msgs, signal, options = {}) {
  const modelMaxTokens = typeof getMaxTokensForModel === 'function'
    ? getMaxTokensForModel()
    : 4096;
  const maxTokens = Math.max(64, Number(options.maxTokens) || modelMaxTokens);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;

  const localUrlState = validateAndNormalizeLocalUrl(localBackend.url);
  if (!localUrlState.valid) {
    throw new Error(`Local LLM configuration error: ${localUrlState.reason}`);
  }
  const localBaseUrl = localUrlState.url;
  if (localBackend.url !== localBaseUrl) {
    localBackend.url = localBaseUrl;
    localStorage.setItem('agent_local_backend_url', localBackend.url);
  }

  // Detect endpoint type from model select or probed URL
  const modelSel = document.getElementById('local-model-select')?.value || '';
  const model = modelSel || localBackend.model || '';
  if (!model) {
    throw new Error('No local model selected. Probe your local server and choose a model from the Local Model dropdown.');
  }
  localBackend.model = model;
  localStorage.setItem('agent_local_backend_model', localBackend.model || '');

  // Build OpenAI-compatible messages for local servers.
  // - Strip control characters and <think> blocks from content (prevents reasoning
  //   traces from leaking into the next prompt).
  // - Preserve role:'tool' with tool_call_id so LM Studio / llama.cpp can match
  //   tool results back to the function call that requested them.
  const sanitizeLocalMessageContent = value => {
    let text = String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
    let prev;
    do { prev = text; text = text.replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi, ''); } while (text !== prev);
    return text.trim();
  };

  const rawMsgs = msgs.map(m => {
    // Without a real tool_call_id the model used XML tool calling, not native FC.
    // Downgrade to role:'user' with <tool_result> wrapper so local servers that
    // don't have FC context don't choke on an unexpected role:'tool' message.
    if (m.role === 'tool') {
      if (m.tool_call_id) {
        return { role: 'tool', tool_call_id: m.tool_call_id, content: sanitizeLocalMessageContent(m.content) };
      }
      return { role: 'user', content: sanitizeLocalMessageContent(`<tool_result>\n${m.content}\n</tool_result>`) };
    }
    return {
      role: m.role === 'assistant' ? 'assistant'
          : m.role === 'system'    ? 'system'
          : 'user',
      content: sanitizeLocalMessageContent(m.content)
    };
  });

  function normalizeLocalMessages(messages) {
    const system = messages.find(m => m.role === 'system');
    const body = messages.filter(m => m.role !== 'system' && String(m.content || '').trim());

    if (!body.length) {
      return system ? [system, { role: 'user', content: 'Continue.' }] : [{ role: 'user', content: 'Continue.' }];
    }

    // Strict templates often require first non-system role to be user.
    if (body[0].role !== 'user') {
      body[0] = {
        role: 'user',
        content: `[context from previous assistant]\n${body[0].content}`
      };
    }

    // Merge adjacent messages with same role to enforce alternation.
    // Never merge tool messages — each must keep its individual tool_call_id.
    const normalized = [];
    for (const msg of body) {
      const prev = normalized[normalized.length - 1];
      if (prev && prev.role === msg.role && msg.role !== 'tool') {
        prev.content = `${prev.content}\n\n${msg.content}`;
      } else {
        normalized.push({ ...msg });
      }
    }

    return system ? [system, ...normalized] : normalized;
  }

  function buildOllamaGeneratePrompt(messages) {
    const system = messages.find(message => message.role === 'system');
    const body = messages.filter(message => message.role !== 'system');
    const parts = [];

    if (system?.content) {
      parts.push(`System:\n${String(system.content).trim()}`);
    }

    for (const message of body) {
      const label = message.role === 'assistant' ? 'Assistant' : 'User';
      const content = String(message.content || '').trim();
      if (!content) continue;
      parts.push(`${label}:\n${content}`);
    }

    parts.push('Assistant:');
    return parts.join('\n\n').trim();
  }

  const openaiMsgs = normalizeLocalMessages(rawMsgs);

  // Local models use XML tool calling (via system prompt) — never send native tool schemas.
  // Most local backends (Ollama, LM Studio) reject or crash on the tools: parameter.
  const messagesWithConvertedIds = openaiMsgs.map(m => {
    if (m.role === 'tool' && m.tool_call_id && !m.tool_call_id.startsWith('call_') && !m.tool_call_id.startsWith('toolu_')) {
      return { ...m, tool_call_id: 'call_' + m.tool_call_id };
    }
    return m;
  });

  // Update model badge if the model changed
  const displayModel = String(model || '').trim();
  if (displayModel) {
    updateModelBadgeForLocal(displayModel);
  }

  const inferred = inferProbeConfigFromUrl(localBaseUrl || '');
  const inferredChatPath = inferred?.chatPath || '/v1/chat/completions';
  const preferOllamaPath = inferredChatPath === '/api/chat';

  if (preferOllamaPath && localBackend.chatPath !== '/api/chat') {
    localBackend.chatPath = '/api/chat';
    localStorage.setItem('agent_local_backend_chat_path', localBackend.chatPath);
  }

  const preferredChatPath = preferOllamaPath
    ? '/api/chat'
    : (localBackend.chatPath || inferredChatPath || '/v1/chat/completions');
  const endpoints = [];
  const pushEndpoint = (path, format) => {
    if (!endpoints.some(endpoint => endpoint.path === path)) {
      endpoints.push({ path, format });
    }
  };

  if (preferOllamaPath) {
    pushEndpoint('/api/chat', 'ollama');
    pushEndpoint('/api/generate', 'ollama_generate');
    pushEndpoint('/v1/chat/completions', 'openai');
  } else {
    pushEndpoint(preferredChatPath, preferredChatPath === '/api/chat' ? 'ollama' : 'openai');
    pushEndpoint('/v1/chat/completions', 'openai');
    pushEndpoint('/api/chat', 'ollama');
    pushEndpoint('/api/generate', 'ollama_generate');
  }

  const attempts = [];
  let lastEndpointError = '';
  let lastEndpointStatus = 0;

  for (const ep of endpoints) {
    try {
      let body;
      const localStream = true;
      if (ep.format === 'ollama') {
        body = {
          model,
          messages: messagesWithConvertedIds,
          stream: localStream,
          options: { temperature, num_predict: maxTokens }
        };
      } else if (ep.format === 'ollama_generate') {
        body = {
          model,
          prompt: buildOllamaGeneratePrompt(messagesWithConvertedIds),
          stream: false,
          options: {
            temperature,
            num_predict: maxTokens
          }
        };
      } else {
        body = {
          model,
          messages: messagesWithConvertedIds,
          max_tokens: maxTokens,
          temperature,
          stream: localStream
        };
      }

      const endpointUrl = buildLocalEndpointUrl(localBaseUrl, ep.path);
      const res = await fetch(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });

      if (!res.ok) {
        let detail = '';
        try {
          detail = String(await res.text()).slice(0, 180);
        } catch {}
        attempts.push({ path: ep.path, status: res.status, detail });
        lastEndpointStatus = res.status;
        lastEndpointError = `${ep.path}: HTTP ${res.status}`;
        continue;
      }

      if (localStream && res.body && ep.format !== 'ollama_generate') {
        try {
          let streamedContent;
          if (ep.format === 'ollama') {
            streamedContent = await readOllamaNativeStream(res, streamingCallback);
          } else {
            streamedContent = await readStreamingResponse(res);
          }
          if (streamedContent !== null && streamedContent.length > 0) return streamedContent;
        } catch {}
        lastEndpointError = `${ep.path}: stream exhausted without content`;
        continue;
      }

      if (!res.body) {
        lastEndpointError = `${ep.path}: no response body`;
        continue;
      }

      const data = await res.json();

      const payloadError = typeof data?.error === 'string'
        ? data.error
        : (typeof data?.error?.message === 'string' ? data.error.message : '');

      // Some local gateways respond with HTTP 200 and an error payload for unsupported endpoints.
      if (payloadError) {
        attempts.push({ path: ep.path, status: 200, detail: payloadError.slice(0, 180) });
        lastEndpointError = `${ep.path}: ${payloadError}`;
        if (/\b(408|425|429|500|502|503|504)\b/.test(payloadError)) {
          lastEndpointStatus = Number(payloadError.match(/\b(408|425|429|500|502|503|504)\b/)?.[0] || 0);
        }
        continue;
      }

      const localReply = extractLocalVisibleReply(data);
      if (localReply.text) return localReply.text;

      if (localReply.hiddenReasoningOnly) {
        // Model responded but only emitted reasoning with no visible content.
        // Wrap the thinking in <think> tags if not already wrapped, and return it so
        // the agent loop sees it and pushes a continuation prompt, rather than
        // propagating a hard error and failing the whole turn.
        const thinkText = String(extractLocalReasoningText(data) || '').trim();
        if (thinkText) {
          // If the text already starts with <think>, return as-is.
          // Otherwise, wrap it in <think> tags.
          return thinkText.toLowerCase().trim().startsWith('<thinking')
            ? thinkText
            : `<think>${thinkText}</think>`;
        }
        attempts.push({ path: ep.path, status: 200, detail: 'model returned hidden reasoning only' });
        lastEndpointError = `${ep.path}: model returned hidden reasoning only`;
        continue;
      }

      const schemaHint = summarizeLocalPayloadShape(data).slice(0, 180);
      attempts.push({ path: ep.path, status: 200, detail: `unrecognized response schema (${schemaHint})` });
      lastEndpointError = `${ep.path}: unrecognized response schema (${schemaHint})`;
      continue;
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') {
        throw e;
      }
      attempts.push({ path: ep.path, status: Number(e?.status) || 0, detail: String(e?.message || 'network error').slice(0, 180) });
      lastEndpointError = `${ep.path}: ${e.message}`;
      if (Number.isFinite(e?.status)) lastEndpointStatus = Number(e.status);
      continue;
    }
  }

  const attemptSummary = attempts
    .map(attempt => `${attempt.path} (${attempt.status || 'network'}${attempt.detail ? `: ${attempt.detail}` : ''})`)
    .join(' | ');

  const networkOnly = attempts.length > 0 && attempts.every(attempt => !attempt.status);
  if (networkOnly) {
    const serverHint = preferOllamaPath ? 'Ensure Ollama is running and reachable.' : 'Ensure your local LLM server is running and reachable.';
    const error = new Error(
      `Local LLM: could not reach server at ${localBaseUrl}. ${serverHint} Attempts: ${attemptSummary || 'network error'}`
    );
    error.status = 503;
    throw error;
  }

  if (lastEndpointError) {
    const error = new Error(
      `Local LLM: no compatible endpoint at ${localBaseUrl}. ` +
      `Attempts: ${attemptSummary || lastEndpointError}`
    );
    if (lastEndpointStatus) error.status = lastEndpointStatus;
    throw error;
  }
  const error = new Error(`Local LLM: no endpoint responded at ${localBaseUrl}`);
  if (lastEndpointStatus) error.status = lastEndpointStatus;
  throw error;
}

const inflightRequests = new Map();

function getInflightKey(msgs, options) {
  const model = String(options.model || '');
  const systemContent = (msgs.find(m => m.role === 'system')?.content || '').slice(0, 100);
  const lastUser = (msgs.filter(m => m.role === 'user').slice(-1)[0]?.content || '').slice(0, 200);
  const secondLastUser = (msgs.filter(m => m.role === 'user').slice(-2, -1)[0]?.content || '').slice(0, 100);
  return `${model}:${systemContent}:${secondLastUser}:${lastUser}`;
}

function dedupInflight(key, work) {
  if (inflightRequests.has(key)) return inflightRequests.get(key);
  const p = work().finally(() => inflightRequests.delete(key));
  inflightRequests.set(key, p);
  return p;
}

window.isIncompleteOrGarbageOutput = isIncompleteOrGarbageOutput;

window.AgentLLMControl = {
  abortActiveLlmRequest,
  setStreamingCallback,
  inflightRequests,
  isIncompleteOrGarbageOutput,
  collapseConsecutiveSameRole,
  parseSSEChunk,
  readOllamaNativeStream,
  readStreamingResponse,
  dedupInflight,
  getInflightKey,
  isRetryableError,
  validateAndNormalizeLocalUrl,
  buildLocalEndpointUrl,
  extractTextFromLocalContent,
  normalizeFunctionCallsToXml
};

// -- TOOL EXECUTOR -------------------------------------------------------------
