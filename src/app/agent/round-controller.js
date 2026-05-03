// src/app/agent/round-controller.js
// Encapsulates one full agent round: LLM → parse → execute → compact.

/** @typedef {import('../../types/index.js').SessionMessage} SessionMessage */

/**
 * @typedef {Object} RoundResult
 * @property {boolean} finalAnswer - Whether the model gave a final answer
 * @property {string} [finalText] - The final answer text
 * @property {SessionMessage[]} messages - Updated message history
 * @property {string[]} [actions] - Actions taken during the round
 * @property {boolean} [shouldContinue] - Whether to continue to next round
 */

/**
 * Drain the steering buffer and inject any mid-session guidance.
 * @param {SessionMessage[]} messages
 * @returns {{ messages: SessionMessage[], steeringNotice?: string }}
 */
function drainSteering(messages) {
  const steeredMessages = window.AgentSteering?.drain ? window.AgentSteering.drain() : [];
  if (!steeredMessages.length) return { messages };

  const combined = steeredMessages.join('\n\n');
  const updated = [...messages, {
    role: 'user',
    content: `[USER STEERING — mid-session guidance, follow immediately]\n${combined}`
  }];

  const cfg = window.CONSTANTS || {};
  const notice = `Steering injected: ${combined.slice(0, cfg.NOTE_MAX_CHARS || 120)}${combined.length > (cfg.NOTE_MAX_CHARS || 120) ? '…' : ''}`;
  return { messages: updated, steeringNotice: notice };
}

// Build LLM call options based on mode and recovery state.
/**
 * Get LLM call options for the current turn.
 * @returns {import('../../types/index.js').LlmCallOptions & {enabledTools: string[], maxTokens: number}} Turn options
 */
function getTurnLlmCallOptions() {
  const Comp = window.AgentCompaction || {};
  const recoverySteps = Math.max(0, Number(Comp.runMaxOutputTokensRecoveryCount || 0));
  const cfg = window.CONSTANTS || {};
  const modelMaxTokens = typeof getMaxTokensForModel === 'function'
    ? getMaxTokensForModel()
    : (cfg.DEFAULT_MAX_TOKENS_LOCAL || 4096);
  const maxTokens = Math.max(512, modelMaxTokens - (recoverySteps * 280));

  if (isLocalModeActive()) {
    return {
      timeoutMs: cfg.DEFAULT_TIMEOUT_MS_LOCAL || 120000,
      retries: cfg.DEFAULT_RETRIES_LOCAL || 0,
      maxTokens,
      enabledTools: Object.entries(window.enabledTools || {}).filter(([, v]) => !!v).map(([k]) => k)
    };
  }
  return {
    timeoutMs: cfg.DEFAULT_TIMEOUT_MS_CLOUD || 35000,
    retries: cfg.DEFAULT_RETRIES_CLOUD || 2,
    maxTokens,
    enabledTools: Object.entries(window.enabledTools || {}).filter(([, v]) => !!v).map(([k]) => k)
  };
}

/**
 * Call LLM and recover from errors.
 * @param {Object} opts
 * @param {SessionMessage[]} opts.messages
 * @param {number} opts.round
 * @param {number} opts.maxRounds
 * @param {number} opts.delay
 * @returns {{ rawReply: string, parsedReply: any, reply: string, error?: Error, recovered?: boolean }}
 */
async function callLlmWithRecovery({ messages, round, maxRounds, delay }) {
  try {
    const rawReply = await callLLM(messages, getTurnLlmCallOptions());
    throwIfStopRequested();
    const parsedReply = splitModelReply(rawReply);
    const reply = parsedReply.visible;
    if (window.AgentToolExecution) window.AgentToolExecution.runLocalTimeoutStreak = 0;
    return { rawReply, parsedReply, reply };
  } catch (e) {
    throwIfStopRequested();

    if (e?.code === 'RUN_STOPPED' || e?.name === 'AbortError') throw e;

    const recovery = window.AgentErrorRecovery?.applyErrorRecovery
      ? window.AgentErrorRecovery.applyErrorRecovery({ error: e, round, maxRounds, messages })
      : { recovered: false, messages, fatal: true };

    if (recovery.fatal) {
      return { rawReply: '', parsedReply: { visible: '' }, reply: '', error: e };
    }

    if (recovery.recovered) {
      return { rawReply: '', parsedReply: { visible: '' }, reply: '', error: e, recovered: true, recoveredMessages: recovery.messages, notice: recovery.notice };
    }

    return { rawReply: '', parsedReply: { visible: '' }, reply: '', error: e };
  }
}

