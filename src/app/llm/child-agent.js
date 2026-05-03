// src/app/llm/child-agent.js
// Child agent spawning for delegated tasks.

;(function() {
  /** @type {Function} */
  var C = function() { return window.CONSTANTS || {}; };

  /**
   * Spawn a child agent for a delegated task.
   * @param {Object} opts - Options
   * @param {string} opts.task - Task description
   * @param {string[]} [opts.tools=[]] - Allowed tools
   * @param {number} [opts.maxIterations=10] - Max iterations
   * @returns {Promise<{success: boolean, task: string, iterations: number, status: string, result: any, toolsSummary: string, childState: Object}>} Child agent result
   */
  async function spawnAgentChild(opts) {
    var task = (opts && opts.task) || '';
    var tools = (opts && opts.tools) || [];
    var maxIterations = (opts && opts.maxIterations) || 10;
    if (!task) return { success: false, error: 'task is required' };
    if (!Array.isArray(tools)) tools = [];
    var cfg = C();
    var maxIters = Math.min(cfg.CHILD_AGENT_MAX_ITERATIONS || 50, Math.max(1, maxIterations));

    var childState = {
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
      if (typeof assertRuntimeReady === 'function') assertRuntimeReady();
      var modules = typeof getRuntimeModules === 'function' ? getRuntimeModules() : {};
      var orchestrator = modules.orchestrator;

      var sysPrompt = await orchestrator.buildSystemPrompt({ userMessage: task, enabledTools: Array.isArray(tools) ? tools : [] });
      childState.messages.push({ role: 'system', content: sysPrompt });
      childState.messages.push({ role: 'user', content: task });

      while (childState.round < childState.maxRounds) {
        childState.round++;

        var rawReply;
        try {
          rawReply = await callLLM(childState.messages, {
            maxTokens: cfg.CHILD_AGENT_MAX_TOKENS || 800,
            temperature: cfg.CHILD_AGENT_TEMPERATURE || 0.3,
            timeoutMs: cfg.CHILD_AGENT_TIMEOUT_MS || 22000,
            retries: cfg.CHILD_AGENT_RETRIES || 1,
            enabledTools: Array.isArray(tools) ? tools : []
          });
        } catch (e) {
          childState.error = 'LLM call failed: ' + (e && e.message || 'unknown');
          break;
        }

        var parsedReply = typeof splitModelReply === 'function' ? splitModelReply(rawReply) : { visible: rawReply, thinkingBlocks: [] };
        var reply = parsedReply.visible;
        childState.messages.push({ role: 'assistant', content: reply });

        var TE = window.AgentToolExecution;
        var toolCalls = TE && TE.resolveToolCallsFromModelReply ? TE.resolveToolCallsFromModelReply(reply, rawReply) : [];
        if (!toolCalls.length) {
          childState.results.push({ type: 'final_answer', content: reply });
          childState.succeeded = true;
          break;
        }

        var filteredCalls = toolCalls.filter(function(call) { return !childState.tools.size || childState.tools.has(call.tool); });
        if (!filteredCalls.length) {
          childState.results.push({ type: 'tool_calls_blocked', content: 'Attempted tools not in allowed set: ' + toolCalls.map(function(c) { return c.tool; }).join(', ') });
          break;
        }

        for (var i = 0; i < filteredCalls.length; i++) {
          var call = filteredCalls[i];
          var toolResult;
          try {
            toolResult = TE && TE.executeTool ? await TE.executeTool(call) : 'ERROR: executeTool not available';
          } catch (e2) {
            toolResult = 'ERROR: ' + (e2 && e2.message || 'tool execution failed');
          }
          childState.results.push({ type: 'tool_result', tool: call.tool, result: toolResult });
          childState.messages.push({ role: 'tool', tool_call_id: call.call_id || call.id || 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9), content: String(toolResult) });
        }
      }

      if (!childState.succeeded && childState.round >= childState.maxRounds) {
        childState.error = 'Max iterations (' + childState.maxRounds + ') reached without completion';
      }
    } catch (e3) {
      childState.error = 'Child agent spawn failed: ' + (e3 && e3.message || 'unknown');
    }

    return {
      success: childState.succeeded && !childState.error,
      task: task,
      iterations: childState.round,
      status: childState.succeeded ? 'completed' : (childState.error ? 'error' : 'timeout'),
      result: childState.results.length ? childState.results : childState.error,
      toolsSummary: 'Executed ' + childState.results.filter(function(r) { return r.type === 'tool_result'; }).length + ' tool(s) across ' + childState.round + ' iteration(s)',
      childState: { messages: childState.messages.length, round: childState.round, maxRounds: childState.maxRounds }
    };
  }

  window.spawnAgentChild = spawnAgentChild;
})();