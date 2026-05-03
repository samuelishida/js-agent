// src/app/agent/agent.js
// Pure orchestration: delegates per-round logic to round-controller.js,
// error recovery to error-recovery.js, tool-call repair to tool-call-repair.js,
// and session lifecycle to session-lifecycle.js.

/** @typedef {import('../../types/index.js').SessionMessage} SessionMessage */

/**
 * Get constants helper.
 * @returns {Object} Window constants
 */
const C = () => window.CONSTANTS || {};

/**
 * Extract long-term memory from a conversation turn.
 * @param {string} userMessage - User message
 * @param {string} assistantMessage - Assistant response
 * @returns {any} Memory extraction result
 */
function maybeExtractLongTermMemory(userMessage, assistantMessage) {
  return window.AgentMemory?.extractFromTurn?.({ userMessage, assistantMessage }) ?? null;
}

/**
 * Main agent loop entry point.
 * @param {string} userMessage - User input message
 * @returns {Promise<void>}
 */
async function agentLoop(userMessage) {
  assertRuntimeReady();
  throwIfStopRequested();
  const { tools, orchestrator } = getRuntimeModules();
  const cfg = C();
  const MAX_ROUNDS = getMaxRounds();
  const CTX_LIMIT = getCtxLimit();

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
  const enrichedMessage = await tools.buildInitialContext(userMessage, { messages: window.messages });
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

    const roundResult = await window.AgentRoundController.executeRound({
      userMessage,
      messages: window.messages,
      round,
      maxRounds: MAX_ROUNDS,
      delay: getDelay(),
      consecutiveNonActionRounds
    });

    if (roundResult.actions?.includes('pending-confirmations')) {
      window.messages = roundResult.messages;
      if (typeof window.openConfirmationPanel === 'function') window.openConfirmationPanel();
      setStatus('busy', 'waiting for confirmation…');
      while ((window.AgentConfirmation?.pending?.() || []).length > 0) {
        throwIfStopRequested();
        await sleep(300);
      }
      if (typeof window.closeConfirmationPanel === 'function') window.closeConfirmationPanel();
      continue;
    }

    if (roundResult.finalAnswer) {
      const finalMarkdown = roundResult.finalText;
      addMessage('agent', finalMarkdown, round, false, false, []);
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
      setStatus('ok', `done in ${round} round${round > 1 ? 's' : ''}`);
      notifyIfHidden(finalMarkdown);
      updateCtxBar();
      return;
    }

    window.messages = roundResult.messages;
    consecutiveNonActionRounds = roundResult.consecutiveNonActionRounds || 0;
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

window.agentLoop = agentLoop;
