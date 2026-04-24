(() => {
  window.AgentSkillModules = window.AgentSkillModules || {};

  window.AgentSkillModules.createWebRuntime = function createWebRuntime({
    formatToolResult,
    detectFxPair = () => null,
    detectWeatherIntent = () => false,
    detectRecencyIntent = () => false,
    detectCodingIntent = () => false,
    detectBiographicalFactIntent = () => false
  } = {}) {
    if (typeof formatToolResult !== 'function') {
      throw new Error('createWebRuntime requires formatToolResult.');
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

    function willTriggerPreflight(init = {}) {
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

    function makePreflightSafeHeaders(headers = {}) {
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
      const headers = init.headers || {};
      const hasCustomHeaders = willTriggerPreflight(init);

      if (hasCustomHeaders) {
        const safeHeaders = makePreflightSafeHeaders(headers);
        console.debug('Preflight detected: retrying with safe headers');
        try {
          const res = await window.fetchWithTimeout(url, { cache: 'no-store', ...init, headers: safeHeaders }, timeoutMs);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        } catch (error) {
          console.debug(`Safe headers attempt failed: ${error.message}, retrying with original headers`);
        }
      }

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

    async function retryWithBackoff(fn, maxAttempts = 3, baseDelayMs = 100) {
      let lastError;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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
          // Google News blocks direct browser requests (CORS + 403).
          // Route through the same-origin dev-server proxy at /api/gnews.
          const rssPath = `/rss/search?q=${encodeURIComponent(terms)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
          const proxyUrl = new URL(`/api/gnews${rssPath}`, window.location.origin).toString();
          const res = await window.fetchWithTimeout(proxyUrl, { cache: 'no-store' }, 8000);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          const xml = await res.text();
          const doc = new DOMParser().parseFromString(xml, 'text/xml');
          const items = [...doc.querySelectorAll('item')].slice(0, 6);

          console.debug(`Google News: found ${items.length} articles`);

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

    async function searchGithubRepositories(query) {
      const terms = String(query || '').replace(/[+]/g, ' ').trim();
      if (!terms) return null;

      try {
        const githubToken = window.localStorage?.getItem?.('github_token') || '';

        let url = `https://api.github.com/search/repositories?q=${encodeURIComponent(`${terms} in:name,description,readme`)}&sort=stars&order=desc&per_page=6`;
        let headers = {
          Accept: 'application/vnd.github+json'
        };

        const hasToken = !!githubToken;
        if (hasToken) {
          headers.Authorization = `token ${githubToken}`;
        }

        let res = await window.fetchWithTimeout(url, { cache: 'no-store', headers }, 8000);

        if (hasToken && (!res.ok || res.status === 0)) {
          console.debug('GitHub with token failed, retrying without auth header');
          headers = { Accept: 'application/vnd.github+json' };
          res = await window.fetchWithTimeout(url, { cache: 'no-store', headers }, 8000);
        }

        if (res.status === 401 || res.status === 403) {
          console.debug('GitHub API auth/rate limit:', res.status, '- skipping');
          return null;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        let data = await res.json();
        let repos = Array.isArray(data?.items) ? data.items.slice(0, 6) : [];

        console.debug(`GitHub search for "${terms}": ${repos.length} results (advanced)`);

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
        return null;
      }
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

      // For biographical facts, ensure we get multiple sources even if recency is detected
      const shouldForceMultipleSources = isBioFactQuery && isRecentQuery;
      
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

      console.debug(`Starting web search for: "${originalQuery}"`);
      if (searchQuery !== originalQuery) {
        console.debug(`(as: "${searchQuery}")`);
      }

      for (const runner of runners) {
        if (typeof runner.enabled === 'function' && !runner.enabled()) {
          diagnostics.push(`${runner.name}: skipped (intent mismatch)`);
          console.debug(`${runner.name}: skipped (intent mismatch)`);
          continue;
        }

        try {
          const result = await runner.run();
          if (hasMeaningfulToolBody(result)) {
            results.push({ source: runner.name, content: result });
            diagnostics.push(`${runner.name}: ok`);
            console.debug(`${runner.name}: got results`);
          } else if (result) {
            diagnostics.push(`${runner.name}: empty`);
            console.debug(`${runner.name}: empty result`);
          } else {
            diagnostics.push(`${runner.name}: no match`);
            console.debug(`${runner.name}: no match`);
          }
        } catch (error) {
          const msg = error.message || 'unknown error';
          diagnostics.push(`${runner.name}: warning ${msg}`);
          console.debug(`${runner.name}: ${msg}`);
        }
      }

      console.debug(`Search complete: ${results.length} providers returned results`);

      // For biographical facts with recency, wait for at least 2 non-news sources before returning
      if (shouldForceMultipleSources && results.length > 0) {
        const nonNewsResults = results.filter(entry => !entry.source.includes('news'));
        if (nonNewsResults.length < 2) {
          // Continue running other sources to get more diverse information
          const remainingRunners = runners.filter(runner => 
            !results.some(result => result.source === runner.name) &&
            !['weather_current', 'fx_rate', 'github_repositories'].includes(runner.name)
          );
          
          for (const runner of remainingRunners) {
            if (typeof runner.enabled === 'function' && !runner.enabled()) continue;
            
            try {
              const result = await runner.run();
              if (hasMeaningfulToolBody(result)) {
                results.push({ source: runner.name, content: result });
                diagnostics.push(`${runner.name}: ok (forced for diversity)`);
                console.debug(`${runner.name}: got forced results for diversity`);
                
                // If we now have at least 2 non-news sources, we can break early
                const currentNonNews = results.filter(entry => !entry.source.includes('news'));
                if (currentNonNews.length >= 2) break;
              }
            } catch (error) {
              console.debug(`${runner.name}: forced diversity run failed: ${error.message}`);
            }
          }
        }
      }

      if (!results.length && originalQuery.length > 0) {
        console.debug(`No results found. Trying fallback with original query: "${originalQuery}"`);

        for (const runner of runners) {
          if (typeof runner.enabled === 'function' && !runner.enabled()) continue;
          if (['weather_current', 'fx_rate', 'readable_web_fallback'].includes(runner.name)) continue;

          try {
            console.debug(`Fallback retry: ${runner.name}`);

            let result = null;

            if (runner.name === 'github_repositories' && isCodingQuery) {
              result = await searchGithubRepositories(originalQuery);
            } else if (runner.name === 'readable_web_fallback') {
              result = await searchReadableWebFallback(originalQuery);
            } else if (runner.name === 'duckduckgo') {
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
              } catch (error) {
                console.debug(`DuckDuckGo fallback failed: ${error.message}`);
              }
            } else if (runner.name === 'wikipedia') {
              try {
                const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(originalQuery)}&srlimit=6&format=json&origin=*`;
                const data = await fetchJsonWithTimeout(url, 6000);
                const hits = Array.isArray(data?.query?.search) ? data.query.search : [];
                const entries = hits.slice(0, 3).map((hit, index) => formatSearchEntry(
                  index + 1,
                  hit.title,
                  normalizeSearchSnippet(hit.snippet),
                  `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
                  'wikipedia'
                ));
                if (entries.length) {
                  result = formatToolResult('Wikipedia search (fallback)', entries.join('\n\n'));
                }
              } catch (error) {
                console.debug(`Wikipedia fallback failed: ${error.message}`);
              }
            } else if (runner.name === 'wikidata') {
              try {
                const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(originalQuery)}&language=en&limit=6&format=json&origin=*`;
                const data = await fetchJsonWithTimeout(url, 6000);
                const hits = Array.isArray(data?.search) ? data.search : [];
                const entries = hits.slice(0, 3).map((hit, index) => formatSearchEntry(
                  index + 1,
                  hit.label || hit.id,
                  normalizeSearchSnippet(hit.description || ''),
                  `https://www.wikidata.org/wiki/${encodeURIComponent(hit.id)}`,
                  'wikidata'
                ));
                if (entries.length) {
                  result = formatToolResult('Wikidata search (fallback)', entries.join('\n\n'));
                }
              } catch (error) {
                console.debug(`Wikidata fallback failed: ${error.message}`);
              }
            }

            if (result) {
              results.push({ source: `${runner.name} (fallback)`, content: result });
              diagnostics.push(`${runner.name}: ok (fallback)`);
              console.debug(`${runner.name}: got fallback results`);
            }
          } catch (error) {
            console.debug(`Fallback error: ${error.message}`);
          }
        }
      }

      if (!results.length) {
        const summaryLines = [
          'Search unavailable - all providers failed',
          `Query: "${originalQuery}"`,
          '',
          'Status: check diagnostics below to troubleshoot.',
          '',
          'Provider status:',
          ...diagnostics.map(item => `  - ${item}`),
          '',
          'Troubleshooting:',
          '1. ok = results found successfully',
          '2. empty = provider returned no data (API issue or no results)',
          '3. no match = no matching content found',
          '4. warning = network or API error occurred',
          '',
          'If most or all providers show warning errors:',
          '  - Check your internet connection',
          '  - Wait a moment and try again',
          '  - Try a simpler, shorter query',
          '',
          'If most providers show no match:',
          '  - Your query might be too specific',
          '  - Try searching for something more general',
          '  - Try different keywords'
        ];

        return formatToolResult(
          'Search Diagnostics - All Providers Failed',
          summaryLines.join('\n')
        );
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

      // For biographical facts, prioritize encyclopedic sources over news
      let combinedResults = results.map(entry => entry.content);
      if (isBioFactQuery) {
        const encyclopedicResults = results.filter(entry => 
          ['wikipedia', 'wikidata'].includes(entry.source)
        ).map(entry => entry.content);
        
        const newsResults = results.filter(entry => 
          entry.source.includes('news')
        ).map(entry => entry.content);
        
        const otherResults = results.filter(entry => 
          !['wikipedia', 'wikidata'].includes(entry.source) && !entry.source.includes('news')
        ).map(entry => entry.content);
        
        // Reorder: encyclopedic first, then others, then news
        combinedResults = [...encyclopedicResults, ...otherResults, ...newsResults];
      }

      const verificationBlock = isBioFactQuery && !nonEncyclopedic.length
        ? formatToolResult(
            'Verification warning',
            'Biographical claim detected (for example death/age/birth) but only encyclopedic sources responded. Treat this as unverified and avoid definitive claims until independent reporting confirms it.'
          )
        : '';

      return [
        combinedResults.join('\n\n'),
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
      // Strip common markdown delimiters that can bleed into extracted URLs (e.g. trailing backtick)
      const normalizedUrl = String(url || '').trim().replace(/[`'"]+$/, '');
      if (!/^https?:\/\//i.test(normalizedUrl)) {
        throw new Error('Invalid URL. Use a full http:// or https:// address.');
      }

      try {
        const githubSnapshot = await fetchGithubRepositorySnapshot(normalizedUrl);
        if (githubSnapshot) return githubSnapshot.slice(0, 8000);
      } catch (error) {
        console.debug(`GitHub snapshot failed: ${error.message}`);
      }

      try {
        const res = await window.fetchWithTimeout(normalizedUrl, { cache: 'no-store' }, 7000);
        if (res.ok) {
          const type = res.headers.get('content-type') || '';
          const raw = await res.text();
          const text = type.includes('html') ? stripHtmlToText(raw) : raw.trim();
          if (text) return text.slice(0, 8000);
        }
      } catch (error) {
        console.debug(`Direct fetch failed: ${error.message}`);
      }

      // Never proxy localhost or private-network addresses through an external reader service.
      if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|\[?::1)/i.test(normalizedUrl)) {
        throw new Error(`Cannot reach private URL via external reader proxy: ${normalizedUrl}`);
      }

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
        try {
          const res = await window.fetchWithTimeout(normalizedUrl, { method, cache: 'no-store' }, 10000);
          const contentType = res.headers.get('content-type') || 'unknown';

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

          const readerUrl = `https://r.jina.ai/${normalizedUrl}`;
          const proxyRes = await window.fetchWithTimeout(readerUrl, { cache: 'no-store' }, 15000);

          if (proxyRes.ok) {
            const text = (await proxyRes.text()).trim();
            return formatToolResult(
              'http_fetch (via reader proxy)',
              `URL: ${normalizedUrl}\nStatus: 200 (proxied)\nContent-Type: text/plain\n\n${text.slice(0, 8000)}`
            );
          }

          throw new Error('Direct fetch and reader proxy both failed');
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

    return {
      runSearchSkills,
      searchFxRate,
      fetchReadablePage,
      fetchHttpResource,
      extractLinks,
      getPageMetadata,
      getCurrentLocation,
      getCurrentWeather
    };
  };
})();
