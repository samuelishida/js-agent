// src/app/agent/agent.js
// Pure orchestration: delegates per-round logic to round-controller.js,
// error recovery to error-recovery.js, tool-call repair to tool-call-repair.js,
// and session lifecycle to session-lifecycle.js.

/** @type {import('../../types/index.js').SessionMessage} */
var _SessionMessageAgent;

/** @type {Function} */
var addMessage;
/** @type {Function} */
var addNotice;
/** @type {Function} */
var setStatus;
/** @type {Function} */
var updateStats;
/** @type {Function} */
var updateCtxBar;
/** @type {Function} */
var notifyIfHidden;
/** @type {Function} */
var showThinking;
/** @type {Function} */
var hideThinking;
/** @type {Function} */
var splitModelReply;
/** @type {Function} */
var stripModelMetaCommentary;
/** @type {Function} */
var getToolCallCleanupRegex;

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
 * Build an attachment context block for the prompt.
 * @param {import('../../types/index.js').Attachment[]} attachments
 * @returns {string} Context block or empty string
 */
function buildAttachmentContextBlock(attachments) {
  if (!attachments?.length) return '';
  const lines = attachments.map((a, i) => {
    const preview = a.textPreview ? `\nPreview (first ${a.textPreview.length} chars):\n${a.textPreview}` : '';
    return `${i + 1}. [${a.kind}] ${a.name} (${a.mimeType}, ${a.size} bytes)${preview}`;
  });
  return `\u003cattachments\u003e\n${lines.join('\n')}\n\u003c/attachments\u003e`;
}

/**
 * Main agent loop entry point.
 * @param {string} userMessage - User input message
 * @param {import('../../types/index.js').Attachment[]} [attachments=[]] - File/image attachments
 * @returns {Promise<void>}
 */
async function agentLoop(userMessage, attachments = []) {
  assertRuntimeReady();
  throwIfStopRequested();

  if (attachments?.length && window.AgentToolExecutor?.registerAttachments) {
    window.AgentToolExecutor.registerAttachments(attachments);
  }
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
  Comp?.armTimeBasedMicrocompactForTurn?.(({ messages: mcMessages }) => {
    window.messages = mcMessages;
    syncSessionState();
  });

  const enrichedMessage = await tools.buildInitialContext(userMessage, { messages: window.messages });
  const memoryBlock = window.AgentMemory?.buildContextBlock?.(userMessage, window.messages) || '';
  const compatBlock = window.AgentToolMemory?.buildRuntimeContextBlock?.() || '';
  const attachmentBlock = buildAttachmentContextBlock(attachments);
  const memoryContextBlock = [memoryBlock, compatBlock, attachmentBlock].filter(Boolean).join('\n\n');
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
    { role: 'user', content: turnInputMessage, attachments: attachments.map(a => ({ id: a.id, name: a.name, mimeType: a.mimeType, kind: a.kind, size: a.size })) }
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
      while ((/** @type {any} */ (window).AgentConfirmation?.pending?.() || []).length > 0) {
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
      const memoryDelta = maybeExtractLongTermMemory(userMessage, '');
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

    // Pre-LLM context check before force-final-answer
    const CompFinal = window.AgentCompaction;
    if (CompFinal?.preLlmContextCheck) {
      const { messages: compacted } = CompFinal.preLlmContextCheck({ messages: window.messages, round: MAX_ROUNDS, ctxLimit: CTX_LIMIT });
      window.messages = compacted;
    }

    const finalReply = await callLLM(window.messages, getTurnLlmCallOptions());
    throwIfStopRequested();
    const parsedFinalReply = splitModelReply(finalReply);
    const finalMarkdown = stripModelMetaCommentary(parsedFinalReply.visible.replace(getToolCallCleanupRegex(), ''));
    throwIfStopRequested();

    hideThinking();
    addMessage('agent', finalMarkdown, MAX_ROUNDS, false, false, parsedFinalReply.thinkingBlocks);
    window.messages.push({ role: 'assistant', content: finalMarkdown });
    const memoryDelta = maybeExtractLongTermMemory(userMessage, '');
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
