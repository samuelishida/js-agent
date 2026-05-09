# Patched Agent Runtime — Final State

Status: COMPLETE

All features from `extension.ts` ported to agent runtime (`agent.js` / `shared.js` / `orchestrator.js`). Bugs fixed. Out-of-scope items addressed.

---

## Files Modified

| File | Description |
|------|-------------|
| `src/app/agent.js` | Main agent runtime: steering, sanitization, tool call handling |
| `src/core/orchestrator.js` | System prompt + continuation prompt builder, sanitized |
| `index.html` | Steering UI input widget next to Stop button |
| `memory/README.md` | This file |
| `memory/TODO_LIST.md` | Itemized checklist of all patches |
| `memory/COMPLETE_CODEBASE.md` | Complete function signatures and documentation |

---

## Patches

### 1. Steering Buffer System
- `pushSteering(msg)` / `drainSteering()` — mid-flight guidance injection
- Exposed via `window.AgentSteering = { push, drain, clear, send }`
- Loop drains at top of every iteration, injects `[USER STEERING]` turns

### 2. Tool Call Input Steering
- `steerToolCall(tool, args)` runs before every `executeTool`
- Blocks: `rm -rf /`, `fdisk`, `diskpart`
- Strips control-channel XML from file paths

### 3. Post-turn Memory Hook
- `window.AgentMemory.onTurnComplete()` fires after every final answer
- Pluggable extraction matching `extractAndStoreMemories` pattern

### 4. Prompt Injection Detection
- 7 detection rules:
  - `[SYSTEM/ASSISTANT/USER OVERRIDE]` markers
  - Encoded injection patterns (base64/hex decode → instruct)
  - Tightened regex to `\u003ctool_call\s*\u003e`

### 5. sanitizeToolResult()
- All tool results sanitized before entering message history
- Strips control-channel XML, replaces with `[blocked]` placeholders

### 6. stableStringify Depth Guard
- `_depth` counter, bails at depth 12 with `"[deep]"`
- Prevents stack overflow from deeply nested objects

### 7. Calc Tool Hardened
- `new Function('Math', ...)` scopes only Math into scope
- `^` → `**` rewriting for exponentiation
- Tightened blocklist for dangerous identifiers

### 8. loadPersistedToolResultReplacements Hardened
- Rejects non-array values
- Coerces all fields to string
- Drops poisoned sessionStorage entries

---

## Remaining / Out-of-Scope Items

### buildRuntimeContinuationPrompt
- Now sanitizes toolSummary before including in prompt
- **Line**: 259 in orchestrator.js

```js
blocks.push(`[TOOL_USE_SUMMARY]\n${String(sanitizeToolResult(toolSummary)).trim()}`);
```

### summarizeContext hist sanitization
- Sanitizes raw tool result content before joining into hist
- **Line**: 1267 in agent.js

```js
.map(m => `[${m.role.toUpperCase()}]: ${sanitizeToolResult(m.content)}`)
```

### Steering UI button
- Added toggle button next to Stop button
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

Ready for deployment.
