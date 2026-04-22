# JS Agent

Browser-first multi-step AI agent. No bundler. Local or cloud LLM. Modular skill runtime with 70+ tools. Runs from a single dev server command.

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
3. Select a model (local or ☁ cloud) → **Enable Ollama** → start chatting

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
    │   ├── modules/                                     (runtime factories)
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
        ├── local-backend.js                             (LM Studio / Ollama probe)
        ├── tools.js                                     (tool group rendering, toggle)
        ├── tool-execution.js → window.AgentToolExecution (dispatch, batching, fs guards)
        ├── llm.js            → window.AgentLLMControl   (multi-lane routing, abort)
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

Three lanes in `llm.js`: `local` (LM Studio / Ollama at a custom host), `ollama` (Ollama Cloud via the proxy), and `cloud` (Gemini, OpenAI, Claude, Azure). Local failures fall back to cloud automatically. The `state.js` probe populates installed local models; unrecognized models route to cloud.

## Context Management

- **Tool-result budget:** 20 KB inline max, 5 KB preview chunks, keeps 15 recent results. Search tools (`web_search`, `web_fetch`, `read_page`) get a 50% boost.
- **Microcompact:** older `<tool_result>` blocks are replaced with digests on each round.
- **LLM summarization:** triggered when context exceeds 82% of limit; cached and reused (`context_summary` scope). Deterministic tail-compression fallback if summarization fails.
- **Time-based clearing:** stale results cleared after 20 min of inactivity.

## Safety

Tool outputs are untrusted. The loop detects prompt-injection patterns in tool results and injects `<system-reminder>` blocks into continuation prompts. Permission denials accumulate per run; repeated denials escalate the permission mode (`default` → `ask` → `deny_write`).

## Verification

```bash
npm run test:smoke          # all runtime layers
npm run test:skills-smoke   # skills, snapshot, memory

node --check src/app/agent.js
node --check src/app/llm.js
node --check src/core/orchestrator.js
node --check src/app/constants.js
node --check src/app/permissions.js
node --check src/app/compaction.js
node --check src/app/steering.js
node --check src/app/tool-execution.js
```

```bash
npm run build:snapshot      # regenerate src/skills/generated/snapshot-data.js
```

## Documentation

Architecture deep-dive: [`docs/agentic-search-arch.html`](docs/agentic-search-arch.html)
