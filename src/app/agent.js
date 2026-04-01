function getToolRegex() {
  return getRuntimeModules().regex?.TOOL_BLOCK || /<tool_call>[\s\S]*?<\/tool_call>/gi;
}

function parseToolCall(text) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  return orchestrator.parseToolCall(text);
}

let stopRequested = false;
let runDisabledToolCalls = new Set();
const runToolFailureCounts = new Map();
let runFsRootExplored = false;

function setStopButtonState(running) {
  const stopBtn = document.getElementById('btn-stop');
  if (!stopBtn) return;
  stopBtn.disabled = !running;
  stopBtn.style.display = running ? 'flex' : 'none';
  const sendBtn = document.getElementById('btn-send');
  if (sendBtn) sendBtn.style.display = running ? 'none' : 'flex';
}

function requestStop() {
  if (!isBusy) return;
  stopRequested = true;
  setStatus('busy', 'stopping…');
  const inputStatus = document.getElementById('input-status');
  if (inputStatus) inputStatus.textContent = 'stopping…';
  window.AgentLLMControl?.abortActiveLlmRequest?.();
  // Abort any pending tab_listen Promises so they reject immediately.
  window.AgentSkills?.abortAllTabListeners?.('Run stopped by user.');
}

function throwIfStopRequested() {
  if (!stopRequested) return;
  const error = new Error('RUN_STOPPED');
  error.code = 'RUN_STOPPED';
  throw error;
}

function resetRunGuards() {
  runDisabledToolCalls = new Set();
  runToolFailureCounts.clear();
  runFsRootExplored = false;
}

function getToolCallSignature(call) {
  return `${call?.tool || 'unknown'}:${JSON.stringify(call?.args || {})}`;
}

function parseJsonObjectFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const unfenced = raw.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    const match = unfenced.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeComparableText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function looksLikeFinalAnswerText(text) {
  const value = String(text || '').trim();
  if (!value) return false;

  if (parseToolCall(value)) return false;
  if (/^\s*<tool_call>/i.test(value)) return false;

  const progressCue = /(verificando|checking|let me check|vou verificar|analisando|aguarde|one moment|um momento|investigando|working on it|processing|continuando|continuing)/i;
  const asksMoreWork = /(continue a tarefa|continue the task|chame uma ferramenta|call exactly one tool|preciso verificar|i need to check)/i;
  if (progressCue.test(value) || asksMoreWork.test(value)) return false;

  const hasSentenceShape = /[.!?]\s*$/.test(value) || value.includes('\n');
  const minLength = value.length >= 90;
  return minLength && hasSentenceShape;
}


function recordToolFailure(call, result) {
  if (!/^ERROR\b/i.test(String(result || ''))) {
    return { repeated: false, count: 0 };
  }

  const signature = String(result || '')
    .replace(/\s+/g, ' ')
    .replace(/\d+/g, '#')
    .slice(0, 180);

  const key = `${call.tool}::${signature}`;
  const count = (runToolFailureCounts.get(key) || 0) + 1;
  runToolFailureCounts.set(key, count);

  if (count >= 2) {
    runDisabledToolCalls.add(getToolCallSignature(call));
    return { repeated: true, count };
  }

  return { repeated: false, count };
}

async function buildPreflightSteering(userMessage, enrichedContext) {
  assertRuntimeReady();
  const systemInstruction = 'You generate compact execution steering for an LLM tool-using agent. Return 3 short lines only. No tool_call, no XML, no markdown tables.';
  const userInstruction = `User request:\n${userMessage}\n\nHeuristic preflight context:\n${enrichedContext}\n\nReturn strict guidance with this structure:\n1) Primary tools\n2) Tools to avoid unless explicitly requested\n3) Fallback sequence`;

  try {
    const response = await callCloud([
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userInstruction }
    ], null, { maxTokens: 220, temperature: 0.1, timeoutMs: 15000, retries: 1 });

    const steering = splitModelReply(response).visible.replace(getToolRegex(), '').trim();
    if (!steering || parseToolCall(steering)) return '';
    return steering.slice(0, 900);
  } catch {
    return '';
  }
}

