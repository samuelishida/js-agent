// src/app/llm/llm-utils.js
// Shared LLM utilities: SSE parsing, streaming, retry, dedup, message normalization.

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
                return '\u003cthink\u003e\n' + fullReasoning + '\n\u003c/think\u003e';
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
  } finally { reader.releaseLock(); }
  return fullContent;
}

async function readStreamingResponse(response, onChunk) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let fullReasoning = '';
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
          if (event.done) { reader.cancel(); return fullContent; }
          const delta = event.parsed?.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            if (onChunk) onChunk(delta.content, fullContent);
          }
          if (delta?.reasoning) {
            fullReasoning += delta.reasoning;
          }
        }
      }
    }
  } finally { reader.releaseLock(); }
  return fullContent;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('Aborted')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('Aborted')); }, { once: true });
  });
}

function isRetryableError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return false;
  if (error.code === 'OLLAMA_CLOUD_CORS_BLOCKED' || error.code === 'OLLAMA_PROXY_NOT_CONFIGURED') return false;
  const message = String(error.message || '');
  if (/EOF.*api_erro|api_erro.*EOF/i.test(message)) return false;
  if (error.code === 'OLLAMA_INCOMPLETE_OUTPUT' || error.code === 'LOCAL_INCOMPLETE_OUTPUT' || error.code === 'OLLAMA_MODEL_CRASH') return false;
  const status = Number(error.status);
  if (LLM_RETRY_STATUSES.has(status)) return true;
  if (/\b(408|425|429|500|502|503|504)\b/.test(message)) return true;
  if (/(timeout|timed out|network|failed to fetch|rate limit|temporarily unavailable|overloaded)/i.test(message)) return true;
  return false;
}

async function retryWithBackoff(fn, { maxAttempts = 3, baseMs = 700, maxMs = 6000, jitterMs = 180 } = {}) {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (error) {
      attempt++;
      if (attempt >= maxAttempts || !isRetryableError(error)) throw error;
      const wait = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1)) + Math.random() * jitterMs;
      console.warn(`[retryWithBackoff] attempt ${attempt}/${maxAttempts} failed, retrying in ${Math.round(wait)}ms`);
      await delay(wait);
    }
  }
}

function validateAndNormalizeLocalUrl(rawUrl) {
  const original = String(rawUrl || '').trim();
  if (!original) {
    return { valid: false, url: '', reason: 'local backend URL is empty' };
  }

  const schemeMatch = original.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (schemeMatch && !/^https?:/i.test(schemeMatch[1])) {
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

    return { valid: true, url: normalized };
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

function normalizeFunctionCallsToXml(toolCallsArr) {
  if (!Array.isArray(toolCallsArr) || !toolCallsArr.length) return '';
  const blocks = toolCallsArr.map(tc => {
    const fn = tc?.function;
    if (!fn) return '';

    let nameJson = null;
    try { nameJson = JSON.parse(fn.name); } catch { /* not JSON — normal */ }
    if (nameJson && typeof nameJson === 'object') {
      const toolName = nameJson.tool || nameJson.name || null;
      if (toolName) {
        const args = nameJson.args ?? nameJson.parameters ?? nameJson.input ?? nameJson.arguments ?? {};
        return `\u003ctool_call\u003e\n${JSON.stringify({ tool: String(toolName), args: args || {}, ...(tc.id ? { id: tc.id } : {}) })}\n\u003c/tool_call\u003e`;
      }
    }

    const toolName = String(fn.name || '').trim();
    if (!toolName) return '';
    let args = {};
    try { args = JSON.parse(fn.arguments || '{}'); } catch { /* malformed args */ }
    const argsVal = args.args ?? args.parameters ?? args.input ?? args.inputs ?? args.arguments ?? args;
    return `\u003ctool_call\u003e\n${JSON.stringify({ tool: toolName, args: argsVal, ...(tc.id ? { id: tc.id } : {}) })}\n\u003c/tool_call\u003e`;
  }).filter(Boolean);

  if (!blocks.length) return '';
  console.debug(`[LLM] normalizeFunctionCallsToXml: converted ${blocks.length} tool_call(s)`);
  return blocks.join('\n');
}

function extractLocalVisibleReply(data) {
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
      return { text, hiddenReasoningOnly: false };
    }
  }

  const hasHiddenReasoning = !!String(extractLocalReasoningText(data) || '').trim();
  return { text: '', hiddenReasoningOnly: hasHiddenReasoning };
}

function buildOpenAiStyleMessages(msgs) {
  return msgs.map(m => {
    let content = String(m.content || '');
    let prev;
    do {
      prev = content;
      content = content.replace(/\u003cthink(?:\s[^\u003e]*)?\u003e[\s\S]*?\u003c\/think\u003e/gi, '');
    } while (content !== prev);
    content = content.trim();

    if (m.role === 'tool') {
      if (m.tool_call_id) {
        return { role: 'tool', tool_call_id: m.tool_call_id, content };
      }
      return { role: 'user', content: `\u003ctool_result${m.name ? ` tool="${m.name}"` : ''}\u003e\n${content}\n\u003c/tool_result\u003e` };
    }
    return {
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content
    };
  });
}

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

function getInflightKey(msgs, options) {
  const model = String(options.model || '');
  const systemContent = (msgs.find(m => m.role === 'system')?.content || '').slice(0, 100);
  const lastUser = (msgs.filter(m => m.role === 'user').slice(-1)[0]?.content || '').slice(0, 200);
  const secondLastUser = (msgs.filter(m => m.role === 'user').slice(-2, -1)[0]?.content || '').slice(0, 100);
  return `${model}:${systemContent}:${secondLastUser}:${lastUser}`;
}

function dedupInflight(key, work) {
  if (!window._llmInflight) window._llmInflight = new Map();
  const existing = window._llmInflight.get(key);
  if (existing) return existing;
  const p = work().finally(() => window._llmInflight.delete(key));
  window._llmInflight.set(key, p);
  return p;
}

window.AgentLLMUtils = {
  LLM_RETRY_STATUSES,
  isIncompleteOrGarbageOutput,
  parseSSEChunk,
  readOllamaNativeStream,
  readStreamingResponse,
  delay,
  isRetryableError,
  retryWithBackoff,
  validateAndNormalizeLocalUrl,
  buildLocalEndpointUrl,
  extractTextFromLocalContent,
  extractLocalReasoningText,
  summarizeLocalPayloadShape,
  normalizeFunctionCallsToXml,
  extractLocalVisibleReply,
  buildOpenAiStyleMessages,
  collapseConsecutiveSameRole,
  getInflightKey,
  dedupInflight
};
