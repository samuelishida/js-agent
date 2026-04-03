let activeLlmController = null;

const LLM_RATE_LIMIT_MS = {
  local: 250,
  cloud: 1200
};

const LLM_TIMEOUT_MS = {
  local: 90000,
  cloud: 45000,
  control: 20000
};

const LLM_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const laneState = {
  local: { chain: Promise.resolve(), nextAt: 0 },
  cloud: { chain: Promise.resolve(), nextAt: 0 }
};

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

  const status = Number(error.status);
  if (LLM_RETRY_STATUSES.has(status)) return true;

  const message = String(error.message || '');
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

    return {
      valid: true,
      url: parsed.origin.replace(/\/+$/, '')
    };
  } catch {
    return { valid: false, url: '', reason: 'local backend URL is not a valid URL' };
  }
}

function getLaneForRequest() {
  if (localBackend.enabled) {
    const localUrlState = validateAndNormalizeLocalUrl(localBackend.url);
    if (!localUrlState.valid) {
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
  return lane === 'local' ? LLM_RATE_LIMIT_MS.local : LLM_RATE_LIMIT_MS.cloud;
}

function getTimeoutMs(lane, options = {}) {
  const configured = Number(options.timeoutMs);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1000, configured);
  }

  const maxTokens = Number(options.maxTokens) || 0;
  const isControlCall = maxTokens > 0 && maxTokens <= 300;
  if (isControlCall) return LLM_TIMEOUT_MS.control;
  return lane === 'local' ? LLM_TIMEOUT_MS.local : LLM_TIMEOUT_MS.cloud;
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

async function callGemini(msgs, options = {}) { return callLLM(msgs, options); }

function getSelectedCloudModel() {
  const modelSelect = document.getElementById('model-select');
  return String(modelSelect?.value || '').trim();
}

function parseCloudProviderModel(rawModel) {
  const model = String(rawModel || '').trim();
  if (!model) return { provider: 'gemini', model: 'gemini-2.5-flash' };

  const prefixed = model.match(/^(gemini|openai|claude|azure|ollama)\/(.+)$/i);
  if (prefixed) {
    return {
      provider: prefixed[1].toLowerCase(),
      model: String(prefixed[2] || '').trim()
    };
  }

  return { provider: 'gemini', model };
}

function buildOpenAiStyleMessages(msgs) {
  return msgs.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: String(m.content || '')
  }));
}

async function callCloud(msgs, signal, options = {}) {
  const selected = parseCloudProviderModel(getSelectedCloudModel());
  const provider = String(options.provider || selected.provider || 'gemini').toLowerCase();
  const model = String(options.model || selected.model || '').trim();

  if (!localBackend.enabled) {
    const badgeModel = document.getElementById('badge-model');
    if (badgeModel) {
      badgeModel.textContent = provider === 'gemini'
        ? model
        : `${provider}/${model}`;
    }
  }

  if (provider === 'openai') return callOpenAiCloud(msgs, signal, options, model);
  if (provider === 'claude') return callClaudeCloud(msgs, signal, options, model);
  if (provider === 'azure') return callAzureOpenAiCloud(msgs, signal, options, model);
  if (provider === 'ollama') return callOllamaCloud(msgs, signal, options, model);
  return callGeminiDirect(msgs, signal, options, model);
}

function sanitizeModelReply(text) {
  return splitModelReply(text).visible;
}

const SAFE_HTML_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's',
  'ul', 'ol', 'li', 'code', 'pre', 'blockquote',
  'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'h1', 'h2', 'h3', 'h4', 'hr', 'div', 'span'
]);

const SAFE_HTML_ATTRS = {
  a: new Set(['href', 'title']),
  th: new Set(['colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan'])
};