async function buildRecoverySteering(userMessage, call, toolError) {
  const fallback = `Do not repeat the exact failing call for ${call.tool}. Pick a different valid next step using available tools.`;

  try {
    const response = await callCloud([
      {
        role: 'system',
        content: 'You produce one concise recovery instruction for a tool-using agent. No tool_call blocks, no analysis.'
      },
      {
        role: 'user',
        content: `User request: ${userMessage}\nFailed tool: ${call.tool}\nError: ${toolError}\nReturn one short recovery instruction.`
      }
    ], null, { maxTokens: 180, temperature: 0.1, timeoutMs: 15000, retries: 1 });

    const steering = splitModelReply(response).visible.replace(getToolRegex(), '').trim();
    if (!steering || parseToolCall(steering)) return fallback;
    return steering;
  } catch {
    return fallback;
  }
}

async function maybeFinalizeFromToolEvidenceWithLlm(userMessage, toolCall, toolResult) {
  const systemInstruction = [
    'You decide whether a single tool result already contains enough evidence to answer the user now.',
    'Return JSON only with schema: {"finalize":true|false,"answer":"markdown answer when finalize=true"}.',
    'If evidence is insufficient, set finalize=false.'
  ].join(' ');
  // Cap tool result to 4k — this is a control call and must stay within control timeout budget.
  // Always route to cloud even in local mode to avoid blocking the loop on a slow local model.
  const userInstruction = `User request: ${userMessage}\nTool call: ${JSON.stringify(toolCall)}\nTool result:\n${String(toolResult || '').slice(0, 4000)}`;

  try {
    const raw = await callCloud([
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userInstruction }
    ], null, { maxTokens: 260, temperature: 0.1, timeoutMs: 18000, retries: 1 });
    const parsed = parseJsonObjectFromText(splitModelReply(raw).visible);
    if (parsed?.finalize && String(parsed.answer || '').trim()) {
      return String(parsed.answer).trim();
    }
  } catch {
    // Continue loop on decision errors.
  }

  return '';
}