/**
 * Attempt to repair malformed tool calls.
 * @param {Object} opts
 * @param {string} opts.userMessage
 * @param {string} opts.rawReply
 * @param {string} opts.reply
 * @param {any} opts.parsedReply
 * @param {SessionMessage[]} opts.messages
 * @returns {{ rawReply: string, parsedReply: any, reply: string, toolCalls: any[] }}
 */
async function tryRepairToolCalls({ userMessage, rawReply, reply, parsedReply, messages }) {
  const TE = window.AgentToolExecution;
  const cleanReply = reply.replace(getToolCallCleanupRegex(), '').trim();

  if (!shouldAttemptToolCallRepair({ rawReply, cleanReply, thinkingBlocks: parsedReply?.thinkingBlocks })) {
    return { rawReply, parsedReply, reply, toolCalls: [] };
  }

  try {
    const repaired = await attemptToolCallRepair({ userMessage, rawReply: rawReply || reply, messages });
    throwIfStopRequested();

    if (repaired?.rawReply) {
      const toolCalls = TE?.dedupeToolCalls
        ? TE.dedupeToolCalls(TE.resolveToolCallsFromModelReply(repaired.parsedReply.visible, repaired.rawReply))
        : [];

      return {
        rawReply: repaired.rawReply,
        parsedReply: repaired.parsedReply,
        reply: repaired.reply,
        toolCalls
      };
    }
  } catch (error) {
    if (error?.code === 'RUN_STOPPED' || error?.name === 'AbortError') throw error;
    addNotice(`Repair pass failed: ${error?.message || 'unknown error'}`);
  }

  return { rawReply, parsedReply, reply, toolCalls: [] };
}

/**
 * Handle a reply with no tool calls (empty, deferred, claimed, or final answer).
 * @param {Object} opts
 * @param {string} opts.reply
 * @param {string} opts.rawReply
 * @param {number} opts.round
 * @param {number} opts.consecutiveNonActionRounds
 * @param {SessionMessage[]} opts.messages
 * @returns {{ finalAnswer: boolean, finalText?: string, messages: SessionMessage[], consecutiveNonActionRounds: number, shouldContinue?: boolean }}
 */
