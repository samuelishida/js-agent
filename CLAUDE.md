# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
After code changes always smoke test to make sure

## Overview

JS Agent is a browser-first multi-step agent with hosted/local LLM routing, modular skill runtime, modular prompt composition, context-aware orchestration, and durable memory/cache layers in localStorage.

## Running the app

**Do not open `index.html` directly or use Live Server** — Ollama Cloud API requests must be proxied server-side (browsers block cross-origin POST to `https://ollama.com`).

```bash
node proxy/dev-server.js
# Then open http://127.0.0.1:5500
```

Environment variables:
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

### Bootstrap order (via `defer` tags in index.html)

No bundler in the critical execution path — `defer` tags act as the dependency graph:

1. `src/core/regex.js` — tool-call parsing helpers
2. `src/core/prompt-loader.js` — prompt markdown loading
3. `src/skills/core/intents.js` / `src/skills/core/tool-meta.js` — intent and tool metadata
4. `src/skills/generated/snapshot-data.js` + `src/skills/snapshot-adapter.js` — prebuilt skill snapshot
5. `src/skills/modules/filesystem-runtime.js`, `data-runtime.js`, `registry-runtime.js`, `web-runtime.js` — register factories on `window.AgentSkillModules`
6. `src/skills/shared.js` — composes factories into `window.AgentSkills` (preflight planning, registry wiring, aliases)
7. `src/skills/groups/*.js` — UI group descriptors; `src/skills/index.js` finalizes skill surface
8. `src/core/orchestrator.js` — consumes prompt loader + `window.AgentSkills`, publishes `window.AgentOrchestrator`
9. `src/app/state.js` → `runtime-memory.js` → `local-backend.js` → `tools.js` → `llm.js` → `agent.js` → `ui-modern.js`

This ordering is load-order dependent, not module-graph dependent. `shared.js` must complete before the orchestrator can describe available tools.

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

The split is deliberate: skills decide what capabilities exist, the orchestrator decides how they're presented to the model, and `agent.js` decides when to call the model again, repair malformed intent, execute tools, compact context, or stop.

### Prompt templates (`prompts/`)

- `system.md` — main system prompt template (variables: `max_rounds`, `ctx_limit`, `tools_list`, `query_hint`)
- `orchestrator.md` — policy section
- `safety_guidelines.md` — safety reminders (prefix, hooks, reminders, autonomous loop behavior, prompt injection safety)
- `repair.md` — used when the model produces malformed tool intent; attempts to rewrite into valid `<tool_call>` blocks
- `summarize.md` — used for LLM context summarization

### Tool execution

`window.AgentOrchestrator.executeSkill(call, context)` iterates through a skill's fallback chain, checking `when` conditions, running `skill.run(args, context)`, and validating output via `AgentRegex.validateSkillOutput`.

The registry in `shared.js` wires all runtime-compatible tool names (including aliases like `read_file` → `runtime_readFile`) through `normalizeToolCall`.

### Local vs cloud routing

`llm.js` uses `isSelectedOllamaModelCloud()` (in `state.js`) to decide routing:
- If `ollamaInstalledModels` has been populated by a probe, any model not in that set is routed to cloud
- If the probe never ran, falls back to checking whether the selected option's optgroup is `#ollama-cloud-optgroup`

Local failures fall back to cloud automatically.

## Key files

- `src/app/agent.js` — ~2750 lines, the main agent loop and most run state. Significant functional areas include: steering buffer (1-90), run state flags (91-177), permission denial tracking (178-370), error classification/repair (371-460), tool call normalization (461-525), filesystem validation (526-885), prompt injection detection (886-1032), compaction/failure tracking (1033-1128), tool execution/batching (1129-1350), context management pipeline (1351-1845), child agent spawning (1846-1941), UI helpers (2398-2749).
- `src/core/orchestrator.js` — prompt assembly, tool-list building, runtime continuation prompt construction, skill execution delegation.
- `src/skills/shared.js` — preflight planning, registry composition with 70+ tools, filesystem/data/web runtime wiring, BroadcastChannel tab sync.
- `src/app/state.js` — mutable global state (messages, sessionStats, isBusy, enabledTools, localBackend), session management, tool cache with multi-scope TTL.
- `src/app/llm.js` — provider selection, request shaping, retry logic, response normalization.
- `src/app/runtime-memory.js` — `AgentRuntimeCache` (multi-scope TTL+maxEntries+maxBytes policy) and `AgentMemory` (durable write/search/list with auto-extraction).

## Verification

```bash
npm run test:skills-smoke
node --check src/core/orchestrator.js
node --check src/app/agent.js
```
