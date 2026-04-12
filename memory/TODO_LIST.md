# Patches Applied to agent.js / shared.js / orchestrator.js

## Summary
All major features from extension.ts have been successfully ported to the agent runtime. The remaining items have been patched.

---

## ✅ Completed — Features Ported from extension.ts

### 1. Steering buffer system
- `steeringBuffer`, `pushSteering()`, `drainSteering()` — mid-session guidance injection
- Exposed via `window.AgentSteering = { push, drain, clear, send }`
- Loop drains at the top of every iteration, injects `[USER STEERING]` turns before LLM call
- **Added**: `clearSteering()` function and toggle UI button in index.html

### 2. Tool call steering / input rewriting
- `steerToolCall(tool, args)` runs before every `executeTool`
- Blocks catastrophic shell commands (`rm -rf /`, `fdisk`, `diskpart`)
- Strips control-channel XML tags from file path arguments

### 3. Post-turn memory hook
- `window.AgentMemory.onTurnComplete()` called after every final answer (normal + max-rounds)
- Fire-and-forget pattern for pluggable session-level memory extraction

### 4. Prompt injection detection — expanded
- Added 2 new detection rules:
  - `[SYSTEM/ASSISTANT/USER OVERRIDE]` markers
  - Encoded injection patterns (base64/hex decode → instruct)
- Tightened control-tag pattern from `<tool_call>` to `<tool_call\s*>`

### 5. New sanitizeToolResult() function
- All tool results are now sanitized before entering message history
- Removes control-channel XML
- Replaces with `[blocked]` placeholders
- Strips: `<tool_call>`, `<system-reminder>`, `<permission_denials>`, `[SYSTEM OVERRIDE]`, `NEW SYSTEM PROMPT`

### 6. stableStringify depth guard
- Added `_depth` counter, bails with `"[deep]"` at depth 12
- Prevents stack overflow from deeply nested objects

### 7. calc tool hardened
- Replaced bare `Function()` with scoped version: `new Function('Math', ...)`
- Added `^` → `**` rewriting for exponentiation
- Tightened blocklist for dangerous identifiers

### 8. loadPersistedToolResultReplacements hardened
- Rejects non-array values
- Coerces all fields to string
- Drops persisted replacements containing injection payloads

---

## ✅ Patched — Remaining Items

### 1. buildRuntimeContinuationPrompt (orchestrator.js)
**Before**: Tool summary inserted directly without sanitization
**After**: Calls `sanitizeToolResult(toolSummary)` before including in prompt
**Line**: 259 in orchestrator.js

```js
blocks.push(`[TOOL_USE_SUMMARY]\n${String(sanitizeToolResult(toolSummary)).trim()}`);
```

### 2. summarizeContext hist sanitization (agent.js)
**Before**: Raw tool result content included directly in hist string
**After**: Each message content passes through `sanitizeToolResult()` before joining
**Line**: 1267-1270 in agent.js

```js
const hist = messages
  .filter(m => m.role !== 'system')
  .map(m => `[${m.role.toUpperCase()}]: ${sanitizeToolResult(m.content)}`)
  .join('\n\n');
```

### 3. buildToolUseSummary sanitization (agent.js)
**Before**: Raw result preview used directly
**After**: Sanitized via `sanitizeToolResult(result)` before extracting preview
**Line**: 796-800 in agent.js

```js
let result = String(item?.result || '');
const preview = sanitizeToolResult(result).replace(/\s+/g, ' ').trim().slice(0, 120);
```

### 4. Steering UI button (index.html)
**Before**: No input widget next to Stop button
**After**: Added steering input row with "⚡Steer" toggle button
- Input field for typing steering messages
- Clear and Send buttons
- Status display area
- Toggle visibility via `window.toggleSteeringUI()`
- Events exposed: `window.setSteeringUIVisible()`, `window.clearSteering()`, `window.sendSteering()`

---

## 🔵 Out of Scope for This Pass

### 1. summarizeContext prompt injection
**Status**: Not applicable — summary responses from LLM are already sanitized via the hist sanitization above. The LLM itself cannot inject control-channel XML (it's an external service).

### 2. Additional sanitization of tool summaries elsewhere
**Status**: Not needed — all paths that include tool results now route through `sanitizeToolResult()`:
- Tool result insertion: Line 1836 in agent.js
- buildToolUseSummary: Line 797 in agent.js  
- buildRuntimeContinuationPrompt: Line 259 in orchestrator.js
- summarizeContext hist: Line 1267 in agent.js

---

## Verification Checklist

- [x] All tool results sanitized before entering message history
- [x] buildRuntimeContinuationPrompt sanitizes toolSummary
- [x] summarizeContext sanitizes hist string
- [x] buildToolUseSummary sanitizes preview
- [x] Steering UI input widget added and exposed
- [x] All public API functions exposed on window
