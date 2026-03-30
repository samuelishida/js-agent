function getToolRegex() {
  return getRuntimeModules().regex?.TOOL_BLOCK || /<tool_call>[\s\S]*?<\/tool_call>/gi;
}

function parseToolCall(text) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  return orchestrator.parseToolCall(text);
}

async function executeTool(call) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  const { tool, args } = call;

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
  bar.style.width = pct + '%';
  bar.classList.toggle('warn', pct > 60 && pct <= 85);
  bar.classList.toggle('danger', pct > 85);
  label.textContent = pct.toFixed(1) + '%';
  document.getElementById('stat-ctx').textContent = size.toLocaleString();
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
  const summary = await callGemini([
    sysMsg,
    { role: 'user', content: prompt }
  ]);

  return [
    sysMsg,
    { role: 'assistant', content: `[SUMMARISED CONTEXT]\n${summary}` },
    { role: 'user', content: userQuery }
  ];
}

async function generateFinalMarkdownAnswer(candidateAnswer, userMessage) {
  assertRuntimeReady();

  const systemInstruction = `You are a concise, final-answer-only assistant. Return exactly one answer formatted in Markdown. Do not include analysis, tool call syntax, or surrounding words like 'final answer'. Never output <think> tags.`;
  const userInstruction = `Context-based finalization request.\n\nOriginal assistant output:\n${candidateAnswer}\n\nProvide a single cleaned final response in Markdown format, without HTML wrapper.`;

  const finalReply = await callGemini([
    { role: 'system', content: systemInstruction },
    { role: 'user', content: userInstruction }
  ]);

  const finalText = splitModelReply(finalReply).visible.replace(getToolRegex(), '').trim();
  if (!finalText) {
    return candidateAnswer.trim();
  }

  return finalText;
}

function looksLikeIntermediaryReply(text) {
  const value = String(text || '').trim();
  if (!value) return true;

  const progressRegex = /(verificando|checking|let me check|vou verificar|analisando|aguarde|one moment|um momento|investigando|working on it|processing)/i;
  const hasProgressCue = progressRegex.test(value);
  const isShort = value.length <= 220;
  const hasToolBlock = /<tool_call>[\s\S]*?<\/tool_call>/i.test(value);
  const endsLikeFinal = /[.!?]$/.test(value);

  return !hasToolBlock && hasProgressCue && isShort && !endsLikeFinal;
}

