// src/skills/skill-loader.js
// Skill loader: discovers, parses, and injects .md-based skills into the agent loop.
// Skills are methodology/expertise documents (not executable tools).
// They provide domain knowledge, workflows, and guidelines that the LLM follows.
//
// Publishes: window.AgentSkillLoader

(() => {
  'use strict';

  // ── Skill registry ──────────────────────────────────────────────────────
  const skills = new Map(); // name → { name, description, content, frontmatter }

  // ── YAML frontmatter parser (minimal) ────────────────────────────────────
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

  // ── Register a skill from raw markdown ───────────────────────────────────
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

  // ── Register a skill from a URL (async fetch) ────────────────────────────
  async function registerSkillFromUrl(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const markdown = await res.text();
      return registerSkill(markdown, url);
    } catch (err) {
      console.warn(`[SkillLoader] Failed to load skill from ${url}: ${err.message}`);
      return null;
    }
  }

  // ── Register skills from a manifest ──────────────────────────────────────
  async function registerSkillsFromManifest(manifestUrl) {
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = await res.json();

      const entries = manifest.skills || manifest;
      if (!Array.isArray(entries)) {
        console.warn('[SkillLoader] Manifest is not an array');
        return [];
      }

      const results = [];
      for (const entry of entries) {
        const url = typeof entry === 'string' ? entry : entry.url;
        if (!url) continue;
        const result = await registerSkillFromUrl(url);
        if (result) results.push(result);
      }
      return results;
    } catch (err) {
      console.warn(`[SkillLoader] Failed to load manifest from ${manifestUrl}: ${err.message}`);
      return [];
    }
  }

  // ── Get a skill by name ──────────────────────────────────────────────────
  function getSkill(name) {
    return skills.get(name) || null;
  }

  // ── List all registered skills ────────────────────────────────────────────
  function listSkills() {
    return Array.from(skills.values());
  }

  // ── Get skill names ──────────────────────────────────────────────────────
  function getSkillNames() {
    return Array.from(skills.keys());
  }

  // ── Build a context block for the system prompt ──────────────────────────
  function buildSkillContextBlock(enabledSkillNames = null) {
    const entries = enabledSkillNames
      ? listSkills().filter(s => enabledSkillNames.includes(s.name))
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

  // ── Match skills to a user message ───────────────────────────────────────
  function matchSkills(userMessage) {
    const msg = String(userMessage || '').toLowerCase();
    const matches = [];

    for (const skill of listSkills()) {
      const desc = (skill.description || '').toLowerCase();
      const name = skill.name.toLowerCase();
      const keywords = (skill.frontmatter.keywords || '').toLowerCase().split(',').map(k => k.trim()).filter(Boolean);

      // Match on skill name (exact or hyphenated parts)
      const nameParts = name.split(/[-_]/);
      const nameMatch = nameParts.some(part => part.length >= 3 && msg.includes(part));

      // Match on explicit keywords
      const keywordMatch = keywords.some(kw => kw.length >= 3 && msg.includes(kw));

      // Match on key phrases from description (3+ word sequences, not individual words)
      const descPhrases = desc.match(/\b[a-z]{3,}(?:\s+[a-z]{2,}){1,4}\b/gi) || [];
      const phraseMatch = descPhrases.some(phrase => phrase.length >= 8 && msg.includes(phrase.toLowerCase()));

      if (nameMatch || keywordMatch || phraseMatch) {
        matches.push(skill);
      }
    }

    // Limit to top 3 matched skills to avoid context bloat
    return matches.slice(0, 3);
  }

  // ── Clear all skills ─────────────────────────────────────────────────────
  function clearSkills() {
    skills.clear();
  }

  // ── Export ────────────────────────────────────────────────────────────────
  window.AgentSkillLoader = {
    registerSkill,
    registerSkillFromUrl,
    registerSkillsFromManifest,
    getSkill,
    listSkills,
    getSkillNames,
    buildSkillContextBlock,
    matchSkills,
    clearSkills
  };
})();