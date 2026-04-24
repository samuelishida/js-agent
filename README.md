# JS Agent

Browser-first multi-step AI agent. No bundler. Local or cloud LLM. Modular skill runtime with 80+ tools. Runs from a single dev server command.

## Running

> Do not open `index.html` directly or use Live Server. The dev server is required to proxy Ollama Cloud API requests (browsers block cross-origin POST to `https://ollama.com`).

```bash
node proxy/dev-server.js
# open http://127.0.0.1:5500 in Chrome or Edge
```

```bash
OLLAMA_API_KEY="your-key" node proxy/dev-server.js  # inject Ollama API key
PORT=8080 node proxy/dev-server.js                  # custom port
```

**Requirements:** Node.js 18+ (no `npm install` needed — dev server uses only built-ins). Chrome or Edge required for the File System Access API.

### First-time setup (Ollama Cloud)

1. Settings → **Ollama** → paste API key → **Save** ([get a key](https://ollama.com/settings/api-keys))
2. **Probe** to detect locally installed models
3. Select a model (local or cloud) → **Enable Ollama** → start chatting

## Agent Loop

```
User message
  → preflight (intent hints, query plan, deferred prefetches)
  → buildSystemPrompt (orchestrator merges templates + live tool list)
  → LLM call (cloud or local lane)
  → parse tool calls → execute batches (parallel when safe)
  → apply tool-result context budget
  → inject runtime continuation reminders
  → microcompact older tool results; summarize if context over limit
  → repeat until final answer or round limit
```

## Project Structure

```text
Agent/
├── index.html              # bootstrap — defer tags are the dependency graph
├── assets/                 # CSS
├── prompts/                # system.md, orchestrator.md, repair.md, summarize.md, safety_guidelines.md
├── proxy/dev-server.js     # static server + Ollama Cloud proxy
├── scripts/                # build-snapshot.mjs, test-smoke.mjs, test-skills-smoke.mjs
├── docs/
│   └── agentic-search-arch.html
└── src/
    ├── core/
    │   ├── regex.js          → window.AgentRegex       (tool-call parser)
    │   ├── prompt-loader.js  → window.AgentPrompts     (markdown prompt loader)
    │   └── orchestrator.js   → window.AgentOrchestrator (prompt builder, skill executor)
    ├── skills/
    │   ├── core/intents.js, tool-meta.js               (intent + tool metadata)
    │   ├── generated/snapshot-data.js                  (prebuilt skill catalog)
    │   ├── snapshot-adapter.js → window.AgentSnapshot
    │   ├── modules/                                   (runtime factories)
    │   │   ├── web-runtime.js
    │   │   ├── filesystem-runtime.js
    │   │   ├── data-runtime.js
    │   │   └── registry-runtime.js
    │   ├── groups/web.js, device.js, data.js, filesystem.js   (UI descriptors)
    │   ├── shared.js   → window.AgentSkills            (preflight + registry wiring)
    │   └── index.js                                    (finalizes skill surface)
    └── app/
        ├── state.js          → session, localStorage, BroadcastChannel sync
        ├── constants.js      → window.CONSTANTS         (budgets, timeouts, thresholds)
        ├── runtime-memory.js → window.AgentRuntimeCache, window.AgentMemory
        ├── permissions.js    → window.AgentPermissions  (denial tracking, escalation)
        ├── compaction.js     → window.AgentCompaction   (context compaction, injection detection)
        ├── steering.js       → window.AgentSteering     (mid-flight guidance buffer)
        ├── rate-limiter.js   → window.AgentRateLimiter  (per-tool rate limiting)
        ├── worker-manager.js → window.AgentWorkers      (sandbox worker only)
        ├── local-backend.js                             (LM Studio / Ollama probe)
        ├── tools.js                                     (tool group rendering, toggle)
        ├── tool-execution.js → window.AgentToolExecution (dispatch, batching, fs guards)
        ├── llm.js            → window.AgentLLMControl   (multi-lane routing, abort, streaming)
        ├── agent.js                                     (agent loop, UI wiring)
        └── ui-modern.js      → window.openSettings/closeSettings
```

## Bootstrap Order

Scripts load with `defer`; execution order is declaration order — no bundler needed.

| Step | Scripts | Publishes |
|------|---------|-----------|
| 1. Core | `regex.js`, `prompt-loader.js` | `AgentRegex`, `AgentPrompts` |
| 2. Skill metadata | `core/intents.js`, `core/tool-meta.js`, `generated/snapshot-data.js`, `snapshot-adapter.js` | `AgentSnapshot` |
| 3. Runtime factories | `modules/filesystem-runtime.js`, `data-runtime.js`, `registry-runtime.js`, `web-runtime.js` | registers onto `AgentSkillModules` |
| 4. Skill assembly | `shared.js`, `groups/*.js`, `index.js` | `AgentSkills` |
| 5. Orchestrator | `orchestrator.js` | `AgentOrchestrator` |
| 6. App state | `state.js`, `constants.js`, `runtime-memory.js` | `CONSTANTS`, `AgentRuntimeCache`, `AgentMemory` |
| 7. App subsystems | `permissions.js`, `compaction.js`, `steering.js` | `AgentPermissions`, `AgentCompaction`, `AgentSteering` |
| 8. Tool infra | `local-backend.js`, `tools.js`, `tool-execution.js` | `AgentToolExecution` |
| 9. LLM + loop | `llm.js`, `agent.js`, `ui-modern.js` | `AgentLLMControl`, inline-handler globals |

`constants.js` must precede all modules that read `window.CONSTANTS`. Skills must be assembled before the orchestrator describes available tools.

## Skills

`window.AgentSkills.registry` is composed from four runtime module families:

- **Web:** `web_search`, `web_fetch`, `read_page`, `http_fetch`, `extract_links`, `page_metadata`
- **Device/browser:** datetime, geolocation, weather, clipboard, storage, notifications, tab messaging
- **Filesystem:** list, read, write, search, tree, walk, stat, copy, move, delete, rename (File System Access API)
- **Data/planning:** parse JSON/CSV, todos, tasks, `ask_user`, `tool_search`, `memory_write/search/list`

Tools carry execution metadata (`readOnly`, `concurrencySafe`, `risk`). Read-only concurrent tools run in parallel; risky or write tools run sequentially.

## Model Routing

Three lanes in `llm.js`: `local` (LM Studio / Ollama at a custom host), `ollama` (local Ollama or Ollama Cloud via proxy), and `cloud` (Gemini, OpenAI, Claude, Azure). Local failures fall back to cloud automatically.

### Ollama local model routing

Local Ollama models use a two-endpoint fallback strategy:

1. **`/v1/chat/completions`** (OpenAI-compatible) — primary endpoint, most reliable for local Ollama
2. **`/api/chat`** (native Ollama) — fallback, used with `stream: true` to avoid 2-minute timeouts

Cloud Ollama models route through the dev server proxy at `/api/ollama/v1`.

All local Ollama calls use streaming (`stream: true`) to prevent timeout errors on long responses.

## Context Management

- **Context budget:** configurable 8k–256k characters (default 32k). Max tokens scale automatically with model context size (~25% of effective context).
- **Tool-result budget:** 20 KB inline max, 5 KB preview chunks, keeps 15 recent results. Search tools (`web_search`, `web_fetch`, `read_page`) get a 50% boost.
- **Microcompact:** older `<tool_result>` blocks are replaced with digests on each round.
- **LLM summarization:** triggered when context exceeds 82% of limit; cached and reused (`context_summary` scope). Deterministic tail-compression fallback if summarization fails.
- **Time-based clearing:** stale results cleared after 20 min of inactivity.

### Model context size inference

`state.js` infers context window size from the model name:

- Explicit suffix: `qwen3.5:9b-256k` → 256k context
- Size bracket: `:70b` → 128k, `:30b` → 32k, `:14b` → 16k, `:<14b` → 8k default
- Ollama `/api/show` probe: reads `num_ctx` from model parameters

`max_tokens` is set to `min(context_size, context_budget) * 0.25`, with a floor of 512.

## Safety

Tool outputs are untrusted. The loop detects prompt-injection patterns in tool results and injects `<system-reminder>` blocks into continuation prompts. Permission denials accumulate per run; repeated denials escalate the permission mode (`default` → `ask` → `deny_write`).

### Filesystem path validation

`tool-execution.js` guards against path traversal:

- Shell expansion (`$HOME`, backticks, `|`, `&`) is rejected
- UNC paths (`\\server\share`, `//server/share`) are blocked
- Glob patterns on write operations are rejected
- Dangerous removal paths (`/`, `/etc`, `C:\`) are blocked

## Verification

```bash
npm run test:smoke          # 114 checks — runtime, LLM utils, context, all modules
npm run test:skills-smoke   # skills, snapshot, memory

node --check src/app/agent.js
node --check src/app/llm.js
node --check src/core/orchestrator.js
node --check src/app/constants.js
node --check src/app/state.js
node --check src/app/permissions.js
node --check src/app/compaction.js
node --check src/app/steering.js
node --check src/app/tool-execution.js
```

```bash
npm run build:snapshot      # regenerate src/skills/generated/snapshot-data.js
```

## Bug Fixes (Code Review)

Round 1 — 14 bugs:

| File | Bug | Fix |
|------|-----|-----|
| `tool-execution.js:149` | `containsVulnerableUncPathLight` checked `startsWith('\}')` instead of `startsWith('\\\\')` — UNC path detection broken | Fixed to `startsWith('\\\\')` |
| `compaction.js:129-134` | Head/tail overlap when text < 2×effectivePreview produced negative `omitted` count | Added overlap guard; returns original text when omitted ≤ 0 |
| `compaction.js:28-30` | `ctxTokenEstimate` passed array `content` to `estimateTokens`, returned 0 silently | `estimateTokens` now handles array content |
| `rate-limiter.js:42-58` | `remaining` off-by-one: computed before recording the call | Return `remaining - 1` |
| `steering.js:25-26` | Null dereference when `steering-input` DOM element missing | Added `if (!input) return` guard |
| `state.js:681` | `C()` not in scope — only defined in `agent.js` | Changed to `(typeof C === 'function' ? C() : window.CONSTANTS)?.DEFAULT_CTX_LIMIT_CHARS` |
| `agent.js:805` | Forced answer pushed raw `finalReply` (with think/tool remnants) | Changed to push `finalMarkdown` |
| `orchestrator.js:415-416` | `when` condition failure consumed retry attempts instead of breaking | Changed `throw` to `break` |
| `orchestrator.js:522-524` | `normalizeToolCall` prefix too aggressive (`"r"` → `runtime_readFile`) | Added minimum-length guard: `requested.length >= Math.min(4, normalized.length)` |
| `llm.js:731-748` | `extractThinkingBlocks` duplicated content for nested blocks | Push only leaf blocks |
| `llm.js:731+` | Regex `/<think[\s\S]*?<\/think>/gi` captured `>` as content | Fixed to `/<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi` |
| `llm.js:1529` | Dead `shouldStream && !res.body` branch after body consumed | Removed dead branch; stream exhaustion continues to next endpoint |
| `llm.js:1814-1821` | `res.json()` on already-consumed streaming body | Added `continue` after stream exhaustion; separate `!res.body` guard |
| `tool-execution.js:559` | Sandbox fallback on non-string `result` produced `[object Object]` | Added type check + `JSON.stringify` |

Round 2 — 12 bugs:

| File | Bug | Fix |
|------|-----|-----|
| `compaction.js` | `microcompactToolResultMessages` only matched `role:'user'` with XML wrapper, missed `role:'tool'` | Match `role:'tool'` natively; use raw text for tool-role replacement |
| `compaction.js` | `getCallSignature` used semantic merge (different args → same sig) | Use exact signature + stable key ordering |
| `compaction.js` | `applyContextManagementPipeline` marked `async` with no `await` | Dropped `async` |
| `runtime-memory.js` | `onTurnComplete` never exported — auto-extraction never fired | Added to `AgentMemory` export |
| `runtime-memory.js` | `saveRuntimeCacheStore` unguarded `QuotaExceededError` | Wrapped in try-catch |
| `runtime-memory.js` | Write-every-read on cache hits | Debounced to every 10th hit |
| `runtime-memory.js` | `touchMemoryEntries` didn't invalidate `memory_retrieval` cache | Added `clearRuntimeScope('memory_retrieval')` after mutation |
| `state.js` | Non-atomic swap of `ollamaInstalledModels` during probe | Atomic swap via temp set + bare name support |
| `state.js` | Failed `/api/show` cached 8K fallback | No longer caches on failure; cloud models default to 32K |
| `state.js` | `getModelContextLength` returned Ollama heuristic for cloud models | Returns `DEFAULT_CTX_LIMIT_CHARS` (32K) for cloud |
| `state.js` | `deleteSession` skipped UI updates when active session deleted | Added `updateStats`, `updateCtxBar`, `setStatus` |
| `llm.js` | Ollama `OLLAMA_MODEL_CRASH` not retried | Added continuation prompt retry on crash |

Round 3 — gpt-oss:120b tool-call + reasoning leak:

| File | Bug | Fix |
|------|-----|-----|
| `regex.js` | `TOOL_BLOCK` regex required `>` on open tag — models omitting `>` produced no match, triggering repair pass; when `>` present, capture group included it, breaking JSON parse | Changed to `/<tool_call(?:\s[^>]*>|>?)\s*([\s\S]*?)\s*<\/tool_call>/` — makes `>` optional |
| `tool-execution.js` | Block match regex same `>` issue | Updated block match regex to match |
| `agent.js` | Tool-call cleanup regex same `>` issue | Updated cleanup regex to match |
| `regex.js` | `looksLikeReasoningLeak` missed model meta-commentary patterns | Added "We need to...", "We will call...", "I will call...", "Let's call..." |
| `agent.js` | Model reasoning leaks ("We need to output tool calls only") shown to user | Added `stripModelMetaCommentary()` — strips steering sentences from visible output |
| `llm.js` | Model monologue leaks into content without `<think>` tags | `normalizeVisibleModelText()` detects reasoning-prefixed long text, extracts answer after delimiter |

## Documentation

Architecture deep-dive: [`docs/agentic-search-arch.html`](https://samuelishida.github.io/js-agent/agentic-search-arch.html)