// src/app/llm/provider-gemini.js
// Google Gemini direct provider implementation.

/** @typedef {import('../../types/index.js').SessionMessage} SessionMessage */
/** @typedef {import('../../types/index.js').LlmCallOptions} LlmCallOptions */

/**
 * Call Gemini direct API.
 * @param {SessionMessage[]} msgs - Messages
 * @param {AbortSignal} signal - Abort signal
 * @param {LlmCallOptions} [options={}] - Call options
 * @param {string} [initialModel=''] - Model override
 * @returns {Promise<string>} Response content
 */
async function callGeminiDirect(msgs, signal, options = {}, initialModel = '') {
  const apiKey = window.apiKey;
  if (!apiKey) {
    const error = new Error('Gemini API key is missing. Enter your API key and click Save.');
    error.status = 401;
    throw error;
  }

  const modelSelect = document.getElementById('model-select');
  const model = String(initialModel || (modelSelect ? modelSelect.value : '') || 'gemini-2.5-flash').trim();
  if (modelSelect && modelSelect.value !== model) modelSelect.value = model;
  if (!localBackend?.enabled) {
    const badgeModel = document.getElementById('topbar-model');
    if (badgeModel) badgeModel.textContent = model;
  }

  const maxTokens = Math.max(64, Number(options.maxTokens) || 4096);
  const temperature = Number.isFinite(options.temperature) ? Number(options.temperature) : 0.7;

  const rawContents = msgs
    .filter(m => m.role !== 'system')
    .map(m => {
      const text = String(m.content || '').replace(/\u003cthink[\s\S]*?\u003c\/think\u003e/gi, '');
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] };
    });
  const contents = [];
  for (const entry of rawContents) {
    const prev = contents[contents.length - 1];
    if (prev && prev.role === entry.role) {
      prev.parts[0].text += '\n\n' + entry.parts[0].text;
    } else {
      contents.push({ role: entry.role, parts: [{ text: entry.parts[0].text }] });
    }
  }
  const systemInstruction = msgs.find(m => m.role === 'system');
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
    const fallback = fallbackModels[model];
    if (modelSelect) modelSelect.value = fallback;
    if (!localBackend?.enabled) {
      const badgeModel = document.getElementById('topbar-model');
      if (badgeModel) badgeModel.textContent = fallback;
    }
    ({ res, text } = await requestModel(fallback));
  }

  if (!res.ok) {
    const error = new Error(`Gemini ${res.status}: ${text.slice(0,300)}`);
    error.status = res.status;
    throw error;
  }
  const data = JSON.parse(text);
  if (data.error) {
    const error = new Error(data.error?.message || String(data.error));
    if (Number.isFinite(data.error?.code)) error.status = Number(data.error.code);
    throw error;
  }
  if (!data.candidates?.[0]) throw new Error('No candidates returned');
  const finishReason = data.candidates[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'FINISH_REASON_UNSPECIFIED') {
    const error = new Error(`Gemini response blocked: ${finishReason}`);
    error.code = 'GEMINI_NONSTOP';
    error.status = 500;
    throw error;
  }

  // Extract thinking/reasoning parts from Gemini response
  const parts = data.candidates[0]?.content?.parts || [];
  let visibleText = '';
  let thinkingText = '';
  for (const part of parts) {
    if (part.text) visibleText += part.text;
    if (part.thought && part.text) thinkingText += part.text;
  }
  // If there are thought parts, wrap them in <think> tags
  if (thinkingText.trim()) {
    let combined = '<tool_call>\n' + thinkingText.trim() + '\n<\/think>\n';
    if (visibleText.trim()) combined += '\n' + visibleText.trim();
    return combined;
  }

  return visibleText || '';
}

window.AgentLLMProviderGemini = { callGeminiDirect };