// -- AGENTIC LOOP --------------------------------------------------------------
async function agentLoop(userMessage) {
  assertRuntimeReady();
  const { skills, orchestrator } = getRuntimeModules();
  const MAX_ROUNDS = getMaxRounds();
  const CTX_LIMIT  = getCtxLimit();
  const delay      = getDelay();
  const enrichedMessage = await skills.buildInitialContext(userMessage);

  // Init messages for this turn
  messages = [
    { role: 'system', content: await buildSystemPrompt(userMessage) },
    ...messages.filter(m => m.role !== 'system').slice(-20), // keep last 20 non-system
    { role: 'user', content: enrichedMessage }
  ];

  let round = 0;
  sessionStats.msgs++;

  while (round < MAX_ROUNDS) {
    round++;
    sessionStats.rounds++;
    updateStats();

    setStatus('busy', `round ${round}/${MAX_ROUNDS}`);
    showThinking(`round ${round}/${MAX_ROUNDS}`);

    // Corporate delay simulation
    if (delay > 0) await sleep(delay);

    let rawReply;
    let parsedReply;
    let reply;
    try {
      rawReply = await callGemini(messages);
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
    const toolCall = parseToolCall(reply);
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

      // Guardrail: do not accept short progress-style replies as final output.
      if (round < MAX_ROUNDS && looksLikeIntermediaryReply(cleanReply)) {
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
      if (!isLocalModeActive()) {
        try {
          finalMarkdown = await generateFinalMarkdownAnswer(cleanReply, userMessage);
        } catch {
          finalMarkdown = cleanReply;
        }
      }

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
    if (toolContent) addMessage('agent', toolContent, round, false, false, parsedReply?.thinkingBlocks || []);

    sessionStats.tools++;
    updateStats();

    addMessage('tool', `? ${toolCall.tool}(${JSON.stringify(toolCall.args)})`, round, true);
    showThinking(`executing ${toolCall.tool}…`);

    if (delay > 0) await sleep(delay * 0.5);

    const result = await executeTool(toolCall);
    hideThinking();
    addMessage('tool', `? ${result}`, round, false, true);

    messages.push({ role: 'assistant', content: rawReply || reply });
    messages.push({ role: 'user', content: `<tool_result tool="${toolCall.tool}">\n${result}\n</tool_result>` });

    // Check context limit
    if (ctxSize(messages) > CTX_LIMIT) {
      try {
        messages = await summarizeContext(userMessage);
      } catch (e) {
        addNotice(`? Summarization failed: ${e.message}`);
      }
    }
    syncSessionState();
    updateCtxBar();
  }

  // Exhausted rounds — force final answer
  addNotice('max_rounds (' + MAX_ROUNDS + ') reached. Forcing final answer.');
  messages.push({ role: 'user', content: 'Answer now with what you know so far. Return the final answer as valid HTML only.' });
  showThinking('forcing final answer…');
  try {
    const finalReply = await callGemini(messages);
    const parsedFinalReply = splitModelReply(finalReply);
    const finalMarkdown = isLocalModeActive()
      ? parsedFinalReply.visible.replace(getToolRegex(), '').trim()
      : await generateFinalMarkdownAnswer(parsedFinalReply.visible, userMessage);

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
  document.getElementById('chat').appendChild(el);
  scrollBottom();
}

function hideThinking() {
  const el = document.getElementById('thinking');
  if (el) el.remove();
}

function addMessage(role, content, round, isCall=false, isResult=false, hiddenThinking=[]) {
  document.getElementById('empty')?.remove();

  const wrap = document.createElement('div');
  wrap.className = 'msg';

  const roleLabels = { user:'USER', agent:'AGENT', tool:'TOOL', system:'SYSTEM', error:'ERROR' };
  const roleCls    = { user:'role-user', agent:'role-agent', tool:'role-tool', system:'role-system', error:'role-error' };

  wrap.innerHTML = `
    <div class="msg-header">
      <span class="msg-role ${roleCls[role]}">${roleLabels[role]}</span>
      ${round ? `<span class="msg-round">R${round}</span>` : ''}
      ${isCall   ? `<span class="msg-round" style="color:var(--green)">call</span>` : ''}
      ${isResult ? `<span class="msg-round" style="color:var(--green)">result</span>` : ''}
    </div>`;

  const body = document.createElement('div');
  body.className = `msg-body ${role==='tool'?'dim':''} ${role==='agent'?'html-body':''}`.trim();
  if (role === 'agent') {
    body.innerHTML = renderAgentHtml(content);
  } else {
    body.textContent = String(content || '');
  }
  wrap.appendChild(body);

  if (role === 'agent' && hiddenThinking.length) {
    const details = document.createElement('details');
    details.className = 'thinking-details';

    const summary = document.createElement('summary');
    summary.textContent = `Hidden thinking (${hiddenThinking.length})`;
    details.appendChild(summary);

    const pre = document.createElement('pre');
    pre.className = 'thinking-pre';
    pre.textContent = hiddenThinking.join('\n\n---\n\n');
    details.appendChild(pre);
    wrap.appendChild(details);
  }

  document.getElementById('chat').appendChild(wrap);
  scrollBottom();
}

function addNotice(text) {
  const el = document.createElement('div');
  el.className = 'ctx-notice';
  el.textContent = text;
  document.getElementById('chat').appendChild(el);
  scrollBottom();
}

function setStatus(state, label) {
  const badge = document.getElementById('badge-status');
  badge.innerHTML = `<span class="status-dot ${state}"></span>&nbsp;${label}`;
}

function updateStats() {
  document.getElementById('stat-rounds').textContent = sessionStats.rounds;
  document.getElementById('stat-tools').textContent  = sessionStats.tools;
  document.getElementById('stat-resets').textContent = sessionStats.resets;
  document.getElementById('stat-msgs').textContent   = sessionStats.msgs;
}

function scrollBottom() {
  const chat = document.getElementById('chat');
  chat.scrollTop = chat.scrollHeight;
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

  if (!isLocalModeActive() && !canUseGemini()) {
    addMessage('error', 'No Gemini API key set. Enter your key in the sidebar and click Save.', null);
    return;
  }

  input.value = '';
  autoResize(input);
  isBusy = true;
  broadcastBusyState(true);
  document.getElementById('btn-send').disabled = true;
  document.getElementById('input-status').textContent = 'processing…';

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
    addMessage('error', e.message, null);
    setStatus('error', 'error');
    syncSessionState();
  }

  isBusy = false;
  broadcastBusyState(false);
  document.getElementById('btn-send').disabled = false;
  document.getElementById('input-status').textContent = `${sessionStats.msgs} message${sessionStats.msgs!==1?'s':''} sent`;
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
});







