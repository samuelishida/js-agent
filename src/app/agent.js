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
let runDisabledSemanticToolCalls = new Set();
const runToolFailureCounts = new Map();
let runFsRootExplored = false;
let runSuccessfulToolCount = 0;
let runLocalTimeoutStreak = 0;
let runLastToolCallSignature = '';
let runRepeatedToolCallCount = 0;
let runCompactionState = {
  count: 0,
  consecutiveFailures: 0,
  lastCompactionRound: 0,
  lastBeforeSize: 0,
  lastAfterSize: 0
};
let runToolResultReplacementState = {
  seenSignatures: new Set(),
  replacements: new Map()
};
let runCompactedResultNoticeSignatures = new Set();

const TOOL_RESULT_CONTEXT_BUDGET = {
  inlineMaxChars: 6000,
  previewChars: 1800,
  keepRecentResults: 8
};

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
  runDisabledSemanticToolCalls = new Set();
  runToolFailureCounts.clear();
  runToolResultReplacementState = {
    seenSignatures: new Set(),
    replacements: new Map()
  };
  runCompactedResultNoticeSignatures = new Set();
  runFsRootExplored = false;
  runSuccessfulToolCount = 0;
  runLocalTimeoutStreak = 0;
  runLastToolCallSignature = '';
  runRepeatedToolCallCount = 0;
  runCompactionState = {
    count: 0,
    consecutiveFailures: 0,
    lastCompactionRound: 0,
    lastBeforeSize: 0,
    lastAfterSize: 0
  };
}

function getToolCallSignature(call) {
  return `${call?.tool || 'unknown'}:${JSON.stringify(call?.args || {})}`;
}

function getSemanticToolCallSignature(call) {
  const tool = String(call?.tool || '').trim();
  if (!tool) return 'unknown';

  if (tool !== 'web_search') {
    return getToolCallSignature(call);
  }

  const rawQuery = String(call?.args?.query || '').trim();
  const normalized = rawQuery
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(de|da|do|das|dos|para|por|com|na|no|nas|nos|em|e|a|o)\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const tokens = [...new Set(normalized.split(/\s+/).filter(Boolean))].sort();
  return `${tool}:${tokens.join(' ') || normalized || rawQuery.toLowerCase()}`;
}

