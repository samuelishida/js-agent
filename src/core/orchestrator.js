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

    const snapshotAddendum = window.AgentClaudeSnapshot?.getPromptAddendum?.() || '';
    return snapshotAddendum
      ? `${policy}\n\n${systemPrompt}\n\n${snapshotAddendum}`
      : `${policy}\n\n${systemPrompt}`;
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

  function canonicalToolName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function normalizeToolCall(call) {
    if (!call?.tool) return null;

    const registry = window.AgentSkills?.registry || {};
    if (registry[call.tool]) {
      return { tool: call.tool, args: call.args || {} };
    }

    const requested = canonicalToolName(call.tool);
    const aliasMap = {
      webfetch: 'web_fetch',
      fileread: 'file_read',
      readfile: 'read_file',
      filewrite: 'file_write',
      writefile: 'write_file',
      fileedit: 'file_edit',
      editfile: 'edit_file',
      globtool: 'glob',
      greptool: 'grep',
      todowrite: 'todo_write',
      taskcreate: 'task_create',
      taskget: 'task_get',
      tasklist: 'task_list',
      taskupdate: 'task_update',
      askuserquestion: 'ask_user_question',
      memorywrite: 'memory_write',
      memorysearch: 'memory_search',
      memorylist: 'memory_list',
      toolsearch: 'tool_search',
      skillcatalog: 'snapshot_skill_catalog',
      snapshotskillcatalog: 'snapshot_skill_catalog'
    };

    if (aliasMap[requested] && registry[aliasMap[requested]]) {
      return { tool: aliasMap[requested], args: call.args || {} };
    }

    const candidates = Object.keys(registry);
    const exact = candidates.find(name => canonicalToolName(name) === requested);
    if (exact) {
      return { tool: exact, args: call.args || {} };
    }

    const prefixed = candidates.find(name => {
      const normalized = canonicalToolName(name);
      return normalized.startsWith(requested) || requested.startsWith(normalized);
    });

    if (prefixed) {
      return { tool: prefixed, args: call.args || {} };
    }

    return { tool: call.tool, args: call.args || {} };
  }

  function parseToolCall(text) {
    const call = window.AgentRegex.extractToolCall(text);
    return normalizeToolCall(call);
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

