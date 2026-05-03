// src/skills/skill-loader.js
// Skill loader: discovers, parses, and injects .md-based skills into the agent loop.
// Skills are methodology/expertise documents (not executable tools).
// They provide domain knowledge, workflows, and guidelines that the LLM follows.
//
// Publishes: window.AgentSkillLoader
//
// Browser compatibility: All skill data is cached in localStorage so skills
// work offline after first load. User preferences (enabled/disabled skills,
// custom skills) are also persisted in localStorage. No filesystem permissions
// required.

// src/skills/skill-loader.js
// Skill loader: discovers, parses, and injects .md-based skills into the agent loop.
// Skills are methodology/expertise documents (not executable tools).
// They provide domain knowledge, workflows, and guidelines that the LLM follows.
//
// Publishes: window.AgentSkillLoader
//
// Browser compatibility: All skill data is cached in localStorage so skills
// work offline after first load. User preferences (enabled/disabled skills,
// custom skills) are also persisted in localStorage. No filesystem permissions
// required.

/** @typedef {import('../types/index.js').SkillEntry} SkillEntry */
/** @typedef {import('../types/index.js').SkillCacheEntry} SkillCacheEntry */
/** @typedef {import('../types/index.js').SkillSearchResult} SkillSearchResult */

(() => {
  'use strict';

  // ── localStorage keys ───────────────────────────────────────────────────
  /** @type {Object.<string, string>} */
  const LS_KEYS = {
    CACHE: 'agent_skills_cache',      // name → { markdown, source, timestamp }
    ENABLED: 'agent_skills_enabled', // string[] of enabled skill names
    CUSTOM: 'agent_skills_custom',    // name → { markdown, source }
    PREFERENCES: 'agent_skills_prefs' // { maxContentLength, matchLimit, ... }
  };

  // ── Skill registry ────────────────────────────────────────────────────────
  /** @type {Map<string, SkillEntry>} */
  const skills = new Map(); // name → { name, description, content, frontmatter, source }

  // ── YAML frontmatter parser (minimal) ─────────────────────────────────────
  /**
   * Parse YAML frontmatter from markdown text.
   * @param {string} text - Raw markdown text
   * @returns {{frontmatter: Object, body: string}} Parsed frontmatter and body
   */
  function parseFrontmatter(text) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return { frontmatter: {}, body: text };

    const raw = match[1];
    const frontmatter = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      frontmatter[key] = value;
    }
    const body = text.slice(match[0].length);
    return { frontmatter, body };
  }

  // ── Register a skill from raw markdown ──────────────────────────────────
  /**
   * Register a skill from raw markdown content.
   * @param {string} markdown - Raw markdown content
   * @param {string} [source='unknown'] - Source identifier
   * @returns {SkillEntry|null} Registered skill entry or null if invalid
   */
  function registerSkill(markdown, source = 'unknown') {
    const { frontmatter, body } = parseFrontmatter(markdown);
    const name = frontmatter.name || source;
    const description = frontmatter.description || '';

    if (!name) {
      console.warn(`[SkillLoader] Skipping skill with no name from ${source}`);
      return null;
    }

    const entry = {
      name,
      description,
      frontmatter,
      content: body.trim(),
      source
    };

    skills.set(name, entry);
    console.debug(`[SkillLoader] Registered skill: ${name}`);
    return entry;
  }

  // ── localStorage helpers ────────────────────────────────────────────────

  /**
   * Read and parse a value from localStorage.
   * @param {string} key - localStorage key
   * @param {any} [fallback=null] - Fallback value if key not found or parse fails
   * @returns {any} Parsed value or fallback
   */
  function lsGet(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      console.warn(`[SkillLoader] localStorage read error for ${key}:`, err.message);
      return fallback;
    }
  }

  /**
   * Write a value to localStorage as JSON.
   * @param {string} key - localStorage key
   * @param {any} value - Value to store
   * @returns {boolean} True if successful
   */
  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn(`[SkillLoader] localStorage write error for ${key}:`, err.message);
      return false;
    }
  }

  // ── Cache management ─────────────────────────────────────────────────────

  /**
   * Save all registered skills to localStorage cache.
   * @returns {void}
   */
  function saveCache() {
    const cache = {};
    for (const [name, skill] of skills) {
      cache[name] = {
        markdown: `---\n${Object.entries(skill.frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${skill.content}`,
        source: skill.source,
        timestamp: Date.now()
      };
    }
    lsSet(LS_KEYS.CACHE, cache);
  }

  /**
   * Load skills from localStorage cache.
   * @returns {SkillEntry[]} Loaded skills
   */
  function loadCache() {
    const cache = lsGet(LS_KEYS.CACHE, {});
    const loaded = [];
    for (const [name, data] of Object.entries(cache)) {
      if (skills.has(name)) continue; // skip if already loaded
      const skill = registerSkill(data.markdown, data.source || 'localStorage-cache');
      if (skill) loaded.push(skill);
    }
    if (loaded.length) {
      console.log(`[SkillLoader] Restored ${loaded.length} skills from localStorage cache`);
    }
    return loaded;
  }

  /**
   * Clear the localStorage skills cache.
   * @returns {void}
   */
  function clearCache() {
    try { localStorage.removeItem(LS_KEYS.CACHE); } catch {}
  }

  // ── User preferences ─────────────────────────────────────────────────────

  /**
   * Get list of enabled skill names.
   * @returns {string[]|null} Enabled skill names or null (all enabled)
   */
  function getEnabledSkills() {
    return lsGet(LS_KEYS.ENABLED, null); // null = all enabled
  }

  /**
   * Enable or disable a single skill.
   * @param {string} name - Skill name
   * @param {boolean} enabled - Whether to enable
   * @returns {void}
   */
  function setEnabledSkill(name, enabled) {
    const current = lsGet(LS_KEYS.ENABLED, null);
    let list = current ? [...current] : Array.from(skills.keys());
    if (enabled) {
      if (!list.includes(name)) list.push(name);
    } else {
      list = list.filter(n => n !== name);
    }
    lsSet(LS_KEYS.ENABLED, list);
  }

  /**
   * Set the list of enabled skills.
   * @param {string[]} names - Skill names to enable
   * @returns {void}
   */
  function setEnabledSkills(names) {
    lsSet(LS_KEYS.ENABLED, names);
  }

  /**
   * Reset enabled skills to default (all enabled).
   * @returns {void}
   */
  function resetEnabledSkills() {
    try { localStorage.removeItem(LS_KEYS.ENABLED); } catch {}
  }

  // ── Custom skills ────────────────────────────────────────────────────────

  /**
   * Save a custom skill to localStorage.
   * @param {string} name - Skill name
   * @param {string} markdown - Raw markdown content
   * @returns {SkillEntry} Registered skill entry
   */
  function saveCustomSkill(name, markdown) {
    const custom = lsGet(LS_KEYS.CUSTOM, {});
    custom[name] = { markdown, source: 'user-custom', addedAt: Date.now() };
    lsSet(LS_KEYS.CUSTOM, custom);
    return registerSkill(markdown, 'user-custom');
  }

  /**
   * Load custom skills from localStorage.
   * @returns {SkillEntry[]} Loaded custom skills
   */
  function loadCustomSkills() {
    const custom = lsGet(LS_KEYS.CUSTOM, {});
    const loaded = [];
    for (const [name, data] of Object.entries(custom)) {
      if (skills.has(name)) continue;
      const skill = registerSkill(data.markdown, data.source || 'user-custom');
      if (skill) loaded.push(skill);
    }
    if (loaded.length) {
      console.log(`[SkillLoader] Loaded ${loaded.length} custom skills from localStorage`);
    }
    return loaded;
  }

  /**
   * Delete a custom skill by name.
   * @param {string} name - Skill name to delete
   * @returns {void}
   */
  function deleteCustomSkill(name) {
    const custom = lsGet(LS_KEYS.CUSTOM, {});
    delete custom[name];
    lsSet(LS_KEYS.CUSTOM, custom);
    skills.delete(name);
  }

  // ── Register a skill from a URL (async fetch) ─────────────────────────
  /**
   * Fetch and register a skill from a URL.
   * @param {string} url - URL to fetch skill from
   * @returns {Promise<SkillEntry|null>} Registered skill or null on failure
   */
  async function registerSkillFromUrl(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const markdown = await res.text();
      const skill = registerSkill(markdown, url);
      if (skill) saveCache(); // update cache after successful fetch
      return skill;
    } catch (err) {
      console.warn(`[SkillLoader] Failed to load skill from ${url}: ${err.message}`);
      return null;
    }
  }

  // ── Register skills from a manifest ───────────────────────────────────
  /**
   * Load skills from a manifest URL, with caching and offline support.
   * @param {string} manifestUrl - URL to manifest JSON
   * @returns {Promise<SkillEntry[]>} Loaded skills
   */
  async function registerSkillsFromManifest(manifestUrl) {
    // 1. Load cached skills first (offline support)
    loadCache();
    loadCustomSkills();

    // 2. Fetch manifest and update from network
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = await res.json();

      const entries = manifest.skills || manifest;
      if (!Array.isArray(entries)) {
        console.warn('[SkillLoader] Manifest is not an array');
        return listSkills();
      }

      const results = [];
      for (const entry of entries) {
        const url = typeof entry === 'string' ? entry : entry.url;
        if (!url) continue;
        // Skip if already cached and fresh (within 24h)
        const cache = lsGet(LS_KEYS.CACHE, {});
        const cached = cache[entry.name || url];
        if (cached && (Date.now() - cached.timestamp < 86400000)) {
          console.debug(`[SkillLoader] Using cached skill: ${entry.name || url}`);
          continue; // already loaded from cache in step 1
        }
        const result = await registerSkillFromUrl(url);
        if (result) results.push(result);
      }

      // Prune cache: remove skills no longer in manifest
      const manifestNames = new Set(entries.map(e => e.name || '').filter(Boolean));
      const cache = lsGet(LS_KEYS.CACHE, {});
      const customSkills = lsGet(LS_KEYS.CUSTOM, {});
      const prunedNames = [];
      for (const name of Object.keys(cache)) {
        if (!manifestNames.has(name) && !customSkills[name]) {
          delete cache[name];
          prunedNames.push(name);
        }
      }
      if (prunedNames.length) {
        lsSet(LS_KEYS.CACHE, cache);
        for (const name of prunedNames) skills.delete(name);
      }

      saveCache();
      return results;
    } catch (err) {
      console.warn(`[SkillLoader] Failed to load manifest from ${manifestUrl}: ${err.message}`);
      console.log('[SkillLoader] Falling back to cached skills');
      return listSkills();
    }
  }

  // ── Get a skill by name ────────────────────────────────────────────────
  /**
   * Get a skill by name.
   * @param {string} name - Skill name
   * @returns {SkillEntry|null} Skill entry or null
   */
  function getSkill(name) {
    return skills.get(name) || null;
  }

  // ── List all registered skills ──────────────────────────────────────────
  /**
   * List all registered skills.
   * @returns {SkillEntry[]} All registered skills
   */
  function listSkills() {
    return Array.from(skills.values());
  }

  // ── Get skill names ────────────────────────────────────────────────────
  /**
   * Get all registered skill names.
   * @returns {string[]} Skill names
   */
  function getSkillNames() {
    return Array.from(skills.keys());
  }

  // ── Build a context block for the system prompt ─────────────────────────
  /**
   * Build a context block of enabled skills for the system prompt.
   * @param {string[]|null} [enabledSkillNames=null] - Names of skills to include
   * @returns {string} Formatted context block
   */
  function buildSkillContextBlock(enabledSkillNames = null) {
    const prefs = enabledSkillNames || getEnabledSkills();
    const entries = prefs
      ? listSkills().filter(s => prefs.includes(s.name))
      : listSkills();

    if (!entries.length) return '';

    const lines = [
      '# Available Skills (Methodology & Expertise)',
      '',
      'Skills provide domain knowledge, workflows, and guidelines. They are NOT executable tools — they are expertise the agent follows when relevant.',
      '',
      'When a user request matches a skill\'s domain, follow the skill\'s methodology and guidelines.',
      ''
    ];

    for (const skill of entries) {
      lines.push(`## ${skill.name}`);
      if (skill.description) lines.push(`Description: ${skill.description}`);
      lines.push('');
      // Truncate very long skill content to avoid context bloat
      const maxContentLength = 4000;
      const content = skill.content.length > maxContentLength
        ? skill.content.slice(0, maxContentLength) + '\n... (truncated)'
        : skill.content;
      lines.push(content);
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Match skills to a user message (scored) ────────────────────────────
  /**
   * Match skills to a user message using scoring.
   * @param {string} userMessage - User message to match against
   * @returns {SkillEntry[]} Top 3 matching skills
   */
  function matchSkills(userMessage) {
    const msg = String(userMessage || '').toLowerCase();
    const scored = [];

    for (const skill of listSkills()) {
      const desc = (skill.description || '').toLowerCase();
      const name = skill.name.toLowerCase();
      const keywords = (skill.frontmatter.keywords || '').toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
      let score = 0;

      // Name parts match (strong signal)
      const nameParts = name.split(/[-_]/);
      for (const part of nameParts) {
        if (part.length >= 3 && msg.includes(part)) score += 3;
      }

      // Keyword match (medium signal)
      for (const kw of keywords) {
        if (kw.length >= 3 && msg.includes(kw)) score += 2;
      }

      // Description phrase match (weaker signal)
      const descPhrases = desc.match(/\b[a-z]{3,}(?:\s+[a-z]{2,}){1,4}\b/gi) || [];
      for (const phrase of descPhrases) {
        if (phrase.length >= 8 && msg.includes(phrase.toLowerCase())) score += 1;
      }

      if (score > 0) scored.push({ skill, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map(s => s.skill);
  }

  // ── Search skills by query (tool-callable) ─────────────────────────────
  /**
   * Search skills by query string.
   * @param {string} query - Search query
   * @returns {SkillSearchResult[]} Top 10 matching skills with scores
   */
  function skillSearch(query) {
    const terms = String(query || '').toLowerCase().trim();
    const scored = [];

    for (const skill of listSkills()) {
      const hay = `${skill.name} ${skill.description} ${skill.frontmatter.keywords || ''}`.toLowerCase();
      let score = 0;

      if (!terms) {
        score = 1; // return all when no query
      } else {
        // Name parts (strong)
        const nameParts = skill.name.toLowerCase().split(/[-_]/);
        for (const part of nameParts) {
          if (part.length >= 3 && terms.includes(part)) score += 3;
        }
        // Keywords (medium)
        const keywords = (skill.frontmatter.keywords || '').toLowerCase().split(',').map(k => k.trim());
        for (const kw of keywords) {
          if (kw.length >= 3 && terms.includes(kw)) score += 2;
        }
        // Description words (weak)
        const descWords = skill.description.toLowerCase().split(/\s+/);
        for (const word of descWords) {
          if (word.length >= 4 && terms.includes(word)) score += 1;
        }
      }

      if (score > 0) scored.push({ skill, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 10).map(s => ({
      name: s.skill.name,
      description: s.skill.description,
      score: s.score
    }));
  }

  // ── Load a skill by name (tool-callable) ───────────────────────────────
  /**
   * Load a skill by name.
   * @param {string} name - Skill name
   * @returns {SkillEntry|null} Skill entry or null
   */
  function skillLoad(name) {
    const skill = getSkill(name);
    if (!skill) return null;
    return {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: skill.source
    };
  }

  // ── Clear all skills ────────────────────────────────────────────────────
  /**
   * Clear all registered skills.
   * @returns {void}
   */
  function clearSkills() {
    skills.clear();
  }

  // ── Export ─────────────────────────────────────────────────────────────
  window.AgentSkillLoader = {
    registerSkill,
    registerSkillFromUrl,
    registerSkillsFromManifest,
    getSkill,
    listSkills,
    getSkillNames,
    buildSkillContextBlock,
    matchSkills,
    skillSearch,
    skillLoad,
    clearSkills,
    // localStorage API
    saveCache,
    loadCache,
    clearCache,
    getEnabledSkills,
    setEnabledSkill,
    setEnabledSkills,
    resetEnabledSkills,
    saveCustomSkill,
    loadCustomSkills,
    deleteCustomSkill
  };
})();