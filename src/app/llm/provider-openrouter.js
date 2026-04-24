// src/app/llm/provider-openrouter.js
// OpenRouter provider implementation.

async function callOpenRouter(msgs, signal, options = {}, initialModel = '') {
  const apiKey = window.apiKey;
  if (!apiKey) {
    const error = new Error('OpenRouter API key is missing. Enter your API key and click Save.');
    error.status = 401;
    throw error;
  }

  const modelSelect = document.getElementById('model-select');
  const model = String(initialModel || (modelSelect ? modelSelect.value : '') || 'openai/gpt-4o-mini').trim();
  if (modelSelect && modelSelect.value !== model) modelSelect.value = model;
  if (!localBackend?.enabled) {
    const badgeModel = document.getElementById('topbar-model');
    if (badgeModel) badgeModel.textContent = model;
  }

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
    const xml = window.AgentLLMUtils?.normalizeFunctionCallsToXml(toolCalls);
    if (xml) return xml;
  }

  return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
}

window.AgentLLMProviderOpenRouter = { callOpenRouter };
