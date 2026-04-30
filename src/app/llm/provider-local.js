// src/app/llm/provider-local.js
// Local / LM Studio provider implementation.

function updateModelBadgeForLocal(modelName) {
  const badgeModel = document.getElementById('topbar-model');
  if (badgeModel) badgeModel.textContent = `local/${modelName || 'unknown'}`;
}

async function callLocal(msgs, signal, options = {}) {
  const modelMaxTokens = typeof getMaxTokensForModel === 'function'
    ? getMaxTokensForModel()
    : 4096;
  const maxTokens = Math.max(64, Number(options.maxTokens) || modelMaxTokens);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;

  const localUrlState = window.AgentLLMUtils?.validateAndNormalizeLocalUrl
    ? window.AgentLLMUtils.validateAndNormalizeLocalUrl(localBackend.url)
    : { valid: false, reason: 'missing validator' };
  if (!localUrlState.valid) {
    throw new Error(`Local LLM configuration error: ${localUrlState.reason}`);
  }
  const localBaseUrl = localUrlState.url;
  if (localBackend.url !== localBaseUrl) {
    localBackend.url = localBaseUrl;
    localStorage.setItem('agent_local_backend_url', localBackend.url);
  }

  const modelSel = document.getElementById('local-model-select')?.value || '';
  const model = modelSel || localBackend.model || '';
  if (!model) {
    throw new Error('No local model selected. Probe your local server and choose a model from the Local Model dropdown.');
  }
  localBackend.model = model;
  localStorage.setItem('agent_local_backend_model', localBackend.model || '');

  const sanitizeLocalMessageContent = value => {
    let text = String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
    let prev;
    do { prev = text; text = text.replace(/\u003cthink(?:\s[^\u003e]*)?\u003e[\s\S]*?\u003c\/think\u003e/gi, ''); } while (text !== prev);
    return text.trim();
  };

  const rawMsgs = msgs.map(m => {
    if (m.role === 'tool') {
      if (m.tool_call_id) {
        return { role: 'tool', tool_call_id: m.tool_call_id, content: sanitizeLocalMessageContent(m.content) };
      }
      return { role: 'user', content: sanitizeLocalMessageContent(`\u003ctool_result\u003e\n${m.content}\n\u003c/tool_result\u003e`) };
    }
    return {
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: sanitizeLocalMessageContent(m.content)
    };
  });

  function normalizeLocalMessages(messages) {
    const system = messages.find(m => m.role === 'system');
    const body = messages.filter(m => m.role !== 'system' && String(m.content || '').trim());
    if (!body.length) {
      return system ? [system, { role: 'user', content: 'Continue.' }] : [{ role: 'user', content: 'Continue.' }];
    }
    if (body[0].role !== 'user') {
      body[0] = { role: 'user', content: `[context from previous assistant]\n${body[0].content}` };
    }
    const normalized = [];
    for (const msg of body) {
      const prev = normalized[normalized.length - 1];
      if (prev && prev.role === msg.role && msg.role !== 'tool') {
        prev.content = `${prev.content}\n\n${msg.content}`;
      } else {
        normalized.push({ ...msg });
      }
    }
    return system ? [system, ...normalized] : normalized;
  }

  function buildOllamaGeneratePrompt(messages) {
    const system = messages.find(message => message.role === 'system');
    const body = messages.filter(message => message.role !== 'system');
    const parts = [];
    if (system?.content) parts.push(`System:\n${String(system.content).trim()}`);
    for (const message of body) {
      const label = message.role === 'assistant' ? 'Assistant' : 'User';
      const content = String(message.content || '').trim();
      if (!content) continue;
      parts.push(`${label}:\n${content}`);
    }
    parts.push('Assistant:');
    return parts.join('\n\n').trim();
  }

  const openaiMsgs = normalizeLocalMessages(rawMsgs);

  const messagesWithConvertedIds = openaiMsgs.map(m => {
    if (m.role === 'tool' && m.tool_call_id && !m.tool_call_id.startsWith('call_') && !m.tool_call_id.startsWith('toolu_')) {
      return { ...m, tool_call_id: 'call_' + m.tool_call_id };
    }
    return m;
  });

  const displayModel = String(model || '').trim();
  if (displayModel) updateModelBadgeForLocal(displayModel);

  const inferred = inferProbeConfigFromUrl(localBaseUrl || '');
  const inferredChatPath = inferred?.chatPath || '/v1/chat/completions';
  const preferOllamaPath = inferredChatPath === '/api/chat';

  if (preferOllamaPath && localBackend.chatPath !== '/api/chat') {
    localBackend.chatPath = '/api/chat';
    localStorage.setItem('agent_local_backend_chat_path', localBackend.chatPath);
  }

  const preferredChatPath = preferOllamaPath
    ? '/api/chat'
    : (localBackend.chatPath || inferredChatPath || '/v1/chat/completions');
  const endpoints = [];
  const pushEndpoint = (path, format) => {
    if (!endpoints.some(endpoint => endpoint.path === path)) endpoints.push({ path, format });
  };

  if (preferOllamaPath) {
    pushEndpoint('/api/chat', 'ollama');
    pushEndpoint('/api/generate', 'ollama_generate');
    pushEndpoint('/v1/chat/completions', 'openai');
  } else {
    pushEndpoint(preferredChatPath, preferredChatPath === '/api/chat' ? 'ollama' : 'openai');
    pushEndpoint('/v1/chat/completions', 'openai');
    pushEndpoint('/api/chat', 'ollama');
    pushEndpoint('/api/generate', 'ollama_generate');
  }

  const attempts = [];
  let lastEndpointError = '';
  let lastEndpointStatus = 0;

  for (const ep of endpoints) {
    try {
      let body;
      const localStream = true;
      if (ep.format === 'ollama') {
        body = { model, messages: messagesWithConvertedIds, stream: localStream, options: { temperature, num_predict: maxTokens } };
      } else if (ep.format === 'ollama_generate') {
        body = { model, prompt: buildOllamaGeneratePrompt(messagesWithConvertedIds), stream: false, options: { temperature, num_predict: maxTokens } };
      } else {
        body = { model, messages: messagesWithConvertedIds, max_tokens: maxTokens, temperature, stream: localStream };
      }

      const endpointUrl = window.AgentLLMUtils?.buildLocalEndpointUrl
        ? window.AgentLLMUtils.buildLocalEndpointUrl(localBaseUrl, ep.path)
        : `${localBaseUrl}${ep.path}`;
      const res = await fetch(endpointUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });

      if (!res.ok) {
        let detail = '';
        try { detail = String(await res.text()).slice(0, 180); } catch {}
        // Detect OOM errors from local Ollama instances
        if (res.status === 500 && /memory layout cannot be allocated/i.test(detail)) {
          const oomError = new Error('Local LLM ran out of GPU/CPU memory (memory layout cannot be allocated). Free up VRAM or use a smaller model.');
          oomError.status = 500;
          oomError.code = 'OLLAMA_OOM';
          throw oomError;
        }
        attempts.push({ path: ep.path, status: res.status, detail });
        lastEndpointStatus = res.status;
        lastEndpointError = `${ep.path}: HTTP ${res.status}`;
        continue;
      }

      if (localStream && res.body && ep.format !== 'ollama_generate') {
        try {
          let streamedContent;
          if (ep.format === 'ollama') {
            streamedContent = await window.AgentLLMUtils?.readOllamaNativeStream?.(res, window.AgentLLMUtils?.streamingCallback);
          } else {
            streamedContent = await window.AgentLLMUtils?.readStreamingResponse?.(res, window.AgentLLMUtils?.streamingCallback);
          }
          if (streamedContent !== null && streamedContent.length > 0) return streamedContent;
        } catch (streamErr) {
          if (signal?.aborted || streamErr?.name === 'AbortError') throw streamErr;
          // Propagate OOM and crash errors — don't silently continue
          if (streamErr?.code === 'OLLAMA_OOM' || streamErr?.code === 'OLLAMA_MODEL_CRASH') throw streamErr;
          console.warn(`[Local] stream error from ${ep.path}: ${streamErr?.message}`);
        }
        lastEndpointError = `${ep.path}: stream exhausted without content`;
        continue;
      }

      if (!res.body) {
        lastEndpointError = `${ep.path}: no response body`;
        continue;
      }

      const data = await res.json();

      const payloadError = typeof data?.error === 'string'
        ? data.error
        : (typeof data?.error?.message === 'string' ? data.error.message : '');
      if (payloadError) {
        attempts.push({ path: ep.path, status: 200, detail: payloadError.slice(0, 180) });
        lastEndpointError = `${ep.path}: ${payloadError}`;
        if (/\b(408|425|429|500|502|503|504)\b/.test(payloadError)) {
          lastEndpointStatus = Number(payloadError.match(/\b(408|425|429|500|502|503|504)\b/)?.[0] || 0);
        }
        continue;
      }

      const localReply = window.AgentLLMUtils?.extractLocalVisibleReply
        ? window.AgentLLMUtils.extractLocalVisibleReply(data)
        : { text: '', hiddenReasoningOnly: false };
      if (localReply.text) return localReply.text;

      if (localReply.hiddenReasoningOnly) {
        const thinkText = String(window.AgentLLMUtils?.extractLocalReasoningText?.(data) || '').trim();
        if (thinkText) {
          return thinkText.toLowerCase().trim().startsWith('\u003cthinking')
            ? thinkText
            : `\u003cthink\u003e${thinkText}\u003c/think\u003e`;
        }
        attempts.push({ path: ep.path, status: 200, detail: 'model returned hidden reasoning only' });
        lastEndpointError = `${ep.path}: model returned hidden reasoning only`;
        continue;
      }

      const schemaHint = window.AgentLLMUtils?.summarizeLocalPayloadShape
        ? window.AgentLLMUtils.summarizeLocalPayloadShape(data).slice(0, 180)
        : 'unknown';
      attempts.push({ path: ep.path, status: 200, detail: `unrecognized response schema (${schemaHint})` });
      lastEndpointError = `${ep.path}: unrecognized response schema (${schemaHint})`;
      continue;
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e;
      attempts.push({ path: ep.path, status: Number(e?.status) || 0, detail: String(e?.message || 'network error').slice(0, 180) });
      lastEndpointError = `${ep.path}: ${e.message}`;
      if (Number.isFinite(e?.status)) lastEndpointStatus = Number(e.status);
      continue;
    }
  }

  const attemptSummary = attempts
    .map(attempt => `${attempt.path} (${attempt.status || 'network'}${attempt.detail ? `: ${attempt.detail}` : ''})`)
    .join(' | ');

  const networkOnly = attempts.length > 0 && attempts.every(attempt => !attempt.status);
  if (networkOnly) {
    const serverHint = preferOllamaPath ? 'Ensure Ollama is running and reachable.' : 'Ensure your local LLM server is running and reachable.';
    const error = new Error(`Local LLM: could not reach server at ${localBaseUrl}. ${serverHint} Attempts: ${attemptSummary || 'network error'}`);
    error.status = 503;
    throw error;
  }

  if (lastEndpointError) {
    const error = new Error(`Local LLM: no compatible endpoint at ${localBaseUrl}. Attempts: ${attemptSummary || lastEndpointError}`);
    if (lastEndpointStatus) error.status = lastEndpointStatus;
    throw error;
  }
  const error = new Error(`Local LLM: no endpoint responded at ${localBaseUrl}`);
  if (lastEndpointStatus) error.status = lastEndpointStatus;
  throw error;
}

window.AgentLLMProviderLocal = { callLocal, updateModelBadgeForLocal };