function extractThinkingBlocks(text) {
  return [...String(text || '').matchAll(/<think>\s*([\s\S]*?)\s*<\/think>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
}

function normalizeVisibleModelText(text) {
  let value = String(text || '').trim();
  if (!value) return '';

  value = value
    .replace(/^```(?:xml|html)?\s*([\s\S]*?)\s*```$/i, '$1')
    .trim();

  // Some models prepend a literal "markdown" token before the actual answer.
  value = value.replace(/^markdown\s+(?=[#>*\-\d`\[]|\w)/i, '');

  return value.trim();
}

function splitModelReply(text) {
  const raw = String(text || '');
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  return {
    raw,
    thinkingBlocks: extractThinkingBlocks(raw),
    visible: normalizeVisibleModelText(withoutThinking)
  };
}

function looksLikeHtmlFragment(text) {
  return /<\/?[a-z][^>]*>/i.test(String(text || ''));
}

function escapeInlineHtml(text) {
  return escHtml(String(text || ''));
}

function renderInlineMarkdown(text) {
  let value = escapeInlineHtml(text);
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+|tel:[^\s)]+)\)/g, '<a href="$2">$1</a>');
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  value = value.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  value = value.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  return value;
}

function renderMarkdownBlocks(text) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) return '<p></p>';

  const lines = source.split('\n');
  const html = [];
  let i = 0;

  const isUl = line => /^(\s*[-*+]\s+)/.test(line);
  const isOl = line => /^(\s*\d+\.\s+)/.test(line);
  const isQuote = line => /^\s*>\s?/.test(line);

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    const fence = trimmed.match(/^```([\w-]+)?\s*$/);
    if (fence) {
      const lang = fence[1] ? ` class="language-${escapeInlineHtml(fence[1])}"` : '';
      const chunk = [];
      i++;
      while (i < lines.length && !lines[i].trim().match(/^```\s*$/)) {
        chunk.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      html.push(`<pre><code${lang}>${escapeInlineHtml(chunk.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      html.push('<hr>');
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (isQuote(line)) {
      const chunk = [];
      while (i < lines.length && isQuote(lines[i])) {
        chunk.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${chunk.map(item => `<p>${renderInlineMarkdown(item)}</p>`).join('')}</blockquote>`);
      continue;
    }

    if (isUl(line)) {
      const items = [];
      while (i < lines.length && isUl(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      html.push(`<ul>${items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (isOl(line)) {
      const items = [];
      while (i < lines.length && isOl(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      html.push(`<ol>${items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ol>`);
      continue;
    }

    const paragraph = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      const nextTrimmed = next.trim();
      if (!nextTrimmed) {
        i++;
        break;
      }
      if (
        nextTrimmed.match(/^```/) ||
        nextTrimmed.match(/^(#{1,4})\s+/) ||
        /^---+$/.test(nextTrimmed) ||
        /^\*\*\*+$/.test(nextTrimmed) ||
        isQuote(next) ||
        isUl(next) ||
        isOl(next)
      ) {
        break;
      }
      paragraph.push(next);
      i++;
    }

    html.push(`<p>${renderInlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  return html.join('');
}

function sanitizeUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(value)) return value;
  return '';
}

function sanitizeHtmlFragment(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');

  const cleanNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.textContent || '');
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return document.createDocumentFragment();
    }

    const tag = node.tagName.toLowerCase();
    if (!SAFE_HTML_TAGS.has(tag)) {
      if (['script', 'style', 'iframe', 'object', 'embed'].includes(tag)) {
        return document.createDocumentFragment();
      }

      const fragment = document.createDocumentFragment();
      [...node.childNodes].forEach(child => fragment.appendChild(cleanNode(child)));
      return fragment;
    }

    const el = document.createElement(tag);
    const allowedAttrs = SAFE_HTML_ATTRS[tag] || new Set();

    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style') continue;
      if (!allowedAttrs.has(name)) continue;

      if (tag === 'a' && name === 'href') {
        const safeHref = sanitizeUrl(attr.value);
        if (!safeHref) continue;
        el.setAttribute('href', safeHref);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
        continue;
      }

      el.setAttribute(name, attr.value);
    }

    [...node.childNodes].forEach(child => el.appendChild(cleanNode(child)));
    return el;
  };

  const fragment = document.createDocumentFragment();
  [...template.content.childNodes].forEach(child => fragment.appendChild(cleanNode(child)));
  const wrapper = document.createElement('div');
  wrapper.appendChild(fragment);
  return wrapper.innerHTML;
}

function renderAgentHtml(text) {
  const raw = String(text || '');
  if (looksLikeHtmlFragment(raw)) {
    // Backward-compatible rendering for historical messages persisted as HTML.
    return sanitizeHtmlFragment(raw);
  }

  const source = renderMarkdownBlocks(raw);
  return sanitizeHtmlFragment(source);
}

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
  const lane = route.lane;
  console.debug(`[callLLM] Selected lane: ${lane}`);
  
  const timeoutMs = getTimeoutMs(lane, options);
  const minIntervalMs = getRateLimitMs(lane, options);
  const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : (lane === 'local' ? 1 : 2);

  try {
    return await scheduleLaneExecution(lane, minIntervalMs, outerSignal, async () => {
      return retryWithBackoff(async () => {
        return runWithTimeout(async signal => {
          if (lane === 'local') {
            console.debug(`[callLLM] Executing on LOCAL lane at ${localBackend.url}`);
            return callLocal(msgs, signal, options);
          }
          console.debug(`[callLLM] Executing on CLOUD lane`);
          return callCloud(msgs, signal, options);
        }, { timeoutMs, parentSignal: outerSignal, laneLabel: lane });
      }, { retries, signal: outerSignal });
    });
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
    const badgeModel = document.getElementById('badge-model');
    if (badgeModel) badgeModel.textContent = model;
  }

  const contents = msgs
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
  const systemInstruction = msgs.find(m => m.role === 'system');
  const maxTokens = Math.max(64, Number(options.maxTokens) || 2048);
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
      const badgeModel = document.getElementById('badge-model');
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
    const error = new Error(data.error.message);
    if (Number.isFinite(data.error?.code)) error.status = Number(data.error.code);
    throw error;
  }
  if (!data.candidates?.[0]) throw new Error('No candidates returned');
  return data.candidates[0].content.parts[0].text || '';
}

async function callOpenAiCloud(msgs, signal, options = {}, initialModel = '') {
  const model = String(initialModel || 'gpt-4.1-mini').trim();
  const maxTokens = Math.max(64, Number(options.maxTokens) || 2048);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;
  const body = {
    model,
    messages: buildOpenAiStyleMessages(msgs),
    max_tokens: maxTokens,
    temperature,
    stream: false
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

  const text = await res.text();
  if (!res.ok) {
    const error = new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }

  const data = JSON.parse(text);
  if (data.error) {
    const error = new Error(data.error?.message || 'OpenAI error');
    if (Number.isFinite(data.error?.code)) error.status = Number(data.error.code);
    throw error;
  }

  return data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
}

async function callClaudeCloud(msgs, signal, options = {}, initialModel = '') {
  const model = String(initialModel || 'claude-3-7-sonnet-latest').trim();
  const maxTokens = Math.max(64, Number(options.maxTokens) || 2048);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;
  const system = msgs.find(m => m.role === 'system')?.content || '';
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: msgs
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal
  });

  const text = await res.text();
  if (!res.ok) {
    const error = new Error(`Claude ${res.status}: ${text.slice(0, 300)}`);
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
  const endpoint = String(localStorage.getItem('agent_azure_openai_endpoint') || '').replace(/\/+$/, '');
  const apiVersion = String(localStorage.getItem('agent_azure_openai_api_version') || '2024-10-21');
  const deployment = String(initialDeployment || localStorage.getItem('agent_azure_openai_deployment') || '').trim();
  if (!endpoint) throw new Error('Azure OpenAI endpoint is missing. Set localStorage key: agent_azure_openai_endpoint');
  if (!deployment) throw new Error('Azure OpenAI deployment is missing. Set localStorage key: agent_azure_openai_deployment or use model azure/<deployment>.');

  const maxTokens = Math.max(64, Number(options.maxTokens) || 2048);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;
  const body = {
    messages: buildOpenAiStyleMessages(msgs),
    max_tokens: maxTokens,
    temperature,
    stream: false
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

  const text = await res.text();
  if (!res.ok) {
    const error = new Error(`Azure OpenAI ${res.status}: ${text.slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }

  const data = JSON.parse(text);
  return data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
}

async function callOllamaCloud(msgs, signal, options = {}, initialModel = '') {
  let configuredEndpoint = String(localStorage.getItem('agent_ollama_cloud_endpoint') || 'https://ollama.com').replace(/\/+$/, '');
  // api.ollama.com responds with redirect for preflight; use canonical host to avoid that branch.
  configuredEndpoint = configuredEndpoint.replace(/^https:\/\/api\.ollama\.com$/i, 'https://ollama.com');
  const endpoint = /\/v1$/i.test(configuredEndpoint)
    ? configuredEndpoint
    : `${configuredEndpoint}/v1`;

  const model = String(initialModel || 'llama3.1:8b').trim();
  const maxTokens = Math.max(64, Number(options.maxTokens) || 2048);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;
  const body = {
    model,
    messages: buildOpenAiStyleMessages(msgs),
    max_tokens: maxTokens,
    temperature,
    stream: false
  };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let res;
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw e;

    const error = new Error(
      'Ollama Cloud request failed in browser. This is usually a CORS block. ' +
      'Use a same-origin proxy endpoint (example: /api/ollama/v1) and save it in Ollama Cloud Endpoint.'
    );
    error.code = 'OLLAMA_CLOUD_CORS_BLOCKED';
    throw error;
  }

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const authError = new Error('Ollama Cloud authentication failed. Check your API key and endpoint.');
      authError.status = res.status;
      throw authError;
    }

    const error = new Error(`Ollama Cloud ${res.status}: ${text.slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }

  const data = JSON.parse(text);
  if (data.error) {
    const error = new Error(data.error?.message || data.error || 'Ollama Cloud error');
    if (Number.isFinite(data.error?.code)) error.status = Number(data.error.code);
    throw error;
  }

  return data.choices?.[0]?.message?.content
    || data.choices?.[0]?.text
    || data.message?.content
    || data.response
    || '';
}

async function callLocal(msgs, signal, options = {}) {
    const maxTokens = Math.max(64, Number(options.maxTokens) || 2048);
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
  const modelSel = document.getElementById('local-model-select').value;
  const model = modelSel || localBackend.model || 'mistralai/ministral-3-14b-reasoning';
  localBackend.model = model;
  localStorage.setItem('agent_local_backend_model', localBackend.model || '');

  // Build OpenAI-compatible messages and normalize for strict templates that require
  // user/assistant alternation after an optional system message.
  const rawMsgs = msgs.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: String(m.content || '')
  }));

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
    const normalized = [];
    for (const msg of body) {
      const prev = normalized[normalized.length - 1];
      if (prev && prev.role === msg.role) {
        prev.content = `${prev.content}\n\n${msg.content}`;
      } else {
        normalized.push({ role: msg.role, content: msg.content });
      }
    }

    return system ? [system, ...normalized] : normalized;
  }

  const openaiMsgs = normalizeLocalMessages(rawMsgs);

  const inferred = inferProbeConfigFromUrl(localBaseUrl || '');
  const preferredChatPath = localBackend.chatPath || inferred.chatPath || '/v1/chat/completions';
  const endpoints = [];
  const pushEndpoint = (path, format) => {
    if (!endpoints.some(endpoint => endpoint.path === path)) {
      endpoints.push({ path, format });
    }
  };
  pushEndpoint(preferredChatPath, preferredChatPath === '/api/chat' ? 'ollama' : 'openai');
  pushEndpoint('/v1/chat/completions', 'openai');
  pushEndpoint('/api/chat', 'ollama');

  let lastEndpointError = '';
  let lastEndpointStatus = 0;

  for (const ep of endpoints) {
    try {
      let body;
      if (ep.format === 'ollama') {
        body = { model, messages: openaiMsgs, stream: false };
      } else {
        body = { model, messages: openaiMsgs, max_tokens: maxTokens, temperature, stream: false };
      }

      const res = await fetch(localBaseUrl + ep.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });

      if (!res.ok) {
        lastEndpointStatus = res.status;
        lastEndpointError = `${ep.path}: HTTP ${res.status}`;
        continue;
      }
      const data = await res.json();

      const payloadError = typeof data?.error === 'string'
        ? data.error
        : (typeof data?.error?.message === 'string' ? data.error.message : '');

      // Some local gateways respond with HTTP 200 and an error payload for unsupported endpoints.
      if (payloadError) {
        lastEndpointError = `${ep.path}: ${payloadError}`;
        if (/\b(408|425|429|500|502|503|504)\b/.test(payloadError)) {
          lastEndpointStatus = Number(payloadError.match(/\b(408|425|429|500|502|503|504)\b/)?.[0] || 0);
        }
        continue;
      }

      // OpenAI format
      if (data.choices?.[0]) return data.choices[0].message?.content || data.choices[0].text || '';
      // Ollama format
      if (data.message?.content) return data.message.content;
      if (data.response) return data.response;
      lastEndpointError = `${ep.path}: unrecognized response schema`;
      return JSON.stringify(data);
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') {
        throw e;
      }
      if (ep.format === 'openai') continue; // try next
      lastEndpointError = `${ep.path}: ${e.message}`;
      if (Number.isFinite(e?.status)) lastEndpointStatus = Number(e.status);
      continue;
    }
  }
  if (lastEndpointError) {
    const error = new Error(`Local LLM: no compatible endpoint at ${localBaseUrl}. Last error: ${lastEndpointError}`);
    if (lastEndpointStatus) error.status = lastEndpointStatus;
    throw error;
  }
  const error = new Error(`Local LLM: no endpoint responded at ${localBaseUrl}`);
  if (lastEndpointStatus) error.status = lastEndpointStatus;
  throw error;
}

window.AgentLLMControl = {
  abortActiveLlmRequest
};

// -- TOOL EXECUTOR -------------------------------------------------------------