function handleNoToolCalls({ reply, rawReply, round, consecutiveNonActionRounds, messages }) {
  const cfg = window.CONSTANTS || {};
  const cleanReply = reply.replace(getToolCallCleanupRegex(), '').trim();
  const reasoningText = (window.AgentReplyAnalysis?.extractThinkingBlocks?.(rawReply || '') || []).join('\n').trim();

  if (!cleanReply && !reasoningText) {
    const nextConsecutive = consecutiveNonActionRounds + 1;
    if (nextConsecutive >= (cfg.MAX_CONSECUTIVE_NON_ACTION_ROUNDS || 6)) {
      return {
        finalAnswer: true,
        finalText: `Model returned empty output ${nextConsecutive} times in a row — stopping to avoid burning rounds. Try a different model or rephrase your prompt.`,
        messages,
        consecutiveNonActionRounds: nextConsecutive
      };
    }
    const updated = [...messages,
      { role: 'assistant', content: rawReply || reply },
      { role: 'user', content: 'No valid tool call or final answer was returned. Continue now: call one or more tools with complete args, or provide a complete final answer.' }
    ];
    return { finalAnswer: false, messages: updated, consecutiveNonActionRounds: nextConsecutive, shouldContinue: true };
  }

  // Reasoning-only output (no visible content, no tool calls) — nudge the model to continue
  if (!cleanReply && reasoningText) {
    const nextConsecutive = consecutiveNonActionRounds + 1;
    if (nextConsecutive >= (cfg.MAX_CONSECUTIVE_NON_ACTION_ROUNDS || 6)) {
      return {
        finalAnswer: true,
        finalText: reasoningText,
        messages,
        consecutiveNonActionRounds: nextConsecutive
      };
    }
    const updated = [...messages,
      { role: 'assistant', content: rawReply || reply },
      { role: 'user', content: 'You produced only reasoning/thinking with no visible answer or tool calls. Based on your reasoning, continue now: call one or more tools with complete args, or provide a complete final answer.' }
    ];
    return { finalAnswer: false, messages: updated, consecutiveNonActionRounds: nextConsecutive, shouldContinue: true };
  }

  var thinkingSaysFinal = window.AgentReplyAnalysis?.thinkingIndicatesFinalAnswer?.(parsedReply?.thinkingBlocks || []);

  if (looksLikeDeferredActionReply(cleanReply) && !thinkingSaysFinal) {
    const nextConsecutive = consecutiveNonActionRounds + 1;
    if (nextConsecutive >= (cfg.MAX_CONSECUTIVE_NON_ACTION_ROUNDS || 6)) {
      return {
        finalAnswer: true,
        finalText: `Model narrated instead of acting ${nextConsecutive} times in a row — stopping to avoid burning rounds. Try a different model or rephrase your prompt.`,
        messages,
        consecutiveNonActionRounds: nextConsecutive
      };
    }
    const updated = [...messages,
      { role: 'assistant', content: rawReply || cleanReply },
      { role: 'user', content: 'Your previous reply described a next action but did not execute it. Continue now without narration: call one or more tools with complete args, or provide the final answer if no tool is needed.' }
    ];
    return { finalAnswer: false, messages: updated, consecutiveNonActionRounds: nextConsecutive, shouldContinue: true };
  }

  if (looksLikeToolExecutionClaimWithoutCall(cleanReply) && !thinkingSaysFinal) {
    const nextConsecutive = consecutiveNonActionRounds + 1;
    if (nextConsecutive >= (cfg.MAX_CONSECUTIVE_NON_ACTION_ROUNDS || 6)) {
      return {
        finalAnswer: true,
        finalText: `Model claimed tool execution without a tool call ${nextConsecutive} times in a row — stopping to avoid burning rounds. Try a different model or rephrase your prompt.`,
        messages,
        consecutiveNonActionRounds: nextConsecutive
      };
    }
    const updated = [...messages,
      { role: 'assistant', content: rawReply || cleanReply },
      { role: 'user', content: 'Your previous reply claimed a tool call already ran, but no valid <tool_call> block was present. Continue now with exactly one of these: (1) emit one or more valid tool calls with complete args, or (2) provide the complete final answer. Do not ask to wait for tool output.' }
    ];
    return { finalAnswer: false, messages: updated, consecutiveNonActionRounds: nextConsecutive, shouldContinue: true };
  }

  // If thinking indicates final answer but visible text is empty, use thinking as final answer
  if (thinkingSaysFinal && !cleanReply && reasoningText) {
    return { finalAnswer: true, finalText: stripModelMetaCommentary(reasoningText), messages, consecutiveNonActionRounds: 0 };
  }

  // Final answer
  const finalMarkdown = stripModelMetaCommentary(cleanReply);
  return { finalAnswer: true, finalText: finalMarkdown, messages, consecutiveNonActionRounds: 0 };
}

/**
 * Validate and filter tool calls, detecting repeated loops.
 * @param {any[]} toolCalls
 * @returns {{ validToolCalls: any[], blockedReasons: string[] }}
 */
function validateToolCalls(toolCalls) {
  const Comp = window.AgentCompaction;
  const validToolCalls = [];
  const blockedReasons = [];

  for (const candidateCall of toolCalls) {
    const normalizedCandidate = completeToolCallArgs(candidateCall, { messages: window.messages, userMessage: '' });
    if (!normalizedCandidate) continue;

    const repeatState = Comp?.recordRepeatedToolCall ? Comp.recordRepeatedToolCall(normalizedCandidate) : { repeated: false };
    if (repeatState.repeated) {
      blockedReasons.push(`repeated loop detected for ${repeatState.signature}`);
      addNotice(`Blocked repeated tool-call loop: ${repeatState.signature}`);
      continue;
    }

    validToolCalls.push(normalizedCandidate);
  }

  return { validToolCalls, blockedReasons };
}

/**
 * Execute tool call batches and process results.
 * @param {Object} opts
 * @param {any[]} opts.validToolCalls
 * @param {string} opts.reply
 * @param {string} opts.rawReply
 * @param {number} opts.round
 * @param {number} opts.delay
 * @param {SessionMessage[]} opts.messages
 * @returns {{ messages: SessionMessage[], roundToolSummaryChunks: string[], roundPromptInjectionNotes: string[], roundSawPermissionDenied: boolean }}
 */
