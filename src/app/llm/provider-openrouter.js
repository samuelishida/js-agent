// src/app/llm/provider-openrouter.js
// OpenRouter provider implementation.

async function callOpenRouter(msgs, signal, options = {}, initialModel = '') {
  const localKey = openrouterBackend?.apiKey === '__proxy__' ? '' : (openrouterBackend?.apiKey || '');
  const useProxy = !localKey && (window.__serverHasOpenRouterKey || false);
  const apiKey = localKey;

  if (!apiKey && !useProxy) {
    const error = new Error('OpenRouter API key is missing. Enter your API key and click Save.');
    error.status = 401;
    throw error;
  }

  const modelSelect = document.getElementById('model-select');
  const openRouterModel = openrouterBackend?.model || '';
  const model = String(initialModel || openRouterModel || (modelSelect ? modelSelect.value : '') || 'openai/gpt-4o-mini').trim();
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

  // Use local proxy when server has the key (key never exposed to browser)
  const endpoint = useProxy
    ? `${window.location.origin}/api/openrouter/chat/completions`
    : 'https://openrouter.ai/api/v1/chat/completions';
  const fetchHeaders = useProxy
    ? { 'Content-Type': 'application/json' }
    : { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': window.location.origin, 'X-Title': 'JS Agent' };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: fetchHeaders,
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
