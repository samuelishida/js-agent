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

  function stripHtmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, noscript, svg, canvas').forEach(el => el.remove());
    const contentRoot = doc.querySelector('main, article, [role="main"], .content, #content') || doc.body;
    return (contentRoot?.innerText || doc.body?.innerText || '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  /** Check if request will trigger CORS preflight (OPTIONS request) */
  function willTriggerPreflight(init = {}) {
    // Preflight is triggered by:
    // 1. Custom headers (except simple headers)
    // 2. Non-simple methods (anything other than GET, HEAD, POST)
    // 3. Content-Type other than application/x-www-form-urlencoded, multipart/form-data, text/plain

    const method = (init.method || 'GET').toUpperCase();
    const isSimpleMethod = ['GET', 'HEAD', 'POST'].includes(method);
    
    if (!isSimpleMethod) return true;

    const headers = init.headers || {};
    const simpleHeaders = ['accept', 'accept-language', 'content-language', 'content-type'];
    
    for (const header of Object.keys(headers)) {
      const lower = header.toLowerCase();
      if (!simpleHeaders.includes(lower)) return true;
    }

    const contentType = headers['Content-Type'] || headers['content-type'] || '';
    if (contentType && ![
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'text/plain'
    ].includes(contentType)) {
      return true;
    }

    return false;
  }

  /** Create preflight-safe headers for simple requests */
  function makePreflightSafeHeaders(headers = {}) {
    // Remove custom headers that trigger preflight
    // Keep only simple headers
    const safe = {};
    const simpleHeaders = ['accept', 'accept-language', 'content-language', 'content-type'];
    
    for (const [key, value] of Object.entries(headers)) {
      if (simpleHeaders.includes(key.toLowerCase())) {
        safe[key] = value;
      }
    }
    
    return safe;
  }

  async function fetchJsonWithTimeout(url, timeoutMs = 6000, init = {}) {
    // Try without preflight-triggering headers first
    let headers = init.headers || {};
    let hasCustomHeaders = willTriggerPreflight(init);
    
    if (hasCustomHeaders) {
      // First attempt: Use preflight-safe headers
      const safeHeaders = makePreflightSafeHeaders(headers);
      console.debug(`Preflight detected: Retrying with safe headers`);
      try {
        const res = await window.fetchWithTimeout(url, { cache: 'no-store', ...init, headers: safeHeaders }, timeoutMs);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      } catch (e) {
        console.debug(`Safe headers attempt failed: ${e.message}, retrying with original headers`);
      }
    }

    // Fallback: Use original headers
    const res = await window.fetchWithTimeout(url, { cache: 'no-store', ...init }, timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function normalizeSearchQuery(query) {
    return String(query || '')
      .replace(/[+]/g, ' ')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\b(pesquise|pesquisa|procure|buscar|busque|me diga|me fale|quero saber|sobre)\b/g, ' ')
      .replace(/\b(quando o|quando a|quando)\b/g, ' ')
      .replace(/\b(morreu|faleceu|obito|obituario)\b/g, ' morte ')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function looksLikePersonNameQuery(query) {
    const text = String(query || '').trim();
    if (!text) return false;
    if (/\b(what|who|when|where|why|how|o que|quem|quando|onde|porque|por que|como|noticias|news)\b/i.test(text)) {
      return false;
    }

    const tokens = text
      .replace(/["'`.,!?()\[\]{}:;\/\\]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    if (tokens.length < 2 || tokens.length > 6) return false;
    return tokens.every(token => /^[\p{L}\p{M}][\p{L}\p{M}'-]*$/u.test(token));
  }

  function buildSearchQueryVariants(query) {
    const original = String(query || '')
      .replace(/[+]/g, ' ')
      .trim();
    if (!original) return [];
    const normalized = normalizeSearchQuery(query);
    const variants = [original, normalized, `"${original}"`];

    const withoutDeathTerms = normalized
      .replace(/\bmorte\b/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (withoutDeathTerms) variants.push(withoutDeathTerms);

    const entityLike = original
      .replace(/\b(quando|pesquise|pesquisa|procure|buscar|busque|morreu|faleceu)\b/gi, ' ')
      .replace(/[?!.]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (entityLike) variants.push(entityLike);

    if (looksLikePersonNameQuery(original)) {
      const parts = original.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        const firstLast = `${parts[0]} ${parts[parts.length - 1]}`;
        variants.push(firstLast, `"${firstLast}"`);
      }
    }

    return [...new Set(variants.filter(Boolean))].slice(0, 7);
  }

  function decodeHtmlEntities(text) {
    const doc = new DOMParser().parseFromString(String(text || ''), 'text/html');
    return doc.documentElement.textContent || '';
  }

  function normalizeSearchSnippet(text) {
    return decodeHtmlEntities(String(text || ''))
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function formatSearchEntry(index, title, snippet, url, source) {
    const parts = [`[${index}] ${title}`];
    if (snippet) parts.push(snippet);
    if (url) parts.push(url);
    if (source) parts.push(`Source: ${source}`);
    return parts.join('\n');
  }

  async function fetchWikipediaSummary(domain, title) {
    const encodedTitle = encodeURIComponent(String(title || '').replace(/ /g, '_'));
    const url = `https://${domain}/api/rest_v1/page/summary/${encodedTitle}`;
    const data = await fetchJsonWithTimeout(url, 6000);
    return {
      title: data.title || title,
      extract: normalizeSearchSnippet(data.extract || ''),
      description: normalizeSearchSnippet(data.description || ''),
      url: data.content_urls?.desktop?.page || `https://${domain}/wiki/${encodedTitle}`
    };
  }

  async function searchFxRate(query) {
    const pair = detectFxPair(query);
    if (!pair) return null;

    const data = await fetchJsonWithTimeout(`https://open.er-api.com/v6/latest/${pair.base}`, 6000);
    if (data.result !== 'success' || !data.rates?.[pair.quote]) {
      throw new Error(`FX lookup unavailable for ${pair.base}/${pair.quote}`);
    }

    return formatToolResult(
      `FX rate ${pair.base}/${pair.quote}`,
      `Pair: ${pair.base}/${pair.quote}\nRate: 1 ${pair.base} = ${Number(data.rates[pair.quote]).toFixed(4)} ${pair.quote}\nUpdated: ${data.time_last_update_utc || 'unknown'}\nSource: open.er-api.com`
    );
  }

  async function searchWikipedia(query) {
    const variants = buildSearchQueryVariants(query);
    if (!variants.length) return null;
    const domains = ['pt.wikipedia.org', 'en.wikipedia.org'];
    const seen = new Set();
    const entries = [];

    for (const domain of domains) {
      for (const variant of variants) {
        if (entries.length >= 6) break;
        try {
          await retryWithBackoff(async () => {
            const url = `https://${domain}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(variant)}&srlimit=3&utf8=1&format=json&origin=*`;
            const data = await fetchJsonWithTimeout(url, 6000);
            const hits = Array.isArray(data?.query?.search) ? data.query.search : [];

            console.debug(`Wikipedia search on ${domain} for "${variant}": ${hits.length} hits`);

            for (const hit of hits) {
              if (entries.length >= 6) break;
              const title = String(hit.title || '').trim();
              const key = `${domain}:${title.toLowerCase()}`;
              if (!title || seen.has(key)) continue;
              seen.add(key);

              let summary = null;
              try {
                summary = await fetchWikipediaSummary(domain, title);
              } catch {}

              const snippet = [
                summary?.description,
                summary?.extract,
                normalizeSearchSnippet(hit.snippet || '')
              ].filter(Boolean).join(' - ');

              entries.push(formatSearchEntry(
                entries.length + 1,
                summary?.title || title,
                snippet || 'No description available.',
                summary?.url || `https://${domain}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
                domain
              ));
            }
          }, 2, 150);
        } catch (error) {
          console.debug(`Wikipedia search on ${domain} failed:`, error.message);
        }

        if (entries.length >= 6) break;
      }

      if (entries.length >= 6) break;
    }

    // Fallback: Try simple query on main variants only
    if (!entries.length && query.length > 0) {
      const mainKeywords = query.split(/\s+/).slice(0, 3).join(' ');
      try {
        console.debug(`Wikipedia fallback query: "${mainKeywords}"`);
        await retryWithBackoff(async () => {
          const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(mainKeywords)}&srlimit=6&format=json&origin=*`;
          const data = await fetchJsonWithTimeout(url, 6000);
          const hits = Array.isArray(data?.query?.search) ? data.query.search : [];

          for (const hit of hits.slice(0, 6)) {
            if (!hit.title || seen.has(hit.title.toLowerCase())) continue;
            seen.add(hit.title.toLowerCase());
            entries.push(formatSearchEntry(
              entries.length + 1,
              hit.title,
              normalizeSearchSnippet(hit.snippet),
              `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
              'wikipedia'
            ));
          }
        }, 2, 150);
      } catch (error) {
        console.debug(`Wikipedia fallback failed:`, error.message);
      }
    }

    return entries.length ? formatToolResult('Wikipedia search', entries.join('\n\n')) : null;
  }

  async function searchWikidata(query) {
    const variants = buildSearchQueryVariants(query);
    if (!variants.length) return null;
    const seen = new Set();
    const entries = [];

    for (const language of ['pt', 'en']) {
      for (const variant of variants) {
        if (entries.length >= 6) break;
        try {
          await retryWithBackoff(async () => {
            const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(variant)}&language=${language}&limit=5&format=json&origin=*`;
            const data = await fetchJsonWithTimeout(url, 6000);
            const hits = Array.isArray(data?.search) ? data.search : [];

            console.debug(`Wikidata search in ${language} for "${variant}": ${hits.length} results`);

            for (const hit of hits) {
              if (entries.length >= 6) break;
              const id = String(hit.id || '').trim();
              if (!id || seen.has(id)) continue;
              seen.add(id);

              const title = String(hit.label || id).trim();
              const snippet = [
                normalizeSearchSnippet(hit.description || ''),
                normalizeSearchSnippet(hit.match?.text || '')
              ].filter(Boolean).join(' - ');

              entries.push(formatSearchEntry(
                entries.length + 1,
                title,
                snippet || 'No description available.',
                `https://www.wikidata.org/wiki/${encodeURIComponent(id)}`,
                `wikidata:${language}`
              ));
            }
          }, 2, 150);
        } catch (error) {
          console.debug(`Wikidata search in ${language} failed:`, error.message);
        }

        if (entries.length >= 6) break;
      }

      if (entries.length >= 6) break;
    }

    // Fallback: Try simple English query
    if (!entries.length && query.length > 0) {
      const mainKeywords = query.split(/\s+/).slice(0, 3).join(' ');
      try {
        console.debug(`Wikidata fallback query: "${mainKeywords}"`);
        await retryWithBackoff(async () => {
          const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(mainKeywords)}&language=en&limit=6&format=json&origin=*`;
          const data = await fetchJsonWithTimeout(url, 6000);
          const hits = Array.isArray(data?.search) ? data.search : [];

          for (const hit of hits.slice(0, 6)) {
            if (!hit.id || seen.has(hit.id)) continue;
            seen.add(hit.id);
            entries.push(formatSearchEntry(
              entries.length + 1,
              hit.label || hit.id,
              normalizeSearchSnippet(hit.description || ''),
              `https://www.wikidata.org/wiki/${encodeURIComponent(hit.id)}`,
              'wikidata'
            ));
          }
        }, 2, 150);
      } catch (error) {
        console.debug(`Wikidata fallback failed:`, error.message);
      }
    }

    return entries.length ? formatToolResult('Wikidata search', entries.join('\n\n')) : null;
  }

  async function searchDuckDuckGo(query) {
    const variants = buildSearchQueryVariants(query);
    if (!variants.length) return null;
    const seen = new Set();
    const entries = [];

    for (const variant of variants) {
      if (entries.length >= 6) break;
      try {
        await retryWithBackoff(async () => {
          const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(variant)}&format=json&no_html=1&no_redirect=1&skip_disambig=1`;
          const data = await fetchJsonWithTimeout(url, 8000);

          // Log response for debugging
          console.debug(`DuckDuckGo response for "${variant}":`, { 
            hasAbstract: !!data.AbstractText,
            topicsCount: Array.isArray(data.RelatedTopics) ? data.RelatedTopics.length : 0,
            response: data 
          });

          if (data.AbstractText) {
            const key = String(data.AbstractURL || data.Heading || variant).toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              entries.push(formatSearchEntry(
                entries.length + 1,
                data.Heading || variant,
                normalizeSearchSnippet(data.AbstractText),
                data.AbstractURL || '',
                'duckduckgo'
              ));
            }
          }

          for (const topic of Array.isArray(data.RelatedTopics) ? data.RelatedTopics : []) {
            if (entries.length >= 6) break;

            if (topic.Text && topic.FirstURL) {
              const key = String(topic.FirstURL).toLowerCase();
              if (seen.has(key)) continue;
              seen.add(key);
              entries.push(formatSearchEntry(
                entries.length + 1,
                normalizeSearchSnippet(topic.Text).split(' - ')[0] || topic.FirstURL,
                normalizeSearchSnippet(topic.Text),
                topic.FirstURL,
                'duckduckgo'
              ));
              continue;
            }

            if (Array.isArray(topic.Topics)) {
              for (const nested of topic.Topics) {
                if (entries.length >= 6) break;
                if (!nested.Text || !nested.FirstURL) continue;
                const key = String(nested.FirstURL).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                entries.push(formatSearchEntry(
                  entries.length + 1,
                  normalizeSearchSnippet(nested.Text).split(' - ')[0] || nested.FirstURL,
                  normalizeSearchSnippet(nested.Text),
                  nested.FirstURL,
                  'duckduckgo'
                ));
              }
            }
          }
        }, 2, 200);
      } catch (error) {
        console.debug(`DuckDuckGo search for "${variant}" failed:`, error.message);
      }
    }

    // If still no results, try a simpler query with just main keywords
    if (!entries.length && query.length > 0) {
      try {
        const mainKeywords = query.split(/\s+/).slice(0, 3).join(' ');
        console.debug(`DuckDuckGo fallback query: "${mainKeywords}"`);
        await retryWithBackoff(async () => {
          const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(mainKeywords)}&format=json&no_html=1`;
          const data = await fetchJsonWithTimeout(url, 8000);
          
          if (data.AbstractText) {
            entries.push(formatSearchEntry(
              1,
              data.Heading || mainKeywords,
              normalizeSearchSnippet(data.AbstractText),
              data.AbstractURL || '',
              'duckduckgo'
            ));
          }
        }, 2, 150);
      } catch (error) {
        console.debug(`DuckDuckGo fallback failed:`, error.message);
      }
    }

    return entries.length ? formatToolResult('DuckDuckGo search', entries.join('\n\n')) : null;
  }

  async function searchGoogleNewsRss(query) {
    const terms = String(query || '').trim();
    if (!terms) return null;

    try {
      return await retryWithBackoff(async () => {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(terms)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
        const res = await window.fetchWithTimeout(url, { cache: 'no-store' }, 8000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const xml = await res.text();
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        const items = [...doc.querySelectorAll('item')].slice(0, 6);
        
        console.debug(`Google News: Found ${items.length} articles`);
        
        if (!items.length) return null;

        const entries = items.map((item, index) => {
          const title = normalizeSearchSnippet(item.querySelector('title')?.textContent || 'Untitled');
          const link = normalizeSearchSnippet(item.querySelector('link')?.textContent || '');
          const pubDate = normalizeSearchSnippet(item.querySelector('pubDate')?.textContent || '');
          const source = normalizeSearchSnippet(item.querySelector('source')?.textContent || 'Google News');

          const snippet = pubDate ? `Published: ${pubDate}` : 'Published date unavailable';
          return formatSearchEntry(index + 1, title, snippet, link, source);
        });

        return formatToolResult('Google News RSS', entries.join('\n\n'));
      }, 2, 150);
    } catch (error) {
      console.debug('Google News search failed:', error.message);
      return null;
    }
  }

  async function searchReadableWebFallback(query) {
    const terms = String(query || '').trim();
    if (!terms) return null;

    const encoded = encodeURIComponent(terms);
    const wikiTitle = encodeURIComponent(terms.replace(/\s+/g, '_'));
    const candidates = [
      `https://r.jina.ai/http://duckduckgo.com/?q=${encoded}`,
      `https://r.jina.ai/http://www.bing.com/search?q=${encoded}`,
      `https://r.jina.ai/http://en.wikipedia.org/wiki/${wikiTitle}`,
      `https://r.jina.ai/http://pt.wikipedia.org/wiki/${wikiTitle}`
    ];

    const seenUrls = new Set();
    const entries = [];

    for (const url of candidates) {
      if (entries.length >= 6) break;
      try {
        const res = await window.fetchWithTimeout(url, { cache: 'no-store' }, 12000);
        if (!res.ok) continue;

        const rawText = (await res.text()).trim();
        if (rawText.length < 120) continue;

        const sourceHost = (() => {
          try {
            return new URL(url.replace('https://r.jina.ai/http://', 'http://')).hostname;
          } catch {
            return 'readable-web';
          }
        })();

        const linkedUrls = [...new Set(
          [...rawText.matchAll(/https?:\/\/[^\s"'<>\])]+/gi)]
            .map(match => String(match[0] || '').trim())
            .filter(link => link && !/r\.jina\.ai/i.test(link))
        )];

        const firstUrl = linkedUrls.find(link => !seenUrls.has(link));
        const snippet = normalizeSearchSnippet(rawText).slice(0, 420);
        const title = normalizeSearchSnippet(rawText.split(/\r?\n/).find(line => line.trim().length > 20) || terms).slice(0, 110);

        if (!snippet) continue;
        if (firstUrl) seenUrls.add(firstUrl);

        entries.push(formatSearchEntry(
          entries.length + 1,
          title || terms,
          snippet,
          firstUrl || '',
          `readable:${sourceHost}`
        ));
      } catch (error) {
        console.debug(`Readable fallback failed for ${url}: ${error?.message || error}`);
      }
    }

    return entries.length ? formatToolResult('Readable web fallback', entries.join('\n\n')) : null;
  }

  function hasMeaningfulToolBody(result) {
    const text = String(result || '').trim();
    if (!text) return false;

    const lines = text.split(/\r?\n/).map(line => line.trim());
    if (lines.length <= 1) return false;

    const contentLines = lines.filter(line => line && !line.startsWith('## '));
    return contentLines.length > 0;
  }

  async function retryWithBackoff(fn, maxAttempts = 3, baseDelayMs = 100) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts - 1) {
          const delayMs = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError;
  }

  async function searchGithubRepositories(query) {
    const terms = String(query || '').replace(/[+]/g, ' ').trim();
    if (!terms) return null;

    try {
      // Try to get GitHub token from config for higher rate limits
      const githubToken = window.localStorage?.getItem?.('github_token') || '';
      
      // First try: Advanced search with multiple fields
      let url = `https://api.github.com/search/repositories?q=${encodeURIComponent(`${terms} in:name,description,readme`)}&sort=stars&order=desc&per_page=6`;
      let headers = {
        Accept: 'application/vnd.github+json'
      };
      
      // Authorization header triggers CORS preflight
      // Try with token first, fallback to no token if preflight fails
      const hasToken = !!githubToken;
      if (hasToken) {
        headers['Authorization'] = `token ${githubToken}`;
      }

      let res = await window.fetchWithTimeout(url, { cache: 'no-store', headers }, 8000);
      
      // If preflight might have failed (0 status or timeout type error), retry without auth header
      if (hasToken && (!res.ok || res.status === 0)) {
        console.debug('GitHub with token failed, retrying without auth header');
        headers = { Accept: 'application/vnd.github+json' };
        res = await window.fetchWithTimeout(url, { cache: 'no-store', headers }, 8000);
      }
      
      // Handle authentication/rate limit errors gracefully
      if (res.status === 401 || res.status === 403) {
        console.debug('GitHub API auth/rate limit: ', res.status, '- skipping');
        return null;
      }
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      let data = await res.json();
      let repos = Array.isArray(data?.items) ? data.items.slice(0, 6) : [];
      
      console.debug(`GitHub search for "${terms}": ${repos.length} results (advanced)`);

      // Fallback: Try simpler search if no results
      if (!repos.length) {
        console.debug(`GitHub fallback for "${terms}": trying simple search`);
        const simpleUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(terms)}&sort=stars&order=desc&per_page=6`;
        res = await window.fetchWithTimeout(simpleUrl, { cache: 'no-store', headers }, 8000);
        
        if (res.ok) {
          data = await res.json();
          repos = Array.isArray(data?.items) ? data.items.slice(0, 6) : [];
          console.debug(`GitHub fallback: ${repos.length} results found`);
        }
      }

      if (!repos.length) return null;

      const entries = repos.map((repo, index) => {
        const title = normalizeSearchSnippet(repo.full_name || repo.name || 'Unknown repository');
        const snippet = [
          normalizeSearchSnippet(repo.description || ''),
          `Stars: ${Number(repo.stargazers_count || 0).toLocaleString('en-US')}`,
          repo.language ? `Language: ${repo.language}` : '',
          repo.updated_at ? `Updated: ${new Date(repo.updated_at).toISOString().slice(0, 10)}` : ''
        ].filter(Boolean).join(' | ');

        return formatSearchEntry(index + 1, title, snippet || 'No description available.', repo.html_url || '', 'github');
      });

      return formatToolResult('GitHub repositories', entries.join('\n\n'));
    } catch (error) {
      console.debug('GitHub search error:', error.message);
      // Return null to let other providers try
      return null;
    }
  }

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

    const pattern = /(?:[A-Za-z]:\\[^\s"'`<>|]+|(?:\.{1,2}\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g;
    const matches = value.match(pattern) || [];

    return [...new Set(matches
      .map(sanitizePathCandidate)
      .filter(Boolean)
      .filter(item => !/^https?:\/\//i.test(item)))];
  }

  function deriveFilesystemPathArg(args = {}, context = {}, toolName = 'fs_tool') {
    const existing = String(args?.path || '').trim();
    if (existing) return { ...args, path: existing };

    const history = Array.isArray(context?.messages) ? context.messages : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i];
      if (message?.role !== 'user') continue;
      const text = stripAgentTags(message.content);
      const candidates = extractPathCandidates(text);
      if (!candidates.length) continue;

      const path = candidates[0];
      console.debug(`${toolName}: recovered missing path from context`, path);
      return { ...args, path };
    }

    return { ...args };
  }

  async function runSearchSkills(query) {
    const diagnostics = [];
    const originalQuery = String(query || '').trim();

    if (!originalQuery) {
      return formatToolResult('web_search', 'ERROR: web_search requires a non-empty query string.');
    }

    const searchQuery = originalQuery;
    const isCodingQuery = detectCodingIntent(searchQuery);
    const isBioFactQuery = detectBiographicalFactIntent(searchQuery);
    const isRecentQuery = detectRecencyIntent(searchQuery);
    const hasFxIntent = !!detectFxPair(searchQuery);
    const hasWeatherIntent = detectWeatherIntent(searchQuery);

    const runners = [
      { name: 'weather_current', enabled: () => hasWeatherIntent, run: () => getCurrentWeather({}) },
      { name: 'fx_rate', enabled: () => hasFxIntent, run: () => searchFxRate(searchQuery) },
      { name: 'google_news', enabled: () => (isRecentQuery || isBioFactQuery), run: () => searchGoogleNewsRss(searchQuery) },
      { name: 'wikipedia', enabled: () => true, run: () => searchWikipedia(searchQuery) },
      { name: 'wikidata', enabled: () => true, run: () => searchWikidata(searchQuery) },
      { name: 'duckduckgo', enabled: () => true, run: () => searchDuckDuckGo(searchQuery) },
      { name: 'readable_web_fallback', enabled: () => true, run: () => searchReadableWebFallback(searchQuery) },
      { name: 'github_repositories', enabled: () => isCodingQuery, run: () => searchGithubRepositories(searchQuery) }
    ];
    const results = [];

    console.debug(`🔍 Starting web search for: "${originalQuery}"`);
    if (searchQuery !== originalQuery) {
      console.debug(`   (as: "${searchQuery}")`);
    }

    for (const runner of runners) {
      if (typeof runner.enabled === 'function' && !runner.enabled()) {
        diagnostics.push(`${runner.name}: ↷ skipped (intent mismatch)`);
        console.debug(`  ↷ ${runner.name}: Skipped (intent mismatch)`);
        continue;
      }

      try {
        const result = await runner.run();
        if (hasMeaningfulToolBody(result)) {
          results.push({ source: runner.name, content: result });
          diagnostics.push(`${runner.name}: ✓ ok`);
          console.debug(`  ✓ ${runner.name}: Got results`);
        } else if (result) {
          diagnostics.push(`${runner.name}: ⊘ empty`);
          console.debug(`  ⊘ ${runner.name}: Empty result`);
        } else {
          diagnostics.push(`${runner.name}: ✗ no match`);
          console.debug(`  ✗ ${runner.name}: No match`);
        }
      } catch (error) {
        const msg = error.message || 'unknown error';
        diagnostics.push(`${runner.name}: ⚠ ${msg}`);
        console.debug(`  ⚠ ${runner.name}: ${msg}`);
      }
    }

    console.debug(`Search complete: ${results.length} providers returned results`);

    // ULTIMATE FALLBACK: If ALL providers returned nothing, retry with ORIGINAL query unchanged
    if (!results.length && originalQuery.length > 0) {
      console.debug(`⚠️ No results found. Trying ultimate fallback with original query: "${originalQuery}"`);
      
      for (const runner of runners) {
        if (typeof runner.enabled === 'function' && !runner.enabled()) continue;
        // Skip high-latency or intent-irrelevant providers in the fallback retry phase.
        if (['weather_current', 'fx_rate', 'readable_web_fallback'].includes(runner.name)) continue;
        
        try {
          console.debug(`  🔄 Fallback retry: ${runner.name}`);
          
          // Direct API calls with original query, skip variant building
          let result = null;
          
          if (runner.name === 'google_news') {
            result = await searchGoogleNewsRss(originalQuery);
          } else if (runner.name === 'github_repositories' && isCodingQuery) {
            result = await searchGithubRepositories(originalQuery);
          } else if (runner.name === 'readable_web_fallback') {
            result = await searchReadableWebFallback(originalQuery);
          } else if (runner.name === 'duckduckgo') {
            // Direct DuckDuckGo call with original query
            try {
              const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(originalQuery)}&format=json&no_html=1`;
              const data = await fetchJsonWithTimeout(url, 8000);
              if (data.AbstractText) {
                result = formatToolResult('DuckDuckGo search (fallback)', formatSearchEntry(
                  1,
                  data.Heading || originalQuery,
                  normalizeSearchSnippet(data.AbstractText),
                  data.AbstractURL || '',
                  'duckduckgo'
                ));
              }
            } catch (e) {
              console.debug(`    Fallback failed: ${e.message}`);
            }
          } else if (runner.name === 'wikipedia') {
            // Direct Wikipedia call with original query
            try {
              const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(originalQuery)}&srlimit=6&format=json&origin=*`;
              const data = await fetchJsonWithTimeout(url, 6000);
              const hits = Array.isArray(data?.query?.search) ? data.query.search : [];
              const entries = hits.slice(0, 3).map((hit, i) => formatSearchEntry(
                i + 1,
                hit.title,
                normalizeSearchSnippet(hit.snippet),
                `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
                'wikipedia'
              ));
              if (entries.length) {
                result = formatToolResult('Wikipedia search (fallback)', entries.join('\n\n'));
              }
            } catch (e) {
              console.debug(`    Fallback failed: ${e.message}`);
            }
          } else if (runner.name === 'wikidata') {
            // Direct Wikidata call with original query
            try {
              const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(originalQuery)}&language=en&limit=6&format=json&origin=*`;
              const data = await fetchJsonWithTimeout(url, 6000);
              const hits = Array.isArray(data?.search) ? data.search : [];
              const entries = hits.slice(0, 3).map((hit, i) => formatSearchEntry(
                i + 1,
                hit.label || hit.id,
                normalizeSearchSnippet(hit.description || ''),
                `https://www.wikidata.org/wiki/${encodeURIComponent(hit.id)}`,
                'wikidata'
              ));
              if (entries.length) {
                result = formatToolResult('Wikidata search (fallback)', entries.join('\n\n'));
              }
            } catch (e) {
              console.debug(`    Fallback failed: ${e.message}`);
            }
          }
          
          if (result) {
            results.push({ source: `${runner.name} (fallback)`, content: result });
            diagnostics.push(`${runner.name}: ✓ ok (fallback)`);
            console.debug(`    ✓ Got fallback results!`);
          }
        } catch (error) {
          console.debug(`    Fallback error: ${error.message}`);
        }
      }
    }

    if (!results.length) {
      // FALLBACK: No providers returned results, provide helpful guidance
      const summaryLines = [
        `⚠️ Search Unavailable - All Providers Failed`,
        `Query: "${originalQuery}"`,
        ``,
        `Status: Check the diagnostics below to troubleshoot.`,
        ``,
        `Provider Status:`,
        ...diagnostics.map(d => `  • ${d}`),
        ``,
        `Troubleshooting:`,
        `1. ✓ (ok) = Results found successfully`,
        `2. ⊘ (empty) = Provider returned no data (API issue or no results)`,
        `3. ✗ (no match) = No matching content found`,
        `4. ⚠ (error) = Network or API error occurred`,
        ``,
        `If most/all providers show ⚠ errors:`,
        `  • Check your internet connection`,
        `  • Wait a moment and try again`,
        `  • Try a simpler, shorter query`,
        ``,
        `If most providers show ✗ no match:`,
        `  • Your query might be too specific`,
        `  • Try searching for something more general`,
        `  • Try different keywords`
      ];

      const fallbackResult = formatToolResult(
        'Search Diagnostics - All Providers Failed',
        summaryLines.join('\n')
      );

      return fallbackResult;
    }

    const recencyRequested = detectRecencyIntent(query);
    const nonEncyclopedic = results.filter(entry => !['wikipedia', 'wikidata'].includes(entry.source));
    if (recencyRequested && !nonEncyclopedic.length) {
      diagnostics.push('recency-check: only encyclopedic sources responded; answer may be outdated.');
    }

    if (isBioFactQuery && !nonEncyclopedic.length) {
      diagnostics.push('verification-warning: sensitive biographical claim with only encyclopedic sources. Treat as unverified unless independent reporting confirms it.');
    }

    if (results.length < 2) {
      diagnostics.push('source-diversity: only one provider returned data for this query.');
    }

    const verificationBlock = isBioFactQuery && !nonEncyclopedic.length
      ? formatToolResult(
          'Verification warning',
          'Biographical claim detected (for example death/age/birth) but only encyclopedic sources responded. Treat this as unverified and avoid definitive claims until independent reporting confirms it.'
        )
      : '';

    return [
      results.map(entry => entry.content).join('\n\n'),
      verificationBlock,
      formatToolResult('Search diagnostics', diagnostics.join('\n'))
    ].filter(Boolean).join('\n\n');
  }

  function parseGithubRepositoryUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      const host = parsed.hostname.toLowerCase();
      if (host !== 'github.com' && host !== 'www.github.com') return null;

      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length < 2) return null;
      const owner = parts[0];
      const repo = parts[1];
      if (!owner || !repo || repo.endsWith('.git')) return null;

      return { owner, repo };
    } catch {
      return null;
    }
  }

  async function fetchGithubRepositorySnapshot(url) {
    const repoInfo = parseGithubRepositoryUrl(url);
    if (!repoInfo) return null;

    const { owner, repo } = repoInfo;
    const baseApi = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const headers = { Accept: 'application/vnd.github+json' };

    const meta = await fetchJsonWithTimeout(baseApi, 8000, { headers });
    let readme = '';

    try {
      const readmeRes = await window.fetchWithTimeout(`${baseApi}/readme`, {
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github.raw+json'
        }
      }, 8000);

      if (readmeRes.ok) {
        readme = (await readmeRes.text()).trim();
      }
    } catch {}

    const summaryLines = [
      `Repository: ${meta.full_name || `${owner}/${repo}`}`,
      `URL: ${meta.html_url || url}`,
      `Description: ${meta.description || 'No description provided.'}`,
      `Stars: ${Number(meta.stargazers_count || 0).toLocaleString('en-US')}`,
      `Language: ${meta.language || 'Unknown'}`,
      `Updated: ${meta.updated_at || 'Unknown'}`,
      ''
    ];

    if (readme) {
      summaryLines.push('README preview:');
      summaryLines.push(readme.slice(0, 7000));
    } else {
      summaryLines.push('README preview unavailable.');
    }

    return summaryLines.join('\n').trim();
  }

  async function fetchReadablePage(url) {
    const normalizedUrl = String(url || '').trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      throw new Error('Invalid URL. Use a full http:// or https:// address.');
    }

    // GitHub HTML often exceeds short browser timeouts; API snapshot is faster and stable.
    try {
      const githubSnapshot = await fetchGithubRepositorySnapshot(normalizedUrl);
      if (githubSnapshot) return githubSnapshot.slice(0, 8000);
    } catch (e) {
      console.debug(`GitHub snapshot failed: ${e.message}`);
    }

    try {
      const res = await window.fetchWithTimeout(normalizedUrl, { cache: 'no-store' }, 7000);
      if (res.ok) {
        const type = res.headers.get('content-type') || '';
        const raw = await res.text();
        const text = type.includes('html') ? stripHtmlToText(raw) : raw.trim();
        if (text) return text.slice(0, 8000);
      }
    } catch (e) {
      console.debug(`Direct fetch failed: ${e.message}`);
    }

    // Try alternative reader proxies
    const bareUrl = normalizedUrl.replace(/^https?:\/\//i, '');
    const readerUrls = [
      `https://r.jina.ai/${normalizedUrl}`,
      `https://r.jina.ai/http://${bareUrl}`,
      `https://r.jina.ai/https://${bareUrl}`
    ];

    let lastError = null;
    for (const readerUrl of readerUrls) {
      try {
        console.debug(`Trying reader proxy: ${readerUrl}`);
        const proxyRes = await window.fetchWithTimeout(readerUrl, { cache: 'no-store' }, 15000);
        
        if (proxyRes.ok) {
          const text = (await proxyRes.text()).trim();
          if (text && text.length > 10) {
            console.debug(`Reader proxy succeeded: ${readerUrl}`);
            return text.slice(0, 8000);
          }
        } else {
          console.debug(`Reader proxy ${readerUrl} returned HTTP ${proxyRes.status}`);
        }
      } catch (error) {
        lastError = error;
        console.debug(`Reader proxy failed: ${error.message}`);
      }
    }

    throw new Error(`Unable to fetch readable page content. ${lastError?.message || 'All fetch strategies failed.'}`);
  }

  async function getCurrentPosition() {
    if (!navigator.geolocation) {
      throw new Error('Geolocation is not supported in this browser.');
    }

    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        position => resolve(position.coords),
        error => reject(new Error(error.message || 'Unable to get current location.')),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 }
      );
    });
  }

  async function getCurrentLocation() {
    const coords = await getCurrentPosition();
    return formatToolResult(
      'geo_current_location',
      `Latitude: ${coords.latitude}\nLongitude: ${coords.longitude}\nAccuracy: ${coords.accuracy} meters`
    );
  }

  function weatherCodeToText(code) {
    const map = {
      0: 'Clear sky',
      1: 'Mainly clear',
      2: 'Partly cloudy',
      3: 'Overcast',
      45: 'Fog',
      48: 'Depositing rime fog',
      51: 'Light drizzle',
      53: 'Moderate drizzle',
      55: 'Dense drizzle',
      61: 'Slight rain',
      63: 'Moderate rain',
      65: 'Heavy rain',
      71: 'Slight snow',
      73: 'Moderate snow',
      75: 'Heavy snow',
      80: 'Rain showers',
      95: 'Thunderstorm'
    };

    return map[code] || `Weather code ${code}`;
  }

  async function getCurrentWeather({ latitude, longitude } = {}) {
    let lat = latitude;
    let lon = longitude;

    if (lat == null || lon == null) {
      const coords = await getCurrentPosition();
      lat = coords.latitude;
      lon = coords.longitude;
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`;
    const data = await fetchJsonWithTimeout(url, 10000);
    const current = data.current || {};

    return formatToolResult(
      'weather_current',
      `Latitude: ${lat}\nLongitude: ${lon}\nTemperature: ${current.temperature_2m} ${data.current_units?.temperature_2m || 'C'}\nFeels like: ${current.apparent_temperature} ${data.current_units?.apparent_temperature || 'C'}\nHumidity: ${current.relative_humidity_2m} ${data.current_units?.relative_humidity_2m || '%'}\nWind: ${current.wind_speed_10m} ${data.current_units?.wind_speed_10m || 'km/h'}\nCondition: ${weatherCodeToText(current.weather_code)}\nTime: ${current.time || 'unknown'}\nSource: open-meteo.com`
    );
  }

  async function fetchHttpResource({ url, method = 'GET' }) {
    const normalizedUrl = String(url || '').trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      throw new Error('Invalid URL. Use a full http:// or https:// address.');
    }

    try {
      // First try direct fetch
      try {
        const res = await window.fetchWithTimeout(normalizedUrl, { method, cache: 'no-store' }, 10000);
        const contentType = res.headers.get('content-type') || 'unknown';
        
        // If not OK status, still try to get body for debugging
        let raw = '';
        try {
          raw = await res.text();
        } catch {
          raw = `[Unable to read response body - Status: ${res.status}]`;
        }
        
        const body = contentType.includes('html') ? stripHtmlToText(raw).slice(0, 8000) : raw.slice(0, 8000);

        return formatToolResult(
          'http_fetch',
          `URL: ${normalizedUrl}\nStatus: ${res.status}\nContent-Type: ${contentType}\n\n${body}`
        );
      } catch (directError) {
        console.debug(`Direct fetch failed: ${directError.message}, trying reader proxy`);
        
        // Fallback to reader proxy for better HTML parsing
        const readerUrl = `https://r.jina.ai/${normalizedUrl}`;
        const proxyRes = await window.fetchWithTimeout(readerUrl, { cache: 'no-store' }, 15000);
        
        if (proxyRes.ok) {
          const text = (await proxyRes.text()).trim();
          return formatToolResult(
            'http_fetch (via reader proxy)',
            `URL: ${normalizedUrl}\nStatus: 200 (proxied)\nContent-Type: text/plain\n\n${text.slice(0, 8000)}`
          );
        } else {
          throw new Error(`Direct fetch and reader proxy both failed`);
        }
      }
    } catch (error) {
      throw new Error(`Failed to fetch ${normalizedUrl}: ${error.message || 'Network error'}`);
    }
  }

  async function extractLinks({ url, text = '' }) {
    let html = text;
    let source = 'inline text';

    if (url) {
      source = url;
      const res = await window.fetchWithTimeout(url, { cache: 'no-store' }, 10000);
      html = await res.text();
    }

    const links = new Set();
    const hrefs = [...String(html || '').matchAll(/https?:\/\/[^\s"'<>]+/gi)].map(match => match[0]);
    hrefs.forEach(link => links.add(link));

    if (/<a\b/i.test(String(html || ''))) {
      const doc = new DOMParser().parseFromString(String(html), 'text/html');
      doc.querySelectorAll('a[href]').forEach(anchor => {
        try {
          const href = anchor.getAttribute('href');
          if (!href) return;
          const resolved = url ? new URL(href, url).toString() : href;
          if (/^https?:\/\//i.test(resolved)) links.add(resolved);
        } catch {}
      });
    }

    return formatToolResult('extract_links', `Source: ${source}\nCount: ${links.size}\n${[...links].slice(0, 200).join('\n') || 'No links found.'}`);
  }

  async function getPageMetadata({ url }) {
    const res = await window.fetchWithTimeout(url, { cache: 'no-store' }, 10000);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = doc.querySelector('title')?.textContent?.trim() || '';
    const description = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';

    return formatToolResult(
      'page_metadata',
      `URL: ${url}\nTitle: ${title || 'n/a'}\nDescription: ${description || 'n/a'}\nCanonical: ${canonical || 'n/a'}`
    );
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

