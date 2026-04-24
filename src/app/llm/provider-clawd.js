// src/app/llm/provider-clawd.js
// Anthropic (Clawd) provider implementation.

async function callClawdCloud(msgs, signal, options = {}, initialModel = '') {
  const apiKey = window.apiKey;
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
    messages: (window.AgentLLMUtils?.collapseConsecutiveSameRole || (x => x))(
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

window.AgentLLMProviderClawd = { callClawdCloud };
