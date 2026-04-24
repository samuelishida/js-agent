(() => {
  const TOOL_BLOCK = /<tool_call(?:\s[^>]*>|>?)\s*([\s\S]*?)\s*<\/tool_call>/i;
  const TOOL_BLOCK_GLOBAL = /<tool_call(?:\s[^>]*>|>?)\s*([\s\S]*?)\s*<\/tool_call>/gi;

  // Matches <|tool_call>call:name{...} or <|tool_call>name{...} used by some local models.
  // The args block is shallow (no nested braces) so [^{}]* is sufficient.
  const PIPE_TOOL_BLOCK = /<\|tool_call>(?:call:)?(\w+)\s*\{([^{}]*)\}/i;

  // Normalize <|token|> quote delimiters (e.g. <|"|>) to standard double-quotes,
  // then parse the result as a JSON object body (without outer braces).
  function parsePipeArgs(raw) {
    const normalized = String(raw || '').replace(/<\|[^|]*\|>/g, '"');
    return parseJsonSafely(`{${normalized}}`) || {};
  }

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

  function extractBalancedObjectAfterKey(raw, key) {
    const value = String(raw || '');
    if (!value) return null;

    const keyMatch = value.match(new RegExp(`"${key}"\\s*:`,'i'));
    if (!keyMatch || keyMatch.index == null) return null;

    const keyStart = keyMatch.index + keyMatch[0].length;
    let start = value.indexOf('{', keyStart);
    if (start < 0) return null;

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
          return value.slice(start, i + 1);
        }
      }
    }

    return null;
  }

  function tryParseToolObject(raw) {
    const parsed = parseJsonSafely(raw);
    if (parsed) {
      // Resolve field aliases used by different model families:
      //   tool name: "tool" (primary) | "name" (OpenAI/Mistral-style — accepted only
      //              when paired with a recognized args field to avoid false positives)
      //   tool args: "args" | "parameters" | "input" | "inputs" | "arguments"
      const argsVal = parsed.args ?? parsed.parameters ?? parsed.input ?? parsed.inputs ?? parsed.arguments ?? null;
      const toolName = parsed.tool
        || (parsed.name && argsVal !== null ? parsed.name : null);

      if (toolName) {
        const parsedArgs = argsVal && typeof argsVal === 'object' && !Array.isArray(argsVal)
          ? argsVal
          : {
              ...(parsed.path && { path: parsed.path }),
              ...(parsed.url && { url: parsed.url }),
              ...(parsed.query && { query: parsed.query }),
              ...(parsed.expression && { expression: parsed.expression }),
              ...(parsed.text && { text: parsed.text }),
              ...(parsed.offset !== undefined && { offset: parsed.offset }),
              ...(parsed.length !== undefined && { length: parsed.length })
            };
        return { tool: String(toolName), args: parsedArgs, ...(parsed.id ? { id: String(parsed.id) } : {}) };
      }
    }

    // Regex-based fallback for raw strings that are not clean JSON.
    const tool = extractJsonString(raw, 'tool') || extractJsonString(raw, 'name');
    if (!tool) return null;

    const argsRaw = extractBalancedObjectAfterKey(raw, 'args')
      || extractBalancedObjectAfterKey(raw, 'parameters')
      || extractBalancedObjectAfterKey(raw, 'input')
      || extractBalancedObjectAfterKey(raw, 'arguments');
    const args = argsRaw ? (parseJsonSafely(argsRaw) || {}) : {};
    return { tool, args };
  }

  function findBalancedJsonObjectWithTool(text) {
    const value = String(text || '');
    // Search for "tool": or "name": — "name" is used by OpenAI/Mistral-style models.
    const toolIndex = value.search(/"tool"\s*:|"name"\s*:/i);
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
      const pipeMatch = String(text || '').match(PIPE_TOOL_BLOCK);
      if (pipeMatch) {
        const tool = pipeMatch[1];
        const args = parsePipeArgs(pipeMatch[2]);
        if (tool) return { tool, args };
      }
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
    const root = extractJsonString(raw, 'root');
    const filePath = extractJsonString(raw, 'filePath');
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
    const offset = raw.match(/"offset"\s*:\s*(-?\d+)/i)?.[1];
    const length = raw.match(/"length"\s*:\s*(-?\d+)/i)?.[1];
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
        ...(root && { root }),
        ...(filePath && { filePath }),
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
        ...(offset !== undefined && { offset: Number(offset) }),
        ...(length !== undefined && { length: Number(length) }),
        ...(latitude && { latitude: Number(latitude) }),
        ...(longitude && { longitude: Number(longitude) })
      }
    };
  }
  // Scans `text` for all balanced JSON objects that look like tool calls.
  // Used as a fallback when no structured block markers (<tool_call>, <|tool_call>)
  // are present — handles models that emit bare JSON or multiple tool objects in prose.
  function scanForStandaloneToolCalls(text) {
    const value = String(text || '');
    const results = [];
    let i = 0;

    while (i < value.length) {
      const bracePos = value.indexOf('{', i);
      if (bracePos < 0) break;

      // Walk forward to find the matching closing '}'
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let j = bracePos; j < value.length; j++) {
        const ch = value[j];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
      }

      if (end < 0) break;

      const candidate = value.slice(bracePos, end + 1);
      if (/"tool"\s*:|"name"\s*:/i.test(candidate)) {
        const parsed = tryParseToolObject(candidate);
        if (parsed?.tool) {
          results.push(parsed);
          i = end + 1;
          continue;
        }
      }
      i = bracePos + 1;
    }

    return results;
  }

  function extractAllToolCalls(text) {
    const calls = [];
    let match;

    while ((match = TOOL_BLOCK_GLOBAL.exec(String(text || ''))) !== null) {
      // Use tryParseToolObject so field aliases (name/parameters/input) are resolved.
      const parsed = tryParseToolObject(match[1]);
      if (parsed?.tool) calls.push(parsed);
    }

    // Also extract <|tool_call> format used by some local models.
    const pipePattern = /<\|tool_call>(?:call:)?(\w+)\s*\{([^{}]*)\}/gi;
    let pm;
    while ((pm = pipePattern.exec(String(text || ''))) !== null) {
      const tool = pm[1];
      const args = parsePipeArgs(pm[2]);
      if (tool) calls.push({ tool, args });
    }

    // Final fallback: when no structured blocks were found, scan for bare JSON tool
    // objects interspersed with prose.  This covers models that output
    // {"tool":"...","args":{...}} or {"name":"...","parameters":{...}} without wrappers.
    if (!calls.length) {
      calls.push(...scanForStandaloneToolCalls(String(text || '')));
    }

    return calls;
  }

  function hasUnprocessedToolCall(text) {
    const s = String(text || '');
    return TOOL_BLOCK.test(s) || PIPE_TOOL_BLOCK.test(s);
  }

  function isBareToolCallOutput(text) {
    const value = String(text || '').trim();
    if (!value) return false;

    if (/^<tool_call>[\s\S]*<\/tool_call>$/i.test(value)) {
      return true;
    }

    if (/^```(?:json)?\s*<tool_call>[\s\S]*<\/tool_call>\s*```$/i.test(value)) {
      return true;
    }

    return false;
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
      /^the response should\b/i,
      /^we (?:need|have|must) to (?:output|generate|produce|call|make)\b/i,
      /^we (?:will|should|must|are going to) (?:call|use|invoke|execute|run)\b/i,
      /^i (?:will|should|am going to|am) (?:call|use|invoke|execute|run|outputting)\b/i,
      /^(let's|lets) (?:call|use|try|invoke)\b/i
    ].some(pattern => pattern.test(value));
  }

  function validateSkillOutput(text) {
    const value = String(text || '');
    const issues = [];

    if (!value.trim()) issues.push('empty output');
    if (isBareToolCallOutput(value)) issues.push('contains bare tool_call block');
    if (value.length > 20000) issues.push('output too large');

    return { valid: !issues.length, issues };
  }

  window.AgentRegex = {
    TOOL_BLOCK,
    extractToolCall,
    extractAllToolCalls,
    hasUnprocessedToolCall,
    isBareToolCallOutput,
    looksLikeReasoningLeak,
    validateSkillOutput
  };
})();
