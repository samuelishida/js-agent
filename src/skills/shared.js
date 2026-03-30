(() => {
  const state = {
    roots: new Map(),
    defaultRootId: null,
    uploads: new Map()
  };
  const instanceId = Math.random().toString(36).slice(2);
  const AGENT_CHANNEL = 'loopagent-v1';
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

    return {
      recommendedTools: [...new Set(plan)],
      hints
    };
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

  async function fetchJsonWithTimeout(url, timeoutMs = 6000) {
    const res = await window.fetchWithTimeout(url, { cache: 'no-store' }, timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function normalizeSearchQuery(query) {
    return String(query || '')
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

  function buildSearchQueryVariants(query) {
    const original = String(query || '').trim();
    const normalized = normalizeSearchQuery(query);
    const variants = [original, normalized];

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

    return [...new Set(variants.filter(Boolean))].slice(0, 4);
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
    const domains = ['pt.wikipedia.org', 'en.wikipedia.org'];
    const seen = new Set();
    const entries = [];

    for (const domain of domains) {
      for (const variant of variants) {
        const url = `https://${domain}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(variant)}&srlimit=3&utf8=1&format=json&origin=*`;
        const data = await fetchJsonWithTimeout(url, 6000);
        const hits = Array.isArray(data?.query?.search) ? data.query.search : [];

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

        if (entries.length >= 6) break;
      }

      if (entries.length >= 6) break;
    }

    return entries.length ? formatToolResult('Wikipedia search', entries.join('\n\n')) : null;
  }

  async function searchWikidata(query) {
    const variants = buildSearchQueryVariants(query);
    const seen = new Set();
    const entries = [];

    for (const language of ['pt', 'en']) {
      for (const variant of variants) {
        const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(variant)}&language=${language}&limit=5&format=json&origin=*`;
        const data = await fetchJsonWithTimeout(url, 6000);
        const hits = Array.isArray(data?.search) ? data.search : [];

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

        if (entries.length >= 6) break;
      }

      if (entries.length >= 6) break;
    }

    return entries.length ? formatToolResult('Wikidata search', entries.join('\n\n')) : null;
  }

  async function searchDuckDuckGo(query) {
    const variants = buildSearchQueryVariants(query);
    const seen = new Set();
    const entries = [];

    for (const variant of variants) {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(variant)}&format=json&no_html=1&no_redirect=1&skip_disambig=1`;
      const data = await fetchJsonWithTimeout(url, 6000);

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
    }

    return entries.length ? formatToolResult('DuckDuckGo search', entries.join('\n\n')) : null;
  }

  async function runSearchSkills(query) {
    const diagnostics = [];
    const runners = [
      { name: 'weather_current', run: () => detectWeatherIntent(query) ? getCurrentWeather({}) : null },
      { name: 'fx_rate', run: () => searchFxRate(query) },
      { name: 'duckduckgo', run: () => searchDuckDuckGo(query) },
      { name: 'wikipedia', run: () => searchWikipedia(query) },
      { name: 'wikidata', run: () => searchWikidata(query) }
    ];
    const results = [];

    for (const runner of runners) {
      try {
        const result = await runner.run();
        if (result) {
          results.push(result);
          diagnostics.push(`${runner.name}: ok`);
        } else {
          diagnostics.push(`${runner.name}: no match`);
        }
      } catch (error) {
        diagnostics.push(`${runner.name}: ${error.message || 'failed'}`);
      }
    }

    if (!results.length) {
      throw new Error(`No search providers returned usable results. Diagnostics: ${diagnostics.join('; ')}`);
    }

    return [results.join('\n\n'), formatToolResult('Search diagnostics', diagnostics.join('\n'))].join('\n\n');
  }
  async function fetchReadablePage(url) {
    const normalizedUrl = String(url || '').trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      throw new Error('Invalid URL. Use a full http:// or https:// address.');
    }

    try {
      const res = await window.fetchWithTimeout(normalizedUrl, { cache: 'no-store' }, 6000);
      if (res.ok) {
        const type = res.headers.get('content-type') || '';
        const raw = await res.text();
        const text = type.includes('html') ? stripHtmlToText(raw) : raw.trim();
        if (text) return text.slice(0, 8000);
      }
    } catch {}

    const readerUrl = `https://r.jina.ai/http://${normalizedUrl.replace(/^https?:\/\//i, '')}`;
    const proxyRes = await window.fetchWithTimeout(readerUrl, { cache: 'no-store' }, 10000);
    if (!proxyRes.ok) throw new Error(`Reader proxy failed with HTTP ${proxyRes.status}`);
    const text = (await proxyRes.text()).trim();
    if (!text) throw new Error('No readable content returned.');
    return text.slice(0, 8000);
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

    const res = await window.fetchWithTimeout(normalizedUrl, { method, cache: 'no-store' }, 10000);
    const contentType = res.headers.get('content-type') || 'unknown';
    const raw = await res.text();
    const body = contentType.includes('html') ? stripHtmlToText(raw).slice(0, 8000) : raw.slice(0, 8000);

    return formatToolResult(
      'http_fetch',
      `URL: ${normalizedUrl}\nStatus: ${res.status}\nContent-Type: ${contentType}\n\n${body}`
    );
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

  async function tabBroadcast({ topic, payload }) {
    if (!topic) {
      throw new Error('tab_broadcast: topic is required.');
    }

    const channel = getBroadcastChannel();
    channel.postMessage({
      topic: String(topic),
      payload: payload ?? null,
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
      const timer = window.setTimeout(() => {
        callbacks.delete(onMessage);
        reject(new Error(`tab_listen: no message on "${normalizedTopic}" within ${waitMs}ms.`));
      }, waitMs);

      function onMessage(payload) {
        window.clearTimeout(timer);
        callbacks.delete(onMessage);
        resolve(formatToolResult(
          'tab_listen',
          `Topic: ${normalizedTopic}\nPayload: ${JSON.stringify(payload ?? null, null, 2).slice(0, 2000)}`
        ));
      }

      callbacks.add(onMessage);
    });
  }

  async function buildInitialContext(userMessage) {
    const blocks = [];
    const preflight = buildPreflightPlan(userMessage);
    const pair = detectFxPair(userMessage);

    blocks.push(formatToolResult(
      'preflight',
      `Recommended tools: ${preflight.recommendedTools.join(', ') || 'none'}\n${preflight.hints.join('\n')}`
    ));

    if (pair) {
      try {
        const fx = await searchFxRate(userMessage);
        if (fx) blocks.push(fx);
      } catch {}
    }

    for (const url of extractEntities(userMessage).urls.slice(0, 1)) {
      try {
        const page = await fetchReadablePage(url);
        blocks.push(formatToolResult(`Prefetched page ${url}`, page));
      } catch {}
    }

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
      run: ({ query }) => runSearchSkills(query)
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
    instanceId,
    state,
    registry,
    extractEntities,
    detectFxPair,
    formatToolResult,
    buildPreflightPlan,
    runSearchSkills,
    fetchReadablePage,
    buildInitialContext
  };
})();

