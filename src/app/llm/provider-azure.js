// src/app/llm/provider-azure.js
// Azure OpenAI provider implementation.

/** @typedef {import('../../types/index.js').SessionMessage} SessionMessage */
/** @typedef {import('../../types/index.js').LlmCallOptions} LlmCallOptions */

/**
 * Call Azure OpenAI cloud API.
 * @param {SessionMessage[]} msgs - Messages
 * @param {AbortSignal} signal - Abort signal
 * @param {LlmCallOptions} [options={}] - Call options
 * @param {string} [initialDeployment=''] - Deployment override
 * @returns {Promise<string>} Response content
 */
async function callAzureOpenAiCloud(msgs, signal, options = {}, initialDeployment = '') {
  const apiKey = window.apiKey;
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

  const useStreamAzure = !!(window.AgentLLMUtils?.streamingCallback && !toolsForThisCall?.length);
  const body = {
    messages: window.AgentLLMUtils?.collapseConsecutiveSameRole
      ? window.AgentLLMUtils.collapseConsecutiveSameRole(messages)
      : messages,
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
    const streamedContent = await window.AgentLLMUtils?.readStreamingResponse?.(res, window.AgentLLMUtils?.streamingCallback);
    if (streamedContent !== null && streamedContent !== '') return streamedContent;
    // Stream exhausted — body consumed, redo without stream
    const nonStreamBody = { ...body, stream: false };
    const retryRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify(nonStreamBody),
      signal
    });
    if (!retryRes.ok) {
      const retryText = await retryRes.text();
      const retryError = new Error(`Azure OpenAI ${retryRes.status}: ${retryText.slice(0, 300)}`);
      retryError.status = retryRes.status;
      throw retryError;
    }
    const retryData = JSON.parse(await retryRes.text());
    const retryToolCalls = retryData?.choices?.[0]?.message?.tool_calls;
    const retryReasoning = retryData?.choices?.[0]?.message?.reasoning || retryData?.choices?.[0]?.message?.reasoning_content || retryData?.choices?.[0]?.message?.thinking || '';
    if (Array.isArray(retryToolCalls) && retryToolCalls.length) {
      const xml = window.AgentLLMUtils?.normalizeFunctionCallsToXml(retryToolCalls);
      if (xml) {
        if (retryReasoning && String(retryReasoning).trim()) {
          return '\u003cthink\u003e\n' + String(retryReasoning).trim() + '\n\u003c/think\u003e\n' + xml;
        }
        return xml;
      }
    }
    const retryContent = retryData?.choices?.[0]?.message?.content || retryData?.choices?.[0]?.text || '';
    if (retryReasoning && String(retryReasoning).trim()) {
      let combined = '<tool_call>\n' + String(retryReasoning).trim() + '\n<\/think>\n';
      if (retryContent) combined += '\n' + retryContent;
      return combined;
    }
    return retryContent;
  }

  const text = await res.text();
  const data = JSON.parse(text);
  const toolCalls = data.choices?.[0]?.message?.tool_calls;
  const rawReasoning = data?.choices?.[0]?.message?.reasoning || data?.choices?.[0]?.message?.reasoning_content || data?.choices?.[0]?.message?.thinking || '';
  if (Array.isArray(toolCalls) && toolCalls.length) {
    const xml = window.AgentLLMUtils?.normalizeFunctionCallsToXml(toolCalls);
    if (xml) {
      if (rawReasoning && String(rawReasoning).trim()) {
        return '\u003cthink\u003e\n' + String(rawReasoning).trim() + '\n\u003c/think\u003e\n' + xml;
      }
      return xml;
    }
  }
  const rawContent = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || '';
  if (rawReasoning && String(rawReasoning).trim()) {
    let combined = '<tool_call>\n' + String(rawReasoning).trim() + '\n<\/think>\n';
    if (rawContent) combined += '\n' + rawContent;
    return combined;
  }
  return rawContent;
}

window.AgentLLMProviderAzure = { callAzureOpenAiCloud };
