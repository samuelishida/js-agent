// src/skills/skill-preflight.js
// Intent detection, preflight planning, deferred prefetches, initial context assembly.
// Reads from window.AgentSkillCore, window.AgentSkillPlanner, window.AgentSkillBroadcast,
// window.AgentSkillMemory, window.AgentSkillExecutor.
// Publishes: window.AgentSkillPreflight

(() => {
  'use strict';

  const skillCore = window.AgentSkillCore || {};
  const intentCore = skillCore.intents || {};
  const toolMetaCore = skillCore.toolMeta || {};

  const {
    extractEntities = () => ({ urls: [], currencies: [] }),
    detectFxPair = () => null,
    detectWeatherIntent = () => false,
    detectFilesystemIntent = () => false,
    detectAuthorizeFolderIntent = () => false,
    detectFullFileDisplayIntent = () => false,
    detectProjectSkillsIntent = () => false,
    detectSaveIntent = () => false,
    detectClipboardIntent = () => false,
    detectParsingIntent = () => false,
    detectTabCoordinationIntent = () => false,
    detectRecencyIntent = () => false,
    detectCodingIntent = () => false,
    detectBiographicalFactIntent = () => false
  } = intentCore;

  const {
    classifyRecommendedTools = tools => ({
      safe: [], write: [], other: Array.isArray(tools) ? [...tools] : [], riskLevel: 'normal'
    })
  } = toolMetaCore;

  // Shared state — will be set by shared.js during initialization
  let _state = null;
  function getState() {
    if (!_state) _state = window.AgentSkills?.state || { roots: new Map(), defaultRootId: null, uploads: new Map() };
    return _state;
  }

  function isFollowUpContinuation(text) {
    const value = String(text || '').trim().toLowerCase();
    if (!value) return false;
    return /^(and|also|ok|okay|yes|no|continue|go on|keep going|more|details|deeper|dive deeper|expand|elaborate|why|how|what about)/i.test(value)
      || /(dive deeper|go deeper|expand on|elaborate|more detail|continue this|that part|this part|follow up|follow-up)/i.test(value);
  }

  function getRecentConversationSignals(conversationMessages = []) {
    const history = Array.isArray(conversationMessages)
      ? conversationMessages.filter(item => item && item.role !== 'system')
      : [];
    const recent = history.slice(-12);
    const joined = recent.map(item => String(item.content || '')).join('\n');

    const hasFilesystemEvidence = /<tool_result\s+tool="fs_(list_dir|walk|read_file|search_name|search_content|tree|glob|grep|stat|exists)"/i.test(joined);
    const hasProjectTerms = /(src\/|readme|orchestrator\.js|shared\.js|skills|codebase|repository|agentic loop|tool call|max_rounds|context manager|preflight)/i.test(joined);
    const hasWebEvidence = /<tool_result\s+tool="web_search"/i.test(joined);

    return { hasFilesystemEvidence, hasProjectTerms, hasWebEvidence };
  }

  function buildPreflightPlan(userMessage, conversationMessages = []) {
    const plan = [];
    const hints = [];
    const text = String(userMessage || '');
    const followUpContinuation = isFollowUpContinuation(text);
    const recentSignals = getRecentConversationSignals(conversationMessages);

    const continuationLooksProjectScoped = followUpContinuation
      && (recentSignals.hasFilesystemEvidence || recentSignals.hasProjectTerms)
      && !recentSignals.hasWebEvidence;

    if (continuationLooksProjectScoped) {
      plan.push('fs_list_dir', 'fs_walk', 'fs_read_file', 'fs_search_content');
      hints.push('Follow-up continuation detected from recent project/filesystem context: keep analysis grounded in local repository tools before external web lookup.');
    }

    if (/(agentic loop|agent loop|orchestrator loop|tool loop|max_rounds|tool_result|context manager)/i.test(text)) {
      plan.push('fs_search_content', 'fs_read_file');
      hints.push('Agent loop/runtime topic detected: inspect local orchestrator and runtime files first (for example src/app/agent.js and src/core/orchestrator.js).');
    }

    if (detectWeatherIntent(text)) {
      plan.push('weather_current');
      hints.push('Weather intent detected: prefer weather_current, fallback to geo_current_location if coordinates are needed.');
    }

    const pair = detectFxPair(text);
    if (pair) {
      plan.push('web_search');
      hints.push(`FX intent detected: ${pair.base}/${pair.quote}. Prefer a direct rate lookup before generic search.`);
    }

    if (extractEntities(text).urls.length) {
      plan.push('read_page', 'page_metadata', 'extract_links');
      hints.push('URL detected: prefer page tools before generic search.');
    }

    if (detectFilesystemIntent(text)) {
      plan.push('fs_list_roots', 'fs_authorize_folder', 'fs_list_dir', 'fs_walk', 'fs_read_file', 'fs_search_name', 'fs_search_content');
      hints.push('Filesystem intent detected: explore before mutating unless the user explicitly asked to save/export a file.');
      hints.push('Use fs_list_dir first, then scoped fs_walk(path, maxDepth, maxResults) with includeDirectories=true and includeFiles=false for structure-first discovery.');
      hints.push('For broad scans, set exclude_names (for example .git,node_modules,dist,build) unless the user explicitly asks to inspect those folders.');
      const state = getState();
      if (!state.roots.size) {
        hints.push('No local folder is authorized yet. Ask the user to click the "Authorize Folder" button in the Files panel before trying direct file access.');
      } else {
        const roots = [...state.roots.keys()];
        hints.push(`Authorized local roots are already available: ${roots.join(', ')}. Prefer using those roots instead of asking for access again.`);
      }
    }

    if (detectAuthorizeFolderIntent(text)) {
      plan.push('fs_list_roots', 'fs_authorize_folder');
      hints.push('Folder authorization intent detected: explain that the user must click "Authorize Folder" in the Files panel due browser gesture requirements.');
    }

    if (detectProjectSkillsIntent(text)) {
      plan.push('fs_walk', 'fs_list_dir', 'fs_read_file');
      hints.push('Project + skills intent detected: start with fs_list_dir on the project root, then run a bounded fs_walk with directory-first settings and excluded heavy folders.');
      hints.push('Read README and src/skills files before answering; prefer evidence-based summaries over assumptions.');
    }

    if (detectFullFileDisplayIntent(text)) {
      plan.push('fs_read_file');
      hints.push('Full-file display intent detected: use fs_read_file directly and preserve source text; avoid paraphrasing.');
      hints.push('If the file exceeds one response, read in chunks with fs_read_file(path, offset, length) and continue until has_more is false.');
    }

    if (detectSaveIntent(text)) {
      plan.push('fs_write_file', 'fs_download_file');
      hints.push('Save/export intent detected: prefer fs_write_file first; if direct filesystem access is unavailable, use fs_download_file.');
    }

    if (detectClipboardIntent(text)) {
      plan.push('clipboard_read', 'clipboard_write');
      hints.push('Clipboard intent detected.');
    }

    if (detectParsingIntent(text)) {
      plan.push('parse_json', 'parse_csv', 'extract_links', 'page_metadata');
      hints.push('Parsing/extraction intent detected.');
    }

    if (detectTabCoordinationIntent(text)) {
      plan.push('tab_broadcast', 'tab_listen');
      hints.push('Multi-tab coordination intent detected: use tab_broadcast to publish results and tab_listen to wait for another tab.');
    }

    if (/(multi\s*-?agent|sub\s*-?agent|workers?|parallel(?:ize|\s+run)?|delegat(?:e|ion)|batch\s+workers?)/i.test(text)) {
      plan.push('worker_batch', 'worker_list', 'worker_get');
      hints.push('Parallel worker intent detected: use worker_batch for bounded concurrent worker prompts, then inspect outcomes via worker_list/worker_get.');
    }

    if (!plan.length) {
      hints.push('No strong preflight intent detected. Use the most specific tool available.');
    }

    const recommendedTools = [...new Set(plan)];
    const classification = classifyRecommendedTools(recommendedTools);
    hints.push(`Tool classification: safe=${classification.safe.length}, write=${classification.write.length}, other=${classification.other.length}, risk=${classification.riskLevel}.`);
    if (classification.write.length) {
      hints.push(`Write-capable tools in plan: ${classification.write.join(', ')}. Require explicit user intent before destructive actions.`);
    }

    return { recommendedTools, hints, classification };
  }

  async function runDeferredPrefetches(userMessage, preflight) {
    const blocks = [];
    const tasks = [];
    const urls = extractEntities(userMessage).urls.slice(0, 1);
    const pair = detectFxPair(userMessage);

    const Executor = window.AgentSkillExecutor;
    const Planner = window.AgentSkillPlanner;

    if (pair && Executor?.searchFxRate) {
      tasks.push(async () => {
        const fx = await Executor.searchFxRate(userMessage);
        if (fx) blocks.push(fx);
      });
    }

    for (const url of urls) {
      if (Executor?.fetchReadablePage) {
        tasks.push(async () => {
          const page = await Executor.fetchReadablePage(url);
          blocks.push(Executor.formatToolResult(`Prefetched page ${url}`, page));
        });
      }
      if (Executor?.getPageMetadata) {
        tasks.push(async () => {
          const meta = await Executor.getPageMetadata({ url });
          blocks.push(meta);
        });
      }
    }

    const pending = tasks.map(task => (async () => {
      try { await task(); } catch {}
    })());

    await Promise.race([Promise.allSettled(pending), new Promise(r => setTimeout(r, 1400))]);
    return blocks;
  }

  async function buildInitialContext(userMessage, context = {}) {
    const blocks = [];
    const Memory = window.AgentSkillMemory;
    const Planner = window.AgentSkillPlanner;
    const Executor = window.AgentSkillExecutor;
    const Broadcast = window.AgentSkillBroadcast;

    const compatContext = Memory?.buildRuntimeContextBlock?.() || '';
    if (compatContext) blocks.push(compatContext);

    const baselinePreflight = buildPreflightPlan(userMessage, context?.messages || []);
    let preflight = baselinePreflight;

    try {
      const planner = await Planner?.planPreflightWithLlm?.(userMessage, baselinePreflight);
      preflight = Planner?.mergePlannerIntoPreflight?.(baselinePreflight, planner, userMessage) || baselinePreflight;
    } catch {}

    blocks.push(Executor?.formatToolResult?.('preflight',
      `Recommended tools: ${preflight.recommendedTools.join(', ') || 'none'}\nRisk level: ${preflight.classification?.riskLevel || 'normal'}\n${preflight.hints.join('\n')}`
    ) || `## preflight\n\nRecommended tools: ${preflight.recommendedTools.join(', ') || 'none'}`);

    if (preflight?.planner?.optimizedQuery) {
      blocks.push(Executor?.formatToolResult?.('query_plan',
        `intent=${preflight.planner.intent}\nquery=${preflight.planner.optimizedQuery}\nconfidence=${preflight.planner.confidence.toFixed(2)}`
      ) || `## query_plan\n\nintent=${preflight.planner.intent}`);
    }

    try {
      const prefetchedBlocks = await runDeferredPrefetches(userMessage, preflight);
      blocks.push(...prefetchedBlocks);
    } catch {}

    return blocks.length ? `<initial_context>\n${blocks.join('\n\n')}\n</initial_context>\n\n${userMessage}` : userMessage;
  }

  window.AgentSkillPreflight = {
    isFollowUpContinuation,
    getRecentConversationSignals,
    buildPreflightPlan,
    runDeferredPrefetches,
    buildInitialContext
  };
})();