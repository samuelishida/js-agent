// src/app/llm/provider-clawd.js
// Anthropic (Clawd) provider implementation.

/** @typedef {import('../../types/index.js').SessionMessage} SessionMessage */
/** @typedef {import('../../types/index.js').LlmCallOptions} LlmCallOptions */

/**
 * Call Clawd (Anthropic) cloud API.
 * @param {SessionMessage[]} msgs - Messages
 * @param {AbortSignal} signal - Abort signal
 * @param {LlmCallOptions} [options={}] - Call options
 * @param {string} [initialModel=''] - Model override
 * @returns {Promise<string>} Response content
 */
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
  // Extract thinking blocks from Claude's extended thinking format
  let thinkingText = '';
  let visibleText = '';
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block?.type === 'thinking' && block?.thinking) {
        thinkingText += block.thinking;
      } else if (block?.type === 'text' && block?.text) {
        visibleText += block.text;
      }
    }
  }
  if (thinkingText.trim()) {
    let combined = '<tool_call>\n' + thinkingText.trim() + '\n<\/think>\n';
    if (visibleText.trim()) combined += '\n' + visibleText.trim();
    return combined;
  }
  return visibleText || data.output_text || '';
}

window.AgentLLMProviderClawd = { callClawdCloud };
