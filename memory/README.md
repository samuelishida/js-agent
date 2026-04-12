# Patched Agent Runtime - Final State

## Status: ✅ COMPLETE

All features from `extension.ts` have been successfully ported to the agent runtime (`agent.js` / `shared.js` / `orchestrator.js`). All identified bugs have been fixed and the remaining out-of-scope items have been addressed.

---

## Files Modified / Created

| File | Description |
|------|------|
| `src/app/agent.js` | Main agent runtime with steering, sanitization, and tool call handling |
| `src/core/orchestrator.js` | System prompt and continuation prompt builder with sanitization |
| `index.html` | Added steering UI input widget next to Stop button |
| `memory/README.md` | This file |
| `memory/TODO_LIST.md` | Itemized checklist of all patches |
| `memory/COMPLETE_CODEBASE.md` | Complete function signatures and documentation |

---

## Summary of Patches

### 1. Steering Buffer System ✅
- `pushSteering(msg)` / `drainSteering()` — mid-flight guidance injection
- Exposed via `window.AgentSteering = { push, drain, clear, send }`
- Loop drains at the top of every iteration and injects `[USER STEERING]` turns

### 2. Tool Call Input Steering ✅
- `steerToolCall(tool, args)` runs before every `executeTool`
- Blocks: `rm -rf /`, `fdisk`, `diskpart`
- Strips control-channel XML from file paths

### 3. Post-turn Memory Hook ✅
- `window.AgentMemory.onTurnComplete()` fires after every final answer
- Pluggable extraction matching `extractAndStoreMemories` pattern

### 4. Prompt Injection Detection ✅
- 7 detection rules including:
  - `[SYSTEM/ASSISTANT/USER OVERRIDE]` markers
  - Encoded injection patterns (base64/hex decode → instruct)
  - Tightened regex to `<tool_call\s*>`

### 5. sanitizeToolResult() ✅
- All tool results sanitized before entering message history
- Strips control-channel XML, replaces with `[blocked]` placeholders

### 6. stableStringify Depth Guard ✅
- `_depth` counter, bails at depth 12 with `"[deep]"`
- Prevents stack overflow from deeply nested objects

### 7. Calc Tool Hardened ✅
- `new Function('Math', ...)` scopes only Math into scope
- `^` → `**` rewriting for exponentiation
- Tightened blocklist for dangerous identifiers

### 8. loadPersistedToolResultReplacements Hardened ✅
- Rejects non-array values
- Coerces all fields to string
- Drops poisoned sessionStorage entries

---

## Remaining / Out-of-Scope Items

### 1. buildRuntimeContinuationPrompt ✅ PATCHED
- Now sanitizes toolSummary before including in prompt
- **Line**: 259 in orchestrator.js

```js
blocks.push(`[TOOL_USE_SUMMARY]\n${String(sanitizeToolResult(toolSummary)).trim()}`);
```

### 2. summarizeContext hist sanitization ✅ PATCHED
- Sanitizes raw tool result content before joining into hist
- **Line**: 1267 in agent.js

```js
.map(m => `[${m.role.toUpperCase()}]: ${sanitizeToolResult(m.content)}`)
```

### 3. Steering UI button ✅ PATCHED
- Added "⚡Steer" toggle button next to Stop button
- Input widget with Clear and Send buttons
- Exposed via `window.setSteeringUIVisible()`, `window.toggleSteeringUI()`

---

## All Functions Exposed on window

| Function | Description |
|----------|-------------|
| `window.AgentSteering.push(msg)` | Inject steering message |
| `window.AgentSteering.drain()` | Drain steering buffer |
| `window.AgentSteering.clear()` | Clear steering buffer |
| `window.AgentSteering.send()` | Send steering from input |
| `window.setSteeringUIVisible(bool)` | Show/hide steering input |
| `window.toggleSteeringUI()` | Toggle visibility |
| `window.AgentMemory.onTurnComplete(...)` | Post-turn memory hook |

---

## Ready for Deployment

All identified issues have been addressed. The patched codebase is ready for use.
