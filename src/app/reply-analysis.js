// src/app/reply-analysis.js
// Reply analysis: strip meta commentary, detect errors, extract thinking blocks.

;(function() {
  /**
   * Strip model meta commentary from text.
   * @param {string} text - Raw text
   * @returns {string} Cleaned text
   */
  function stripModelMetaCommentary(text) {
    var value = String(text || '').trim();
    if (!value) return '';
    value = value.replace(/^[Ww]e (?:need|have|must) to output (?:tool|function) calls? only\.?\s*/i, '');
    value = value.replace(/^[Ww]e (?:will|should|must|need to|are going to) (?:call|use|invoke|execute|run) \S+(?:\s+with\s+[^.]+)?\.?\s*/i, '');
    value = value.replace(/^[Ii] (?:will|should|need to|must|am going to|am) (?:call|use|invoke|execute|run|outputting) \S+(?:\s+with\s+[^.]+)?\.?\s*/i, '');
    value = value.replace(/^[Ll]et's (?:call|use|try|invoke) \S+\.?\s*/i, '');
    value = value.replace(/^[Ww]e need to (?:output|generate|produce|call|make) (?:a )?(?:tool|function) call\.?\s*/i, '');
    value = value.replace(/^I need to (?:output|generate|produce|call|make) (?:a )?(?:tool|function) call\.?\s*/i, '');
    return value.trim();
  }

  /**
   * Check if error looks like max output token error.
   * @param {Error} error - Error object
   * @returns {boolean} True if max output token error
   */
  function isMaxOutputTokenLikeError(error) {
    var message = String(error && error.message || '');
    if (!message) return false;
    return /(max(?:imum)?\s*(?:output\s*)?tokens?|max_output_tokens|output token limit|too many output tokens|exceeded.*output|finish_reason\s*[:=]\s*"?length"?)/i.test(message);
  }

  /**
   * Check if reply looks like deferred action.
   * @param {string} text - Reply text
   * @returns {boolean} True if deferred
   */
  function looksLikeDeferredActionReply(text) {
    var value = String(text || '').trim();
    if (!value) return false;
    var futureActionPattern = /\b(?:i\s+will|i'll|let me|i am going to|i'm going to|next[, ]+i(?:\s+will|'ll)?|i'll\s+(?:start|begin|now)|now\s+i(?:'ll|\s+will))\b/i;
    var actionVerbPattern = /\b(?:search|look up|check|verify|probe|inspect|browse|review|find|perform|run|try|investigate|list|listing|read|reading|fetch|fetching|scan|scanning|call|calling|execute|executing|start|starting|begin|beginning|map|mapping|gather|gathering|analyze|analyzing|collect|collecting|query|querying|load|loading|open|opening|access|accessing|retrieve|retrieving|walk|walking|traverse|traversing|explore|exploring|examine|examining|identify|identifying|inspect)\b/i;
    var finalityPattern = /\b(?:final answer|in summary|overall|therefore|the answer is|based on (?:the|current) (?:evidence|information))\b/i;
    return futureActionPattern.test(value) && actionVerbPattern.test(value) && !finalityPattern.test(value);
  }

  /**
   * Check if reply claims tool execution without call.
   * @param {string} text - Reply text
   * @returns {boolean} True if claim without call
   */
  function looksLikeToolExecutionClaimWithoutCall(text) {
    var value = String(text || '').trim();
    if (!value) return false;
    var executionClaimPattern = /\b(?:i\s+(?:have|already)\s+(?:executed|called|run|performed)|(?:the\s+)?tool\s+call\s+(?:has\s+been\s+)?(?:executed|made|performed)|executed\s+the\s+necessary\s+tool\s+call|necessary\s+tool\s+call)\b/i;
    var waitingPattern = /\b(?:please\s+wait|wait\s+for\s+(?:the\s+)?tool\s+output|await(?:ing)?\s+tool\s+output|once\s+the\s+tool\s+output|after\s+tool\s+output|provide\s+the\s+final\s+answer\s+after\s+tool\s+output)\b/i;
    var finalityPattern = /\b(?:final answer|in summary|overall|therefore|the answer is|based on (?:the|current) (?:evidence|information))\b/i;
    return executionClaimPattern.test(value) && waitingPattern.test(value) && !finalityPattern.test(value);
  }

  /**
   * Get regex for tool call cleanup.
   * @returns {RegExp} Cleanup regex
   */
  function getToolCallCleanupRegex() {
    var regex = window.AgentRegex;
    var sharedToolBlock = regex && regex.TOOL_BLOCK;
    if (sharedToolBlock instanceof RegExp) {
      return new RegExp(sharedToolBlock.source, 'gi');
    }
    return /<tool_call(?:\s[^>]*>|>?)\s*[\s\S]*?<\/tool_call>/gi;
  }

  /**
   * Extract planner optimized query from messages.
   * @param {import('../types/index.js').SessionMessage[]} messages - Messages
   * @returns {string} Extracted query
   */
  function extractPlannerOptimizedQueryFromMessages(messages) {
    var recentUserMessages = Array.isArray(messages)
      ? messages.filter(function(message) { return message && message.role === 'user'; }).slice(-8).reverse()
      : [];

    for (var i = 0; i < recentUserMessages.length; i++) {
      var content = String(recentUserMessages[i] && recentUserMessages[i].content || '');
      var queryPlanBlocks = [];
      var match;
      var qpRegex = /<tool_result\s+tool="query_plan">\s*([\s\S]*?)\s*<\/tool_result>/gi;
      while ((match = qpRegex.exec(content)) !== null) {
        queryPlanBlocks.push(match);
      }
      for (var j = queryPlanBlocks.length - 1; j >= 0; j--) {
        var block = String(queryPlanBlocks[j] && queryPlanBlocks[j][1] || '');
        var directMatch = block.match(/(?:^|\n)query=([^\n]+)/i);
        if (directMatch && directMatch[1]) {
          var query = String(directMatch[1]).trim();
          if (query) return query;
        }
      }
      var plannerMatch = content.match(/Planner optimized query:\s*"([^"]+)"/i);
      if (plannerMatch && plannerMatch[1]) {
        var pquery = String(plannerMatch[1]).trim();
        if (pquery) return pquery;
      }
    }
    return '';
  }

  /**
   * Extract thinking blocks from text.
   * @param {string} text - Raw text
   * @returns {string[]} Thinking blocks
   */
  function extractThinkingBlocks(text) {
    var blocks = [];
    var remaining = String(text || '');
    var prev;
    do {
      prev = remaining;
      remaining = remaining.replace(/<think(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/think>/gi, function(_, content) {
        var trimmed = content.trim();
        if (trimmed) {
          var nested = extractThinkingBlocks(trimmed);
          if (nested.length > 0) {
            for (var ni = 0; ni < nested.length; ni++) blocks.push(nested[ni]);
          } else {
            blocks.push(trimmed);
          }
        }
        return '';
      });
    } while (remaining !== prev);
    return blocks.filter(Boolean);
  }

  /**
   * Normalize visible model text.
   * @param {string} text - Raw text
   * @returns {string} Normalized text
   */
  function normalizeVisibleModelText(text) {
    var value = String(text || '').trim();
    if (!value) return '';

    value = value
      .replace(/^```(?:xml|html)?\s*([\s\S]*?)\s*```$/i, '$1')
      .trim();

    value = value.replace(/^markdown\s+(?=[#>*\-\d`\[]|\w)/i, '');

    var answerDelimiters = [
      /\n\n((?:[A-Z][\s\S]*))/,
      /\n(So\s+(?:the |the )?(?:answer|result|conclusion|output|response) is\b[\s\S]*)/i,
      /\n(Therefore,?\s*[\s\S]*)/i,
      /\n(In (?:conclusion|summary),?\s*[\s\S]*)/i,
      /\n((?:Chuck |As of |The |It is |He |She |They |This )(?:(?:is|are|was|were|has|have)\b)[\s\S]*)/i,
    ];

    var startsWithReasoning = /^(?:We (?:will|should|need|could)|I (?:will|should|need|could|am|can)|Let's|Actually|Hmm|Wait|First,|Let me)/i.test(value);
    if (startsWithReasoning && value.length > 150) {
      for (var di = 0; di < answerDelimiters.length; di++) {
        var delimMatch = value.match(answerDelimiters[di]);
        if (delimMatch && delimMatch[1] && delimMatch[1].trim().length > 20) {
          value = delimMatch[1].trim();
          break;
        }
      }
    }

    return value.trim();
  }

  /**
   * Check if thinking blocks indicate the model intended a final answer.
   * @param {string[]} thinkingBlocks - Extracted thinking blocks
   * @returns {boolean} True if thinking suggests final answer intent
   */
  function thinkingIndicatesFinalAnswer(thinkingBlocks) {
    var text = (thinkingBlocks || []).join('\n').trim();
    if (!text) return false;
    var finalPatterns = [
      /\b(?:final answer|provide the answer|answer the user|respond to the user|give the final|output the final|deliver the final|conclude with|wrap up with|summarize for the user)\b/i,
      /\b(?:no (?:more )?tools needed|no (?:further )?tool calls? (?:are )?required|done with tools|finished with tools)\b/i,
      /\b(?:the user (?:just |only )?wants|user (?:only |just )?asked for|user request is complete)\b/i
    ];
    for (var i = 0; i < finalPatterns.length; i++) {
      if (finalPatterns[i].test(text)) return true;
    }
    return false;
  }

  /**
   * Split model reply into raw, thinking, and visible parts.
   * @param {string} text - Raw reply
   * @returns {{raw: string, thinkingBlocks: string[], visible: string}} Split reply
   */
  function splitModelReply(text) {
    var raw = String(text || '');
    var withoutThinking = raw;
    var prev;
    do {
      prev = withoutThinking;
      withoutThinking = withoutThinking.replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi, '');
    } while (withoutThinking !== prev);
    return {
      raw: raw,
      thinkingBlocks: extractThinkingBlocks(raw),
      visible: normalizeVisibleModelText(withoutThinking)
    };
  }

  window.AgentReplyAnalysis = {
    stripModelMetaCommentary: stripModelMetaCommentary,
    isMaxOutputTokenLikeError: isMaxOutputTokenLikeError,
    looksLikeDeferredActionReply: looksLikeDeferredActionReply,
    looksLikeToolExecutionClaimWithoutCall: looksLikeToolExecutionClaimWithoutCall,
    getToolCallCleanupRegex: getToolCallCleanupRegex,
    extractPlannerOptimizedQueryFromMessages: extractPlannerOptimizedQueryFromMessages,
    extractThinkingBlocks: extractThinkingBlocks,
    normalizeVisibleModelText: normalizeVisibleModelText,
    splitModelReply: splitModelReply,
    thinkingIndicatesFinalAnswer: thinkingIndicatesFinalAnswer
  };

  window.stripModelMetaCommentary = stripModelMetaCommentary;
  window.isMaxOutputTokenLikeError = isMaxOutputTokenLikeError;
  window.looksLikeDeferredActionReply = looksLikeDeferredActionReply;
  window.looksLikeToolExecutionClaimWithoutCall = looksLikeToolExecutionClaimWithoutCall;
  window.getToolCallCleanupRegex = getToolCallCleanupRegex;
  window.extractPlannerOptimizedQueryFromMessages = extractPlannerOptimizedQueryFromMessages;
  window.splitModelReply = splitModelReply;
})();