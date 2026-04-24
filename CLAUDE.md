# CLAUDE.md

JS Agent: browser-first multi-step agent. Hosted/local LLM routing. Modular skill runtime. Prompt composition. Context-aware orchestration. Durable memory/cache layers in localStorage.

## Running app

**Never open index.html directly or use Live Server** — browsers block cross-origin POST to `https://ollama.com`.

```bash
node proxy/dev-server.js
# Then open http://127.0.0.1:5500
```

Env variables:
```bash
OLLAMA_API_KEY="..." node proxy/dev-server.js  # auto-forward bearer header
PORT=8080 node proxy/dev-server.js             # custom port
```

## Key commands

```bash
npm run build:snapshot   # regenerate src/skills/generated/snapshot-data.js
npm run test:skills-smoke # smoke-test runtime assembly in Node VM
node --check src/app/agent.js
node --check src/core/orchestrator.js
```

## Architecture

### Bootstrap order (via defer tags in index.html)

No bundler in critical execution path. defer tags act as dependency graph:

1. `src/core/regex.js` — tool-call parsing helpers
2. `src/core/prompt-loader.js` — prompt markdown loading
3. `src/skills/core/intents.js` / `src/skills/core/tool-meta.js` — intent + tool metadata
4. `src/skills/generated/snapshot-data.js` + `src/skills/snapshot-adapter.js` — prebuilt skill snapshot
5. `src/skills/modules/filesystem-runtime.js`, `data-runtime.js`, `registry-runtime.js`, `web-runtime.js` — register factories on `window.AgentSkillModules`
6. `src/skills/shared.js` — compose factories into `window.AgentSkills` (preflight planning, registry wiring, aliases)
7. `src/skills/groups/*.js` — UI group descriptors; `src/skills/index.js` finalize skill surface
8. `src/core/orchestrator.js` — consume prompt loader + `window.AgentSkills`, publish `window.AgentOrchestrator`
9. `src/app/state.js` → `runtime-memory.js` → `permissions.js` → `compaction.js` → `filesystem-guards.js` → `steering.js` → `local-backend.js` → `tools.js` → `tool-execution.js` → `ui-render.js` → `reply-analysis.js` → `llm.js` → `child-agent.js` → `agent.js` → `app-init.js` → `ui-modern.js`

Load-order dependent, not module-graph. shared.js must complete before orchestrator describes available tools.

### Agent loop flow

```
User message
  → buildInitialContext (preflight plan + query hints via AgentSkills)
  → buildSystemPrompt (orchestrator assembles prompt from templates + live tool metadata)
  → callLLM (cloud or local lane via llm.js)
  → splitModelReply (strip thinking blocks)
  → resolveToolCalls (regex parse + deduplication)
  → partitionToolCallBatches (group by concurrency safety + path conflict)
  → executeTool (orchestrator.executeSkill → skill.run)
  → applyToolResultContextBudget (compact large results, digest for later)
  → buildRuntimeContinuationPrompt (inject tool summary, denials, compaction notes)
  → applyContextManagementPipeline (microcompact stale tool results → LLM summarize if needed)
  → repeat until final answer or round limit
```

Skills decide capabilities, orchestrator decides presentation to model, agent.js decides when to call model again, repair malformed intent, execute tools, compact context, or stop.

### Prompt templates (prompts/)

- `system.md` — main template (variables: `max_rounds`, `ctx_limit`, `tools_list`, `query_hint`)
- `orchestrator.md` — policy section
- `safety_guidelines.md` — safety reminders (prefix, hooks, reminders, autonomous loop behavior, prompt injection safety)
- `repair.md` — rewrite malformed tool intent into valid `<tool_call>` blocks
- `summarize.md` — LLM context summarization

### Tool execution

`window.AgentOrchestrator.executeSkill(call, context)` iterates skill fallback chain, checking `when` conditions, running `skill.run(args, context)`, validating output via `AgentRegex.validateSkillOutput`.

Registry in `shared.js` wires all runtime-compatible tool names (aliases like `read_file` → `runtime_readFile`) through `normalizeToolCall`.

### Local vs cloud routing

`llm.js` uses `isSelectedOllamaModelCloud()` (in `local-backend.js`) to decide routing:
- If `ollamaInstalledModels` populated by probe, any model not in that set routes to cloud
- If probe never ran, falls back to checking whether selected option's optgroup is `#ollama-cloud-optgroup`

Local failures fall back to cloud automatically.

## Key files

- `src/app/agent.js` — ~760 lines, main agent loop + run state. Functional areas: steering buffer (1-90), run state flags (91-177), permission denial tracking (178-370), error classification/repair (371-460), tool call normalization (461-525), prompt injection detection, compaction/failure tracking, tool execution/batching, context management pipeline, UI helpers.
- `src/core/orchestrator.js` — prompt assembly, tool-list building, runtime continuation prompt construction, skill execution delegation.
- `src/skills/shared.js` — preflight planning, registry composition with 70+ tools, filesystem/data/web runtime wiring, BroadcastChannel tab sync.
- `src/app/state.js` — mutable global state (messages, sessionStats, isBusy, enabledTools, localBackend), session management, tool cache, routing readiness (isLocalModeActive, isOllamaReady, getCloudReadiness, canUseCloud, clearSession).
- `src/app/local-backend.js` — LM Studio probe, Ollama probe + cloud routing (probeOllama, toggleOllamaBackend, isSelectedOllamaModelCloud, inferContextLength, fetchModelContextLength, getOllamaCloudModel/ApiKey/ProxyUrl, getModelContextLength, getMaxTokensForModel).
- `src/app/llm.js` — provider selection, request shaping, retry logic, response normalization.
- `src/app/ui-render.js` — markdown engine (renderMarkdownBlocks, renderAgentHtml, sanitizeHtmlFragment), message rendering (addMessage, addNotice, setStatus, updateStats, updateCtxBar), sidebar/badges (updateBadge, updateActiveProviderBadge, renderSessionList, renderChatFromMessages).
- `src/app/reply-analysis.js` — model reply parsing (splitModelReply, extractThinkingBlocks, normalizeVisibleModelText), repair detection (looksLikeToolExecutionClaimWithoutCall, isMaxOutputTokenLikeError).
- `src/app/filesystem-guards.js` — path validation (normalizePathInput, isDangerousRemovalPath, validateFilesystemCallGuard), dangerous path detection.
- `src/app/child-agent.js` — spawnAgentChild sub-loop for delegated tasks.
- `src/app/app-init.js` — DOMContentLoaded bootstrap (session loading, UI wiring, runtime checks, slider init).
- `src/app/runtime-memory.js` — `AgentRuntimeCache` (multi-scope TTL+maxEntries+maxBytes policy) + `AgentMemory` (durable write/search/list with auto-extraction).

## Verification

```bash
npm run test:skills-smoke
node --check src/core/orchestrator.js
node --check src/app/agent.js
node --check src/app/local-backend.js
node --check src/app/state.js
node --check src/app/ui-render.js
node --check src/app/reply-analysis.js
node --check src/app/filesystem-guards.js
node --check src/app/child-agent.js
node --check src/app/app-init.js
```