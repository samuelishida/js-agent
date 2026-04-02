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

  function extractEntities(text) {
    const input = String(text || '');
    return {
      urls: [...input.matchAll(/https?:\/\/[^\s]+/gi)].map(match => match[0]),
      currencies: [...input.matchAll(/\b(usd|dolar|d[oÃ³]lar|brl|real|reais|eur|euro|gbp|libra|jpy|iene)\b/gi)].map(match => match[1].toLowerCase())
    };
  }

  function normalizeCurrencyToken(token) {
    const aliases = {
      usd: 'USD',
      dolar: 'USD',
      'dÃ³lar': 'USD',
      dolar: 'USD',
      brl: 'BRL',
      real: 'BRL',
      reais: 'BRL',
      eur: 'EUR',
      euro: 'EUR',
      gbp: 'GBP',
      libra: 'GBP',
      jpy: 'JPY',
      iene: 'JPY'
    };

    return aliases[String(token || '').toLowerCase()] || null;
  }

  function detectFxPair(text) {
    const currencies = extractEntities(text).currencies.map(normalizeCurrencyToken).filter(Boolean);
    const unique = [...new Set(currencies)];

    if (unique.length >= 2) return { base: unique[0], quote: unique[1] };
    if (unique.length === 1 && (unique[0] === 'USD' || unique[0] === 'BRL')) return { base: 'USD', quote: 'BRL' };
    if (/\bcota[cÃ§][aÃ£]o\b/i.test(text) && /\b(dolar|d[oÃ³]lar|usd)\b/i.test(text) && /\b(real|reais|brl)\b/i.test(text)) {
      return { base: 'USD', quote: 'BRL' };
    }

    return null;
  }

  function detectWeatherIntent(text) {
    const value = String(text || '').toLowerCase();
    return /(weather|temperature|temperatura|clima|forecast|previs[aÃ£]o|how hot|how cold)/i.test(value);
  }

  function detectFilesystemIntent(text) {
    return /(file|files|arquivo|arquivos|folder|pasta|directory|diret[oÃ³]rio|rename|renome|move|mover|copy|copiar|delete|deletar|remove|remover|list files|listar arquivos|search file|buscar arquivo|open file|abrir arquivo|read project|ler projeto|leia o projeto|leio o proejto|codebase|repo|repository|src\/|[a-z]:\\)/i.test(String(text || ''));
  }

  function detectAuthorizeFolderIntent(text) {
    return /(authorize folder|autorizar pasta|authorize|autoriz[aá]r|permiss[aã]o|directory access|acesso [àa] pasta)/i.test(String(text || ''));
  }

  function detectFullFileDisplayIntent(text) {
    const value = String(text || '');
    return /(show|mostre|mostrar|exiba|print|imprima|cat|dump|full|complete|completo|inteiro).*(readme|README|arquivo|file)|((readme|README).*(full|complete|completo|inteiro))/i.test(value);
  }

  function detectProjectSkillsIntent(text) {
    return /(explain|explique|skills|habilidades|capabilities|capacidades).*(project|projeto|repo|codebase)|((project|projeto|repo|codebase).*(skills|habilidades|capabilities))/i.test(String(text || ''));
  }

  function detectSaveIntent(text) {
    return /(save|salvar|write file|escrever arquivo|export|exportar|download|baixar|save it|save as|json file|arquivo json)/i.test(String(text || ''));
  }

  function detectClipboardIntent(text) {
    return /(clipboard|area de transferencia|Ã¡rea de transferÃªncia|copiar texto|paste|colar)/i.test(String(text || ''));
  }

  function detectParsingIntent(text) {
    return /(json|csv|parse|validar json|parsear csv|extract links|extrair links|metadata)/i.test(String(text || ''));
  }

  function detectTabCoordinationIntent(text) {
    return /(other tab|another tab|open tab|other window|another window|dashboard|share|send to other tab|manda pra outra aba|outra aba|outra janela|espera a outra aba|broadcast|all tabs|todas as abas)/i.test(String(text || ''));
  }

  function detectRecencyIntent(text) {
    return /(recent|recente|latest|last\s+(hour|day|week|month|year)|today|hoje|agora|atual|atualizado|news|noticia|noticias|ultim[ao]s?|202[4-9]|2030)/i.test(String(text || ''));
  }

  function detectCodingIntent(text) {
    return /(github|repo|repository|source code|javascript|typescript|python|java|rust|go|node|npm|package|library|framework|api sdk|open source)/i.test(String(text || ''));
  }

  function detectBiographicalFactIntent(text) {
    return /(when|quando|date|data|born|nasc|died|morreu|faleceu|death|obito|biography|biografia|idade|age)/i.test(String(text || ''));
  }

  const SAFE_CLASSIFIED_TOOLS = new Set([
    'web_search',
    'web_fetch',
    'read_page',
    'http_fetch',
    'extract_links',
    'page_metadata',
    'datetime',
    'geo_current_location',
    'weather_current',
    'parse_json',
    'parse_csv',
    'fs_list_roots',
    'fs_authorize_folder',
    'fs_list_dir',
    'fs_read_file',
    'fs_preview_file',
    'fs_search_name',
    'fs_search_content',
    'fs_glob',
    'fs_grep',
    'fs_tree',
    'fs_exists',
    'fs_stat',
    'file_read',
    'read_file',
    'glob',
    'grep',
    'task_get',
    'task_list',
    'tool_search'
  ]);

  const WRITE_CLASSIFIED_TOOLS = new Set([
    'clipboard_write',
    'storage_set',
    'notification_send',
    'tab_broadcast',
    'fs_write_file',
    'fs_copy_file',
    'fs_move_file',
    'fs_delete_path',
    'fs_rename_path',
    'fs_mkdir',
    'fs_touch',
    'fs_save_upload',
    'fs_download_file',
    'file_write',
    'write_file',
    'file_edit',
    'edit_file',
    'todo_write',
    'task_create',
    'task_update'
  ]);

  const NON_CONCURRENT_TOOLS = new Set([
    'tab_listen',
    'fs_authorize_folder',
    'fs_pick_directory',
    'fs_write_file',
    'fs_copy_file',
    'fs_move_file',
    'fs_delete_path',
    'fs_rename_path',
    'fs_mkdir',
    'fs_touch',
    'fs_save_upload',
    'fs_download_file',
    'file_write',
    'write_file',
    'file_edit',
    'edit_file',
    'todo_write',
    'task_create',
    'task_update',
    'ask_user_question'
  ]);

  const BUILTIN_EXECUTION_META = {
    calc: { readOnly: true, concurrencySafe: true, destructive: false, riskLevel: 'normal' },
    datetime: { readOnly: true, concurrencySafe: true, destructive: false, riskLevel: 'normal' }
  };

  function classifyRecommendedTools(tools) {
    const safe = [];
    const write = [];
    const other = [];

    for (const tool of tools) {
      if (SAFE_CLASSIFIED_TOOLS.has(tool)) safe.push(tool);
      else if (WRITE_CLASSIFIED_TOOLS.has(tool)) write.push(tool);
      else other.push(tool);
    }

    return {
      safe,
      write,
      other,
      riskLevel: write.length ? 'elevated' : 'normal'
    };
  }

  function getToolExecutionMeta(toolName) {
    const name = String(toolName || '').trim();
    if (!name) {
      return {
        readOnly: false,
        concurrencySafe: false,
        destructive: false,
        riskLevel: 'elevated'
      };
    }

    if (BUILTIN_EXECUTION_META[name]) {
      return BUILTIN_EXECUTION_META[name];
    }

    const isWrite = WRITE_CLASSIFIED_TOOLS.has(name);
    const isSafe = SAFE_CLASSIFIED_TOOLS.has(name);
    const isFilesystemTool = name.startsWith('fs_');
    const isConcurrentCandidate = !isWrite && !NON_CONCURRENT_TOOLS.has(name) && !isFilesystemTool;

    return {
      readOnly: !isWrite,
      concurrencySafe: isConcurrentCandidate,
      destructive: isWrite,
      riskLevel: isWrite ? 'elevated' : (isSafe ? 'normal' : 'normal')
    };
  }

  function canRunToolConcurrently(call) {
    const meta = getToolExecutionMeta(call?.tool);
    return !!meta.concurrencySafe;
  }

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
      plan.push('fs_list_roots', 'fs_authorize_folder', 'fs_list_dir', 'fs_read_file', 'fs_search_name', 'fs_search_content');
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
      plan.push('fs_list_dir', 'fs_read_file');
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

  async function parseJsonText({ text }) {
    const value = JSON.parse(String(text || ''));
    return formatToolResult('parse_json', JSON.stringify(value, null, 2).slice(0, 12000));
  }

  async function parseCsvText({ text }) {
    const rows = String(text || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => line.split(',').map(cell => cell.trim()));

    if (!rows.length) {
      throw new Error('CSV input is empty.');
    }

    const preview = rows.slice(0, 10).map(row => row.join(' | ')).join('\n');
    return formatToolResult('parse_csv', `Rows: ${rows.length}\nColumns: ${rows[0].length}\n\n${preview}`);
  }

  async function clipboardRead() {
    if (!navigator.clipboard?.readText) {
      throw new Error('Clipboard read is not supported in this browser.');
    }

    const text = await navigator.clipboard.readText();
    return formatToolResult('clipboard_read', text || '(clipboard empty)');
  }

  async function clipboardWrite({ text }) {
    if (!navigator.clipboard?.writeText) {
      throw new Error('Clipboard write is not supported in this browser.');
    }

    await navigator.clipboard.writeText(String(text || ''));
    return formatToolResult('clipboard_write', 'Clipboard updated.');
  }

  async function listStorageKeys() {
    const lines = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      lines.push(key);
    }

    return formatToolResult('storage_list_keys', lines.join('\n') || '(no localStorage keys)');
  }

  async function storageGet({ key }) {
    return formatToolResult('storage_get', `${key} = ${localStorage.getItem(String(key))}`);
  }

  async function storageSet({ key, value }) {
    localStorage.setItem(String(key), String(value ?? ''));
    return formatToolResult('storage_set', `Saved ${key}`);
  }

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
    const preflight = buildPreflightPlan(userMessage);

    blocks.push(formatToolResult(
      'preflight',
      `Recommended tools: ${preflight.recommendedTools.join(', ') || 'none'}\nRisk level: ${preflight.classification?.riskLevel || 'normal'}\n${preflight.hints.join('\n')}`
    ));

    try {
      const prefetchedBlocks = await runDeferredPrefetches(userMessage, preflight);
      blocks.push(...prefetchedBlocks);
    } catch {}

    return blocks.length ? `<initial_context>\n${blocks.join('\n\n')}\n</initial_context>\n\n${userMessage}` : userMessage;
  }

  function registerRoot(handle, label) {
    const rootId = label || handle.name || `root-${state.roots.size + 1}`;
    state.roots.set(rootId, handle);
    if (!state.defaultRootId) state.defaultRootId = rootId;
    return rootId;
  }

  function parseVirtualPath(path) {
    const raw = String(path || '').trim();
    if (!raw) return { rootId: state.defaultRootId, segments: [] };

    const normalized = raw.replace(/\\/g, '/').replace(/\/+/g, '/');

    const explicit = normalized.match(/^([^:]+):\/?(.*)$/);
    if (explicit && state.roots.has(explicit[1])) {
      return {
        rootId: explicit[1],
        segments: explicit[2].split('/').filter(Boolean)
      };
    }

    const windowsAbsolute = normalized.match(/^[A-Za-z]:\/(.+)$/);
    if (windowsAbsolute) {
      const absoluteSegments = windowsAbsolute[1].split('/').filter(Boolean);
      for (const rootId of state.roots.keys()) {
        const rootName = String(rootId || '').toLowerCase();
        const matchIndex = absoluteSegments.findIndex(segment => segment.toLowerCase() === rootName);
        if (matchIndex >= 0) {
          return {
            rootId,
            segments: absoluteSegments.slice(matchIndex + 1)
          };
        }
      }
    }

    // Support paths that redundantly include the authorized root name,
    // e.g. /agent, /Agent/src when rootId is "Agent".
    const normalizedSegments = normalized.replace(/^\/+/, '').split('/').filter(Boolean);
    if (normalizedSegments.length) {
      const first = normalizedSegments[0].toLowerCase();
      for (const rootId of state.roots.keys()) {
        if (String(rootId || '').toLowerCase() === first) {
          return {
            rootId,
            segments: normalizedSegments.slice(1)
          };
        }
      }
    }

    return {
      rootId: state.defaultRootId,
      segments: normalized.replace(/^\/+/, '').split('/').filter(Boolean)
    };
  }

  async function ensureRoot(rootId) {
    const id = rootId || state.defaultRootId;
    const root = state.roots.get(id);
    if (!root) {
      throw new Error('No directory root selected. Ask the user to click "Authorize Folder" in the Files panel first.');
    }
    return { rootId: rootId || state.defaultRootId, root };
  }

  async function resolveDirectory(path, create = false) {
    const { rootId, segments } = parseVirtualPath(path);
    const { root } = await ensureRoot(rootId);
    let current = root;

    for (const segment of segments) {
      current = await current.getDirectoryHandle(segment, { create });
    }

    return { rootId, handle: current };
  }

  async function resolveFile(path, create = false) {
    const { rootId, segments } = parseVirtualPath(path);
    if (!segments.length) throw new Error('A file path is required.');
    const fileName = segments.pop();
    const { root } = await ensureRoot(rootId);
    let current = root;

    for (const segment of segments) {
      current = await current.getDirectoryHandle(segment, { create });
    }

    const handle = await current.getFileHandle(fileName, { create });
    return { rootId, parent: current, handle, fileName };
  }

  async function readFileAsText(handle) {
    const file = await handle.getFile();
    return file.text();
  }

  async function writeFile(handle, content) {
    const writer = await handle.createWritable();
    await writer.write(content);
    await writer.close();
  }

  async function collectEntries(directoryHandle) {
    const entries = [];
    for await (const [name, handle] of directoryHandle.entries()) {
      entries.push({ name, kind: handle.kind });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function walkDirectory(directoryHandle, basePath = '') {
    const items = [];
    for await (const [name, handle] of directoryHandle.entries()) {
      const fullPath = `${basePath}/${name}`.replace(/^\/+/, '/');
      items.push({ path: fullPath, kind: handle.kind, handle });
      if (handle.kind === 'directory') {
        items.push(...await walkDirectory(handle, fullPath));
      }
    }
    return items;
  }

  async function pickDirectory() {
    assertFsAccess();
    let handle;
    try {
      handle = await window.showDirectoryPicker();
    } catch (error) {
      if (/user gesture/i.test(String(error?.message || ''))) {
        throw new Error('Directory access requires a direct user gesture. Ask the user to click "Authorize Folder" in the Files panel.');
      }
      throw error;
    }
    const rootId = registerRoot(handle, handle.name);
    const entries = await collectEntries(handle);
    return formatToolResult('fs_pick_directory', `Root: ${rootId}\nEntries: ${entries.length}\n${entries.map(item => `${item.kind}: ${item.name}`).join('\n')}`);
  }

  async function authorizeFolder() {
    const roots = [...state.roots.keys()];
    if (roots.length) {
      const body = [
        `Authorized roots: ${roots.join(', ')}`,
        `Default root: ${state.defaultRootId || roots[0]}`,
        'You can proceed with fs_list_dir or fs_read_file using one of these roots.'
      ].join('\n');
      return formatToolResult('fs_authorize_folder', body);
    }

    return formatToolResult(
      'fs_authorize_folder',
      [
        'No folder is authorized yet.',
        'Action required: click "Authorize Folder" in the Files panel (user gesture required by browser security).',
        'After authorizing, call fs_list_roots and then fs_list_dir to continue.'
      ].join('\n')
    );
  }

  async function listDirectory({ path = '' }) {
    const { rootId, handle } = await resolveDirectory(path);
    const entries = await collectEntries(handle);
    return formatToolResult('fs_list_dir', `Root: ${rootId}\nPath: ${path || '/'}\n${entries.map(item => `${item.kind}: ${item.name}`).join('\n') || '(empty)'}`);
  }

  async function readLocalFile({ path, offset = 0, length = 12000 }) {
    const { handle } = await resolveFile(path, false);
    const text = await readFileAsText(handle);
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLength = Math.min(20000, Math.max(500, Number(length) || 12000));
    const chunk = text.slice(safeOffset, safeOffset + safeLength);
    const nextOffset = safeOffset + chunk.length;
    const hasMore = nextOffset < text.length;

    const header = [
      `Path: ${path}`,
      `Offset: ${safeOffset}`,
      `Returned chars: ${chunk.length}`,
      `Total chars: ${text.length}`,
      `Has more: ${hasMore ? 'yes' : 'no'}`,
      `Next offset: ${hasMore ? nextOffset : safeOffset}`
    ].join('\n');

    return formatToolResult(`fs_read_file ${path}`, `${header}\n\n${chunk}`);
  }

  async function pickUpload() {
    if (!window.showOpenFilePicker) {
      throw new Error('Open file picker is not supported in this browser.');
    }

    const handles = await window.showOpenFilePicker({ multiple: true });
    const names = [];
    for (const handle of handles) {
      state.uploads.set(handle.name, handle);
      names.push(handle.name);
    }

    return formatToolResult('fs_upload_pick', names.length ? names.join('\n') : 'No files selected.');
  }

  async function downloadFile({ path, content = '', filename = '' }) {
    let blob;
    let resolvedName = filename;

    if (path) {
      const { handle, fileName } = await resolveFile(path, false);
      const file = await handle.getFile();
      blob = file;
      resolvedName = resolvedName || fileName;
    } else {
      blob = new Blob([String(content)], { type: 'text/plain;charset=utf-8' });
      resolvedName = resolvedName || 'download.txt';
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = resolvedName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    return formatToolResult('fs_download_file', `Triggered browser download for ${resolvedName}`);
  }

  async function previewFile({ path }) {
    const { handle, fileName } = await resolveFile(path, false);
    const file = await handle.getFile();
    const type = file.type || 'application/octet-stream';

    if (type.startsWith('image/')) {
      return formatToolResult('fs_preview_file', `Image preview available\nName: ${fileName}\nType: ${type}\nSize: ${file.size} bytes`);
    }

    if (type === 'application/pdf') {
      return formatToolResult('fs_preview_file', `PDF preview available\nName: ${fileName}\nSize: ${file.size} bytes`);
    }

    if (supportsTextPreview(fileName)) {
      return formatToolResult('fs_preview_file', (await file.text()).slice(0, 4000));
    }

    return formatToolResult('fs_preview_file', `Preview metadata only\nName: ${fileName}\nType: ${type}\nSize: ${file.size} bytes`);
  }

  async function searchByName({ path = '', pattern }) {
    const { handle } = await resolveDirectory(path);
    const entries = await walkDirectory(handle, path || '');
    const needle = String(pattern || '').toLowerCase();
    const matches = entries.filter(item => item.path.toLowerCase().includes(needle)).slice(0, 100);

    return formatToolResult('fs_search_name', matches.length ? matches.map(item => `${item.kind}: ${item.path}`).join('\n') : 'No matches.');
  }

  async function searchByContent({ path = '', pattern }) {
    const { handle } = await resolveDirectory(path);
    const entries = await walkDirectory(handle, path || '');
    const needle = String(pattern || '');
    const matches = [];

    for (const entry of entries) {
      if (entry.kind !== 'file' || !supportsTextPreview(entry.handle.name)) continue;
      const text = await readFileAsText(entry.handle);
      if (text.includes(needle)) {
        matches.push(entry.path);
      }
      if (matches.length >= 50) break;
    }

    return formatToolResult('fs_search_content', matches.length ? matches.join('\n') : 'No content matches.');
  }

  function escapeRegexLiteral(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function globPatternToRegExp(pattern) {
    const source = String(pattern || '**/*').replace(/\\/g, '/').trim() || '**/*';
    let out = '^';

    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      const next = source[i + 1];

      if (ch === '*' && next === '*') {
        out += '.*';
        i += 1;
        continue;
      }

      if (ch === '*') {
        out += '[^/]*';
        continue;
      }

      if (ch === '?') {
        out += '[^/]';
        continue;
      }

      out += escapeRegexLiteral(ch);
    }

    out += '$';
    return new RegExp(out, 'i');
  }

  async function globPaths({ path = '', pattern = '**/*', includeDirectories = false, maxResults = 200 }) {
    const { handle } = await resolveDirectory(path);
    const entries = await walkDirectory(handle, path || '');
    const matcher = globPatternToRegExp(pattern);
    const limit = Math.max(1, Math.min(1000, Number(maxResults) || 200));

    const matches = [];
    for (const entry of entries) {
      if (!includeDirectories && entry.kind !== 'file') continue;
      const normalizedPath = String(entry.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!normalizedPath) continue;
      if (!matcher.test(normalizedPath)) continue;
      matches.push(`${entry.kind}: /${normalizedPath}`);
      if (matches.length >= limit) break;
    }

    return formatToolResult(
      'fs_glob',
      `Path: ${path || '/'}\nPattern: ${pattern}\nMatches: ${matches.length}\n\n${matches.join('\n') || '(no matches)'}`
    );
  }

  async function grepPaths({ path = '', pattern, isRegexp = false, caseSensitive = false, maxResults = 200 }) {
    const rawPattern = String(pattern || '');
    if (!rawPattern.trim()) {
      throw new Error('grep requires a non-empty pattern.');
    }

    const flags = caseSensitive ? 'g' : 'gi';
    const matcher = new RegExp(isRegexp ? rawPattern : escapeRegexLiteral(rawPattern), flags);
    const { handle } = await resolveDirectory(path);
    const entries = await walkDirectory(handle, path || '');
    const limit = Math.max(1, Math.min(1000, Number(maxResults) || 200));
    const results = [];

    for (const entry of entries) {
      if (entry.kind !== 'file' || !supportsTextPreview(entry.handle.name)) continue;
      const text = await readFileAsText(entry.handle);
      const lines = String(text || '').split(/\r?\n/);

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        matcher.lastIndex = 0;
        if (!matcher.test(line)) continue;
        results.push(`${entry.path}:${i + 1}: ${line.slice(0, 220)}`);
        if (results.length >= limit) break;
      }

      if (results.length >= limit) break;
    }

    return formatToolResult(
      'fs_grep',
      `Path: ${path || '/'}\nPattern: ${rawPattern}\nMatches: ${results.length}\n\n${results.join('\n') || '(no matches)'}`
    );
  }

  async function editLocalFile({ path, oldText, newText, replaceAll = false }) {
    const targetPath = String(path || '').trim();
    if (!targetPath) throw new Error('file_edit requires a path.');

    const before = String(oldText ?? '');
    if (!before.length) throw new Error('file_edit requires oldText.');

    const replacement = String(newText ?? '');
    const { handle } = await resolveFile(targetPath, false);
    const content = await readFileAsText(handle);
    if (!String(content).includes(before)) {
      throw new Error('file_edit could not find oldText in file.');
    }

    const updated = replaceAll
      ? String(content).split(before).join(replacement)
      : String(content).replace(before, replacement);

    await writeFile(handle, updated);

    return formatToolResult(
      'file_edit',
      `Edited file: ${targetPath}\nReplace all: ${replaceAll ? 'yes' : 'no'}\nOld length: ${before.length}\nNew length: ${replacement.length}`
    );
  }

  function loadTodos() {
    try {
      const stored = JSON.parse(localStorage.getItem(TODOS_STORAGE_KEY) || '[]');
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  function saveTodos(todos) {
    localStorage.setItem(TODOS_STORAGE_KEY, JSON.stringify(todos));
  }

  async function todoWrite({ items, text }) {
    const now = new Date().toISOString();
    let normalizedItems = [];

    if (Array.isArray(items)) {
      normalizedItems = items
        .map(item => {
          if (typeof item === 'string') {
            return { text: item.trim(), status: 'todo' };
          }

          const value = item && typeof item === 'object' ? item : null;
          const itemText = String(value?.text || value?.title || '').trim();
          const status = String(value?.status || 'todo').trim() || 'todo';
          if (!itemText) return null;
          return { text: itemText, status };
        })
        .filter(Boolean);
    } else {
      const lines = String(text || '')
        .split(/\r?\n/)
        .map(line => line.replace(/^\s*[-*\d.\[\]xX]+\s*/, '').trim())
        .filter(Boolean);
      normalizedItems = lines.map(line => ({ text: line, status: 'todo' }));
    }

    if (!normalizedItems.length) {
      throw new Error('todo_write requires non-empty items or text.');
    }

    const next = normalizedItems.map((item, index) => ({
      id: `todo_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
      text: item.text,
      status: item.status,
      createdAt: now,
      updatedAt: now
    }));

    saveTodos(next);

    return formatToolResult(
      'todo_write',
      `Saved ${next.length} todo item(s).\n\n${next.map((item, index) => `${index + 1}. [${item.status}] ${item.text}`).join('\n')}`
    );
  }

  function loadTasks() {
    try {
      const stored = JSON.parse(localStorage.getItem(TASKS_STORAGE_KEY) || '[]');
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  function saveTasks(tasks) {
    localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
  }

  function normalizeTaskStatus(status) {
    const value = String(status || 'todo').toLowerCase().trim();
    if (['todo', 'in_progress', 'done', 'blocked'].includes(value)) return value;
    return 'todo';
  }

  async function taskCreate(args = {}) {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('task_create requires title.');

    const tasks = loadTasks();
    const now = new Date().toISOString();
    const task = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      description: String(args.description || '').trim(),
      status: normalizeTaskStatus(args.status),
      createdAt: now,
      updatedAt: now
    };

    tasks.unshift(task);
    saveTasks(tasks);
    return formatToolResult('task_create', JSON.stringify(task, null, 2));
  }

  async function taskGet({ id }) {
    const taskId = String(id || '').trim();
    if (!taskId) throw new Error('task_get requires id.');
    const task = loadTasks().find(item => item.id === taskId);
    if (!task) throw new Error(`task_get: task not found (${taskId}).`);
    return formatToolResult('task_get', JSON.stringify(task, null, 2));
  }

  async function taskList({ status, limit = 50 } = {}) {
    const max = Math.max(1, Math.min(500, Number(limit) || 50));
    const wanted = String(status || '').trim().toLowerCase();
    const tasks = loadTasks()
      .filter(item => !wanted || String(item.status || '').toLowerCase() === wanted)
      .slice(0, max);

    return formatToolResult(
      'task_list',
      tasks.length
        ? tasks.map((item, index) => `${index + 1}. ${item.id} | [${item.status}] ${item.title}`).join('\n')
        : '(no tasks)'
    );
  }

  async function taskUpdate(args = {}) {
    const taskId = String(args.id || '').trim();
    if (!taskId) throw new Error('task_update requires id.');

    const tasks = loadTasks();
    const index = tasks.findIndex(item => item.id === taskId);
    if (index < 0) throw new Error(`task_update: task not found (${taskId}).`);

    const current = tasks[index];
    const next = {
      ...current,
      ...(args.title !== undefined ? { title: String(args.title || '').trim() } : {}),
      ...(args.description !== undefined ? { description: String(args.description || '').trim() } : {}),
      ...(args.status !== undefined ? { status: normalizeTaskStatus(args.status) } : {}),
      updatedAt: new Date().toISOString()
    };

    tasks[index] = next;
    saveTasks(tasks);
    return formatToolResult('task_update', JSON.stringify(next, null, 2));
  }

  async function askUserQuestion({ question, options }) {
    const prompt = String(question || '').trim();
    if (!prompt) throw new Error('ask_user_question requires question.');
    const optionList = Array.isArray(options) ? options.map(item => `- ${String(item)}`).join('\n') : '';

    return formatToolResult(
      'ask_user_question',
      `Question for user:\n${prompt}${optionList ? `\n\nOptions:\n${optionList}` : ''}\n\nRuntime note: direct interactive prompt tool is not available in this browser runtime. Ask the user in chat and continue after they reply.`
    );
  }

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

  async function writeTextFile({ path, content }) {
    if (!supportsFsAccess()) {
      const fallbackName = String(path || 'download.txt').split(/[\\/]/).pop() || 'download.txt';
      return downloadFile({ content, filename: fallbackName });
    }

    const { handle } = await resolveFile(path, true);
    await writeFile(handle, String(content || ''));
    return formatToolResult('fs_write_file', `Wrote file: ${path}`);
  }
  async function copyFile({ sourcePath, destinationPath }) {
    const source = await resolveFile(sourcePath, false);
    const destination = await resolveFile(destinationPath, true);
    await writeFile(destination.handle, await readFileAsText(source.handle));
    return formatToolResult('fs_copy_file', `Copied ${sourcePath} -> ${destinationPath}`);
  }

  async function deletePath({ path, recursive = true }) {
    const parsed = parseVirtualPath(path);
    if (!parsed.segments.length) throw new Error('Refusing to delete the root directory.');

    const name = parsed.segments.pop();
    const parentPath = parsed.rootId ? `${parsed.rootId}:/${parsed.segments.join('/')}` : parsed.segments.join('/');
    const { handle: parent } = await resolveDirectory(parentPath, false);
    await parent.removeEntry(name, { recursive: !!recursive });
    return formatToolResult('fs_delete_path', `Deleted: ${path}`);
  }

  async function moveFile({ sourcePath, destinationPath }) {
    await copyFile({ sourcePath, destinationPath });
    await deletePath({ path: sourcePath, recursive: false });
    return formatToolResult('fs_move_file', `Moved ${sourcePath} -> ${destinationPath}`);
  }

  async function renamePath({ path, newName }) {
    const parsed = parseVirtualPath(path);
    if (!parsed.segments.length) throw new Error('A path is required.');
    const currentName = parsed.segments[parsed.segments.length - 1];
    parsed.segments[parsed.segments.length - 1] = newName;
    const destination = `${parsed.rootId}:/${parsed.segments.join('/')}`;
    const source = `${parsed.rootId}:/${[...parsed.segments.slice(0, -1), currentName].join('/')}`;
    return moveFile({ sourcePath: source, destinationPath: destination });
  }

  async function listRoots() {
    const roots = [...state.roots.keys()];
    if (!roots.length) {
      return formatToolResult('fs_list_roots', '(no roots selected)\nTip: call fs_authorize_folder for the next authorization step.');
    }

    const lines = roots.map(rootId => {
      const marker = rootId === state.defaultRootId ? ' (default)' : '';
      return `${rootId}${marker}`;
    });
    return formatToolResult('fs_list_roots', lines.join('\n'));
  }

  async function fileExists({ path }) {
    try {
      await resolveFile(path, false);
      return formatToolResult('fs_exists', `${path} = true`);
    } catch {
      try {
        await resolveDirectory(path, false);
        return formatToolResult('fs_exists', `${path} = true (directory)`);
      } catch {
        return formatToolResult('fs_exists', `${path} = false`);
      }
    }
  }

  async function statPath({ path }) {
    try {
      const { handle, fileName } = await resolveFile(path, false);
      const file = await handle.getFile();
      return formatToolResult('fs_stat', `Path: ${path}\nKind: file\nName: ${fileName}\nSize: ${file.size} bytes\nType: ${file.type || 'unknown'}\nLast modified: ${new Date(file.lastModified).toISOString()}`);
    } catch {
      const { handle } = await resolveDirectory(path, false);
      const entries = await collectEntries(handle);
      return formatToolResult('fs_stat', `Path: ${path || '/'}\nKind: directory\nEntries: ${entries.length}`);
    }
  }

  async function makeDirectory({ path }) {
    await resolveDirectory(path, true);
    return formatToolResult('fs_mkdir', `Created directory: ${path}`);
  }

  async function touchFile({ path }) {
    const { handle } = await resolveFile(path, true);
    const file = await handle.getFile();
    if (file.size === 0) {
      return formatToolResult('fs_touch', `Touched file: ${path}`);
    }
    return formatToolResult('fs_touch', `File already exists: ${path}`);
  }

  async function directoryTree({ path = '' }) {
    const { handle } = await resolveDirectory(path, false);
    const entries = await walkDirectory(handle, path || '');
    const lines = entries.slice(0, 200).map(entry => `${entry.kind}: ${entry.path}`);
    return formatToolResult('fs_tree', lines.join('\n') || '(empty)');
  }

  async function savePickedUpload({ uploadName, destinationPath }) {
    const handle = state.uploads.get(String(uploadName || ''));
    if (!handle) {
      throw new Error('Upload not found in session. Run fs_upload_pick first.');
    }

    const file = await handle.getFile();
    const destination = await resolveFile(destinationPath, true);
    await writeFile(destination.handle, await file.arrayBuffer());
    return formatToolResult('fs_save_upload', `Saved upload ${uploadName} -> ${destinationPath}`);
  }

  const registry = {
    web_search: {
      name: 'web_search',
      description: 'Performs live search skills and returns concise findings.',
      retries: 1,
      run: (args = {}, context = {}) => {
        const recoveredQuery = deriveWebSearchQuery(args?.query, context);
        return runSearchSkills(recoveredQuery);
      }
    },
    read_page: {
      name: 'read_page',
      description: 'Fetches and extracts readable page content from a URL.',
      retries: 1,
      run: ({ url }) => fetchReadablePage(url).then(text => formatToolResult(`read_page ${url}`, text))
    },
    geo_current_location: {
      name: 'geo_current_location',
      description: 'Gets the current browser geolocation coordinates.',
      retries: 1,
      run: () => getCurrentLocation()
    },
    weather_current: {
      name: 'weather_current',
      description: 'Gets the current weather for the current or provided coordinates.',
      retries: 1,
      run: args => getCurrentWeather(args),
      fallbacks: ['geo_current_location']
    },
    http_fetch: {
      name: 'http_fetch',
      description: 'Fetches an HTTP resource and returns a readable response preview.',
      retries: 1,
      run: args => fetchHttpResource(args)
    },
    web_fetch: {
      name: 'web_fetch',
      description: 'Alias of http_fetch for src compatibility.',
      retries: 1,
      run: args => fetchHttpResource(args)
    },
    extract_links: {
      name: 'extract_links',
      description: 'Extracts links from a URL or a block of text.',
      retries: 1,
      run: args => extractLinks(args)
    },
    page_metadata: {
      name: 'page_metadata',
      description: 'Extracts title and metadata from a web page.',
      retries: 1,
      run: args => getPageMetadata(args)
    },
    parse_json: {
      name: 'parse_json',
      description: 'Validates and pretty-prints JSON input.',
      retries: 1,
      run: args => parseJsonText(args)
    },
    parse_csv: {
      name: 'parse_csv',
      description: 'Parses CSV text and returns a structured preview.',
      retries: 1,
      run: args => parseCsvText(args)
    },
    clipboard_read: {
      name: 'clipboard_read',
      description: 'Reads text from the system clipboard when supported.',
      retries: 1,
      run: () => clipboardRead()
    },
    clipboard_write: {
      name: 'clipboard_write',
      description: 'Writes text to the system clipboard when supported.',
      retries: 1,
      run: args => clipboardWrite(args)
    },
    storage_list_keys: {
      name: 'storage_list_keys',
      description: 'Lists localStorage keys available to the app.',
      retries: 1,
      run: () => listStorageKeys()
    },
    storage_get: {
      name: 'storage_get',
      description: 'Reads a value from localStorage.',
      retries: 1,
      run: args => storageGet(args)
    },
    storage_set: {
      name: 'storage_set',
      description: 'Writes a value to localStorage.',
      retries: 1,
      run: args => storageSet(args)
    },
    notification_request_permission: {
      name: 'notification_request_permission',
      description: 'Requests native browser notification permission from the user. Use once before sending notifications if permission is still unknown.',
      retries: 1,
      run: () => requestNotificationPermission()
    },
    notification_send: {
      name: 'notification_send',
      description: 'Sends a native browser notification. Use when a long task finishes, when an important result needs attention, or when the user explicitly asks to be notified.',
      retries: 1,
      run: args => sendNotification(args)
    },
    tab_broadcast: {
      name: 'tab_broadcast',
      description: 'Publishes a message to other open tabs running this agent. Use to share results or coordinate work across multiple windows.',
      retries: 1,
      run: args => tabBroadcast(args)
    },
    tab_listen: {
      name: 'tab_listen',
      description: 'Waits for a broadcast message on a specific topic from another tab and returns the payload or a timeout error.',
      retries: 1,
      run: args => tabListen(args)
    },
    fs_list_roots: {
      name: 'fs_list_roots',
      description: 'Lists the currently selected local directory roots.',
      retries: 1,
      run: () => listRoots()
    },
    fs_authorize_folder: {
      name: 'fs_authorize_folder',
      description: 'Reports folder authorization status and tells the user how to authorize a directory from the Files panel when needed.',
      retries: 1,
      run: () => authorizeFolder()
    },
    fs_pick_directory: {
      name: 'fs_pick_directory',
      description: 'Prompts the user to pick a local directory root for direct file operations. This must be triggered from a direct user gesture, such as clicking the Authorize Folder button in the Files panel.',
      retries: 1,
      run: () => pickDirectory()
    },
    fs_list_dir: {
      name: 'fs_list_dir',
      description: 'Lists entries inside a selected local directory.',
      retries: 1,
      run: args => listDirectory(args),
      fallbacks: ['fs_authorize_folder', 'fs_pick_directory']
    },
    fs_read_file: {
      name: 'fs_read_file',
      description: 'Opens and reads a local file as text, with optional chunking via offset and length.',
      retries: 1,
      run: args => readLocalFile(args)
    },
    fs_upload_pick: {
      name: 'fs_upload_pick',
      description: 'Opens the browser upload picker and registers selected files for the session.',
      retries: 1,
      run: () => pickUpload()
    },
    fs_download_file: {
      name: 'fs_download_file',
      description: 'Triggers a browser download from content or a local file path; use this when direct filesystem access is unavailable or when the user asks to export/download a file.',
      retries: 1,
      run: args => downloadFile(args)
    },
    fs_preview_file: {
      name: 'fs_preview_file',
      description: 'Returns preview information or text preview for a supported local file.',
      retries: 1,
      run: args => previewFile(args)
    },
    fs_search_name: {
      name: 'fs_search_name',
      description: 'Searches local files and folders by name pattern.',
      retries: 1,
      run: args => searchByName(args)
    },
    fs_search_content: {
      name: 'fs_search_content',
      description: 'Searches inside local text files for matching content.',
      retries: 1,
      run: args => searchByContent(args)
    },
    fs_glob: {
      name: 'fs_glob',
      description: 'Matches local paths using glob patterns (*, **, ?).',
      retries: 1,
      run: args => globPaths(args)
    },
    fs_grep: {
      name: 'fs_grep',
      description: 'Searches local file contents and returns path:line matches.',
      retries: 1,
      run: args => grepPaths(args)
    },
    fs_tree: {
      name: 'fs_tree',
      description: 'Recursively lists a local directory tree.',
      retries: 1,
      run: args => directoryTree(args)
    },
    fs_exists: {
      name: 'fs_exists',
      description: 'Checks whether a file or directory exists.',
      retries: 1,
      run: args => fileExists(args)
    },
    fs_stat: {
      name: 'fs_stat',
      description: 'Returns metadata about a file or directory.',
      retries: 1,
      run: args => statPath(args)
    },
    fs_mkdir: {
      name: 'fs_mkdir',
      description: 'Creates a local directory path.',
      retries: 1,
      run: args => makeDirectory(args)
    },
    fs_touch: {
      name: 'fs_touch',
      description: 'Creates an empty file if it does not exist.',
      retries: 1,
      run: args => touchFile(args)
    },
    fs_write_file: {
      name: 'fs_write_file',
      description: 'Creates or overwrites a local text file. If direct filesystem access is unavailable, it falls back to a browser download using the requested filename.',
      retries: 1,
      run: args => writeTextFile(args)
    },
    file_read: {
      name: 'file_read',
      description: 'Alias of fs_read_file for src compatibility.',
      retries: 1,
      run: args => readLocalFile(args)
    },
    read_file: {
      name: 'read_file',
      description: 'Alias of fs_read_file for src compatibility.',
      retries: 1,
      run: args => readLocalFile(args)
    },
    file_write: {
      name: 'file_write',
      description: 'Alias of fs_write_file for src compatibility.',
      retries: 1,
      run: args => writeTextFile(args)
    },
    write_file: {
      name: 'write_file',
      description: 'Alias of fs_write_file for src compatibility.',
      retries: 1,
      run: args => writeTextFile(args)
    },
    file_edit: {
      name: 'file_edit',
      description: 'Edits a local file by replacing oldText with newText.',
      retries: 1,
      run: args => editLocalFile(args)
    },
    edit_file: {
      name: 'edit_file',
      description: 'Alias of file_edit for src compatibility.',
      retries: 1,
      run: args => editLocalFile(args)
    },
    glob: {
      name: 'glob',
      description: 'Alias of fs_glob for src compatibility.',
      retries: 1,
      run: args => globPaths(args)
    },
    grep: {
      name: 'grep',
      description: 'Alias of fs_grep for src compatibility.',
      retries: 1,
      run: args => grepPaths(args)
    },
    todo_write: {
      name: 'todo_write',
      description: 'Stores a todo list in local browser state.',
      retries: 1,
      run: args => todoWrite(args)
    },
    task_create: {
      name: 'task_create',
      description: 'Creates a persisted task record.',
      retries: 1,
      run: args => taskCreate(args)
    },
    task_get: {
      name: 'task_get',
      description: 'Retrieves a persisted task by id.',
      retries: 1,
      run: args => taskGet(args)
    },
    task_list: {
      name: 'task_list',
      description: 'Lists persisted tasks with optional status filter.',
      retries: 1,
      run: args => taskList(args)
    },
    task_update: {
      name: 'task_update',
      description: 'Updates an existing persisted task.',
      retries: 1,
      run: args => taskUpdate(args)
    },
    ask_user_question: {
      name: 'ask_user_question',
      description: 'Asks the user for clarification in chat-friendly format.',
      retries: 1,
      run: args => askUserQuestion(args)
    },
    tool_search: {
      name: 'tool_search',
      description: 'Searches available tools by name and description.',
      retries: 1,
      run: args => toolSearch(args)
    },
    fs_copy_file: {
      name: 'fs_copy_file',
      description: 'Copies a local file from one path to another.',
      retries: 1,
      run: args => copyFile(args)
    },
    fs_move_file: {
      name: 'fs_move_file',
      description: 'Moves a local file from one path to another.',
      retries: 1,
      run: args => moveFile(args)
    },
    fs_delete_path: {
      name: 'fs_delete_path',
      description: 'Deletes a local file or directory under the selected root.',
      retries: 1,
      run: args => deletePath(args)
    },
    fs_rename_path: {
      name: 'fs_rename_path',
      description: 'Renames a local file or directory.',
      retries: 1,
      run: args => renamePath(args)
    },
    fs_save_upload: {
      name: 'fs_save_upload',
      description: 'Saves a previously picked upload into the selected local directory.',
      retries: 1,
      run: args => savePickedUpload(args)
    }
  };

  window.AgentSkills = {
    state,
    registry,
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

