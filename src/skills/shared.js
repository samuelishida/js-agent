(() => {
  const state = {
    roots: new Map(),
    defaultRootId: null,
    uploads: new Map()
  };
  // Sync with state.js agentInstanceId via sessionStorage so the echo filter works
  // even if shared.js loads before state.js sets window.AgentSkills.
  const instanceId = (() => {
    const key = '_agent_instance_id_session';
    try {
      const stored = sessionStorage.getItem(key);
      if (stored) return stored;
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(key, id);
      return id;
    } catch {
      return Math.random().toString(36).slice(2);
    }
  })();
  const AGENT_CHANNEL = 'loopagent-v1';
  const TASKS_STORAGE_KEY = 'agent_tasks_v1';
  const TODOS_STORAGE_KEY = 'agent_todos_v1';
  let broadcastChannel = null;
  const broadcastListeners = new Map();

  const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'csv', 'log', 'yml', 'yaml']);
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
      safe: [],
      write: [],
      other: Array.isArray(tools) ? [...tools] : [],
      riskLevel: 'normal'
    }),
    getToolExecutionMeta = () => ({
      readOnly: false,
      concurrencySafe: false,
      destructive: false,
      riskLevel: 'elevated'
    }),
    canRunToolConcurrently = call => !!getToolExecutionMeta(call?.tool).concurrencySafe
  } = toolMetaCore;

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function withTimeout(promise, timeoutMs) {
    let timerId = 0;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timerId = window.setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
    } finally {
      if (timerId) window.clearTimeout(timerId);
    }
  }

  function parseJsonObjectFromText(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? String(fenced[1] || '').trim() : text;

    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;

    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  function normalizePlannerIntent(value) {
    const intent = String(value || '').trim().toLowerCase();
    const allowed = new Set(['weather', 'news', 'biography', 'filesystem', 'coding', 'fx', 'web_lookup', 'other']);
    return allowed.has(intent) ? intent : 'other';
  }

  function normalizePlannerQuery(value) {
    return String(value || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 180);
  }

  function normalizePlannerTools(list, fallbackTools = []) {
    const source = Array.isArray(list) ? list : [];
    const allowed = new Set([
      ...Object.keys(window.AgentSkills?.registry || {}),
      ...(Array.isArray(fallbackTools) ? fallbackTools : []),
      'web_search',
      'weather_current',
      'geo_current_location',
      'read_page',
      'page_metadata',
      'extract_links'
    ]);

    return [...new Set(source
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .filter(item => allowed.has(item)))];
  }

  async function planPreflightWithLlm(userMessage, preflight) {
    const text = String(userMessage || '').trim();
    if (!text) return null;

    const llm = typeof window.callLLM === 'function'
      ? window.callLLM
      : (typeof callLLM === 'function' ? callLLM : null);
    if (!llm) return null;

    const currentTools = Array.isArray(preflight?.recommendedTools)
      ? preflight.recommendedTools
      : [];
    const currentHints = Array.isArray(preflight?.hints)
      ? preflight.hints.slice(0, 6)
      : [];

    const prompt = [
      `User request: ${text}`,
      `Current recommended tools: ${currentTools.join(', ') || 'none'}`,
      `Current hints:`,
      ...currentHints.map(hint => `- ${hint}`),
      '',
      'Return only JSON with this exact schema:',
      '{',
      '  "intent": "weather|news|biography|filesystem|coding|fx|web_lookup|other",',
      '  "confidence": 0.0,',
      '  "optimized_query": "string",',
      '  "recommended_tools": ["tool_name"],',
      '  "notes": "short guidance"',
      '}',
      '',
      'Rules:',
      '- Keep optimized_query concise and search-ready.',
      '- For weather questions, include location and time words if available.',
      '- Do not suggest repeated or near-duplicate web_search calls.',
      '- If no better query exists, reuse the original intent with an empty optimized_query.'
    ].join('\n');

    try {
      const raw = await withTimeout(
        llm(
          [
            {
              role: 'system',
              content: 'You optimize intent detection and web search query quality for a tool-calling agent. Output strict JSON only.'
            },
            { role: 'user', content: prompt }
          ],
          { maxTokens: 220, temperature: 0.1, timeoutMs: 2200, retries: 0 }
        ),
        2600
      );

      const parsed = parseJsonObjectFromText(raw);
      if (!parsed || typeof parsed !== 'object') return null;

      const confidenceValue = Number(parsed.confidence);
      const confidence = Number.isFinite(confidenceValue)
        ? Math.max(0, Math.min(1, confidenceValue))
        : 0;
      const intent = normalizePlannerIntent(parsed.intent);
      const optimizedQuery = normalizePlannerQuery(parsed.optimized_query);
      const recommendedTools = normalizePlannerTools(parsed.recommended_tools, currentTools);
      const notes = String(parsed.notes || '').replace(/\s{2,}/g, ' ').trim().slice(0, 180);

      if (!optimizedQuery && !recommendedTools.length && intent === 'other') {
        return null;
      }

      return {
        intent,
        confidence,
        optimizedQuery,
        recommendedTools,
        notes
      };
    } catch {
      return null;
    }
  }

  function mergePlannerIntoPreflight(preflight, planner, userMessage) {
    if (!planner) return preflight;

    const mergedTools = [...new Set([
      ...(Array.isArray(preflight?.recommendedTools) ? preflight.recommendedTools : []),
      ...(Array.isArray(planner?.recommendedTools) ? planner.recommendedTools : [])
    ])];

    if (planner.intent === 'weather' && !mergedTools.includes('weather_current')) {
      mergedTools.unshift('weather_current');
    }

    if (planner.optimizedQuery && detectWeatherIntent(userMessage) && !mergedTools.includes('web_search')) {
      mergedTools.push('web_search');
    }

    const hints = [
      ...(Array.isArray(preflight?.hints) ? preflight.hints : []),
      `Planner intent: ${planner.intent} (confidence ${planner.confidence.toFixed(2)}).`
    ];

    if (planner.notes) {
      hints.push(`Planner note: ${planner.notes}`);
    }

    if (planner.optimizedQuery) {
      hints.push(`Planner optimized query: "${planner.optimizedQuery}". If web_search is needed, run one call with this query before trying variants.`);
    }

    hints.push('Loop guard: avoid repeated near-duplicate web_search calls in the same run.');

    return {
      ...preflight,
      recommendedTools: mergedTools,
      hints,
      classification: classifyRecommendedTools(mergedTools),
      planner
    };
  }

  function buildPreflightPlan(userMessage) {
    const plan = [];
    const hints = [];
    const text = String(userMessage || '');

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
      hints.push('Project + skills intent detected: read README and src/skills files before answering; prefer evidence-based summaries over assumptions.');
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

    if (!plan.length) {
      hints.push('No strong preflight intent detected. Use the most specific tool available.');
    }

    const recommendedTools = [...new Set(plan)];
    const classification = classifyRecommendedTools(recommendedTools);
    hints.push(`Tool classification: safe=${classification.safe.length}, write=${classification.write.length}, other=${classification.other.length}, risk=${classification.riskLevel}.`);
    if (classification.write.length) {
      hints.push(`Write-capable tools in plan: ${classification.write.join(', ')}. Require explicit user intent before destructive actions.`);
    }

    return {
      recommendedTools,
      hints,
      classification
    };
  }

  async function runDeferredPrefetches(userMessage, preflight) {
    const blocks = [];
    const tasks = [];
    const urls = extractEntities(userMessage).urls.slice(0, 1);
    const pair = detectFxPair(userMessage);

    if (pair) {
      tasks.push(async () => {
        const fx = await searchFxRate(userMessage);
        if (fx) blocks.push(fx);
      });
    }

    for (const url of urls) {
      tasks.push(async () => {
        const page = await fetchReadablePage(url);
        blocks.push(formatToolResult(`Prefetched page ${url}`, page));
      });
      tasks.push(async () => {
        const meta = await getPageMetadata({ url });
        blocks.push(meta);
      });
    }

    if (detectRecencyIntent(userMessage) && preflight?.recommendedTools?.includes('web_search')) {
      tasks.push(async () => {
        const quick = await withTimeout(searchGoogleNewsRss(userMessage), 900);
        if (quick) blocks.push(quick);
      });
    }

    const pending = tasks.map(task => (async () => {
      try {
        await withTimeout(task(), 1200);
      } catch {}
    })());

    // Do not block the first agent round for long-running prefetches.
    await Promise.race([
      Promise.allSettled(pending),
      delay(1400)
    ]);

    return blocks;
  }

  function formatToolResult(title, body) {
    return `## ${title}\n\n${body}`.trim();
  }

  function getExtension(name) {
    return String(name || '').split('.').pop().toLowerCase();
  }

  function supportsTextPreview(name) {
    return TEXT_EXTENSIONS.has(getExtension(name));
  }

  function supportsFsAccess() {
    return !!window.showDirectoryPicker;
  }

  function supportsTabMessaging() {
    return 'BroadcastChannel' in window;
  }

  function getBroadcastChannel() {
    if (!supportsTabMessaging()) {
      throw new Error('BroadcastChannel is not supported in this browser.');
    }

    if (!broadcastChannel) {
      broadcastChannel = new BroadcastChannel(AGENT_CHANNEL);
      broadcastChannel.onmessage = event => {
        const { topic, payload, from } = event.data || {};
        if (!topic || from === instanceId) return;

        const callbacks = broadcastListeners.get(String(topic)) || new Set();
        callbacks.forEach(callback => callback(payload, String(topic)));
      };
    }

    return broadcastChannel;
  }

  function assertFsAccess() {
    if (!supportsFsAccess()) {
      throw new Error('File System Access API is not supported in this browser.');
    }
  }

  function missingWebRuntime(name) {
    return async () => {
      throw new Error(`Web runtime unavailable: ${name}`);
    };
  }

  const webModuleFactory = window.AgentSkillModules?.createWebRuntime;
  const webRuntime = typeof webModuleFactory === 'function'
    ? webModuleFactory({
        formatToolResult,
        detectFxPair,
        detectWeatherIntent,
        detectRecencyIntent,
        detectCodingIntent,
        detectBiographicalFactIntent
      })
    : {};

  const runSearchSkills = webRuntime.runSearchSkills || missingWebRuntime('runSearchSkills');
  const searchFxRate = webRuntime.searchFxRate || missingWebRuntime('searchFxRate');
  const searchGoogleNewsRss = webRuntime.searchGoogleNewsRss || missingWebRuntime('searchGoogleNewsRss');
  const fetchReadablePage = webRuntime.fetchReadablePage || missingWebRuntime('fetchReadablePage');
  const fetchHttpResource = webRuntime.fetchHttpResource || missingWebRuntime('fetchHttpResource');
  const extractLinks = webRuntime.extractLinks || missingWebRuntime('extractLinks');
  const getPageMetadata = webRuntime.getPageMetadata || missingWebRuntime('getPageMetadata');
  const getCurrentLocation = webRuntime.getCurrentLocation || missingWebRuntime('getCurrentLocation');
  const getCurrentWeather = webRuntime.getCurrentWeather || missingWebRuntime('getCurrentWeather');

  function stripAgentTags(text) {
    return String(text || '')
      .replace(/<tool_result[\s\S]*?<\/tool_result>/gi, ' ')
      .replace(/<initial_context>[\s\S]*?<\/initial_context>/gi, ' ')
      .replace(/<execution_steering>[\s\S]*?<\/execution_steering>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function deriveWebSearchQuery(query, context = {}) {
    const direct = String(query || '').trim();
    if (direct) return direct;

    const history = Array.isArray(context?.messages) ? context.messages : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i];
      if (message?.role !== 'user') continue;
      const candidate = stripAgentTags(message.content);
      if (candidate) return candidate.slice(0, 240);
    }

    return '';
  }

  function sanitizePathCandidate(candidate) {
    return String(candidate || '')
      .trim()
      .replace(/^['"`]+|['"`]+$/g, '')
      .replace(/[),.;:!?]+$/g, '')
      .trim();
  }

  function extractPathCandidates(text) {
    const value = String(text || '');
    if (!value) return [];

    const slashPattern = /(?:[A-Za-z]:\\[^\s"'`<>|]+|(?:\.{1,2}\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g;
    const filenamePattern = /\b[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}\b/g;
    const folderHintPattern = /\b(?:Agent|src|prompts|docs|assets|proxy|progress)\b/g;

    const matches = [
      ...(value.match(slashPattern) || []),
      ...(value.match(filenamePattern) || []),
      ...(value.match(folderHintPattern) || [])
    ];

    return [...new Set(matches
      .map(sanitizePathCandidate)
      .filter(Boolean)
      .filter(item => !/^https?:\/\//i.test(item)))];
  }

  function normalizeFilesystemArgs(args = {}) {
    const next = { ...args };
    const root = String(next.root || '').trim();
    const path = String(next.path || next.filePath || '').trim();

    if (!path && root) {
      next.path = root;
      return next;
    }

    if (path && root) {
      const normalizedPath = path.replace(/\\/g, '/');
      const normalizedRoot = root.replace(/\\/g, '/');
      const hasAbsolutePrefix = /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith('/');
      const alreadyScoped = normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`) || normalizedPath.toLowerCase() === normalizedRoot.toLowerCase();

      if (!hasAbsolutePrefix && !alreadyScoped) {
        next.path = `${root}/${path}`.replace(/\/+/g, '/');
        return next;
      }

      next.path = path;
      return next;
    }

    if (path) {
      next.path = path;
    }

    return next;
  }

  function deriveFilesystemPathArg(args = {}, context = {}, toolName = 'fs_tool') {
    const normalized = normalizeFilesystemArgs(args);
    const existing = String(normalized?.path || '').trim();
    if (existing) return { ...normalized, path: existing };

    const history = Array.isArray(context?.messages) ? context.messages : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i];
      if (message?.role !== 'user') continue;
      const text = stripAgentTags(message.content);
      const candidates = extractPathCandidates(text);
      if (!candidates.length) continue;

      const path = candidates[0];
      console.debug(`${toolName}: recovered missing path from context`, path);
      return { ...normalized, path };
    }

    return { ...normalized };
  }

  function missingDataRuntime(name) {
    return async () => {
      throw new Error(`Data runtime unavailable: ${name}`);
    };
  }

  const dataModuleFactory = window.AgentSkillModules?.createDataRuntime;
  const dataRuntime = typeof dataModuleFactory === 'function'
    ? dataModuleFactory({
        formatToolResult,
        TODOS_STORAGE_KEY,
        TASKS_STORAGE_KEY
      })
    : {};

  const parseJsonText = dataRuntime.parseJsonText || missingDataRuntime('parseJsonText');
  const parseCsvText = dataRuntime.parseCsvText || missingDataRuntime('parseCsvText');
  const clipboardRead = dataRuntime.clipboardRead || missingDataRuntime('clipboardRead');
  const clipboardWrite = dataRuntime.clipboardWrite || missingDataRuntime('clipboardWrite');
  const listStorageKeys = dataRuntime.listStorageKeys || missingDataRuntime('listStorageKeys');
  const storageGet = dataRuntime.storageGet || missingDataRuntime('storageGet');
  const storageSet = dataRuntime.storageSet || missingDataRuntime('storageSet');
  const todoWrite = dataRuntime.todoWrite || missingDataRuntime('todoWrite');
  const taskCreate = dataRuntime.taskCreate || missingDataRuntime('taskCreate');
  const taskGet = dataRuntime.taskGet || missingDataRuntime('taskGet');
  const taskList = dataRuntime.taskList || missingDataRuntime('taskList');
  const taskUpdate = dataRuntime.taskUpdate || missingDataRuntime('taskUpdate');
  const askUserQuestion = dataRuntime.askUserQuestion || missingDataRuntime('askUserQuestion');

  let notificationPermissionState = ('Notification' in window && window.Notification?.permission) || 'unsupported';

  function notificationsSupported() {
    return 'Notification' in window;
  }

  async function ensureNotificationPermission() {
    if (!notificationsSupported()) {
      throw new Error('Notifications are not supported in this browser.');
    }

    notificationPermissionState = window.Notification.permission;
    if (notificationPermissionState === 'granted') return true;
    if (notificationPermissionState === 'denied') {
      throw new Error('Notification permission was denied. Reset it in browser settings to enable alerts.');
    }

    notificationPermissionState = await window.Notification.requestPermission();
    if (notificationPermissionState !== 'granted') {
      throw new Error('Notification permission was not granted.');
    }

    return true;
  }

  async function requestNotificationPermission() {
    if (!notificationsSupported()) {
      return formatToolResult('notification_request_permission', 'Notifications not supported in this browser.');
    }

    notificationPermissionState = await window.Notification.requestPermission();
    return formatToolResult('notification_request_permission', `Permission: ${notificationPermissionState}`);
  }

  async function sendNotification({ title, body, tag, silent }) {
    await ensureNotificationPermission();

    const safeTitle = String(title || 'JS Agent').slice(0, 64);
    const safeBody = String(body || '').slice(0, 200);
    new window.Notification(safeTitle, {
      body: safeBody,
      tag: String(tag || 'agent-notification'),
      silent: silent === true
    });

    return formatToolResult('notification_send', `Notification sent: "${safeTitle}"`);
  }


  // Tracks all active tab_listen abort functions so the agent loop can cancel them on stop.
  const activeTabListeners = new Set();

  function abortAllTabListeners(reason = 'Agent run stopped.') {
    for (const abort of [...activeTabListeners]) {
      try { abort(reason); } catch {}
    }
    activeTabListeners.clear();
  }

  // Clean up on page unload to avoid memory leaks.
  window.addEventListener('beforeunload', () => abortAllTabListeners('Page unloaded.'), { once: true });

  async function tabBroadcast({ topic, payload }) {
    if (!topic) {
      throw new Error('tab_broadcast: topic is required.');
    }

    // Validate payload is structured-cloneable before postMessage.
    let safePayload = null;
    if (payload !== undefined && payload !== null) {
      try {
        safePayload = JSON.parse(JSON.stringify(payload));
      } catch {
        throw new Error('tab_broadcast: payload must be JSON-serializable.');
      }
    }

    const channel = getBroadcastChannel();
    channel.postMessage({
      topic: String(topic),
      payload: safePayload,
      from: instanceId,
      timestamp: new Date().toISOString()
    });

    return formatToolResult('tab_broadcast', `Broadcast sent on topic "${String(topic)}".`);
  }

  async function tabListen({ topic, timeout_ms }) {
    if (!topic) {
      throw new Error('tab_listen: topic is required.');
    }

    const waitMs = Math.max(1, Number(timeout_ms) || 15000);
    const normalizedTopic = String(topic);
    getBroadcastChannel();

    if (!broadcastListeners.has(normalizedTopic)) {
      broadcastListeners.set(normalizedTopic, new Set());
    }

    const callbacks = broadcastListeners.get(normalizedTopic);

    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error(`tab_listen: no message on "${normalizedTopic}" within ${waitMs}ms.`));
      }, waitMs);

      function cleanup() {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        callbacks.delete(onMessage);
        activeTabListeners.delete(abortFn);
      }

      function onMessage(payload) {
        cleanup();
        resolve(formatToolResult(
          'tab_listen',
          `Topic: ${normalizedTopic}\nPayload: ${JSON.stringify(payload ?? null, null, 2).slice(0, 2000)}`
        ));
      }

      function abortFn(reason) {
        cleanup();
        reject(new Error(`tab_listen aborted: ${reason}`));
      }

      callbacks.add(onMessage);
      activeTabListeners.add(abortFn);
    });
  }

  async function buildInitialContext(userMessage) {
    const blocks = [];
    const baselinePreflight = buildPreflightPlan(userMessage);
    let preflight = baselinePreflight;

    try {
      const planner = await planPreflightWithLlm(userMessage, baselinePreflight);
      preflight = mergePlannerIntoPreflight(baselinePreflight, planner, userMessage);
    } catch {}

    blocks.push(formatToolResult(
      'preflight',
      `Recommended tools: ${preflight.recommendedTools.join(', ') || 'none'}\nRisk level: ${preflight.classification?.riskLevel || 'normal'}\n${preflight.hints.join('\n')}`
    ));

    if (preflight?.planner?.optimizedQuery) {
      blocks.push(formatToolResult(
        'query_plan',
        `intent=${preflight.planner.intent}\nquery=${preflight.planner.optimizedQuery}\nconfidence=${preflight.planner.confidence.toFixed(2)}`
      ));
    }

    try {
      const prefetchedBlocks = await runDeferredPrefetches(userMessage, preflight);
      blocks.push(...prefetchedBlocks);
    } catch {}

    return blocks.length ? `<initial_context>\n${blocks.join('\n\n')}\n</initial_context>\n\n${userMessage}` : userMessage;
  }

  function missingFsRuntime(name) {
    return async () => {
      throw new Error(`Filesystem runtime unavailable: ${name}`);
    };
  }

  const fsModuleFactory = window.AgentSkillModules?.createFilesystemRuntime;
  const fsRuntime = typeof fsModuleFactory === 'function'
    ? fsModuleFactory({
        state,
        formatToolResult,
        supportsFsAccess,
        supportsTextPreview
      })
    : {};

  const authorizeFolder = fsRuntime.authorizeFolder || missingFsRuntime('authorizeFolder');
  const listDirectory = fsRuntime.listDirectory || missingFsRuntime('listDirectory');
  const readLocalFile = fsRuntime.readLocalFile || missingFsRuntime('readLocalFile');
  const pickUpload = fsRuntime.pickUpload || missingFsRuntime('pickUpload');
  const downloadFile = fsRuntime.downloadFile || missingFsRuntime('downloadFile');
  const previewFile = fsRuntime.previewFile || missingFsRuntime('previewFile');
  const searchByName = fsRuntime.searchByName || missingFsRuntime('searchByName');
  const searchByContent = fsRuntime.searchByContent || missingFsRuntime('searchByContent');
  const globPaths = fsRuntime.globPaths || missingFsRuntime('globPaths');
  const grepPaths = fsRuntime.grepPaths || missingFsRuntime('grepPaths');
  const editLocalFile = fsRuntime.editLocalFile || missingFsRuntime('editLocalFile');
  const writeTextFile = fsRuntime.writeTextFile || missingFsRuntime('writeTextFile');
  const copyFile = fsRuntime.copyFile || missingFsRuntime('copyFile');
  const deletePath = fsRuntime.deletePath || missingFsRuntime('deletePath');
  const moveFile = fsRuntime.moveFile || missingFsRuntime('moveFile');
  const renamePath = fsRuntime.renamePath || missingFsRuntime('renamePath');
  const listRoots = fsRuntime.listRoots || missingFsRuntime('listRoots');
  const fileExists = fsRuntime.fileExists || missingFsRuntime('fileExists');
  const statPath = fsRuntime.statPath || missingFsRuntime('statPath');
  const makeDirectory = fsRuntime.makeDirectory || missingFsRuntime('makeDirectory');
  const touchFile = fsRuntime.touchFile || missingFsRuntime('touchFile');
  const directoryTree = fsRuntime.directoryTree || missingFsRuntime('directoryTree');
  const walkPaths = fsRuntime.walkPaths || missingFsRuntime('walkPaths');
  const savePickedUpload = fsRuntime.savePickedUpload || missingFsRuntime('savePickedUpload');
  const pickDirectory = fsRuntime.pickDirectory || missingFsRuntime('pickDirectory');

  async function toolSearch({ query = '', limit = 30 }) {
    const terms = String(query || '').toLowerCase().trim();
    const max = Math.max(1, Math.min(200, Number(limit) || 30));
    const entries = Object.values(registry || {});
    const matches = entries.filter(item => {
      if (!terms) return true;
      const hay = `${item.name || ''} ${item.description || ''}`.toLowerCase();
      return hay.includes(terms);
    }).slice(0, max);

    return formatToolResult(
      'tool_search',
      matches.length
        ? matches.map((item, index) => `${index + 1}. ${item.name} — ${item.description || 'no description'}`).join('\n')
        : '(no matching tools)'
    );
  }

  const registryModuleFactory = window.AgentSkillModules?.createRegistryRuntime;
  const registryRuntime = typeof registryModuleFactory === 'function'
    ? registryModuleFactory({
        web_search: (args = {}, context = {}) => {
          const recoveredQuery = deriveWebSearchQuery(args?.query, context);
          return runSearchSkills(recoveredQuery);
        },
        web_fetch: args => fetchHttpResource(args),
        read_page: ({ url }) => fetchReadablePage(url).then(text => formatToolResult(`read_page ${url}`, text)),
        http_fetch: args => fetchHttpResource(args),
        extract_links: args => extractLinks(args),
        page_metadata: args => getPageMetadata(args),
        geo_current_location: () => getCurrentLocation(),
        weather_current: args => getCurrentWeather(args),
        clipboard_read: () => clipboardRead(),
        clipboard_write: args => clipboardWrite(args),
        storage_list_keys: () => listStorageKeys(),
        storage_get: args => storageGet(args),
        storage_set: args => storageSet(args),
        notification_request_permission: () => requestNotificationPermission(),
        notification_send: args => sendNotification(args),
        tab_broadcast: args => tabBroadcast(args),
        tab_listen: args => tabListen(args),
        fs_list_roots: () => listRoots(),
        fs_authorize_folder: () => authorizeFolder(),
        fs_pick_directory: () => pickDirectory(),
        fs_list_dir: (args, context = {}) => listDirectory(deriveFilesystemPathArg(args, context, 'fs_list_dir')),
        fs_tree: args => directoryTree(args),
        fs_walk: (args, context = {}) => walkPaths(deriveFilesystemPathArg(args, context, 'fs_walk')),
        fs_exists: args => fileExists(args),
        fs_stat: args => statPath(args),
        fs_read_file: (args, context = {}) => readLocalFile(deriveFilesystemPathArg(args, context, 'fs_read_file')),
        fs_preview_file: (args, context = {}) => previewFile(deriveFilesystemPathArg(args, context, 'fs_preview_file')),
        fs_search_name: (args, context = {}) => searchByName(deriveFilesystemPathArg(args, context, 'fs_search_name')),
        fs_search_content: (args, context = {}) => searchByContent(deriveFilesystemPathArg(args, context, 'fs_search_content')),
        fs_glob: args => globPaths(args),
        fs_grep: args => grepPaths(args),
        fs_upload_pick: () => pickUpload(),
        fs_save_upload: args => savePickedUpload(args),
        fs_download_file: args => downloadFile(args),
        fs_mkdir: args => makeDirectory(args),
        fs_touch: args => touchFile(args),
        fs_write_file: args => writeTextFile(args),
        fs_copy_file: args => copyFile(args),
        fs_move_file: args => moveFile(args),
        fs_delete_path: args => deletePath(args),
        fs_rename_path: args => renamePath(args),
        file_read: (args, context = {}) => readLocalFile(deriveFilesystemPathArg(args, context, 'file_read')),
        read_file: (args, context = {}) => readLocalFile(deriveFilesystemPathArg(args, context, 'read_file')),
        file_write: args => writeTextFile(args),
        write_file: args => writeTextFile(args),
        file_edit: args => editLocalFile(args),
        edit_file: args => editLocalFile(args),
        glob: args => globPaths(args),
        grep: args => grepPaths(args),
        parse_json: args => parseJsonText(args),
        parse_csv: args => parseCsvText(args),
        todo_write: args => todoWrite(args),
        task_create: args => taskCreate(args),
        task_get: args => taskGet(args),
        task_list: args => taskList(args),
        task_update: args => taskUpdate(args),
        ask_user_question: args => askUserQuestion(args),
        tool_search: args => toolSearch(args)
      })
    : {
        registry: {},
        skillGroups: {}
      };

  const registry = registryRuntime.registry || {};
  const skillGroups = registryRuntime.skillGroups || {};

  window.AgentSkills = {
    state,
    registry,
    skillGroups,
    instanceId,
    extractEntities,
    detectFxPair,
    formatToolResult,
    buildPreflightPlan,
    runSearchSkills,
    fetchReadablePage,
    getToolExecutionMeta,
    canRunToolConcurrently,
    buildInitialContext,
    abortAllTabListeners
  };
})();

