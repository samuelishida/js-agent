// src/app/llm/provider-ollama.js
// Ollama (local + cloud) provider implementation.

/** @typedef {import('../../types/index.js').SessionMessage} SessionMessage */
/** @typedef {import('../../types/index.js').LlmCallOptions} LlmCallOptions */

/**
 * Call Ollama (local or cloud) for chat completions.
 * @param {SessionMessage[]} msgs - Messages
 * @param {AbortSignal} signal - Abort signal
 * @param {LlmCallOptions} [options={}] - Call options
 * @param {string} [initialModel=''] - Model override
 * @returns {Promise<string>} Response content
 */
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

  const isCloudModel = (typeof isSelectedOllamaModelCloud === 'function') && isSelectedOllamaModelCloud();

  let toolsForThisCall = null;
  if (isCloudModel && typeof window.AgentOrchestrator?.buildOpenAiToolSchemas === 'function') {
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
    const shouldStream = isCloudModel
      ? !!(window.AgentLLMUtils?.streamingCallback && !toolsForThisCall?.length)
      : true;
    const reqBody = isNative
      ? {
          model,
          messages: window.AgentLLMUtils?.collapseConsecutiveSameRole
            ? window.AgentLLMUtils.collapseConsecutiveSameRole(messages)
            : messages,
          stream: shouldStream,
          options: { temperature, num_predict: maxTokens, num_ctx: Math.min(typeof getCtxLimit === 'function' ? getCtxLimit() : 4096, 256000) }
        }
      : {
          model,
          messages: window.AgentLLMUtils?.collapseConsecutiveSameRole
            ? window.AgentLLMUtils.collapseConsecutiveSameRole(messages)
            : messages,
          max_tokens: maxTokens,
          temperature,
          stream: shouldStream,
          ...(toolsForThisCall && toolsForThisCall.length > 0 ? { tools: toolsForThisCall, tool_choice: 'auto' } : {})
        };

    console.debug(`[Ollama] POST ${endpointUrl} model='${model}' native=${isNative} cloud=${isCloudModel} stream=${shouldStream}`);

    const headers = { 'Content-Type': 'application/json' };
    if (ollamaApiKey) headers.Authorization = `Bearer ${ollamaApiKey}`;

    let res;
    try {
      res = await fetch(endpointUrl, { method: 'POST', headers, body: JSON.stringify(reqBody), signal });
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
      if (res.status === 500 && /memory layout cannot be allocated/i.test(errText)) {
        const oomError = new Error('Ollama ran out of GPU/CPU memory (memory layout cannot be allocated). Free up VRAM or use a smaller model.');
        oomError.status = 500;
        oomError.code = 'OLLAMA_OOM';
        throw oomError;
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

    if (shouldStream && res.body) {
      let streamResult;
      try {
        if (isNative) {
          streamResult = await window.AgentLLMUtils?.readOllamaNativeStream?.(res, window.AgentLLMUtils?.streamingCallback);
        } else {
          streamResult = await window.AgentLLMUtils?.readStreamingResponse?.(res, window.AgentLLMUtils?.streamingCallback);
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
    try { data = JSON.parse(text); } catch {
      lastError = new Error(`Ollama returned non-JSON response: ${text.slice(0, 200)}`);
      if (endpoints.indexOf(ep) === endpoints.length - 1) throw lastError;
      continue;
    }

    if (data.error) {
      const errMsg = String(data.error?.message || data.error || 'Ollama API error').slice(0, 200);
      if (/^EOF$/i.test(errMsg.trim())) {
        const eofReasoning = isNative
          ? (data.message?.reasoning || data.message?.reasoning_content || data.message?.thinking || '')
          : (data.choices?.[0]?.message?.reasoning || data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.thinking || '');
        const eofContent = isNative
          ? (data.message?.content || '')
          : (data.choices?.[0]?.message?.content || '');
        if (!eofReasoning?.trim() && !eofContent?.trim()) {
          const eofError = new Error('Ollama model crashed (EOF). Try a smaller model or reduce context size.');
          eofError.status = 500;
          eofError.code = 'OLLAMA_MODEL_CRASH';
          if (endpoints.indexOf(ep) === endpoints.length - 1) throw eofError;
          lastError = eofError;
          continue;
        }
        let eofResult = '';
        if (eofReasoning?.trim()) eofResult += '\u003cthink\u003e\n' + eofReasoning + '\n\u003c/think\u003e';
        if (eofResult && eofContent?.trim()) eofResult += '\n';
        if (eofContent?.trim()) eofResult += eofContent;
        return eofResult;
      }
      lastError = new Error(errMsg);
      if (endpoints.indexOf(ep) === endpoints.length - 1) throw lastError;
      continue;
    }

    const rawContent = isNative
      ? (data.message?.content || '')
      : (data.choices?.[0]?.message?.content || data.choices?.[0]?.text || data.message?.content || data.response || '');

    const rawReasoning = isNative
      ? (data.message?.reasoning || data.message?.reasoning_content || data.message?.thinking || '')
      : (data.choices?.[0]?.message?.reasoning || data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.thinking || data.choices?.[0]?.reasoning || data.choices?.[0]?.reasoning_content || '');

    if (rawReasoning && rawReasoning.trim()) {
      let combined = '\u003cthink\u003e\n' + rawReasoning + '\n\u003c/think\u003e';
      if (rawContent) combined += '\n' + rawContent;
      return combined;
    }

    const finishReason = isNative
      ? (data.done ? 'stop' : null)
      : (data.choices?.[0]?.finish_reason ?? data.finish_reason ?? null);
    if (window.AgentLLMUtils?.isIncompleteOrGarbageOutput?.(rawContent, finishReason)) {
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

    if (!isNative) {
      const toolCalls = data.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length) {
        const xml = window.AgentLLMUtils?.normalizeFunctionCallsToXml(toolCalls);
        if (xml) {
          // Preserve reasoning even when returning tool calls
          if (rawReasoning && rawReasoning.trim()) {
            return '<think>\n' + rawReasoning + '\n</think>\n' + xml;
          }
          return xml;
        }
      }
    }

    return rawContent;
  }

  if (lastError) throw lastError;
  throw new Error('Ollama: all endpoints failed');
}

window.AgentLLMProviderOllama = { callOllamaCloud };
