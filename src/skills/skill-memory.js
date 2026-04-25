// src/skills/skill-memory.js
// Runtime memory: scoped read/write, context block building, memory tool wrappers.
// Publishes: window.AgentSkillMemory

(() => {
  'use strict';

  const RUNTIME_MEMORY_GLOBAL_KEY = 'runtime_memory_global_v1';
  const RUNTIME_MEMORY_PROJECT_PREFIX = 'runtime_memory_project_v1';

  function formatToolResult(title, body) {
    return `## ${title}\n\n${body}`.trim();
  }

  function getRuntimeProjectMemoryKey() {
    const state = window.AgentSkills?.state;
    const rootId = String(state?.defaultRootId || 'default').trim().toLowerCase();
    return `${RUNTIME_MEMORY_PROJECT_PREFIX}:${rootId || 'default'}`;
  }

  function readRuntimeScopedMemory(scope = 'all') {
    const globalMemory = String(localStorage.getItem(RUNTIME_MEMORY_GLOBAL_KEY) || '').trim();
    const projectMemory = String(localStorage.getItem(getRuntimeProjectMemoryKey()) || '').trim();

    if (scope === 'global') return globalMemory;
    if (scope === 'project') return projectMemory;

    return [
      globalMemory ? `## Global Memory\n${globalMemory}` : '',
      projectMemory ? `## Project Memory\n${projectMemory}` : ''
    ].filter(Boolean).join('\n\n');
  }

  function writeRuntimeScopedMemory({ topic = '', content = '', scope = 'global', replace = false } = {}) {
    const targetKey = scope === 'project' ? getRuntimeProjectMemoryKey() : RUNTIME_MEMORY_GLOBAL_KEY;
    const trimmedContent = String(content || '').trim();
    if (!trimmedContent) throw new Error('memory_write requires content.');

    const heading = String(topic || 'memory').trim();
    const block = heading ? `## ${heading}\n${trimmedContent}` : trimmedContent;
    const existing = String(localStorage.getItem(targetKey) || '').trim();
    const next = replace || !existing ? block : `${existing}\n\n${block}`.trim();
    localStorage.setItem(targetKey, next);
    return next;
  }

  function buildRuntimeContextBlock() {
    const globalMemory = readRuntimeScopedMemory('global');
    const projectMemory = readRuntimeScopedMemory('project');
    const state = window.AgentSkills?.state;
    const rootSummary = state?.defaultRootId
      ? `Authorized workspace root: ${state.defaultRootId}`
      : 'No workspace root authorized yet.';

    const sections = [
      rootSummary,
      globalMemory ? `## Global Memory\n${globalMemory}` : '',
      projectMemory ? `## Project Memory\n${projectMemory}` : ''
    ].filter(Boolean);

    return sections.length ? `<runtime_context>\n${sections.join('\n\n')}\n</runtime_context>` : '';
  }

  async function memoryWrite({ text = '', tags = [], importance = 0.5 } = {}) {
    const result = window.AgentMemory?.write?.({ text, tags, importance, source: 'tool' });
    if (!result?.saved) throw new Error(`memory_write failed: ${result?.reason || 'unknown reason'}`);
    return formatToolResult('memory_write', result.duplicate ? `Updated existing memory.\nText: ${result.entry.text}` : `Saved memory.\nText: ${result.entry.text}`);
  }

  async function memorySearch({ query = '', limit = 8 } = {}) {
    const entries = window.AgentMemory?.search?.({ query, limit }) || [];
    return formatToolResult('memory_search', window.AgentMemory?.formatList?.(entries) || '(no memories)');
  }

  async function memoryList({ limit = 30 } = {}) {
    const entries = window.AgentMemory?.list?.({ limit }) || [];
    return formatToolResult('memory_list', window.AgentMemory?.formatList?.(entries) || '(no memories)');
  }

  async function runtimeMemoryRead({ scope = 'all' } = {}) {
    const normalizedScope = ['all', 'global', 'project'].includes(String(scope || '').trim()) ? String(scope || 'all').trim() : 'all';
    const text = readRuntimeScopedMemory(normalizedScope);
    return formatToolResult('memory_read', text || '(no memory stored)');
  }

  async function runtimeMemoryWrite({ topic = '', content = '', replace = false, scope = 'global' } = {}) {
    const normalizedScope = String(scope || 'global').trim() === 'project' ? 'project' : 'global';
    const stored = writeRuntimeScopedMemory({ topic, content, replace, scope: normalizedScope });

    if (normalizedScope === 'global') {
      try {
        window.AgentMemory?.write?.({ text: `${topic ? `${topic}: ` : ''}${String(content || '').trim()}`, tags: ['compat', normalizedScope], source: 'tool', importance: 0.7 });
      } catch {}
    }

    return formatToolResult('memory_write', `Saved ${normalizedScope} memory.${stored ? `\n\n${stored.slice(0, 4000)}` : ''}`);
  }

  window.AgentSkillMemory = {
    formatToolResult,
    getRuntimeProjectMemoryKey,
    readRuntimeScopedMemory,
    writeRuntimeScopedMemory,
    buildRuntimeContextBlock,
    memoryWrite,
    memorySearch,
    memoryList,
    runtimeMemoryRead,
    runtimeMemoryWrite
  };
})();