// src/tools/tool-planner.js
// Query planning: LLM-based intent optimization, normalization, merging.
// Reads from window.AgentToolCore (intentCore, toolMetaCore).
// Publishes: window.AgentToolPlanner

(() => {
  'use strict';

  const toolCore = window.AgentToolCore || {};
  const intentCore = toolCore.intents || {};
  const toolMetaCore = toolCore.toolMeta || {};

  const {
    detectWeatherIntent = () => false
  } = intentCore;

  const {
    classifyRecommendedTools = tools => ({
      safe: [], write: [], other: Array.isArray(tools) ? [...tools] : [], riskLevel: 'normal'
    })
  } = toolMetaCore;

  function parseJsonObjectFromText(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? String(fenced[1] || '').trim() : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
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
      ...Object.keys(window.AgentTools?.registry || {}),
      ...(Array.isArray(fallbackTools) ? fallbackTools : []),
      'web_search', 'weather_current', 'geo_current_location',
      'read_page', 'page_metadata', 'extract_links'
    ]);
    return [...new Set(source.map(item => String(item || '').trim()).filter(Boolean).filter(item => allowed.has(item)))];
  }

  async function planPreflightWithLlm(userMessage, preflight) {
    const text = String(userMessage || '').trim();
    if (!text) return null;

    const llm = typeof window.callLLM === 'function' ? window.callLLM : (typeof callLLM === 'function' ? callLLM : null);
    if (!llm) return null;

    const currentTools = Array.isArray(preflight?.recommendedTools) ? preflight.recommendedTools : [];
    const currentHints = Array.isArray(preflight?.hints) ? preflight.hints.slice(0, 6) : [];

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
      let timeoutId;
      const raw = await Promise.race([
        llm(
          [
            { role: 'system', content: 'You optimize intent detection and web search query quality for a tool-calling agent. Output strict JSON only.' },
            { role: 'user', content: prompt }
          ],
          { maxTokens: 220, temperature: 0.1, timeoutMs: 9000, retries: 0 }
        ),
        new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('timeout 9600ms')), 9600); })
      ]);
      clearTimeout(timeoutId);

      const parsed = parseJsonObjectFromText(raw);
      if (!parsed || typeof parsed !== 'object') return null;

      const confidenceValue = Number(parsed.confidence);
      const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0;
      const intent = normalizePlannerIntent(parsed.intent);
      const optimizedQuery = normalizePlannerQuery(parsed.optimized_query);
      const recommendedTools = normalizePlannerTools(parsed.recommended_tools, currentTools);
      const notes = String(parsed.notes || '').replace(/\s{2,}/g, ' ').trim().slice(0, 180);

      if (!optimizedQuery && !recommendedTools.length && intent === 'other') return null;

      return { intent, confidence, optimizedQuery, recommendedTools, notes };
    } catch { return null; }
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

    if (planner.notes) hints.push(`Planner note: ${planner.notes}`);
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

  window.AgentToolPlanner = {
    parseJsonObjectFromText,
    normalizePlannerIntent,
    normalizePlannerQuery,
    normalizePlannerTools,
    planPreflightWithLlm,
    mergePlannerIntoPreflight
  };
})();