async function evaluateTurnGuardrailsWithLlm({ userMessage, replyText, proposedToolCall, round, maxRounds }) {
  const systemInstruction = [
    'You are a turn guardrail controller for a tool-using agent.',
    'Return strict JSON only with schema:',
    '{"request_continuation":boolean,"show_intermediate":boolean,"action":"keep|replace","reason":"...","call":{"tool":"...","args":{...}}|null}',
    'If there is no tool call and text is intermediary, set request_continuation=true.',
    'If action is keep, return the original call in call.',
    'Never output markdown or prose.'
  ].join(' ');

  const userInstruction = `User request: ${userMessage}\nRound: ${round}/${maxRounds}\nDraft reply: ${replyText}\nProposed call: ${proposedToolCall ? JSON.stringify(proposedToolCall) : 'NONE'}`;

  try {
    const raw = await callCloud([
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userInstruction }
    ], null, { maxTokens: 260, temperature: 0.1, timeoutMs: 18000, retries: 1 });
    const parsed = parseJsonObjectFromText(splitModelReply(raw).visible);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function normalizeToolCallWithLlm(replyText, userMessage) {
  const allowedTools = Object.entries(enabledTools)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(', ');

  const systemInstruction = [
    'You are a tool-call normalizer.',
    'Extract at most one tool call from the draft reply.',
    'Return exactly one JSON object: {"tool":"name","args":{...}} or NONE.',
    'Use only tools from the allowed list.',
    'No prose, no markdown fences, no XML.'
  ].join(' ');

  const compactReply = String(replyText || '').slice(0, 2600);
  const compactUser = String(userMessage || '').slice(0, 600);
  const userInstruction = `Allowed tools: ${allowedTools}\nUser request: ${compactUser}\nDraft reply: ${compactReply}\nReturn JSON or NONE.`;

  try {
    const raw = await callCloud([
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userInstruction }
    ], null, { maxTokens: 140, temperature: 0.05, timeoutMs: 15000, retries: 1 });

    const text = splitModelReply(raw).visible.trim();
    if (!text || /^NONE$/i.test(text)) return null;
    const parsed = parseToolCall(text);
    if (!parsed) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function resolveToolCallFromModelReply(reply, rawReply, userMessage) {
  const direct = parseToolCall(reply);
  if (direct?.tool) return direct;

  const fromRaw = parseToolCall(rawReply);
  if (fromRaw?.tool) return fromRaw;

  return normalizeToolCallWithLlm(rawReply || reply, userMessage);
}

async function executeTool(call) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  const { tool, args } = call;

  const callSignature = getToolCallSignature(call);

  if (runDisabledToolCalls.has(callSignature)) {
    return `ERROR: tool call '${callSignature}' is temporarily disabled for this run after repeated failures.`;
  }

  if (!enabledTools[tool]) {
    return `ERROR: tool '${tool}' is disabled in this environment.`;
  }

  if (tool === 'calc') {
    const expr = args.expression || '';
    try {
      if (!/^[0-9+\-*/().%\s^epsqrtlogabtincfloreil,MathPI]+$/i.test(expr.replace(/Math\./g,''))) {
        const result = Function('"use strict"; return (' + expr + ')')();
        return `${expr} = ${result}`;
      }
      const result = Function('"use strict"; return (' + expr + ')')();
      return `${expr} = ${result}`;
    } catch (e) {
      return `calc error: ${e.message}`;
    }
  }

  if (tool === 'datetime') {
    const now = new Date();
    return `Current datetime: ${now.toISOString()}\nLocal: ${now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', timeZoneName:'short' })}\nTimezone: America/Sao_Paulo (BRT)`;
  }

  const cachedResult = getCachedToolResult(call);
  if (cachedResult) {
    return `${cachedResult}\n\n[cache hit]`;
  }

  const result = await orchestrator.executeSkill(call, {
    localBackend,
    enabledTools,
    messages
  });
  if (!/^ERROR\b/i.test(result)) {
    setCachedToolResult(call, result);
  }
  return result;
}

// -- CONTEXT SIZE + SUMMARIZE --------------------------------------------------
function ctxSize(msgs) {
  return msgs.reduce((n, m) => n + (m.content || '').length, 0);
}

function updateCtxBar() {
  const size = ctxSize(messages);
  const limit = getCtxLimit();
  const pct = Math.min(100, (size / limit) * 100);
  const bar = document.getElementById('ctx-bar');
  const label = document.getElementById('ctx-pct');
  if (bar) {
    bar.style.width = pct + '%';
    bar.classList.toggle('warn', pct > 60 && pct <= 85);
    bar.classList.toggle('danger', pct > 85);
  }
  if (label) label.textContent = pct.toFixed(1) + '%';
  const statCtx = document.getElementById('stat-ctx');
  if (statCtx) statCtx.textContent = size.toLocaleString();
}

function notifyIfHidden(summary) {
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window)) return;
  if (window.Notification.permission !== 'granted') return;

  new window.Notification('JS Agent', {
    body: String(summary || 'Task complete.').slice(0, 120),
    tag: 'agent-run-finished',
    silent: false
  });
}

async function summarizeContext(userQuery) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  addNotice('Context limit reached (' + ctxSize(messages).toLocaleString() + ' chars). Compressing via LLM.');
  sessionStats.resets++;
  updateStats();

  const hist = messages
    .filter(m => m.role !== 'system')
    .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');

  const prompt = await orchestrator.buildSummaryPrompt(hist, userQuery);

  const sysMsg = messages.find(m => m.role === 'system');
  const summary = await callLLM([
    sysMsg,
    { role: 'user', content: prompt }
  ], { maxTokens: 700, temperature: 0.2, timeoutMs: 28000, retries: 1 });

  const summaryText = String(summary || '').trim();
  const looksLikeErrorJson = /^\{[\s\S]*"error"\s*:/i.test(summaryText);
  const looksLikeEndpointError = /Unexpected endpoint or method|no compatible endpoint|Local LLM:/i.test(summaryText);
  if (!summaryText || looksLikeErrorJson || looksLikeEndpointError) {
    throw new Error('Summarization returned an invalid backend payload.');
  }

  return [
    sysMsg,
    { role: 'assistant', content: `[SUMMARISED CONTEXT]\n${summaryText}` },
    { role: 'user', content: userQuery }
  ];
}

function fallbackCompressContext(userQuery) {
  const sysMsg = messages.find(m => m.role === 'system') || { role: 'system', content: '' };
  const tail = messages.filter(m => m.role !== 'system').slice(-8);

  if (!tail.length || tail[tail.length - 1].role !== 'user') {
    tail.push({ role: 'user', content: userQuery });
  }

  return [sysMsg, ...tail];
}

