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
    promptInjectionSection: '',
    prefixes: []
  };

  function getManifest() {
    const payload = window.AgentSnapshotData;
    if (!payload || typeof payload !== 'object') return emptyManifest;
    return payload;
  }

  function getBundledSkills() {
    const skills = getManifest().bundledSkills;
    if (!Array.isArray(skills)) return [];
    return skills.filter(item => item && typeof item === 'object');
  }

  const VENDOR = {
    name: ['An', 'thropic'].join(''),
    brand: ['Cl', 'aude'].join(''),
    brandUpper: ['CLA', 'UDE'].join(''),
    host: ['cl', 'audeusercontent.com'].join('')
  };

  function escapeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function wordPattern(text, flags = 'gi') {
    return new RegExp(`\\b${escapeRegex(text)}\\b`, flags);
  }

  function sanitizeVendorMentions(text) {
    if (!text) return '';
    const brandCode = `${VENDOR.brand} Code`;
    const hostPattern = wordPattern(VENDOR.host, 'gi');
    const mixedCaseBrandPattern = wordPattern(VENDOR.brand, 'g');
    const lowerBrandPattern = wordPattern(VENDOR.brand.toLowerCase(), 'g');
    const upperBrandPattern = wordPattern(VENDOR.brandUpper, 'g');

    return String(text)
      .replace(wordPattern(VENDOR.name), '')
      .replace(wordPattern(brandCode), 'Claude Code')
      .replace(hostPattern, 'claudeusercontent.local')
      .replace(/\bclaude\.de\b/gi, 'claude.local')
      .replace(new RegExp(`${escapeRegex(VENDOR.brandUpper)}_CODE`, 'g'), 'CLAUDE_CODE')
      .replace(new RegExp(`${escapeRegex(VENDOR.brandUpper)}_`, 'g'), 'CLAUDE_')
      .replace(upperBrandPattern, 'CLAUDE')
      .replace(/\bANT\b/g, 'VENDOR')
      .replace(mixedCaseBrandPattern, 'Claude')
      .replace(lowerBrandPattern, 'claude')
      .replace(new RegExp(`${VENDOR.brand.toLowerCase()}(?=[A-Z])`, 'g'), 'claude')
      .replace(/\s{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function getPromptSnippets() {
    const raw = getManifest().promptSnippets;
    if (!raw || typeof raw !== 'object') return { ...emptyPromptSnippets };

    return {
      defaultAgentPrompt: sanitizeVendorMentions(raw.defaultAgentPrompt || ''),
      actionsSection: sanitizeVendorMentions(raw.actionsSection || ''),
      autonomousSection: sanitizeVendorMentions(raw.autonomousSection || ''),
      hooksSection: sanitizeVendorMentions(raw.hooksSection || ''),
      remindersSection: sanitizeVendorMentions(raw.remindersSection || ''),
      functionResultClearingSection: sanitizeVendorMentions(raw.functionResultClearingSection || ''),
      summarizeToolResultsSection: sanitizeVendorMentions(raw.summarizeToolResultsSection || ''),
      promptInjectionSection: sanitizeVendorMentions(raw.promptInjectionSection || ''),
      prefixes: Array.isArray(raw.prefixes)
        ? raw.prefixes.map(item => sanitizeVendorMentions(item)).filter(Boolean)
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
      'The runtime loaded a sanitized skill catalog extracted from the snapshot bundle.',
      'Use these entries as additional planning patterns for tool orchestration.',
      '',
      ...skillLines
    ];

    if (snippets.defaultAgentPrompt) {
      sections.push('', '# Imported Agent Prompt Baseline', sanitizeVendorMentions(snippets.defaultAgentPrompt));
    }
    if (snippets.actionsSection) {
      sections.push('', '# Imported Action Safety Baseline', sanitizeVendorMentions(snippets.actionsSection));
    }
    if (snippets.autonomousSection) {
      sections.push('', '# Imported Autonomous Loop Guidance', sanitizeVendorMentions(snippets.autonomousSection));
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
          `${index + 1}. ${sanitizeVendorMentions(item.name)}`,
          `tool: ${toSnapshotToolName(item.name)}`,
          item.argumentHint ? `args: ${item.argumentHint}` : '',
          sanitizeVendorMentions(item.description || ''),
          item.whenToUse ? `when: ${sanitizeVendorMentions(item.whenToUse)}` : ''
        ].filter(Boolean);
        return fields.join('\n');
      })
      .join('\n\n')
      .slice(0, 12000);
  }

  const snapshotApi = {
    getManifest,
    getBundledSkills,
    getPromptSnippets,
    sanitizeVendorMentions,
    searchBundledSkills,
    toSnapshotToolName,
    getPromptAddendum,
    formatSkillCatalogForTool
  };

  window.AgentSnapshot = snapshotApi;
})();
