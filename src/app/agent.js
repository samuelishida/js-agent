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
}

function requestStop() {
  if (!isBusy) return;
  stopRequested = true;
  setStatus('busy', 'stopping…');
  document.getElementById('input-status').textContent = 'stopping…';
  window.AgentLLMControl?.abortActiveLlmRequest?.();
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

function isFilesystemTask(userMessage) {
  return /(arquivo|arquivos|file|files|readme|path|caminho|pasta|folder|diret[oó]rio|directory|fs_)/i.test(String(userMessage || ''));
}

function requiresFilesystemPath(toolName) {
  return new Set([
    'fs_read_file',
    'fs_preview_file',
    'fs_exists',
    'fs_stat',
    'fs_tree',
    'fs_search_name',
    'fs_search_content',
    'fs_mkdir',
    'fs_touch',
    'fs_delete_path',
    'fs_rename_path',
    'fs_move_file',
    'fs_copy_file',
    'fs_write_file'
  ]).has(String(toolName || ''));
}

function applyFilesystemExplorationGuardrail(call, userMessage) {
  if (!call?.tool) return { call, guarded: false };

  const tool = String(call.tool);
  const args = call.args || {};
  const isFsTool = tool.startsWith('fs_');
  const fileTask = isFilesystemTask(userMessage);

  if (!fileTask) return { call, guarded: false };

  // For file tasks, if model drifts into non-filesystem tools, force root exploration first.
  if (!isFsTool && !runFsRootExplored) {
    return {
      call: { tool: 'fs_list_dir', args: { path: '/' } },
      guarded: true,
      reason: `Guardrail: switched ${tool} to fs_list_dir('/') to discover files before other operations.`
    };
  }

  // For first filesystem action in a file task, require a root exploration pass.
  if (isFsTool && tool !== 'fs_list_dir' && tool !== 'fs_list_roots' && !runFsRootExplored) {
    return {
      call: { tool: 'fs_list_dir', args: { path: '/' } },
      guarded: true,
      reason: `Guardrail: forcing fs_list_dir('/') before ${tool} to anchor path resolution.`
    };
  }

  // If a path-required filesystem tool came without path, recover by exploring root instead of looping errors.
  if (isFsTool && requiresFilesystemPath(tool) && !args.path) {
    return {
      call: { tool: 'fs_list_dir', args: { path: '/' } },
      guarded: true,
      reason: `Guardrail: ${tool} requires args.path; running fs_list_dir('/') to recover context.`
    };
  }

  return { call, guarded: false };
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
    const response = await callGemini([
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userInstruction }
    ]);

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
    const response = await callGemini([
      {
        role: 'system',
        content: 'You produce one concise recovery instruction for a tool-using agent. No tool_call blocks, no analysis.'
      },
      {
        role: 'user',
        content: `User request: ${userMessage}\nFailed tool: ${call.tool}\nError: ${toolError}\nReturn one short recovery instruction.`
      }
    ]);

    const steering = splitModelReply(response).visible.replace(getToolRegex(), '').trim();
    if (!steering || parseToolCall(steering)) return fallback;
    return steering;
  } catch {
    return fallback;
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

  const userInstruction = `Allowed tools: ${allowedTools}\nUser request: ${userMessage}\nDraft reply: ${replyText}\nReturn JSON or NONE.`;

  try {
    const raw = await callGemini([
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userInstruction }
    ]);

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

function isExplicitFileDisplayRequest(userMessage) {
  return /(mostre|mostrar|show|display|conteudo|conteúdo|full|completo|inteiro).*(readme|arquivo|file)|((readme|arquivo|file).*(no chat|in chat|aqui))/i.test(String(userMessage || ''));
}

function extractReadFilePayload(result) {
  const raw = String(result || '');
  const hasMore = /Has more:\s*yes/i.test(raw);
  const match = raw.match(/Next offset:[^\n]*\n\n([\s\S]*)$/i);
  return {
    content: (match ? match[1] : raw).trim(),
    hasMore
  };
}

function looksLikeMetaPromptLeak(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return /(You are a response formatter|Draft Assistant Reply|Polish this for user display|execution_steering|Return strict guidance)/i.test(value);
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
      rawReply = await callGemini(messages);
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

    if (toolCall?.tool) {
      const guard = applyFilesystemExplorationGuardrail(toolCall, userMessage);
      if (guard.guarded) {
        toolCall = guard.call;
        addNotice(guard.reason);
      }
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
    if (toolContent && !looksLikeMetaPromptLeak(toolContent)) {
      addMessage('agent', toolContent, round, false, false, []);
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

    if (toolCall.tool === 'fs_read_file' && !/^ERROR\b/i.test(String(result || '')) && isExplicitFileDisplayRequest(userMessage)) {
      const payload = extractReadFilePayload(result);
      const finalMarkdown = payload.hasMore
      ? `Aqui está a primeira parte do arquivo:\n\n\`\`\`text\n${payload.content}\n\`\`\`\n\nO arquivo é maior que um único bloco. Posso continuar com a próxima parte.`
        : payload.content;

      addMessage('agent', finalMarkdown, round, false, false, []);
      messages.push({ role: 'assistant', content: finalMarkdown });
      syncSessionState();
      setStatus('ok', `done in ${round} round${round>1?'s':''}`);
      notifyIfHidden('File content ready.');
      updateCtxBar();
      return;
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
    const finalReply = await callGemini(messages);
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
  stopRequested = false;
  resetRunGuards();
  broadcastBusyState(true);
  document.getElementById('btn-send').disabled = true;
  setStopButtonState(true);
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
  document.getElementById('btn-send').disabled = false;
  setStopButtonState(false);
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
  setStopButtonState(false);
});