async function generateFinalMarkdownAnswer(candidateAnswer, userMessage) {
  assertRuntimeReady();

  const systemInstruction = `You are a concise, final-answer-only assistant. Return exactly one answer formatted in Markdown. Do not include analysis, tool call syntax, or surrounding words like 'final answer'. Never output <think> tags.`;
  const userInstruction = `Context-based finalization request.\n\nOriginal assistant output:\n${candidateAnswer}\n\nProvide a single cleaned final response in Markdown format, without HTML wrapper.`;

  const finalReply = await callCloud([
    { role: 'system', content: systemInstruction },
    { role: 'user', content: userInstruction }
  ], null, { maxTokens: 700, temperature: 0.2, timeoutMs: 22000, retries: 1 });

  const finalText = splitModelReply(finalReply).visible.replace(getToolRegex(), '').trim();
  if (!finalText) {
    return candidateAnswer.trim();
  }

  return finalText;
}

// -- AGENTIC LOOP --------------------------------------------------------------
async function agentLoop(userMessage) {
  assertRuntimeReady();
  throwIfStopRequested();
  const { skills, orchestrator } = getRuntimeModules();
  const MAX_ROUNDS = getMaxRounds();
  const CTX_LIMIT  = getCtxLimit();
  const delay      = getDelay();
  const enrichedMessage = await skills.buildInitialContext(userMessage);
  const preflightSteering = await buildPreflightSteering(userMessage, enrichedMessage);
  throwIfStopRequested();
  const userMessageWithSteering = preflightSteering
    ? `${enrichedMessage}\n\n<execution_steering>\n${preflightSteering}\n</execution_steering>`
    : enrichedMessage;

  // Init messages for this turn
  messages = [
    { role: 'system', content: await buildSystemPrompt(userMessage) },
    ...messages.filter(m => m.role !== 'system').slice(-20), // keep last 20 non-system
    { role: 'user', content: userMessageWithSteering }
  ];

  let round = 0;
  sessionStats.msgs++;

  while (round < MAX_ROUNDS) {
    throwIfStopRequested();
    round++;
    sessionStats.rounds++;
    updateStats();

    setStatus('busy', `round ${round}/${MAX_ROUNDS}`);
    showThinking(`round ${round}/${MAX_ROUNDS}`);

    // Corporate delay simulation
    if (delay > 0) await sleep(delay);
    throwIfStopRequested();

    let rawReply;
    let parsedReply;
    let reply;
    try {
      rawReply = await callLLM(messages, { timeoutMs: isLocalModeActive() ? 70000 : 35000, retries: isLocalModeActive() ? 1 : 2 });
      throwIfStopRequested();
      parsedReply = splitModelReply(rawReply);
      reply = parsedReply.visible;
      if (parsedReply.thinkingBlocks.length) {
      }
    } catch (e) {
      hideThinking();
      addMessage('error', `LLM error: ${e.message}`, round);
      setStatus('error', 'api error');
      return;
    }

    hideThinking();

    // Parse for tool call
    let toolCall = await resolveToolCallFromModelReply(reply, rawReply, userMessage);
    throwIfStopRequested();

    const turnGuard = await evaluateTurnGuardrailsWithLlm({
      userMessage,
      replyText: reply,
      proposedToolCall: toolCall,
      round,
      maxRounds: MAX_ROUNDS
    });
    throwIfStopRequested();

    if (toolCall?.tool && turnGuard?.action === 'replace' && turnGuard?.call?.tool) {
      toolCall = { tool: String(turnGuard.call.tool), args: turnGuard.call.args && typeof turnGuard.call.args === 'object' ? turnGuard.call.args : {} };
      addNotice(String(turnGuard.reason || 'Guardrail replaced tool call.'));
    }

    const leakedReasoning = !toolCall && orchestrator.hasReasoningLeak(reply);

    if (leakedReasoning) {
      messages.push({ role: 'assistant', content: rawReply || reply });
      messages.push({ role: 'user', content: await buildDirectAnswerRepairPrompt(userMessage) });
      addNotice('Model exposed internal reasoning. Requesting a direct answer.');
      updateCtxBar();
      continue;
    }

    if (!toolCall) {
      const cleanReply = reply.replace(getToolRegex(), '').trim();

      const likelyFinalAnswer = looksLikeFinalAnswerText(cleanReply);
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      const repeatedAssistantAnswer = normalizeComparableText(lastAssistant?.content) === normalizeComparableText(cleanReply) && !!cleanReply;
      const intermediary = !!turnGuard?.request_continuation && !likelyFinalAnswer && !repeatedAssistantAnswer;

      if (!!turnGuard?.request_continuation && !intermediary) {
        addNotice('Guardrail requested continuation, but answer looks final. Accepting final response.');
      }

      if (intermediary) {
        messages.push({ role: 'assistant', content: rawReply || reply });
        messages.push({
          role: 'user',
          content: 'Your previous answer looked like an intermediary status update. Continue the task now: either call exactly one tool, or provide a complete final answer.'
        });
        addNotice('Model returned an intermediary status update. Requesting continuation.');
        updateCtxBar();
        continue;
      }

      let finalMarkdown = cleanReply;
      throwIfStopRequested();

      addMessage('agent', finalMarkdown, round, false, false, []);
      messages.push({ role: 'assistant', content: finalMarkdown });
      syncSessionState();
      setStatus('ok', `done in ${round} round${round>1?'s':''}`);
      notifyIfHidden(finalMarkdown);
      updateCtxBar();
      return;
    }

    // Tool call detected
    const toolContent = reply.replace(getToolRegex(), '').trim();
    if (toolContent) {
      const shouldShowIntermediate = turnGuard?.show_intermediate !== undefined
        ? !!turnGuard.show_intermediate
        : true;
      if (shouldShowIntermediate) {
        addMessage('agent', toolContent, round, false, false, []);
      }
    }

    sessionStats.tools++;
    updateStats();

    addMessage('tool', `? ${toolCall.tool}(${JSON.stringify(toolCall.args)})`, round, true);
    showThinking(`executing ${toolCall.tool}…`);

    if (delay > 0) await sleep(delay * 0.5);
    throwIfStopRequested();

    const result = await executeTool(toolCall);
    throwIfStopRequested();
    hideThinking();
    addMessage('tool', `? ${result}`, round, false, true);

    if (!/^ERROR\b/i.test(String(result || ''))) {
      const evidenceFinal = await maybeFinalizeFromToolEvidenceWithLlm(userMessage, toolCall, result);
      throwIfStopRequested();
      if (evidenceFinal) {
        addMessage('agent', evidenceFinal, round, false, false, []);
        messages.push({ role: 'assistant', content: evidenceFinal });
        syncSessionState();
        setStatus('ok', `done in ${round} round${round>1?'s':''}`);
        notifyIfHidden(evidenceFinal);
        updateCtxBar();
        return;
      }
    }

    if (toolCall.tool === 'fs_list_dir' && !/^ERROR\b/i.test(String(result || ''))) {
      runFsRootExplored = true;
    }

    const failureState = recordToolFailure(toolCall, result);

    messages.push({ role: 'assistant', content: rawReply || reply });
    messages.push({ role: 'user', content: `<tool_result tool="${toolCall.tool}">\n${result}\n</tool_result>` });

    if (failureState.repeated) {
      const recoverySteering = await buildRecoverySteering(userMessage, toolCall, result);
      throwIfStopRequested();
      messages.push({ role: 'user', content: `Recovery guidance: ${recoverySteering}` });
      addNotice(`Repeated failure on ${getToolCallSignature(toolCall)}. Added recovery guidance and disabled only this failing call pattern.`);
    }

    // Check context limit
    if (ctxSize(messages) > CTX_LIMIT) {
      try {
        messages = await summarizeContext(userMessage);
      } catch (e) {
        addNotice(`? Summarization failed: ${e.message}`);
        messages = fallbackCompressContext(userMessage);
        addNotice('Applied fallback context compression without LLM.');
      }
    }
    syncSessionState();
    updateCtxBar();
  }

  // Exhausted rounds — force final answer
  addNotice('max_rounds (' + MAX_ROUNDS + ') reached. Forcing final answer.');
  messages.push({ role: 'user', content: 'Answer now with what you know so far. Return the final answer in Markdown only.' });
  showThinking('forcing final answer…');
  try {
    throwIfStopRequested();
    const finalReply = await callLLM(messages, { timeoutMs: isLocalModeActive() ? 70000 : 35000, retries: isLocalModeActive() ? 1 : 2 });
    throwIfStopRequested();
    const parsedFinalReply = splitModelReply(finalReply);
    const finalMarkdown = parsedFinalReply.visible.replace(getToolRegex(), '').trim();
    throwIfStopRequested();

    hideThinking();
    addMessage('agent', finalMarkdown, MAX_ROUNDS, false, false, []);
    messages.push({ role: 'assistant', content: finalMarkdown });
    syncSessionState();
    notifyIfHidden(finalMarkdown || 'Response ready. Check the latest result.');
  } catch (e) {
    hideThinking();
    addMessage('error', `Final answer failed: ${e.message}`, MAX_ROUNDS);
  }
  setStatus('ok', 'response limit reached');
  updateCtxBar();
}

