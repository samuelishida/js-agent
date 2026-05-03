// src/app/llm/provider-openai.js
// OpenAI cloud provider implementation.

/** @typedef {import('../../types/index.js').SessionMessage} SessionMessage */
/** @typedef {import('../../types/index.js').LlmCallOptions} LlmCallOptions */

/**
 * Call OpenAI cloud API.
 * @param {SessionMessage[]} msgs - Messages
 * @param {AbortSignal} signal - Abort signal
 * @param {LlmCallOptions} [options={}] - Call options
 * @param {string} [initialModel=''] - Model override
 * @returns {Promise<string>} Response content
 */
async function callOpenAiCloud(msgs, signal, options = {}, initialModel = '') {
  const apiKey = window.apiKey;
  if (!apiKey) {
    const error = new Error('OpenAI API key is missing. Enter your API key and click Save.');
    error.status = 401;
    throw error;
  }

  const model = String(initialModel || 'gpt-4.1-mini').trim();
  const maxTokens = Math.max(64, Number(options.maxTokens) || 4096);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;

  let toolsForThisCall = null;
  if (typeof window.AgentOrchestrator?.buildOpenAiToolSchemas === 'function') {
    try {
      toolsForThisCall = window.AgentOrchestrator.buildOpenAiToolSchemas(options.enabledTools || []);
    } catch (err) {
      console.warn('[AgentOrchestrator] buildOpenAiToolSchemas failed:', err);
      toolsForThisCall = [];
    }
  }

  const messages = window.AgentLLMUtils?.buildOpenAiStyleMessages
    ? window.AgentLLMUtils.buildOpenAiStyleMessages(msgs).map(m => {
        if (m.role === 'tool' && m.tool_call_id && !m.tool_call_id.startsWith('call_') && !m.tool_call_id.startsWith('toolu_')) {
          return { ...m, tool_call_id: 'call_' + m.tool_call_id };
        }
        return m;
      })
    : msgs;

  const useStream = !!(window.AgentLLMUtils?.streamingCallback && !toolsForThisCall?.length);
  const body = {
    model,
    messages: window.AgentLLMUtils?.collapseConsecutiveSameRole
      ? window.AgentLLMUtils.collapseConsecutiveSameRole(messages)
      : messages,
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
    const streamedContent = await window.AgentLLMUtils?.readStreamingResponse?.(res, window.AgentLLMUtils?.streamingCallback);
    if (streamedContent !== null && streamedContent !== '') return streamedContent;
    // Stream exhausted without content — body already consumed, fall through to non-stream path
    // Need a fresh request since body was consumed by stream reader
    const nonStreamBody = { ...body, stream: false };
    const retryRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(nonStreamBody),
      signal
    });
    if (!retryRes.ok) {
      const retryText = await retryRes.text();
      const retryError = new Error(`OpenAI ${retryRes.status}: ${retryText.slice(0, 300)}`);
      retryError.status = retryRes.status;
      throw retryError;
    }
    const retryData = JSON.parse(await retryRes.text());
    const retryToolCalls = retryData?.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(retryToolCalls) && retryToolCalls.length) {
      const xml = window.AgentLLMUtils?.normalizeFunctionCallsToXml(retryToolCalls);
      if (xml) return xml;
    }
    return retryData?.choices?.[0]?.message?.content || retryData?.choices?.[0]?.text || '';
  }

  const text = await res.text();
  const data = JSON.parse(text);
  if (data.error) {
    const error = new Error(data.error?.message || 'OpenAI error');
    if (Number.isFinite(data.error?.code)) error.status = Number(data.error.code);
    throw error;
  }

  const toolCalls = data.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length) {
    const xml = window.AgentLLMUtils?.normalizeFunctionCallsToXml(toolCalls);
    if (xml) return xml;
  }
  return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
}

window.AgentLLMProviderOpenAI = { callOpenAiCloud };
