(() => {
  const TOOL_BLOCK = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i;
  const TOOL_BLOCK_GLOBAL = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

  function parseJsonSafely(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function extractJsonString(raw, key) {
    const match = String(raw || '').match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i'));
    if (!match) return undefined;

    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1];
    }
  }

  function tryParseToolObject(raw) {
    const parsed = parseJsonSafely(raw);
    if (parsed?.tool) {
      const parsedArgs = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
        ? parsed.args
        : {
            ...(parsed.path && { path: parsed.path }),
            ...(parsed.url && { url: parsed.url }),
            ...(parsed.query && { query: parsed.query }),
            ...(parsed.expression && { expression: parsed.expression }),
            ...(parsed.text && { text: parsed.text }),
            ...(parsed.offset !== undefined && { offset: parsed.offset }),
            ...(parsed.length !== undefined && { length: parsed.length })
          };

      return {
        tool: String(parsed.tool),
        args: parsedArgs
      };
    }

    const tool = extractJsonString(raw, 'tool');
    if (!tool) return null;

    const argsMatch = String(raw || '').match(/"args"\s*:\s*(\{[\s\S]*\})/i);
    const args = argsMatch ? (parseJsonSafely(argsMatch[1]) || {}) : {};
    return { tool, args };
  }

  function findBalancedJsonObjectWithTool(text) {
    const value = String(text || '');
    const toolIndex = value.search(/"tool"\s*:/i);
    if (toolIndex < 0) return null;

    let start = value.lastIndexOf('{', toolIndex);
    while (start >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let i = start; i < value.length; i++) {
        const ch = value[i];

        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === '\\') {
            escaped = true;
            continue;
          }
          if (ch === '"') {
            inString = false;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }

        if (ch === '{') {
          depth += 1;
          continue;
        }

        if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            const candidate = value.slice(start, i + 1);
            if (/"tool"\s*:/i.test(candidate)) {
              return candidate;
            }
            break;
          }
        }
      }

      start = value.lastIndexOf('{', start - 1);
    }

    return null;
  }

  function extractStandaloneToolCall(text) {
    const value = String(text || '').trim();
    if (!value) return null;

    const unfenced = value.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();

    const direct = tryParseToolObject(unfenced);
    if (direct?.tool) return direct;

    const objectLike = findBalancedJsonObjectWithTool(unfenced);
    if (!objectLike) return null;

    return tryParseToolObject(objectLike);
  }

  function extractToolCall(text) {
    const match = String(text || '').match(TOOL_BLOCK);
    if (!match) {
      return extractStandaloneToolCall(text);
    }

    const parsed = parseJsonSafely(match[1]);
    if (parsed?.tool) return parsed;

    const raw = match[1];
    const tool = extractJsonString(raw, 'tool');
    const query = extractJsonString(raw, 'query');
    const expression = extractJsonString(raw, 'expression');
    const url = extractJsonString(raw, 'url');
    const path = extractJsonString(raw, 'path');
    const sourcePath = extractJsonString(raw, 'sourcePath');
    const destinationPath = extractJsonString(raw, 'destinationPath');
    const pattern = extractJsonString(raw, 'pattern');
    const content = extractJsonString(raw, 'content');
    const filename = extractJsonString(raw, 'filename');
    const uploadName = extractJsonString(raw, 'uploadName');
    const newName = extractJsonString(raw, 'newName');
    const recursive = raw.match(/"recursive"\s*:\s*(true|false)/i)?.[1];
    const key = extractJsonString(raw, 'key');
    const value = extractJsonString(raw, 'value');
    const method = extractJsonString(raw, 'method');
    const textArg = extractJsonString(raw, 'text');
    const latitude = raw.match(/"latitude"\s*:\s*(-?\d+(?:\.\d+)?)/i)?.[1];
    const longitude = raw.match(/"longitude"\s*:\s*(-?\d+(?:\.\d+)?)/i)?.[1];

    if (!tool) return null;

    return {
      tool,
      args: {
        ...(query && { query }),
        ...(expression && { expression }),
        ...(url && { url }),
        ...(path && { path }),
        ...(sourcePath && { sourcePath }),
        ...(destinationPath && { destinationPath }),
        ...(pattern && { pattern }),
        ...(content && { content }),
        ...(filename && { filename }),
        ...(uploadName && { uploadName }),
        ...(newName && { newName }),
        ...(recursive && { recursive: recursive.toLowerCase() === 'true' }),
        ...(key && { key }),
        ...(value && { value }),
        ...(method && { method }),
        ...(textArg && { text: textArg }),
        ...(latitude && { latitude: Number(latitude) }),
        ...(longitude && { longitude: Number(longitude) })
      }
    };
  }
  function extractAllToolCalls(text) {
    const calls = [];
    let match;

    while ((match = TOOL_BLOCK_GLOBAL.exec(String(text || ''))) !== null) {
      const parsed = parseJsonSafely(match[1]);
      if (parsed?.tool) calls.push(parsed);
    }

    return calls;
  }

  function hasUnprocessedToolCall(text) {
    return TOOL_BLOCK.test(String(text || ''));
  }

  function looksLikeReasoningLeak(text) {
    const value = String(text || '').trim();
    if (!value) return false;

    return [
      /^(okay|ok),?\s+the user/i,
      /^let me\b/i,
      /^wait,?\b/i,
      /^in portuguese\b/i,
      /^the user (might|is|wrote)/i,
      /^i need to\b/i,
      /^the response should\b/i
    ].some(pattern => pattern.test(value));
  }

  function validateSkillOutput(text) {
    const value = String(text || '');
    const issues = [];

    if (!value.trim()) issues.push('empty output');
    if (hasUnprocessedToolCall(value)) issues.push('contains nested tool_call');
    if (value.length > 20000) issues.push('output too large');

    return { valid: !issues.length, issues };
  }

  window.AgentRegex = {
    TOOL_BLOCK,
    extractToolCall,
    extractAllToolCalls,
    hasUnprocessedToolCall,
    looksLikeReasoningLeak,
    validateSkillOutput
  };
})();