// -- UI HELPERS ----------------------------------------------------------------
let thinkingEl = null;

function showThinking(label) {
  hideThinking();
  const el = document.createElement('div');
  el.className = 'thinking';
  el.id = 'thinking';
  el.innerHTML = `
    <div class="thinking-dots">
      <div class="dot"></div><div class="dot"></div><div class="dot"></div>
    </div>
    <span class="thinking-label">${label}</span>`;
  const container = document.getElementById('messages') || document.getElementById('chat');
  container.appendChild(el);
  scrollBottom();
}

function hideThinking() {
  const el = document.getElementById('thinking');
  if (el) el.remove();
}

function addMessage(role, content, round, isCall=false, isResult=false, hiddenThinking=[]) {
  document.getElementById('empty')?.remove();

  const wrap = document.createElement('div');

  if (role === 'user') {
    wrap.className = 'msg user';
    const bubble = document.createElement('div');
    bubble.className = 'msg-content';
    bubble.textContent = String(content || '');
    wrap.appendChild(bubble);
  } else if (role === 'agent') {
    wrap.className = 'msg assistant';
    const bubble = document.createElement('div');
    bubble.className = 'msg-content html-body';
    bubble.innerHTML = renderAgentHtml(content);
    wrap.appendChild(bubble);
    if (hiddenThinking.length) {
      const details = document.createElement('details');
      details.className = 'thinking-details';
      const summary = document.createElement('summary');
      summary.textContent = `Thinking (${hiddenThinking.length})`;
      details.appendChild(summary);
      const pre = document.createElement('pre');
      pre.className = 'thinking-pre';
      pre.textContent = hiddenThinking.join('\n\n---\n\n');
      details.appendChild(pre);
      wrap.appendChild(details);
    }
  } else {
    // tool, error, system — monospace pill style
    const cssRole = role === 'error' ? 'msg-error' : role === 'tool' ? 'msg-tool' : 'msg-system';
    wrap.className = `msg assistant ${cssRole}`;
    const bubble = document.createElement('div');
    bubble.className = 'msg-content msg-content-mono';
    const meta = [];
    if (round) meta.push(`R${round}`);
    if (isCall) meta.push('call');
    if (isResult) meta.push('result');
    if (meta.length) {
      const badge = document.createElement('span');
      badge.className = 'msg-meta-badge';
      badge.textContent = meta.join(' · ');
      bubble.appendChild(badge);
    }
    const text = document.createElement('span');
    text.textContent = String(content || '');
    bubble.appendChild(text);
    wrap.appendChild(bubble);
  }

  const container = document.getElementById('messages') || document.getElementById('chat');
  container.appendChild(wrap);
  scrollBottom();
}