async function executeToolBatches({ validToolCalls, reply, rawReply, round, delay, messages }) {
  const TE = window.AgentToolExecution;
  const Comp = window.AgentCompaction;
  const Perm = window.AgentPermissions || {};

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
      messages.push({ role: 'tool', tool_call_id: toolCall.call_id || toolCall.id || '', ...(toolCall.tool ? { name: toolCall.tool } : {}), content: safeResult });

      if (failureState.repeated) {
        messages.push({
          role: 'user',
          content: `Previous tool call failed repeatedly (${TE?.getToolCallSignature ? TE.getToolCallSignature(toolCall) : toolCall.tool}). Do not repeat it. Choose a different tool or provide a final answer with available evidence.`
        });
        addNotice(`Repeated failure on ${TE?.getToolCallSignature ? TE.getToolCallSignature(toolCall) : toolCall.tool}. Disabled this call pattern for this run.`);
      }
    }

    const toolSummary = Comp?.buildToolUseSummary ? Comp.buildToolUseSummary(batchResults) : '';
    if (toolSummary) {
      messages.push({ role: 'assistant', content: toolSummary });
      roundToolSummaryChunks.push(toolSummary);
    }

    const pendingConfirmations = window.AgentConfirmation?.pending?.() || [];
    if (pendingConfirmations.length > 0) {
      const confirmationMessages = pendingConfirmations.map(item => `[CONFIRMATION_PENDING] ${item.message}`);
      messages.push({ role: 'user', content: confirmationMessages.join('\n\n') });
      addNotice(`Waiting for user confirmation on ${pendingConfirmations.length} tool call(s).`);
      return { messages, roundToolSummaryChunks, roundPromptInjectionNotes, roundSawPermissionDenied: true, pendingConfirmations: true };
    }

    roundSawPermissionDenied = roundSawPermissionDenied || sawPermissionDenied;
  }

  return { messages, roundToolSummaryChunks, roundPromptInjectionNotes, roundSawPermissionDenied };
}

/**
 * Execute a single agent round.
 * @param {Object} opts
 * @param {string} opts.userMessage
 * @param {SessionMessage[]} opts.messages
 * @param {number} opts.round
 * @param {number} opts.maxRounds
 * @param {number} opts.delay
 * @param {number} opts.consecutiveNonActionRounds
 * @returns {Promise<RoundResult>}
 */
/**
 * Execute a single agent round.
 * @param {Object} opts
 * @param {string} opts.userMessage
 * @param {SessionMessage[]} opts.messages
 * @param {number} opts.round
 * @param {number} opts.maxRounds
 * @param {number} opts.delay
 * @param {number} opts.consecutiveNonActionRounds
 * @returns {Promise<RoundResult>}
 */
