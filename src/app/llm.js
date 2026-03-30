let activeLlmController = null;

function abortActiveLlmRequest() {
  if (!activeLlmController) return;
  activeLlmController.abort();
}

async function callGemini(msgs) { return callLLM(msgs); }

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

function splitModelReply(text) {
  const raw = String(text || '');
  return {
    raw,
    thinkingBlocks: extractThinkingBlocks(raw),
    visible: raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^\s*```(?:xml|html)?\s*([\s\S]*?)\s*```$/i, '$1')
      .trim()
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

async function callLLM(msgs) {
  if (activeLlmController) {
    activeLlmController.abort();
  }

  activeLlmController = new AbortController();
  const { signal } = activeLlmController;

  if (localBackend.enabled && localBackend.url) {
    try {
      return await callLocal(msgs, signal);
    } finally {
      if (activeLlmController?.signal === signal) {
        activeLlmController = null;
      }
    }
  }

  try {
    return await callGeminiDirect(msgs, signal);
  } finally {
    if (activeLlmController?.signal === signal) {
      activeLlmController = null;
    }
  }
}

async function callGeminiDirect(msgs, signal) {
  const modelSelect = document.getElementById('model-select');
  let model = modelSelect.value;
  if (!localBackend.enabled) document.getElementById('badge-model').textContent = model;

  const contents = msgs
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
  const systemInstruction = msgs.find(m => m.role === 'system');
  const body = { contents, generationConfig: { maxOutputTokens: 2048, temperature: 0.7 } };
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
    modelSelect.value = model;
    if (!localBackend.enabled) document.getElementById('badge-model').textContent = model;
    ({ res, text } = await requestModel(model));
  }

  if (!res.ok) { throw new Error(`Gemini ${res.status}: ${text.slice(0,300)}`); }
  const data = JSON.parse(text);
  if (data.error) throw new Error(data.error.message);
  if (!data.candidates?.[0]) throw new Error('No candidates returned');
  return data.candidates[0].content.parts[0].text || '';
}
async function callLocal(msgs, signal) {
  // Detect endpoint type from model select or probed URL
  const modelSel = document.getElementById('local-model-select').value;
  const model = modelSel || localBackend.model || 'local-model';
  localBackend.model = model;
  localStorage.setItem('agent_local_backend_model', localBackend.model || '');

  // Build OpenAI-compatible messages (works for LM Studio + llama.cpp + Ollama /v1/)
  const openaiMsgs = msgs.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: m.content
  }));

  const inferred = inferProbeConfigFromUrl(localBackend.url || '');
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

  for (const ep of endpoints) {
    try {
      let body;
      if (ep.format === 'ollama') {
        body = { model, messages: openaiMsgs, stream: false };
      } else {
        body = { model, messages: openaiMsgs, max_tokens: 2048, temperature: 0.7, stream: false };
      }

      const res = await fetch(localBackend.url + ep.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });

      if (!res.ok) continue;
      const data = await res.json();

      // OpenAI format
      if (data.choices?.[0]) return data.choices[0].message?.content || data.choices[0].text || '';
      // Ollama format
      if (data.message?.content) return data.message.content;
      if (data.response) return data.response;
      return JSON.stringify(data);
    } catch (e) {
      if (ep.format === 'openai') continue; // try next
      throw new Error(`Local LLM error: ${e.message}`);
    }
  }
  throw new Error(`Local LLM: no endpoint responded at ${localBackend.url}`);
}

window.AgentLLMControl = {
  abortActiveLlmRequest
};

// -- TOOL EXECUTOR -------------------------------------------------------------