function addNotice(text) {
  const el = document.createElement('div');
  el.className = 'ctx-notice';
  el.textContent = text;
  const container = document.getElementById('messages') || document.getElementById('chat');
  container.appendChild(el);
  scrollBottom();
}

function setStatus(state, label) {
  // topbar inline status
  const topbarStatus = document.getElementById('topbar-status');
  if (topbarStatus) topbarStatus.textContent = label;
  // topbar badge
  const badge = document.getElementById('badge-status');
  if (badge) badge.textContent = label;
  // legacy badge-status-dot (no-op if gone)
  const dot = document.getElementById('badge-status-dot');
  if (dot) dot.innerHTML = `<span class="status-dot ${state}"></span>&nbsp;${label}`;
}

function updateStats() {
  const rounds = document.getElementById('stat-rounds');
  if (rounds) rounds.textContent = sessionStats.rounds;
  const tools = document.getElementById('stat-tools');
  if (tools) tools.textContent = sessionStats.tools;
  const resets = document.getElementById('stat-resets');
  if (resets) resets.textContent = sessionStats.resets;
  const msgs = document.getElementById('stat-msgs');
  if (msgs) msgs.textContent = sessionStats.msgs;
}

function scrollBottom() {
  const chat = document.getElementById('chat');
  if (chat) chat.scrollTop = chat.scrollHeight;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -- SEND ----------------------------------------------------------------------
async function sendMessage() {
  if (isBusy) return;
  if (!runtimeReady()) {
    addMessage('error', 'Agent bootstrap failed: required modules were not loaded.', null);
    return;
  }
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;

  if (!isLocalModeActive() && !canUseCloud()) {
    addMessage('error', 'No cloud API key set. Enter your key in the sidebar and click Save.', null);
    return;
  }

  input.value = '';
  autoResize(input);
  isBusy = true;
  stopRequested = false;
  resetRunGuards();
  broadcastBusyState(true);
  const sendBtn = document.getElementById('btn-send');
  if (sendBtn) sendBtn.disabled = true;
  setStopButtonState(true);
  const inputStatus = document.getElementById('input-status');
  if (inputStatus) inputStatus.textContent = 'processing…';

  addMessage('user', text, null);
  if (!getActiveSession() || !getActiveSession().messages.length) {
    const session = getActiveSession() || createSession(text);
    session.title = makeSessionTitle(text);
  }
  saveSessions();
  renderSessionList();

  try {
    await agentLoop(text);
  } catch (e) {
    hideThinking();
    if (e?.code === 'RUN_STOPPED' || e?.name === 'AbortError') {
      addNotice('Run stopped by user.');
      setStatus('ok', 'stopped');
    } else {
      addMessage('error', e.message, null);
      setStatus('error', 'error');
    }
    syncSessionState();
  }

  isBusy = false;
  broadcastBusyState(false);
  const sendBtn2 = document.getElementById('btn-send');
  if (sendBtn2) sendBtn2.disabled = false;
  setStopButtonState(false);
  const inputStatus2 = document.getElementById('input-status');
  if (inputStatus2) inputStatus2.textContent = `${sessionStats.msgs} message${sessionStats.msgs!==1?'s':''} sent`;
  input.focus();
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function useExample(btn) {
  const input = document.getElementById('msg-input');
  input.value = btn.textContent;
  autoResize(input);
  input.focus();
}

function clearSession() {
  createSession();
  resetLiveSessionState();
  updateStats();
  updateCtxBar();
  renderChatFromMessages();
  renderSessionList();
  setStatus('ok', 'idle');
}

// -- INIT ----------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  applySidebarState();
  bindSidebarPanels();
  window.addEventListener('resize', handleResponsiveSidebar);
  updateBadge();
  updateStats();
  updateCtxBar();

  if (!runtimeReady()) {
    setStatus('error', 'bootstrap failed');
    addNotice('ERROR: required modules did not load. Check the browser console and reload the page.');
    return;
  }

  chatSessions = loadSessions();
  initCacheSync();
  initBusySync();
  updateFileAccessStatus();
  if (!chatSessions.length) createSession();
  if (!getActiveSession()) activeSessionId = chatSessions[0]?.id || createSession().id;
  renderSessionList();
  renderToolGroups();
  activateSession(activeSessionId);
  if (apiKey) {
    document.getElementById('api-key').value = apiKey;
    setStatus('ok', 'key set');
  }
  if (localBackend.url) {
    document.getElementById('local-url').value = localBackend.url;
    if (localBackend.model) {
      const sel = document.getElementById('local-model-select');
      sel.innerHTML = `<option value="${localBackend.model}">${localBackend.model}</option>`;
      sel.value = localBackend.model;
      document.getElementById('local-model-row').style.display = 'block';
    }
    if (localBackend.enabled) {
      _activateLocal(true);
    }
  }
  // Auto-probe local backends on load
  probeLocal();
  setStopButtonState(false);
});







