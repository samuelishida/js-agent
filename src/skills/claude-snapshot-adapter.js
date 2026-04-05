(() => {
  const emptyManifest = {
    generatedAt: null,
    bundledSkills: [],
    promptSnippets: {}
  };
  const emptyPromptSnippets = {
    defaultAgentPrompt: '',
    actionsSection: '',
    autonomousSection: '',
    hooksSection: '',
    remindersSection: '',
    functionResultClearingSection: '',
    summarizeToolResultsSection: '',
    prefixes: []
  };

  function getManifest() {
    const payload = window.AgentClaudeSnapshotData;
    if (!payload || typeof payload !== 'object') return emptyManifest;
    return payload;
  }

  function getBundledSkills() {
    const skills = getManifest().bundledSkills;
    if (!Array.isArray(skills)) return [];
    return skills.filter(item => item && typeof item === 'object');
  }

  function sanitizeAnthropicMentions(text) {
    if (!text) return '';
    return String(text)
      .replace(/\bAnthropic\b/gi, 'model provider')
      .replace(/\bClaude Code\b/gi, 'agent runtime')
      .replace(/\bClaude\b/g, 'Assistant')
      .replace(/\bclaude\b/g, 'assistant');
  }

  function getPromptSnippets() {
    const raw = getManifest().promptSnippets;
    if (!raw || typeof raw !== 'object') return { ...emptyPromptSnippets };

    return {
      defaultAgentPrompt: sanitizeAnthropicMentions(raw.defaultAgentPrompt || ''),
      actionsSection: sanitizeAnthropicMentions(raw.actionsSection || ''),
      autonomousSection: sanitizeAnthropicMentions(raw.autonomousSection || ''),
      hooksSection: sanitizeAnthropicMentions(raw.hooksSection || ''),
      remindersSection: sanitizeAnthropicMentions(raw.remindersSection || ''),
      functionResultClearingSection: sanitizeAnthropicMentions(raw.functionResultClearingSection || ''),
      summarizeToolResultsSection: sanitizeAnthropicMentions(raw.summarizeToolResultsSection || ''),
      prefixes: Array.isArray(raw.prefixes)
        ? raw.prefixes.map(item => sanitizeAnthropicMentions(item)).filter(Boolean)
        : []
    };
  }

  function normalizeQuery(query) {
    return String(query || '').trim().toLowerCase();
  }

  function toSnapshotToolName(skillName) {
    const normalized = String(skillName || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return normalized ? `snapshot_skill_${normalized}` : 'snapshot_skill_unknown';
  }

  function searchBundledSkills({ query = '', limit = 20 } = {}) {
    const q = normalizeQuery(query);
    const max = Math.max(1, Math.min(100, Number(limit) || 20));
    const all = getBundledSkills();
    const filtered = q
      ? all.filter(item => {
          const haystack = [
            item.name,
            item.description,
            item.whenToUse,
            item.argumentHint,
            item.usage
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(q);
        })
      : all;
    return filtered.slice(0, max);
  }

  function getPromptAddendum() {
    const snippets = getPromptSnippets();
    const skills = getBundledSkills().slice(0, 30);
    if (!skills.length) return '';

    const skillLines = skills.map(item => {
      const toolName = toSnapshotToolName(item.name);
      const parts = [
        `- ${item.name} (tool: ${toolName})`,
        item.argumentHint ? `args: ${item.argumentHint}` : '',
        item.description || item.whenToUse || ''
      ].filter(Boolean);
      return parts.join(' | ');
    });

    const sections = [
      '# Imported Snapshot Skills',
      'The runtime loaded a sanitized skill catalog extracted from claude-code-main.',
      'Use these entries as additional planning patterns for tool orchestration.',
      '',
      ...skillLines
    ];

    if (snippets.defaultAgentPrompt) {
      sections.push('', '# Imported Agent Prompt Baseline', sanitizeAnthropicMentions(snippets.defaultAgentPrompt));
    }
    if (snippets.actionsSection) {
      sections.push('', '# Imported Action Safety Baseline', sanitizeAnthropicMentions(snippets.actionsSection));
    }
    if (snippets.autonomousSection) {
      sections.push('', '# Imported Autonomous Loop Guidance', sanitizeAnthropicMentions(snippets.autonomousSection));
    }

    return sections.join('\n').slice(0, 12000);
  }

  function formatSkillCatalogForTool({ query = '', limit = 20 } = {}) {
    const matches = searchBundledSkills({ query, limit });
    if (!matches.length) {
      return 'No imported snapshot skills matched the query.';
    }

    return matches
      .map((item, index) => {
        const fields = [
          `${index + 1}. ${sanitizeAnthropicMentions(item.name)}`,
          `tool: ${toSnapshotToolName(item.name)}`,
          item.argumentHint ? `args: ${item.argumentHint}` : '',
          sanitizeAnthropicMentions(item.description || ''),
          item.whenToUse ? `when: ${sanitizeAnthropicMentions(item.whenToUse)}` : ''
        ].filter(Boolean);
        return fields.join('\n');
      })
      .join('\n\n')
      .slice(0, 12000);
  }

  window.AgentClaudeSnapshot = {
    getManifest,
    getBundledSkills,
    getPromptSnippets,
    sanitizeAnthropicMentions,
    searchBundledSkills,
    toSnapshotToolName,
    getPromptAddendum,
    formatSkillCatalogForTool
  };
})();