function normalizeToolArgs(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
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

function canAttemptCompaction(round, currentSize, ctxLimit) {
  if (runCompactionState.consecutiveFailures >= 2) return false;
  if (round - runCompactionState.lastCompactionRound < 2) return false;
  if (currentSize < (ctxLimit * 0.8)) return false;
  return true;
}

function registerCompactionSuccess(round, beforeSize, afterSize) {
  runCompactionState.count += 1;
  runCompactionState.consecutiveFailures = 0;
  runCompactionState.lastCompactionRound = round;
  runCompactionState.lastBeforeSize = beforeSize;
  runCompactionState.lastAfterSize = afterSize;

  if (typeof getActiveSession === 'function') {
    const session = getActiveSession();
    if (session) {
      if (!session.context || typeof session.context !== 'object') {
        session.context = { compactions: 0, lastCompactedAt: null };
      }
      session.context.compactions = Number(session.context.compactions || 0) + 1;
      session.context.lastCompactedAt = new Date().toISOString();
      if (typeof saveSessions === 'function') {
        saveSessions();
      }
    }
  }
}

function registerCompactionFailure(round) {
  runCompactionState.consecutiveFailures += 1;
  runCompactionState.lastCompactionRound = round;
}

function recordRepeatedToolCall(call) {
  const signature = getSemanticToolCallSignature(call);

  if (signature === runLastToolCallSignature) {
    runRepeatedToolCallCount += 1;
  } else {
    runLastToolCallSignature = signature;
    runRepeatedToolCallCount = 1;
  }

  if (runRepeatedToolCallCount >= 2) {
    runDisabledSemanticToolCalls.add(signature);
    return { repeated: true, count: runRepeatedToolCallCount, signature };
  }

  return { repeated: false, count: runRepeatedToolCallCount, signature };
}

function getTurnLlmCallOptions() {
  if (isLocalModeActive()) {
    return { timeoutMs: 45000, retries: 0 };
  }
  return { timeoutMs: 35000, retries: 2 };
}

function resolveToolCallFromModelReply(reply, rawReply) {
  const direct = parseToolCall(reply);
  if (direct?.tool) return direct;

  const fromRaw = parseToolCall(rawReply);
  if (fromRaw?.tool) return fromRaw;

  return null;
}

function normalizeToolCallObject(call) {
  if (!call?.tool) return null;
  const tool = String(call.tool || '').trim();
  if (!tool) return null;
  return { tool, args: normalizeToolArgs(call.args) };
}

function dedupeToolCalls(calls, maxCalls = 3) {
  const deduped = [];
  const seen = new Set();

  for (const call of calls) {
    const normalized = normalizeToolCallObject(call);
    if (!normalized) continue;
    const signature = getToolCallSignature(normalized);
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(normalized);
    if (deduped.length >= maxCalls) break;
  }

  return deduped;
}

function resolveToolCallsFromModelReply(reply, rawReply) {
  const blockMatches = String(rawReply || '')
    .match(/<tool_call>\s*[\s\S]*?<\/tool_call>/gi) || [];

  const parsedBlockCalls = blockMatches
    .map(block => parseToolCall(block))
    .filter(call => !!call?.tool);

  if (parsedBlockCalls.length) {
    return dedupeToolCalls(parsedBlockCalls);
  }

  const fallbackCall = resolveToolCallFromModelReply(reply, rawReply);
  return fallbackCall ? [fallbackCall] : [];
}

function getToolExecutionMeta(toolName) {
  const metaFromSkills = window.AgentSkills?.getToolExecutionMeta?.(toolName);
  if (metaFromSkills) return metaFromSkills;

  const name = String(toolName || '').trim();
  if (name === 'calc' || name === 'datetime') {
    return { readOnly: true, concurrencySafe: true, destructive: false, riskLevel: 'normal' };
  }

  return { readOnly: false, concurrencySafe: false, destructive: false, riskLevel: 'normal' };
}

function canRunToolConcurrently(call) {
  const meta = getToolExecutionMeta(call?.tool);
  return !!meta.concurrencySafe;
}

function partitionToolCallBatches(calls) {
  const batches = [];

  for (const call of calls) {
    const concurrencySafe = canRunToolConcurrently(call);
    const lastBatch = batches[batches.length - 1];

    if (concurrencySafe && lastBatch?.concurrencySafe) {
      lastBatch.calls.push(call);
      continue;
    }

    batches.push({ concurrencySafe, calls: [call] });
  }

  return batches;
}

async function executeTool(call) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  const { tool, args } = call;

  const callSignature = getToolCallSignature(call);
  const semanticSignature = getSemanticToolCallSignature(call);

  if (runDisabledToolCalls.has(callSignature)) {
    return `ERROR: tool call '${callSignature}' is temporarily disabled for this run after repeated failures.`;
  }

  if (runDisabledSemanticToolCalls.has(semanticSignature)) {
    return `ERROR: tool call '${tool}' was blocked to prevent repeated near-duplicate requests in this run.`;
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

  const compactBoundary = `[COMPACT_BOUNDARY]\n${new Date().toISOString()}`;

  return [
    sysMsg,
    { role: 'assistant', content: compactBoundary },
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

function applyToolResultContextBudget(call, result) {
  const text = String(result || '');
  if (!text) return text;

  const signature = getToolCallSignature(call);
  const existingReplacement = runToolResultReplacementState.replacements.get(signature);
  if (existingReplacement !== undefined) {
    return existingReplacement;
  }

  runToolResultReplacementState.seenSignatures.add(signature);

  if (/^ERROR\b/i.test(text) || text.length <= TOOL_RESULT_CONTEXT_BUDGET.inlineMaxChars) {
    return text;
  }

  const preview = text.slice(0, TOOL_RESULT_CONTEXT_BUDGET.previewChars).trimEnd();
  const compacted = [
    '[tool_result_compacted]',
    `Tool: ${call?.tool || 'unknown'}`,
    `Original chars: ${text.length}`,
    '',
    'Preview:',
    preview,
    '',
    'Use narrower follow-up tool calls if full output is required.'
  ].join('\n');

  runToolResultReplacementState.replacements.set(signature, compacted);
  return compacted;
}

function microcompactToolResultMessages(msgs, keepRecent = TOOL_RESULT_CONTEXT_BUDGET.keepRecentResults) {
  const toolResultIndexes = [];
  for (let i = 0; i < msgs.length; i += 1) {
    const msg = msgs[i];
    if (msg?.role !== 'user') continue;
    if (!String(msg?.content || '').includes('<tool_result')) continue;
    toolResultIndexes.push(i);
  }

  if (toolResultIndexes.length <= keepRecent) {
    return { messages: msgs, clearedCount: 0, savedChars: 0 };
  }

  const keepSet = new Set(toolResultIndexes.slice(-Math.max(1, keepRecent)));
  const next = [...msgs];
  let clearedCount = 0;
  let savedChars = 0;

  for (const index of toolResultIndexes) {
    if (keepSet.has(index)) continue;

    const original = String(msgs[index]?.content || '');
    if (original.includes('[Old tool result content cleared by microcompact]')) continue;

    const compacted = original.replace(
      /<tool_result([^>]*)>[\s\S]*?<\/tool_result>/gi,
      '<tool_result$1>\n[Old tool result content cleared by microcompact]\n</tool_result>'
    );

    if (compacted === original) continue;
    clearedCount += 1;
    savedChars += Math.max(0, original.length - compacted.length);
    next[index] = { ...msgs[index], content: compacted };
  }

  return { messages: next, clearedCount, savedChars };
}

async function applyContextManagementPipeline({ round, userMessage, ctxLimit }) {
  const microcompact = microcompactToolResultMessages(messages);
  if (microcompact.clearedCount > 0) {
    messages = microcompact.messages;
    addNotice(`Context manager: cleared ${microcompact.clearedCount} older tool result(s), saved ~${microcompact.savedChars} chars.`);
  }

  const currentCtxSize = ctxSize(messages);
  if (currentCtxSize <= ctxLimit) {
    return;
  }

  if (!canAttemptCompaction(round, currentCtxSize, ctxLimit)) {
    addNotice('Context near limit, but compaction is cooling down after recent attempts/failures.');
    return;
  }

  try {
    const beforeSize = currentCtxSize;
    messages = await summarizeContext(userMessage);
    const afterSize = ctxSize(messages);

    // If summarization does not reduce enough, fall back to deterministic tail compression.
    if (afterSize >= (beforeSize * 0.9)) {
      addNotice('LLM summarization reduction was small; applying deterministic tail compression.');
      messages = fallbackCompressContext(userMessage);
    }

    registerCompactionSuccess(round, beforeSize, ctxSize(messages));
  } catch (e) {
    registerCompactionFailure(round);
    addNotice(`? Summarization failed: ${e.message}`);
    messages = fallbackCompressContext(userMessage);
    addNotice('Applied fallback context compression without LLM.');
    if (runCompactionState.consecutiveFailures >= 2) {
      addNotice('Compaction disabled for this run after repeated failures.');
    }
  }
}

// -- AGENTIC LOOP --------------------------------------------------------------
async function agentLoop(userMessage) {
  assertRuntimeReady();
  throwIfStopRequested();
  const { skills } = getRuntimeModules();
  const MAX_ROUNDS = getMaxRounds();
  const CTX_LIMIT  = getCtxLimit();
  const delay      = getDelay();
  const enrichedMessage = await skills.buildInitialContext(userMessage);
  throwIfStopRequested();

  // Init messages for this turn
  messages = [
    { role: 'system', content: await buildSystemPrompt(userMessage) },
    ...messages.filter(m => m.role !== 'system').slice(-20), // keep last 20 non-system
    { role: 'user', content: enrichedMessage }
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
      rawReply = await callLLM(messages, getTurnLlmCallOptions());
      throwIfStopRequested();
      parsedReply = splitModelReply(rawReply);
      reply = parsedReply.visible;
      runLocalTimeoutStreak = 0;
      if (parsedReply.thinkingBlocks.length) {
      }
    } catch (e) {
      hideThinking();
      if (isLocalModeActive() && /timeout/i.test(String(e?.message || '')) && round < MAX_ROUNDS) {
        runLocalTimeoutStreak += 1;
        if (runLocalTimeoutStreak <= 2) {
          addNotice(`Local model timed out on round ${round}. Retrying with concise continuation guidance.`);
          messages.push({
            role: 'user',
            content: 'Previous attempt timed out. Continue from the current context with a concise response: either call exactly one tool with complete args or provide the final answer.'
          });
          updateCtxBar();
          continue;
        }
      }
      addMessage('error', `LLM error: ${e.message}`, round);
      setStatus('error', 'api error');
      return;
    }

    hideThinking();

    // Parse for tool call(s)
    const toolCalls = resolveToolCallsFromModelReply(reply, rawReply);
    throwIfStopRequested();

    if (!toolCalls.length) {
      const cleanReply = reply.replace(getToolRegex(), '').trim();

      if (!cleanReply) {
        messages.push({ role: 'assistant', content: rawReply || reply });
        messages.push({
          role: 'user',
          content: 'No valid tool call or final answer was returned. Continue now: either call exactly one tool with complete args, or provide a complete final answer.'
        });
        addNotice('Model returned empty output. Requesting continuation.');
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

    const validToolCalls = [];
    const blockedToolReasons = [];

    for (const candidateCall of toolCalls) {
      const normalizedCandidate = normalizeToolCallObject(candidateCall);
      if (!normalizedCandidate) continue;

      const repeatState = recordRepeatedToolCall(normalizedCandidate);
      if (repeatState.repeated) {
        blockedToolReasons.push(`repeated loop detected for ${repeatState.signature}`);
        addNotice(`Blocked repeated tool-call loop: ${repeatState.signature}`);
        continue;
      }

      validToolCalls.push(normalizedCandidate);
    }

    if (!validToolCalls.length) {
      messages.push({ role: 'assistant', content: rawReply || reply });
      messages.push({
        role: 'user',
        content: `All proposed tool calls were blocked or invalid (${blockedToolReasons.join('; ') || 'no valid call'}). Do not repeat them. Choose different valid tools with complete args or provide a final answer.`
      });
      updateCtxBar();
      continue;
    }

    // Tool call(s) detected
    const toolContent = String(reply || '').replace(/<tool_call>\s*[\s\S]*?<\/tool_call>/gi, '').trim();
    if (toolContent) {
      addMessage('agent', toolContent, round, false, false, []);
    }

    messages.push({ role: 'assistant', content: rawReply || reply });

    for (const toolCall of validToolCalls) {
      sessionStats.tools++;
      updateStats();
      addMessage('tool', `? ${toolCall.tool}(${JSON.stringify(toolCall.args)})`, round, true);
    }

    const batches = partitionToolCallBatches(validToolCalls);
    for (const batch of batches) {
      throwIfStopRequested();

      let batchResults = [];
      if (batch.concurrencySafe && batch.calls.length > 1) {
        showThinking(`executing ${batch.calls.length} read-only tools…`);
        if (delay > 0) await sleep(Math.min(250, delay));
        batchResults = await Promise.all(batch.calls.map(async call => {
          try {
            const result = await executeTool(call);
            return { call, result };
          } catch (error) {
            return { call, result: `ERROR executing ${call.tool}: ${error?.message || 'unknown failure'}` };
          }
        }));
        hideThinking();
      } else {
        for (const call of batch.calls) {
          showThinking(`executing ${call.tool}…`);
          if (delay > 0) await sleep(delay * 0.5);
          let result;
          try {
            result = await executeTool(call);
          } catch (error) {
            result = `ERROR executing ${call.tool}: ${error?.message || 'unknown failure'}`;
          }
          hideThinking();
          batchResults.push({ call, result });
        }
      }

      for (const { call: toolCall, result } of batchResults) {
        throwIfStopRequested();
        addMessage('tool', `? ${result}`, round, false, true);

        if (!/^ERROR\b/i.test(String(result || ''))) {
          runSuccessfulToolCount += 1;
        }

        if (toolCall.tool === 'fs_list_dir' && !/^ERROR\b/i.test(String(result || ''))) {
          runFsRootExplored = true;
        }

        const failureState = recordToolFailure(toolCall, result);
        const contextSafeResult = applyToolResultContextBudget(toolCall, result);
        if (contextSafeResult !== String(result || '')) {
          const signature = getToolCallSignature(toolCall);
          if (!runCompactedResultNoticeSignatures.has(signature)) {
            runCompactedResultNoticeSignatures.add(signature);
            addNotice(`Context manager compacted a large ${toolCall.tool} result before storing it in history.`);
          }
        }

        messages.push({ role: 'user', content: `<tool_result tool="${toolCall.tool}">\n${contextSafeResult}\n</tool_result>` });

        if (failureState.repeated) {
          messages.push({
            role: 'user',
            content: `Previous tool call failed repeatedly (${getToolCallSignature(toolCall)}). Do not repeat it. Choose a different tool or provide a final answer with available evidence.`
          });
          addNotice(`Repeated failure on ${getToolCallSignature(toolCall)}. Disabled this call pattern for this run.`);
        }
      }
    }

    await applyContextManagementPipeline({ round, userMessage, ctxLimit: CTX_LIMIT });

    syncSessionState();
    updateCtxBar();
  }

  // Exhausted rounds — force final answer
  addNotice('max_rounds (' + MAX_ROUNDS + ') reached. Forcing final answer.');
  const noEvidenceWarning = runSuccessfulToolCount === 0
    ? 'No successful tool evidence was gathered in this run. Do not fabricate facts; clearly state uncertainty and what could not be verified.'
    : 'Use only the verified tool evidence already gathered in this run.';
  messages.push({ role: 'user', content: `Answer now with what you know so far. Return the final answer in Markdown only. ${noEvidenceWarning}` });
  showThinking('forcing final answer…');
  try {
    throwIfStopRequested();
    const finalReply = await callLLM(messages, getTurnLlmCallOptions());
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
  loadGithubTokenStatus();
  if (typeof loadOllamaCloudEndpoint === 'function') {
    loadOllamaCloudEndpoint();
  }
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







