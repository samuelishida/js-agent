// ── Agent Loop ─────────────────────────────────────────────────────────────────
// The main agent loop and UI wiring. All extracted logic lives in sibling
// modules (steering.js, permissions.js, tool-execution.js, compaction.js)
// and is accessed via window.* properties. This file should remain focused
// on orchestration and event binding.
// ─────────────────────────────────────────────────────────────────────────────

function stripModelMetaCommentary(text) {
  let value = String(text || '').trim();
  if (!value) return '';
  value = value.replace(/^[Ww]e (?:need|have|must) to output (?:tool|function) calls? only\.?\s*/i, '');
  value = value.replace(/^[Ww]e (?:will|should|must|need to|are going to) (?:call|use|invoke|execute|run) \S+(?:\s+with\s+[^.]+)?\.?\s*/i, '');
  value = value.replace(/^[Ii] (?:will|should|need to|must|am going to|am) (?:call|use|invoke|execute|run|outputting) \S+(?:\s+with\s+[^.]+)?\.?\s*/i, '');
  value = value.replace(/^[Ll]et's (?:call|use|try|invoke) \S+\.?\s*/i, '');
  value = value.replace(/^[Ww]e need to (?:output|generate|produce|call|make) (?:a )?(?:tool|function) call\.?\s*/i, '');
  value = value.replace(/^I need to (?:output|generate|produce|call|make) (?:a )?(?:tool|function) call\.?\s*/i, '');
  return value.trim();
}

// ── Constants accessor ───────────────────────────────────────────────────────
const C = () => window.CONSTANTS || {};

// ── Stop control ─────────────────────────────────────────────────────────────

let stopRequested = false;

function requestStop() {
  if (!window.isBusy) return;
  stopRequested = true;
  setStatus('busy', 'stopping…');
  const inputStatus = document.getElementById('input-status');
  if (inputStatus) inputStatus.textContent = 'stopping…';
  window.AgentLLMControl?.abortActiveLlmRequest?.();
  window.AgentSkills?.abortAllTabListeners?.('Run stopped by user.');
}

function throwIfStopRequested() {
  if (!stopRequested) return;
  const error = new Error('RUN_STOPPED');
  error.code = 'RUN_STOPPED';
  throw error;
}

function setStopButtonState(running) {
  const stopBtn = document.getElementById('btn-stop');
  if (!stopBtn) return;
  stopBtn.disabled = !running;
  stopBtn.style.display = running ? 'flex' : 'none';
  const sendBtn = document.getElementById('btn-send');
  if (sendBtn) sendBtn.style.display = running ? 'none' : 'flex';
}

// ── Reset run guards ─────────────────────────────────────────────────────────

function resetRunGuards() {
  window.AgentToolExecution?.resetRunToolState?.();
  window.AgentRateLimiter?.resetRateLimiter?.();
  window.AgentCompaction?.resetCompactionState?.();
  window.AgentPermissions?.resetRunPermissionState?.();
  window.AgentCompaction?.resetPromptInjectionState?.();
  stopRequested = false;
}

// ── Error classification helpers ─────────────────────────────────────────────

function isMaxOutputTokenLikeError(error) {
  const message = String(error?.message || '');
  if (!message) return false;
  return /(max(?:imum)?\s*(?:output\s*)?tokens?|max_output_tokens|output token limit|too many output tokens|exceeded.*output|finish_reason\s*[:=]\s*"?length"?)/i.test(message);
}

function looksLikeDeferredActionReply(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const futureActionPattern = /\b(?:i\s+will|i'll|let me|i am going to|i'm going to|next[, ]+i(?:\s+will|'ll)?|i'll\s+(?:start|begin|now)|now\s+i(?:'ll|\s+will))\b/i;
  const actionVerbPattern = /\b(?:search|look up|check|verify|probe|inspect|browse|review|find|perform|run|try|investigate|list|listing|read|reading|fetch|fetching|scan|scanning|call|calling|execute|executing|start|starting|begin|beginning|map|mapping|gather|gathering|analyze|analyzing|collect|collecting|query|querying|load|loading|open|opening|access|accessing|retrieve|retrieving|walk|walking|traverse|traversing|explore|exploring|examine|examining|identify|identifying|inspect)\b/i;
  const finalityPattern = /\b(?:final answer|in summary|overall|therefore|the answer is|based on (?:the|current) (?:evidence|information))\b/i;
  return futureActionPattern.test(value) && actionVerbPattern.test(value) && !finalityPattern.test(value);
}

function looksLikeToolExecutionClaimWithoutCall(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const executionClaimPattern = /\b(?:i\s+(?:have|already)\s+(?:executed|called|run|performed)|(?:the\s+)?tool\s+call\s+(?:has\s+been\s+)?(?:executed|made|performed)|executed\s+the\s+necessary\s+tool\s+call|necessary\s+tool\s+call)\b/i;
  const waitingPattern = /\b(?:please\s+wait|wait\s+for\s+(?:the\s+)?tool\s+output|await(?:ing)?\s+tool\s+output|once\s+the\s+tool\s+output|after\s+tool\s+output|provide\s+the\s+final\s+answer\s+after\s+tool\s+output)\b/i;
  const finalityPattern = /\b(?:final answer|in summary|overall|therefore|the answer is|based on (?:the|current) (?:evidence|information))\b/i;
  return executionClaimPattern.test(value) && waitingPattern.test(value) && !finalityPattern.test(value);
}

function getToolCallCleanupRegex() {
  const regex = window.AgentRegex;
  const sharedToolBlock = regex?.TOOL_BLOCK;
  if (sharedToolBlock instanceof RegExp) {
    return new RegExp(sharedToolBlock.source, 'gi');
  }
  return /<tool_call(?:\s[^>]*>|>?)\s*[\s\S]*?<\/tool_call>/gi;
}

// ── Query planning helpers ───────────────────────────────────────────────────

function extractPlannerOptimizedQueryFromMessages(messages = []) {
  const recentUserMessages = Array.isArray(messages)
    ? messages.filter(message => message?.role === 'user').slice(-8).reverse()
    : [];

  for (const message of recentUserMessages) {
    const content = String(message?.content || '');
    const queryPlanBlocks = [...content.matchAll(/<tool_result\s+tool="query_plan">\s*([\s\S]*?)\s*<\/tool_result>/gi)];
    for (let i = queryPlanBlocks.length - 1; i >= 0; i -= 1) {
      const block = String(queryPlanBlocks[i]?.[1] || '');
      const directMatch = block.match(/(?:^|\n)query=([^\n]+)/i);
      if (directMatch?.[1]) {
        const query = String(directMatch[1]).trim();
        if (query) return query;
      }
    }
    const plannerMatch = content.match(/Planner optimized query:\s*"([^"]+)"/i);
    if (plannerMatch?.[1]) {
      const query = String(plannerMatch[1]).trim();
      if (query) return query;
    }
  }
  return '';
}

function maybeExtractLongTermMemory(userMessage, assistantMessage) {
  return window.AgentMemory?.extractFromTurn?.({ userMessage, assistantMessage }) ?? null;
}

function completeToolCallArgs(call, { messages = [], userMessage = '' } = {}) {
  const TE = window.AgentToolExecution;
  const normalized = TE?.normalizeToolCallObject ? TE.normalizeToolCallObject(call) : null;
  if (!normalized) return null;

  if (normalized.tool === 'web_search' && !String(normalized.args?.query || '').trim()) {
    const recoveredQuery = extractPlannerOptimizedQueryFromMessages(messages) || String(userMessage || '').trim();
    if (recoveredQuery) {
      normalized.args = { ...normalized.args, query: recoveredQuery };
    }
  }

  return normalized;
}

// ── Tool call repair ─────────────────────────────────────────────────────────

function shouldAttemptToolCallRepair({ rawReply = '', cleanReply = '', thinkingBlocks = [] } = {}) {
  const raw = String(rawReply || '').trim();
  const visible = String(cleanReply || '').trim();
  if (!raw) return false;

  const { regex, orchestrator } = getRuntimeModules();

  if (regex?.hasUnprocessedToolCall?.(raw)) return true;
  if (/<\|tool_call>|<tool_call\b/i.test(raw) || /"tool"\s*:/i.test(raw)) return true;
  if (!visible && Array.isArray(thinkingBlocks) && thinkingBlocks.some(block => String(block || '').trim())) return true;
  if (looksLikeDeferredActionReply(visible)) return true;
  if (looksLikeToolExecutionClaimWithoutCall(visible)) return true;
  if (orchestrator?.hasReasoningLeak?.(visible)) return true;

  return false;
}

async function attemptToolCallRepair({ userMessage = '', rawReply = '', messages = [] } = {}) {
  const TE = window.AgentToolExecution;
  const assistantReply = String(rawReply || '').trim();
  if (!assistantReply) return null;

  const hashText = TE?.stableHashText || (v => v);
  const repairSignature = hashText(`${userMessage}\n${assistantReply}`);
  if (TE?.runToolCallRepairAttempts?.has(repairSignature)) return null;
  TE?.runToolCallRepairAttempts?.add(repairSignature);

  const enabledToolNames = Object.entries(window.enabledTools || {}).filter(([, enabled]) => !!enabled).map(([name]) => name);
  const systemMessage = Array.isArray(messages) ? messages.find(message => message?.role === 'system') : null;
  const recentMessages = Array.isArray(messages) ? messages.filter(message => message?.role !== 'system').slice(-12) : [];

  const { orchestrator } = getRuntimeModules();
  const repairPrompt = await orchestrator.buildRepairPrompt({
    userMessage,
    previousReply: assistantReply,
    enabledTools: enabledToolNames
  });

  const cfg = C();
  const repairedRawReply = await callLLM([
    ...(systemMessage ? [systemMessage] : []),
    ...recentMessages,
    { role: 'assistant', content: assistantReply },
    { role: 'user', content: repairPrompt }
  ], {
    maxTokens: cfg.TOOL_CALL_REPAIR_MAX_TOKENS || 450,
    temperature: cfg.TOOL_CALL_REPAIR_TEMPERATURE || 0.1,
    timeoutMs: isLocalModeActive()
      ? (cfg.TOOL_CALL_REPAIR_TIMEOUT_MS_LOCAL || 70000)
      : (cfg.TOOL_CALL_REPAIR_TIMEOUT_MS_CLOUD || 22000),
    retries: isLocalModeActive()
      ? (cfg.TOOL_CALL_REPAIR_RETRIES_LOCAL || 0)
      : (cfg.TOOL_CALL_REPAIR_RETRIES_CLOUD || 1)
  });
  const repairedParsedReply = splitModelReply(repairedRawReply);
  const TE2 = window.AgentToolExecution;
  const repairedToolCalls = TE2?.dedupeToolCalls ? TE2.dedupeToolCalls(TE2.resolveToolCallsFromModelReply(repairedParsedReply.visible, repairedRawReply)) : [];

  return {
    rawReply: repairedRawReply,
    parsedReply: repairedParsedReply,
    reply: repairedParsedReply.visible,
    toolCalls: repairedToolCalls
  };
}

// ── LLM call options ──────────────────────────────────────────────────────────

function getTurnLlmCallOptions() {
  const Comp = window.AgentCompaction || {};
  const recoverySteps = Math.max(0, Number(Comp.runMaxOutputTokensRecoveryCount || 0));
  const cfg = C();
  const modelMaxTokens = typeof getMaxTokensForModel === 'function'
    ? getMaxTokensForModel()
    : (cfg.DEFAULT_MAX_TOKENS_LOCAL || 4096);
  const maxTokens = Math.max(512, modelMaxTokens - (recoverySteps * 280));
  const enabledTools = Object.entries(window.enabledTools || {}).filter(([, v]) => !!v).map(([k]) => k);

  if (isLocalModeActive()) {
    return {
      timeoutMs: cfg.DEFAULT_TIMEOUT_MS_LOCAL || 120000,
      retries: cfg.DEFAULT_RETRIES_LOCAL || 0,
      maxTokens,
      enabledTools
    };
  }
  return {
    timeoutMs: cfg.DEFAULT_TIMEOUT_MS_CLOUD || 35000,
    retries: cfg.DEFAULT_RETRIES_CLOUD || 2,
    maxTokens,
    enabledTools
  };
}

// ── Child agent spawning ──────────────────────────────────────────────────────

async function spawnAgentChild({ task = '', tools = [], maxIterations = 10 } = {}) {
  if (!task) return { success: false, error: 'task is required' };
  if (!Array.isArray(tools)) tools = [];
  const cfg = C();
  const maxIters = Math.min(cfg.CHILD_AGENT_MAX_ITERATIONS || 50, Math.max(1, maxIterations));

  const childState = {
    messages: [],
    round: 0,
    maxRounds: maxIters,
    tools: new Set(tools),
    results: [],
    succeeded: false,
    error: null,
    startedAt: new Date().toISOString()
  };

  try {
    assertRuntimeReady();
    const { orchestrator } = getRuntimeModules();

    const sysPrompt = await orchestrator.buildSystemPrompt({ userMessage: task, enabledTools: Array.isArray(tools) ? tools : [] });
    childState.messages.push({ role: 'system', content: sysPrompt });
    childState.messages.push({ role: 'user', content: task });

    while (childState.round < childState.maxRounds) {
      childState.round++;

      let rawReply;
      try {
        rawReply = await callLLM(childState.messages, {
          maxTokens: cfg.CHILD_AGENT_MAX_TOKENS || 800,
          temperature: cfg.CHILD_AGENT_TEMPERATURE || 0.3,
          timeoutMs: cfg.CHILD_AGENT_TIMEOUT_MS || 22000,
          retries: cfg.CHILD_AGENT_RETRIES || 1,
          enabledTools: Array.isArray(tools) ? tools : []
        });
      } catch (e) {
        childState.error = `LLM call failed: ${e?.message || 'unknown'}`;
        break;
      }

      const parsedReply = splitModelReply(rawReply);
      const reply = parsedReply.visible;
      childState.messages.push({ role: 'assistant', content: reply });

      const TE = window.AgentToolExecution;
      let toolCalls = TE?.resolveToolCallsFromModelReply ? TE.resolveToolCallsFromModelReply(reply, rawReply) : [];
      if (!toolCalls.length) {
        childState.results.push({ type: 'final_answer', content: reply });
        childState.succeeded = true;
        break;
      }

      const filteredCalls = toolCalls.filter(call => !childState.tools.size || childState.tools.has(call.tool));
      if (!filteredCalls.length) {
        childState.results.push({ type: 'tool_calls_blocked', content: `Attempted tools not in allowed set: ${toolCalls.map(c => c.tool).join(', ')}` });
        break;
      }

      for (const call of filteredCalls) {
        let toolResult;
        try {
          toolResult = await (TE?.executeTool ? TE.executeTool(call) : `ERROR: executeTool not available`);
        } catch (e) {
          toolResult = `ERROR: ${e?.message || 'tool execution failed'}`;
        }
        childState.results.push({ type: 'tool_result', tool: call.tool, result: toolResult });
        childState.messages.push({ role: 'tool', tool_call_id: call.call_id || call.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`, content: String(toolResult) });
      }
    }

    if (!childState.succeeded && childState.round >= childState.maxRounds) {
      childState.error = `Max iterations (${childState.maxRounds}) reached without completion`;
    }
  } catch (e) {
    childState.error = `Child agent spawn failed: ${e?.message || 'unknown'}`;
  }

  return {
    success: childState.succeeded && !childState.error,
    task,
    iterations: childState.round,
    status: childState.succeeded ? 'completed' : (childState.error ? 'error' : 'timeout'),
    result: childState.results.length ? childState.results : childState.error,
    toolsSummary: `Executed ${childState.results.filter(r => r.type === 'tool_result').length} tool(s) across ${childState.round} iteration(s)`,
    childState: { messages: childState.messages.length, round: childState.round, maxRounds: childState.maxRounds }
  };
}

window.spawnAgentChild = spawnAgentChild;

// ── Notifications ────────────────────────────────────────────────────────────

function notifyIfHidden(summary) {
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window)) return;
  if (window.Notification.permission !== 'granted') return;

  try {
    new window.Notification('JS Agent', {
      body: String(summary || 'Task complete.').slice(0, (C().NOTIFICATION_BODY_MAX_CHARS || 200)),
      tag: 'agent-run-finished',
      silent: false
    });
  } catch (error) {
    console.warn('Notification failed:', error?.message || error);
  }
}

// ── Context bar ─────────────────────────────────────────────────────────────

function updateCtxBar() {
  const Comp = window.AgentCompaction;
  const size = Comp?.ctxSize ? Comp.ctxSize(window.messages) : window.messages.reduce((n, m) => n + (m.content || '').length, 0);
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
}

// ── MAIN AGENT LOOP ───────────────────────────────────────────────────────────

async function agentLoop(userMessage) {
  assertRuntimeReady();
  throwIfStopRequested();
  const { skills, orchestrator } = getRuntimeModules();
  const cfg = C();
  const MAX_ROUNDS = getMaxRounds();
  const CTX_LIMIT = getCtxLimit();
  const delay = getDelay();

  const TE = window.AgentToolExecution;
  if (TE) TE.runQueryTracking = {
    chainId: TE.generateRunChainId ? TE.generateRunChainId() : `chain_${Date.now().toString(36)}`,
    startedAt: new Date().toISOString()
  };

  const Perm = window.AgentPermissions || {};
  if (Perm.updateRunSessionContext) Perm.updateRunSessionContext({ queryTracking: TE?.runQueryTracking });
  Perm.emitAgentHook?.('session_start', {
    queryTracking: TE?.runQueryTracking,
    userMessage: String(userMessage || '')
  });

  const Comp = window.AgentCompaction;
  Comp?.armTimeBasedMicrocompactForTurn?.();
  const enrichedMessage = await skills.buildInitialContext(userMessage, { messages: window.messages });
  const memoryContextBlock = window.AgentMemory?.buildContextBlock?.(userMessage, window.messages) || '';
  const turnInputMessage = memoryContextBlock ? `${memoryContextBlock}\n\n${enrichedMessage}` : enrichedMessage;
  throwIfStopRequested();

  const enabledToolNames = Object.entries(window.enabledTools || {}).filter(([, v]) => !!v).map(([k]) => k);
  const sysPrompt = await orchestrator.buildSystemPrompt({ userMessage, maxRounds: MAX_ROUNDS, ctxLimit: CTX_LIMIT, enabledTools: enabledToolNames });
  const unresolvedPlaceholders = sysPrompt.match(/\{\{[^}]+\}\}/g);
  if (unresolvedPlaceholders) {
    throw new Error(`System prompt has unresolved template placeholders: ${unresolvedPlaceholders.join(', ')}`);
  }
  window.messages = [
    { role: 'system', content: sysPrompt },
    ...window.messages.filter(m => m.role !== 'system').slice(-20),
    { role: 'user', content: turnInputMessage }
  ];

  let round = 0;
  let consecutiveNonActionRounds = 0;
  window.sessionStats.msgs++;

  while (round < MAX_ROUNDS) {
    throwIfStopRequested();
    round++;
    window.sessionStats.rounds++;
    updateStats();

    setStatus('busy', `round ${round}/${MAX_ROUNDS}`);
    showThinking(`round ${round}/${MAX_ROUNDS}`);

    // Drain steering buffer — inject any mid-session guidance from user.
    const steeredMessages = window.AgentSteering?.drain ? window.AgentSteering.drain() : [];
    if (steeredMessages.length) {
      const combined = steeredMessages.join('\n\n');
      window.messages.push({
        role: 'user',
        content: `[USER STEERING — mid-session guidance, follow immediately]\n${combined}`
      });
      addNotice(`Steering injected: ${combined.slice(0, cfg.NOTE_MAX_CHARS || 120)}${combined.length > (cfg.NOTE_MAX_CHARS || 120) ? '…' : ''}`);
    }

    if (delay > 0) await sleep(delay);
    throwIfStopRequested();

    let rawReply;
    let parsedReply;
    let reply;
    try {
      rawReply = await callLLM(window.messages, getTurnLlmCallOptions());
      throwIfStopRequested();
      parsedReply = splitModelReply(rawReply);
      reply = parsedReply.visible;
      if (TE) TE.runLocalTimeoutStreak = 0;
    } catch (e) {
      hideThinking();
      if (e?.code === 'RUN_STOPPED' || e?.name === 'AbortError') throw e;

      if (isMaxOutputTokenLikeError(e) && round < MAX_ROUNDS) {
        if (Comp) Comp.runMaxOutputTokensRecoveryCount = (Comp.runMaxOutputTokensRecoveryCount || 0) + 1;
        if ((Comp?.runMaxOutputTokensRecoveryCount || 0) <= (cfg.MAX_OUTPUT_TOKEN_RECOVERY_ATTEMPTS || 3)) {
          const retryCount = Comp?.runMaxOutputTokensRecoveryCount || 1;
          addNotice(`Model output limit reached on round ${round}. Recovery attempt ${retryCount}/${cfg.MAX_OUTPUT_TOKEN_RECOVERY_ATTEMPTS || 3} with stricter brevity.`);

          if (retryCount >= 2) {
            const tightened = Comp?.microcompactToolResultMessages ? Comp.microcompactToolResultMessages(window.messages, {
              keepRecent: 4,
              clearOnly: true,
              clearedNotice: '[Older tool result content cleared after output-limit recovery]'
            }) : { clearedCount: 0, messages: window.messages, savedChars: 0 };
            if (tightened.clearedCount > 0) {
              window.messages = tightened.messages;
              addNotice(`Recovery compacted ${tightened.clearedCount} older tool result(s), saved ~${tightened.savedChars} chars.`);
            }
          }

          window.messages.push({
            role: 'user',
            content: 'Previous reply exceeded output token limits. Continue with a concise response under 220 words: either call the required tool(s) with complete args or provide a final answer grounded in current evidence.'
          });
          updateCtxBar();
          continue;
        }
      }

      if (isLocalModeActive() && /timeout/i.test(String(e?.message || '')) && round < MAX_ROUNDS) {
        if (TE) TE.runLocalTimeoutStreak = (TE.runLocalTimeoutStreak || 0) + 1;
        if ((TE?.runLocalTimeoutStreak || 0) <= 1) {
          addNotice(`Local model timed out on round ${round}. Retrying once with concise continuation guidance.`);
          window.messages.push({
            role: 'user',
            content: 'Previous attempt timed out. Continue from the current context with a concise response: either call the required tool(s) with complete args or provide the final answer.'
          });
          updateCtxBar();
          continue;
        }
      }

      // Model crashed or produced garbage — show user-friendly message
      if (e?.code === 'OLLAMA_INCOMPLETE_OUTPUT' || e?.code === 'LOCAL_INCOMPLETE_OUTPUT') {
        addMessage('error', e.message, round);
        setStatus('error', 'model error');
        return;
      }
      if (e?.code === 'OLLAMA_MODEL_CRASH' && round < MAX_ROUNDS) {
        addNotice(`Model crashed (EOF). Retrying with a compact continuation prompt.`);
        window.messages.push({
          role: 'user',
          content: 'The previous model call crashed. Continue now with a shorter, focused response: call one tool with complete args, or provide a concise final answer.'
        });
        updateCtxBar();
        continue;
      }
      addMessage('error', `LLM error: ${e.message}`, round);
      setStatus('error', 'api error');
      return;
    }

    hideThinking();

    let toolCalls = TE?.resolveToolCallsFromModelReply ? TE.resolveToolCallsFromModelReply(reply, rawReply) : [];
    throwIfStopRequested();

    if (!toolCalls.length) {
      const cleanReply = reply.replace(getToolCallCleanupRegex(), '').trim();
      if (shouldAttemptToolCallRepair({ rawReply, cleanReply, thinkingBlocks: parsedReply?.thinkingBlocks })) {
        try {
          const repaired = await attemptToolCallRepair({ userMessage, rawReply: rawReply || reply, messages: window.messages });
          throwIfStopRequested();
          if (repaired?.rawReply) {
            rawReply = repaired.rawReply;
            parsedReply = repaired.parsedReply;
            reply = repaired.reply;
            toolCalls = repaired.toolCalls;

            if (toolCalls.length) {
              addNotice(`Repair pass normalized malformed output into valid tool call(s): ${toolCalls.map(call => call.tool).join(', ')}.`);
            } else if (String(reply || '').trim()) {
              addNotice('Repair pass normalized malformed output into a contract-compliant reply.');
            }
          }
        } catch (error) {
          if (error?.code === 'RUN_STOPPED' || error?.name === 'AbortError') throw error;
          addNotice(`Repair pass failed: ${error?.message || 'unknown error'}`);
        }
      }
    }

    if (!toolCalls.length) {
      const cleanReply = reply.replace(getToolCallCleanupRegex(), '').trim();

      if (!cleanReply) {
        consecutiveNonActionRounds++;
        if (consecutiveNonActionRounds >= (cfg.MAX_CONSECUTIVE_NON_ACTION_ROUNDS || 6)) {
          addMessage('error', `Model returned empty output ${consecutiveNonActionRounds} times in a row — stopping to avoid burning rounds. Try a different model or rephrase your prompt.`, round);
          syncSessionState();
          setStatus('ok', `stopped after ${round} round${round > 1 ? 's' : ''}`);
          updateCtxBar();
          return;
        }
        window.messages.push({ role: 'assistant', content: rawReply || reply });
        window.messages.push({
          role: 'user',
          content: 'No valid tool call or final answer was returned. Continue now: call one or more tools with complete args, or provide a complete final answer.'
        });
        addNotice('Model returned empty output. Requesting continuation.');
        updateCtxBar();
        continue;
      }

      if (looksLikeDeferredActionReply(cleanReply)) {
        consecutiveNonActionRounds++;
        if (consecutiveNonActionRounds >= (cfg.MAX_CONSECUTIVE_NON_ACTION_ROUNDS || 6)) {
          addMessage('error', `Model narrated instead of acting ${consecutiveNonActionRounds} times in a row — stopping to avoid burning rounds. Try a different model or rephrase your prompt.`, round);
          syncSessionState();
          setStatus('ok', `stopped after ${round} round${round > 1 ? 's' : ''}`);
          updateCtxBar();
          return;
        }
        window.messages.push({ role: 'assistant', content: rawReply || cleanReply });
        window.messages.push({
          role: 'user',
          content: 'Your previous reply described a next action but did not execute it. Continue now without narration: call one or more tools with complete args, or provide the final answer if no tool is needed.'
        });
        addNotice('Model narrated a next step without making a tool call. Requesting direct continuation.');
        updateCtxBar();
        continue;
      }

      if (looksLikeToolExecutionClaimWithoutCall(cleanReply)) {
        consecutiveNonActionRounds++;
        if (consecutiveNonActionRounds >= (cfg.MAX_CONSECUTIVE_NON_ACTION_ROUNDS || 6)) {
          addMessage('error', `Model claimed tool execution without a tool call ${consecutiveNonActionRounds} times in a row — stopping to avoid burning rounds. Try a different model or rephrase your prompt.`, round);
          syncSessionState();
          setStatus('ok', `stopped after ${round} round${round > 1 ? 's' : ''}`);
          updateCtxBar();
          return;
        }
        window.messages.push({ role: 'assistant', content: rawReply || cleanReply });
        window.messages.push({
          role: 'user',
          content: 'Your previous reply claimed a tool call already ran, but no valid <tool_call> block was present. Continue now with exactly one of these: (1) emit one or more valid tool calls with complete args, or (2) provide the complete final answer. Do not ask to wait for tool output.'
        });
        addNotice('Model claimed tool execution without emitting a tool call. Requesting strict continuation.');
        updateCtxBar();
        continue;
      }

      let finalMarkdown = cleanReply;
      throwIfStopRequested();

      addMessage('agent', finalMarkdown, round, false, false, parsedReply.thinkingBlocks);
      window.messages.push({ role: 'assistant', content: finalMarkdown });
      const memoryDelta = maybeExtractLongTermMemory(userMessage, finalMarkdown);
      if (memoryDelta?.saved) {
        addNotice(`Memory manager: stored ${memoryDelta.saved} durable memory item(s).`);
      }
      void Promise.resolve().then(() => {
        try { window.AgentMemory?.onTurnComplete?.({ userMessage, assistantMessage: finalMarkdown, messages: window.messages }); } catch {}
      });
      const statusEl = document.getElementById('steering-status');
      if (statusEl) statusEl.textContent = '';
      syncSessionState();
      setStatus('ok', `done in ${round} round${round>1?'s':''}`);
      notifyIfHidden(finalMarkdown);
      updateCtxBar();
      return;
    }

    const validToolCalls = [];
    const blockedToolReasons = [];

    for (const candidateCall of toolCalls) {
      const normalizedCandidate = completeToolCallArgs(candidateCall, { messages: window.messages, userMessage });
      if (!normalizedCandidate) continue;

      const repeatState = Comp?.recordRepeatedToolCall ? Comp.recordRepeatedToolCall(normalizedCandidate) : { repeated: false };
      if (repeatState.repeated) {
        blockedToolReasons.push(`repeated loop detected for ${repeatState.signature}`);
        addNotice(`Blocked repeated tool-call loop: ${repeatState.signature}`);
        continue;
      }

      validToolCalls.push(normalizedCandidate);
    }

    if (!validToolCalls.length) {
      window.messages.push({ role: 'assistant', content: rawReply || reply });
      window.messages.push({
        role: 'user',
        content: `All proposed tool calls were blocked or invalid (${blockedToolReasons.join('; ') || 'no valid call'}). Do not repeat them. Choose different valid tools with complete args or provide a final answer.`
      });
      updateCtxBar();
      continue;
    }

    consecutiveNonActionRounds = 0;
    const toolContent = stripModelMetaCommentary(String(reply || '').replace(/<tool_call(?:\s[^>]*>|>?)\s*[\s\S]*?<\/tool_call>/gi, ''));
    if (toolContent) {
      addMessage('agent', toolContent, round, false, false, []);
    }

    window.messages.push({ role: 'assistant', content: rawReply || reply });

    for (const toolCall of validToolCalls) {
      window.sessionStats.tools++;
      updateStats();
      addMessage('tool', `? ${toolCall.tool}(${JSON.stringify(toolCall.args)})`, round, true);
    }

    const batches = TE?.partitionToolCallBatches ? TE.partitionToolCallBatches(validToolCalls) : [{ concurrencySafe: false, calls: validToolCalls }];
    const roundToolSummaryChunks = [];
    const roundPromptInjectionNotes = [];
    let roundSawPermissionDenied = false;

    for (const batch of batches) {
      throwIfStopRequested();

      let batchResults = [];
      if (batch.concurrencySafe && batch.calls.length > 1) {
        showThinking(`executing ${batch.calls.length} read-only tools…`);
        if (delay > 0) await sleep(Math.min(250, delay));
        batchResults = await Promise.all(batch.calls.map(async call => {
          try {
            const result = await (TE?.executeTool ? TE.executeTool(call) : 'ERROR: executeTool not available');
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
            result = TE?.executeTool ? await TE.executeTool(call) : 'ERROR: executeTool not available';
          } catch (error) {
            result = `ERROR executing ${call.tool}: ${error?.message || 'unknown failure'}`;
          }
          hideThinking();
          batchResults.push({ call, result });
        }
      }

      let sawPermissionDenied = false;
      for (const { call: toolCall, result } of batchResults) {
        throwIfStopRequested();
        addMessage('tool', `? ${result}`, round, false, true);

        if (!/^ERROR\b/i.test(String(result || ''))) {
          if (TE) TE.runSuccessfulToolCount = (TE.runSuccessfulToolCount || 0) + 1;
        }

        if (TE?.checkReadBeforeWriteWarning) {
          const readWarning = TE.checkReadBeforeWriteWarning(toolCall);
          if (readWarning && !roundPromptInjectionNotes.includes(readWarning)) {
            roundPromptInjectionNotes.push(readWarning);
            addNotice(readWarning);
          }
        }

        if (toolCall.tool === 'fs_list_dir' && !/^ERROR\b/i.test(String(result || ''))) {
          if (TE) TE.runFsRootExplored = true;
        }

        const failureState = Comp?.recordToolFailure ? Comp.recordToolFailure(toolCall, result) : { repeated: false };
        if (Perm.isPermissionDeniedResult ? Perm.isPermissionDeniedResult(result) : /^ERROR:\s*PERMISSION_DENIED\b/i.test(result)) {
          sawPermissionDenied = true;
          addNotice(`Permission guard blocked ${toolCall.tool}. The loop will pivot to a different approach.`);
        }

        if (Comp?.extractPromptInjectionSignals) {
          const promptInjectionSignals = Comp.extractPromptInjectionSignals(toolCall, result);
          if (promptInjectionSignals.length) {
            Comp.registerPromptInjectionSignals(promptInjectionSignals);
            for (const signal of promptInjectionSignals) {
              if (!roundPromptInjectionNotes.includes(signal)) roundPromptInjectionNotes.push(signal);
            }
            addNotice(`Prompt injection guard flagged suspicious output from ${toolCall.tool}.`);
          }
        }

        const contextSafeResult = Comp?.applyToolResultContextBudget ? Comp.applyToolResultContextBudget(toolCall, result) : result;
        if (contextSafeResult !== String(result || '')) {
          const sig = TE?.getToolCallSignature ? TE.getToolCallSignature(toolCall) : `${toolCall.tool}:{}`;
          if (Comp?.runCompactedResultNoticeSignatures && !Comp.runCompactedResultNoticeSignatures.has(sig)) {
            Comp.runCompactedResultNoticeSignatures.add(sig);
            addNotice(`Context manager compacted a large ${toolCall.tool} result before storing it in history.`);
          }
        }

        const safeResult = Comp?.sanitizeToolResult ? Comp.sanitizeToolResult(contextSafeResult) : String(contextSafeResult || '');
        window.messages.push({ role: 'tool', tool_call_id: toolCall.call_id || toolCall.id || '', ...(toolCall.tool ? { name: toolCall.tool } : {}), content: safeResult });

        if (failureState.repeated) {
          window.messages.push({
            role: 'user',
            content: `Previous tool call failed repeatedly (${TE?.getToolCallSignature ? TE.getToolCallSignature(toolCall) : toolCall.tool}). Do not repeat it. Choose a different tool or provide a final answer with available evidence.`
          });
          addNotice(`Repeated failure on ${TE?.getToolCallSignature ? TE.getToolCallSignature(toolCall) : toolCall.tool}. Disabled this call pattern for this run.`);
        }
      }

      const toolSummary = Comp?.buildToolUseSummary ? Comp.buildToolUseSummary(batchResults) : '';
      if (toolSummary) {
        window.messages.push({ role: 'assistant', content: toolSummary });
        roundToolSummaryChunks.push(toolSummary);
      }

      // Check for pending confirmations after batch execution
      const pendingConfirmations = window.AgentConfirmation?.pending?.() || [];
      if (pendingConfirmations.length > 0) {
        const confirmationMessages = pendingConfirmations.map(item => 
          `[CONFIRMATION_PENDING] ${item.message}`
        );
        window.messages.push({
          role: 'user',
          content: confirmationMessages.join('\n\n')
        });
        addNotice(`Waiting for user confirmation on ${pendingConfirmations.length} tool call(s).`);
        updateCtxBar();
        continue;
      }

      roundSawPermissionDenied = roundSawPermissionDenied || sawPermissionDenied;
    }

    const compactionNotes = Comp?.applyContextManagementPipeline
      ? await Comp.applyContextManagementPipeline({ round, userMessage, ctxLimit: CTX_LIMIT })
      : [];

    const continuationPrompt = orchestrator.buildRuntimeContinuationPrompt({
      toolSummary: roundToolSummaryChunks.join('\n\n'),
      permissionDenials: roundSawPermissionDenied && Perm.runPermissionDenials ? Perm.runPermissionDenials.slice(-3) : [],
      compactionNotes,
      promptInjectionNotes: roundPromptInjectionNotes
    });

    if (continuationPrompt) {
      window.messages.push({ role: 'user', content: continuationPrompt });
    }

    syncSessionState();
    updateCtxBar();
  }

  // Exhausted rounds — force final answer
  addNotice('max_rounds (' + MAX_ROUNDS + ') reached. Forcing final answer.');
  const noEvidenceWarning = (TE?.runSuccessfulToolCount || 0) === 0
    ? 'No successful tool evidence was gathered in this run. Do not fabricate facts; clearly state uncertainty and what could not be verified.'
    : 'Use only the verified tool evidence already gathered in this run.';
  const denialWarning = Perm.runPermissionDenials?.length
    ? `Permission denials occurred for some attempted actions (${Perm.runPermissionDenials.slice(-2).map(item => item.tool).join(', ')}). Respect those constraints in the final answer.`
    : '';
  window.messages.push({
    role: 'user',
    content: `Answer now with what you know so far. Return the final answer in Markdown only. ${noEvidenceWarning} ${denialWarning}`.trim()
  });
  showThinking('forcing final answer…');
  try {
    throwIfStopRequested();
    const finalReply = await callLLM(window.messages, getTurnLlmCallOptions());
    throwIfStopRequested();
    const parsedFinalReply = splitModelReply(finalReply);
    const finalMarkdown = stripModelMetaCommentary(parsedFinalReply.visible.replace(getToolCallCleanupRegex(), ''));
    throwIfStopRequested();

    hideThinking();
    addMessage('agent', finalMarkdown, MAX_ROUNDS, false, false, parsedFinalReply.thinkingBlocks);
    window.messages.push({ role: 'assistant', content: finalMarkdown });
    const memoryDelta = maybeExtractLongTermMemory(userMessage, finalMarkdown);
    if (memoryDelta?.saved) {
      addNotice(`Memory manager: stored ${memoryDelta.saved} durable memory item(s).`);
    }
    void Promise.resolve().then(() => {
      try { window.AgentMemory?.onTurnComplete?.({ userMessage, assistantMessage: finalMarkdown, messages: window.messages }); } catch {}
    });
    syncSessionState();
    setStatus('ok', 'response limit reached');
    notifyIfHidden(finalMarkdown || 'Response ready. Check the latest result.');
  } catch (e) {
    hideThinking();
    if (e?.code === 'RUN_STOPPED' || e?.name === 'AbortError') {
      setStatus('ok', 'stopped');
      updateCtxBar();
      return;
    }
    addMessage('error', `Final answer failed: ${e.message}`, MAX_ROUNDS);
    setStatus('error', 'final answer failed');
  }
  updateCtxBar();
}

// ── UI HELPERS ───────────────────────────────────────────────────────────────

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
    <span class="thinking-label">${escHtml(String(label || ''))}</span>`;
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
    if (containsMarkdown(content)) {
      bubble.className = 'msg-content html-body';
      bubble.innerHTML = renderAgentHtml(content);
    } else {
      bubble.className = 'msg-content';
      bubble.textContent = String(content || '');
    }
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
    const cssRole = role === 'error' ? 'msg-error' : role === 'tool' ? 'msg-tool' : 'msg-system';
    wrap.className = `msg assistant ${cssRole}`;
    const bubble = document.createElement('div');
    bubble.className = 'msg-content msg-content-mono';

    const meta = [];
    if (round) meta.push(`R${round}`);
    if (isCall) meta.push('call');
    if (isResult) meta.push('result');
    meta.push(role);

    const badge = document.createElement('span');
    badge.className = 'msg-meta-badge';
    badge.textContent = meta.join(' · ');
    bubble.appendChild(badge);

    let prettyContent = String(content || '');
    try { const parsed = JSON.parse(prettyContent); prettyContent = JSON.stringify(parsed, null, 2); } catch {}

    const details = document.createElement('details');
    details.className = 'debug-details';
    const summary = document.createElement('summary');
    summary.className = 'debug-summary';
    const preview = prettyContent.length > 120 ? prettyContent.slice(0, 120).replace(/\n/g, ' ') + '…' : prettyContent.replace(/\n/g, ' ');
    summary.textContent = preview;
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.className = 'debug-pre';
    pre.textContent = prettyContent;
    details.appendChild(pre);
    bubble.appendChild(details);

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
  const topbarStatus = document.getElementById('topbar-status');
  if (topbarStatus) topbarStatus.textContent = label;
  const badge = document.getElementById('badge-status');
  if (badge) badge.textContent = label;
  const dot = document.getElementById('badge-status-dot');
  if (dot) dot.innerHTML = `<span class="status-dot ${state}"></span>&nbsp;${label}`;
}

function updateStats() {
  const rounds = document.getElementById('stat-rounds');
  if (rounds) rounds.textContent = window.sessionStats.rounds;
  const tools = document.getElementById('stat-tools');
  if (tools) tools.textContent = window.sessionStats.tools;
  const resets = document.getElementById('stat-resets');
  if (resets) resets.textContent = window.sessionStats.resets;
  const msgs = document.getElementById('stat-msgs');
  if (msgs) msgs.textContent = window.sessionStats.msgs;
}

function scrollBottom() {
  const chat = document.getElementById('chat');
  if (chat) chat.scrollTop = chat.scrollHeight;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SEND ──────────────────────────────────────────────────────────────────────

async function sendMessage() {
  if (window.isBusy) return;
  if (!runtimeReady()) {
    addMessage('error', 'Agent bootstrap failed: required modules were not loaded.', null);
    return;
  }
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;

  if (!isLocalModeActive()) {
    const cloudReadiness = typeof getCloudReadiness === 'function'
      ? getCloudReadiness()
      : { ready: canUseCloud(), reason: 'Cloud provider is not ready.' };
    if (!cloudReadiness.ready) {
      addMessage('error', cloudReadiness.reason || 'Cloud provider is not ready.', null);
      return;
    }
  } else if (typeof isOllamaReady === 'function') {
    const ollamaReadiness = isOllamaReady();
    if (!ollamaReadiness.ready) {
      addMessage('error', ollamaReadiness.reason, null);
      return;
    }
  }

  input.value = '';
  autoResize(input);
  window.isBusy = true;
  stopRequested = false;
  resetRunGuards();
  broadcastBusyState(true);
  const sendBtn = document.getElementById('btn-send');
  if (sendBtn) sendBtn.disabled = true;
  setStopButtonState(true);
  const inputStatus = document.getElementById('input-status');
  if (inputStatus) inputStatus.textContent = 'processing…';

  const curSession = getActiveSession() || createSession(text);
  if (!curSession.messages?.length) {
    curSession.title = makeSessionTitle(text);
  }
  addMessage('user', text, null);
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
  } finally {
    window.isBusy = false;
    broadcastBusyState(false);
    if (sendBtn) sendBtn.disabled = false;
    setStopButtonState(false);
    if (inputStatus) inputStatus.textContent = `${window.sessionStats.msgs} message${window.sessionStats.msgs!==1?'s':''} sent`;
    input.focus();
  }
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

window.requestStop = requestStop;
window.sendMessage = sendMessage;
window.handleKey = handleKey;
window.autoResize = autoResize;
window.useExample = useExample;
window.clearSession = clearSession;
window.setStatus = setStatus;

// ── INIT ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  installUnhandledRejectionGuard();
  applySidebarState();
  window.addEventListener('resize', handleResponsiveSidebar);

  const sliderDefs = [
    { id: 'sl-rounds', valId: 'val-rounds', key: 'agent_sl_rounds' },
    { id: 'sl-ctx',    valId: 'val-ctx',    key: 'agent_sl_ctx'    },
    { id: 'sl-delay',  valId: 'val-delay',  key: 'agent_sl_delay'  }
  ];
  for (const def of sliderDefs) {
    try {
      const stored = localStorage.getItem(def.key);
      if (stored !== null) {
        const sl = document.getElementById(def.id);
        const vl = document.getElementById(def.valId);
        if (sl) sl.value = stored;
        if (vl) vl.textContent = stored;
      }
    } catch {}
  }

  updateBadge();
  updateStats();
  updateCtxBar();

  if (!runtimeReady()) {
    setStatus('error', 'bootstrap failed');
    addNotice('ERROR: required modules did not load. Check the browser console and reload the page.');
    return;
  }

  window.chatSessions = loadSessions();
  initCacheSync();
  initBusySync();
  updateFileAccessStatus();
  loadGithubTokenStatus();
  if (typeof loadCloudModelSelection === 'function') loadCloudModelSelection();
  if (typeof loadOllamaBackendState === 'function') loadOllamaBackendState();
  if (!window.chatSessions.length) createSession();
  if (!getActiveSession()) window.activeSessionId = window.chatSessions[0]?.id || createSession().id;
  renderSessionList();
  if (typeof loadPersistedEnabledTools === 'function') loadPersistedEnabledTools();
  renderToolGroups();
  activateSession(window.activeSessionId);
  if (window.apiKey) {
    document.getElementById('api-key').value = window.apiKey;
    setStatus('ok', 'key set');
  }
  if (window.localBackend?.url) {
    document.getElementById('local-url').value = window.localBackend.url;
    if (window.localBackend.model) {
      const sel = document.getElementById('local-model-select');
      sel.innerHTML = `<option value="${window.localBackend.model}">${window.localBackend.model}</option>`;
      sel.value = window.localBackend.model;
      document.getElementById('local-model-row').style.display = 'block';

      sel?.addEventListener('change', function() {
        const model = this.value;
        if (model) {
          window.localBackend.model = model;
          localStorage.setItem('agent_local_backend_model', model);
          updateModelBadgeForLocal(model);
          updateBadge();
        }
      });
    }
    if (window.localBackend.enabled) {
      _activateLocal(true);
    }
  }
  if (window.ollamaBackend?.enabled) {
    console.debug('[Agent] Skipping local backend probe — Ollama is active');
  } else {
    probeLocal().catch(error => {
      const message = String(error?.message || 'probe failed');
      console.warn('[Local Probe] startup probe failed:', message);
    });
  }
  window.addEventListener('beforeunload', flushSaveSessions);
  setStopButtonState(false);
});

let extensionChannelWarningShown = false;

function installUnhandledRejectionGuard() {
  if (window.__agentUnhandledRejectionGuardInstalled) return;
  window.__agentUnhandledRejectionGuardInstalled = true;

  window.addEventListener('unhandledrejection', event => {
    const message = String(event?.reason?.message || event?.reason || '');
    const isExtensionChannelClose = /A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received/i.test(message);
    if (!isExtensionChannelClose) return;

    event.preventDefault();
    if (extensionChannelWarningShown) return;
    extensionChannelWarningShown = true;
    addNotice('Ignored extension async response warning from browser message channel.');
  });
}