async function executeRound({ userMessage, messages, round, maxRounds, delay, consecutiveNonActionRounds }) {
  const actions = [];
  const cfg = window.CONSTANTS || {};

  // 1. Drain steering buffer
  const steering = drainSteering(messages);
  if (steering.steeringNotice) {
    addNotice(steering.steeringNotice);
    actions.push('steering-injected');
  }
  messages = steering.messages;

  if (delay > 0) await sleep(delay);
  throwIfStopRequested();

  // 2. Call LLM
  setStatus('busy', `round ${round}/${maxRounds}`);
  showThinking(`round ${round}/${maxRounds}`);

  var prevStreamingCb = window.AgentLLMUtils?.streamingCallback;
  window.AgentLLMUtils && (window.AgentLLMUtils.streamingCallback = function(contentDelta, fullContent, reasoningDelta) {
    if (reasoningDelta && window.updateStreamingThinking) {
      window.updateStreamingThinking(contentDelta, reasoningDelta);
    }
  });

  const llmResult = await callLlmWithRecovery({ messages, round, maxRounds, delay });

  if (window.AgentLLMUtils) window.AgentLLMUtils.streamingCallback = prevStreamingCb;

  if (llmResult.recovered && llmResult.recoveredMessages) {
    hideThinking();
    if (llmResult.notice) addNotice(llmResult.notice);
    return { finalAnswer: false, messages: llmResult.recoveredMessages, actions: [...actions, 'error-recovered'], shouldContinue: true };
  }

  if (llmResult.error) {
    hideThinking();
    const error = llmResult.error;

    if (error?.code === 'OLLAMA_INCOMPLETE_OUTPUT' || error?.code === 'LOCAL_INCOMPLETE_OUTPUT') {
      return { finalAnswer: true, finalText: error.message, messages, actions: [...actions, 'incomplete-output'] };
    }

    return { finalAnswer: true, finalText: `LLM error: ${error.message}`, messages, actions: [...actions, 'llm-error'] };
  }

  const { rawReply, parsedReply, reply } = llmResult;
  hideThinking();

  // 3. Parse / repair tool calls
  const TE = window.AgentToolExecution;
  const Perm = window.AgentPermissions || {};
  let toolCalls = TE?.resolveToolCallsFromModelReply ? TE.resolveToolCallsFromModelReply(reply, rawReply) : [];

  if (!toolCalls.length) {
    const repaired = await tryRepairToolCalls({ userMessage, rawReply, reply, parsedReply, messages });
    if (repaired.toolCalls.length) {
      addNotice(`Repair pass normalized malformed output into valid tool call(s): ${repaired.toolCalls.map(c => c.tool).join(', ')}.`);
      toolCalls = repaired.toolCalls;
    } else if (String(repaired.reply || '').trim()) {
      addNotice('Repair pass normalized malformed output into a contract-compliant reply.');
    }
  }

  // 4. Handle no tool calls (final answer or continuation)
  if (!toolCalls.length) {
    const noToolResult = handleNoToolCalls({ reply, rawReply, round, consecutiveNonActionRounds, messages });

    if (noToolResult.finalAnswer) {
      const finalText = noToolResult.finalText;
      const updatedMessages = [...messages, { role: 'assistant', content: finalText }];
      return { finalAnswer: true, finalText, messages: updatedMessages, consecutiveNonActionRounds: noToolResult.consecutiveNonActionRounds, actions: [...actions, 'final-answer'] };
    }

    if (noToolResult.shouldContinue) {
      return { finalAnswer: false, messages: noToolResult.messages, consecutiveNonActionRounds: noToolResult.consecutiveNonActionRounds, actions: [...actions, 'no-action-continuation'], shouldContinue: true };
    }
  }

  // 5. Validate tool calls
  const { validToolCalls, blockedReasons } = validateToolCalls(toolCalls);

  if (!validToolCalls.length) {
    messages.push({ role: 'assistant', content: rawReply || reply });
    messages.push({
      role: 'user',
      content: `All proposed tool calls were blocked or invalid (${blockedReasons.join('; ') || 'no valid call'}). Do not repeat them. Choose different valid tools with complete args or provide a final answer.`
    });
    return { finalAnswer: false, messages, consecutiveNonActionRounds: 0, actions: [...actions, 'all-blocked'], shouldContinue: true };
  }

  // 6. Execute batches
  const toolContent = stripModelMetaCommentary(String(reply || '').replace(/\u003ctool_call(?:\s[^\u003e]*\u003e|\u003e?)\s*[\s\S]*?\u003c\/tool_call\u003e/gi, ''));
  if (toolContent) {
    addMessage('agent', toolContent, round, false, false, parsedReply.thinkingBlocks || []);
  }

  messages.push({ role: 'assistant', content: rawReply || reply });

  for (const toolCall of validToolCalls) {
    window.sessionStats.tools++;
    updateStats();
    addMessage('tool', `? ${toolCall.tool}(${JSON.stringify(toolCall.args)})`, round, true);
  }

  const batchResult = await executeToolBatches({ validToolCalls, reply, rawReply, round, delay, messages });
  messages = batchResult.messages;

  if (batchResult.pendingConfirmations) {
    return { finalAnswer: false, messages, consecutiveNonActionRounds: 0, actions: [...actions, 'pending-confirmations'], shouldContinue: true };
  }

  // 7. Apply compaction
  const Comp = window.AgentCompaction;
  const compactionNotes = Comp?.applyContextManagementPipeline
    ? await Comp.applyContextManagementPipeline({ round, userMessage, ctxLimit: getCtxLimit() })
    : [];

  // 8. Build continuation prompt
  const { orchestrator } = getRuntimeModules();
  const continuationPrompt = orchestrator.buildRuntimeContinuationPrompt({
    toolSummary: batchResult.roundToolSummaryChunks.join('\n\n'),
    permissionDenials: batchResult.roundSawPermissionDenied && Perm.runPermissionDenials ? Perm.runPermissionDenials.slice(-3) : [],
    compactionNotes,
    promptInjectionNotes: batchResult.roundPromptInjectionNotes
  });

  if (continuationPrompt) {
    messages.push({ role: 'user', content: continuationPrompt });
  }

  return {
    finalAnswer: false,
    messages,
    consecutiveNonActionRounds: 0,
    actions: [...actions, 'tool-execution', `tools:${validToolCalls.map(c => c.tool).join(',')}`],
    shouldContinue: true
  };
}

window.AgentRoundController = { executeRound };
