(() => {
  const DEFAULT_PROMPTS = {
    system: 'prompts/system.md',
    repair: 'prompts/repair.md',
    summarize: 'prompts/summarize.md',
    policy: 'prompts/orchestrator.md'
  };
  const BUILTIN_SKILL_DESCRIPTIONS = {
    calc: 'Evaluates a mathematical expression.',
    datetime: 'Returns the current date and time.'
  };

  async function buildSystemPrompt({ userMessage, maxRounds, ctxLimit, enabledTools }) {
    const toolsList = enabledTools
      .map(name => {
        const skill = window.AgentSkills?.registry?.[name];
        return `- ${name}: ${skill?.description || BUILTIN_SKILL_DESCRIPTIONS[name] || 'available skill'}`;
      })
      .join('\n');

    const pair = window.AgentSkills?.detectFxPair?.(userMessage);
    const hint = pair ? `The user likely wants the ${pair.base}/${pair.quote} exchange rate.` : '';

    const [policy, systemPrompt] = await Promise.all([
      window.AgentPrompts.load(DEFAULT_PROMPTS.policy),
      window.AgentPrompts.loadRendered(DEFAULT_PROMPTS.system, {
        max_rounds: maxRounds,
        ctx_limit: ctxLimit,
        tools_list: toolsList,
        query_hint: hint
      })
    ]);

    return `${policy}\n\n${systemPrompt}`;
  }

  async function buildRepairPrompt(userMessage) {
    return window.AgentPrompts.loadRendered(DEFAULT_PROMPTS.repair, { user_message: userMessage });
  }

  async function buildSummaryPrompt(history, userMessage) {
    return window.AgentPrompts.loadRendered(DEFAULT_PROMPTS.summarize, {
      history,
      user_message: userMessage
    });
  }

  async function executeSkill(call, context = {}) {
    const registry = window.AgentSkills?.registry || {};
    const skill = registry[call.tool];
    if (!skill) {
      return `ERROR: unknown tool '${call.tool}'. Available: ${Object.keys(registry).join(', ')}`;
    }

    const chain = [skill.name, ...(skill.fallbacks || [])];
    let lastError = null;

    for (const name of chain) {
      const current = registry[name];
      if (!current) continue;

      let attempts = Math.max(1, current.retries || 1);
      while (attempts > 0) {
        attempts -= 1;
        try {
          if (current.when && !current.when(call.args || {}, context)) {
            throw new Error('skill condition not satisfied');
          }

          const result = await current.run(call.args || {}, context);
          const validation = window.AgentRegex.validateSkillOutput(result);
          if (!validation.valid) {
            throw new Error(`invalid skill output: ${validation.issues.join(', ')}`);
          }

          return result;
        } catch (error) {
          lastError = error;
        }
      }
    }

    return `ERROR executing ${call.tool}: ${lastError?.message || 'unknown failure'}`;
  }

  function parseToolCall(text) {
    return window.AgentRegex.extractToolCall(text);
  }

  function hasReasoningLeak(text) {
    return window.AgentRegex.looksLikeReasoningLeak(text);
  }

  window.AgentOrchestrator = {
    prompts: DEFAULT_PROMPTS,
    buildSystemPrompt,
    buildRepairPrompt,
    buildSummaryPrompt,
    executeSkill,
    parseToolCall,
    hasReasoningLeak
  };
})();

