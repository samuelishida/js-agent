# JS Agent

<p align="center">
  <img src="assets/logo.svg" alt="js-agent logo" width="320">
</p>

Browser-first multi-step AI agent. No bundler. Local or cloud LLM. Modular tool runtime with 80+ tools. Runs from a single dev server command.

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

### First-time setup (OpenRouter — recommended)

1. Settings → **OpenRouter** → paste API key → **Save** ([get a free key](https://openrouter.ai/keys))
2. Select a model from the dropdown (free models marked with `:free` suffix)
3. Check **"Use OpenRouter as active provider"** → start chatting

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
├── scripts/                # build-snapshot.mjs, test-smoke.mjs, test-tools-smoke.mjs
├── docs/
│   └── agentic-search-arch.html
└── src/
    ├── core/
    │   ├── regex.js          → window.AgentRegex       (tool-call parser)
    │   ├── prompt-loader.js  → window.AgentPrompts     (markdown prompt loader)
    │   └── orchestrator.js   → window.AgentOrchestrator (prompt builder, tool executor)
    ├── tools/
    │   ├── core/intents.js, tool-meta.js               (intent + tool metadata)
    │   ├── generated/snapshot-data.js                  (prebuilt tool catalog)
    │   ├── snapshot-adapter.js → window.AgentSnapshot
    │   ├── modules/                                   (runtime factories)
    │   │   ├── web-runtime.js
    │   │   ├── filesystem-runtime.js
    │   │   ├── data-runtime.js
    │   │   └── registry-runtime.js
    │   ├── groups/web.js, device.js, data.js, filesystem.js   (UI descriptors)
    │   ├── shared.js   → window.AgentTools            (preflight + registry wiring)
    │   └── index.js                                    (finalizes tool surface)
    ├── skills/
    │   ├── skill-loader.js   → window.AgentSkillLoader (methodology/expertise loader)
    │   ├── skills-manifest.json                        (built-in skill catalog)
    │   └── algorithmic-art/, pdf/, xlsx/, ...          (16 .md skill dirs)
     │   └── app/
     │       ├── core/                # state.js, constants.js, permissions.js, provider-state.js
     │       ├── agent/              # agent.js, round-controller.js, session-lifecycle.js, error-recovery.js, tool-call-repair.js
     │       ├── llm/               # llm.js, local-backend.js, child-agent.js + provider-*.js
     │       ├── tools/              # tool-execution.js, filesystem-guards.js, rate-limiter.js
     │       ├── context/           # compaction.js, steering.js, runtime-memory.js
     │       ├── ui/               # ui-render.js, tools.js, ui-modern.js
     │       └── app-init.js
```

## Bootstrap Order

Scripts load with `defer`; execution order is declaration order — no bundler needed.

| Step | Scripts | Publishes |
|------|---------|-----------|
| 1. Core | `regex.js`, `prompt-loader.js` | `AgentRegex`, `AgentPrompts` |
| 2. Tool metadata | `core/intents.js`, `core/tool-meta.js`, `generated/snapshot-data.js`, `snapshot-adapter.js` | `AgentSnapshot` |
| 3. Runtime factories | `modules/filesystem-runtime.js`, `data-runtime.js`, `registry-runtime.js`, `web-runtime.js` | registers onto `AgentToolModules` |
| 4. Tool assembly | `shared.js`, `groups/*.js`, `index.js` | `AgentTools`, `AgentToolGroups` |
| 4b. Skills loader | `skill-loader.js` | `AgentSkillLoader` |
| 5. Orchestrator | `orchestrator.js` | `AgentOrchestrator` |
| 6. App state | `state.js`, `constants.js`, `runtime-memory.js` | `CONSTANTS`, `AgentRuntimeCache`, `AgentMemory` |
| 7. App subsystems | `permissions.js`, `compaction.js`, `filesystem-guards.js`, `steering.js` | `AgentPermissions`, `AgentCompaction`, `AgentFilesystemGuards`, `AgentSteering` |
| 8. Tool infra | `local-backend.js`, `tools.js`, `tool-execution.js` | `AgentToolExecution` |
| 9. UI layer | `ui-render.js`, `reply-analysis.js` | `AgentUIRender`, `AgentReplyAnalysis` |
| 10. LLM + loop | `llm.js`, `child-agent.js`, `agent.js`, `app-init.js`, `ui-modern.js` | `AgentLLMControl`, `AgentChildAgent`, inline-handler globals |

`constants.js` must precede all modules that read `window.CONSTANTS`. Tools must be assembled before the orchestrator describes available tools.

## Tools

`window.AgentTools.registry` is composed from four runtime module families:

- **Web:** `web_search`, `web_fetch`, `read_page`, `http_fetch`, `extract_links`, `page_metadata`
- **Device/browser:** datetime, geolocation, weather, clipboard, storage, notifications, tab messaging
- **Filesystem:** list, read, write, search, tree, walk, stat, copy, move, delete, rename (File System Access API)
- **Data/planning:** parse JSON/CSV, todos, tasks, `ask_user`, `tool_search`, `memory_write/search/list`

Tools carry execution metadata (`readOnly`, `concurrencySafe`, `risk`). Read-only concurrent tools run in parallel; risky or write tools run sequentially.

## Skills

Skills are **methodology and expertise** — not executable tools. They are `.md` files loaded at runtime that provide domain knowledge, workflows, and guidelines the LLM follows when relevant.

| Resource | Function | Who Controls? | Example |
|----------|----------|---------------|---------|
| **Tools** | Actions / Execution | Model (active call) | `create_jira_issue(title, desc)` |
| **Skills** | Expertise / Methodology | Model (as needed) | "How to review security code" |
| **MCP** | Standardization / Connection | Infrastructure | Connect Slack to Claude |

`window.AgentSkillLoader` auto-loads 16 built-in skills from `src/skills/`:

- **algorithmic-art** — p5.js generative art with seeded randomness
- **brand-guidelines** — Brand colors and typography styling
- **canvas-design** — Visual art in .png/.pdf
- **doc-coauthoring** — Structured documentation co-authoring
- **docx** — Word document creation/editing
- **frontend-design** — Production-grade frontend UI
- **internal-comms** — Company communication formats
- **mcp-builder** — MCP server creation guide
- **pdf** — PDF manipulation (merge, split, OCR, forms)
- **pptx** — PowerPoint creation/editing
- **skill-creator** — Create and improve skills
- **slack-gif-creator** — Animated GIFs for Slack
- **theme-factory** — 10 pre-set themes for styling
- **web-artifacts-builder** — React + Tailwind + shadcn/ui artifacts
- **webapp-testing** — Playwright-based web testing
- **xlsx** — Spreadsheet creation and analysis

Skills are matched to user messages via keyword detection and injected into the system prompt as context blocks.

## 🚀 Deploy to Production (Render.com — Free Tier)

### CI/CD Status

![CI](https://github.com/samuelishida/js-agent/workflows/CI/badge.svg)

Every push to `main` triggers:
- JS syntax check (`npm run check:js`)
- Smoke tests (`npm run test:smoke`)
- Tools smoke tests (`npm run test:tools-smoke`)
- Matrix across Node 18, 20, 22

### One-click deploy

1. Fork this repo on GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Render auto-detects `render.yaml`:
   - **Build Command**: `npm run check:js`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. Add environment variables in Render Dashboard → Settings → Environment:
   - `OPENROUTER_API_KEY` = your free key from [openrouter.ai/keys](https://openrouter.ai/keys)
   - `OLLAMA_API_KEY` = (optional) your Ollama Cloud key
6. Click **Deploy**

Your agent will be live at `https://js-agent-xxx.onrender.com` within 2 minutes.

### Manual deploy (any Node.js host)

```bash
# 1. Clone
git clone https://github.com/YOUR_USER/js-agent.git
cd js-agent

# 2. Install (no build step needed)
npm install

# 3. Set env vars
cp .env.example .env
# Edit .env with your OPENROUTER_API_KEY

# 4. Start
npm start
```

The server listens on `PORT` (default 5500) and serves the SPA + API proxy.

### Health check

```bash
curl https://your-app.onrender.com/api/health
# → {"ok":true,"uptime":123,"version":"0.1.0",...}
```

---

## Model Routing

Four lanes in `llm.js`:
- **`openrouter`** — OpenRouter.ai (OpenAI-compatible API, 100+ models including free tier)
- **`local`** — LM Studio / llama.cpp at a custom host
- **`ollama`** — Local Ollama or Ollama Cloud via proxy
- **`cloud`** — Direct browser API calls (Gemini, OpenAI, Claude, Azure)

Local failures fall back to cloud automatically. OpenRouter is the recommended provider for new users — it requires only a free API key and offers access to state-of-the-art models.

### OpenRouter setup

1. Get a free key at [openrouter.ai/keys](https://openrouter.ai/keys)
2. Paste it in Settings → **OpenRouter** → API Key → **Save**
3. Select a model from the dropdown (free models use the `:free` suffix)
4. Check **"Use OpenRouter as active provider"**

The topbar badge shows the active OpenRouter model ID. Free models include `openai/gpt-oss-120b:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `google/gemma-4-26b-a4b-it:free`, and others.

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

`local-backend.js` infers context window size from the model name:

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
npm run test:smoke          # 118 checks — runtime, LLM utils, context, all modules
npm run test:tools-smoke   # tools, snapshot, memory

node --check src/app/agent/agent.js
node --check src/app/llm/llm.js
node --check src/core/orchestrator.js
node --check src/app/core/constants.js
node --check src/app/core/state.js
node --check src/app/core/permissions.js
node --check src/app/context/compaction.js
node --check src/app/context/steering.js
node --check src/app/tools/tool-execution.js
node --check src/app/tools/filesystem-guards.js
node --check src/app/reply-analysis.js
node --check src/app/ui/ui-render.js
node --check src/app/llm/child-agent.js
node --check src/app/app-init.js
```

```bash
npm run build:snapshot      # regenerate src/tools/generated/snapshot-data.js
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

Round 4 — `AgentSkills` → `AgentTools` refactoring:

| File | Bug | Fix |
|------|-----|-----|
| `orchestrator.js` | All references to `AgentSkills`, `executeSkill`, `BUILTIN_SKILL_DESCRIPTIONS`, `SNAPSHOT_SKILL_LIMIT` were stale after rename | Updated to `AgentTools`, `executeTool`, `BUILTIN_TOOL_DESCRIPTIONS`, `SNAPSHOT_TOOL_LIMIT` |
| `tool-execution.js` | `AgentSkills.getToolExecutionMeta`, `AgentSkillCore.toolMeta`, `orchestrator.executeSkill` were stale | Updated to `AgentTools`, `AgentToolCore`, `orchestrator.executeTool` |
| `session-lifecycle.js` | `AgentSkills.abortAllTabListeners` stale | Updated to `AgentTools.abortAllTabListeners` |
| `agent.js` | `tools.buildInitialContext` referenced via stale `skills` variable from `getRuntimeModules()` | Fixed variable name to `tools` throughout |
| `test-smoke.mjs` | `runtime.skillGroups` check stale after rename | Changed to `runtime.toolGroups` |
| `test-tools-smoke.mjs` | `runtime.skillGroups` check stale | Changed to `runtime.toolGroups` |

Round 5 — runtime `ReferenceError` + filesystem guard:

| File | Bug | Fix |
|------|-----|-----|
| `round-controller.js` | `Perm` used in `executeRound()` but only declared inside `executeToolBatches()` — ReferenceError at runtime | Added `const Perm = window.AgentPermissions \|\| {};` to `executeRound()` |
| `filesystem-guards.js` | `hasSuspiciousWindowsPathPattern` blocked `.` and `..` (valid relative paths) via `/[.\s]+$/` regex | Added exemption: skip check when trailing segment is 1–2 dots only |

Round 6 — confirmation loop, browser downloads, dead entries:

| File | Bug | Fix |
|------|-----|-----|
| `agent.js` | Agent loop skipped past pending confirmation gates — loop continued immediately to next round instead of pausing | Added polling wait loop after `executeRound()` returns `pending-confirmations`: polls `AgentConfirmation.pending()` every 300 ms with `throwIfStopRequested()` for interruptibility |
| `ui-modern.js` | `openConfirmationPanel` / `closeConfirmationPanel` were local functions, inaccessible from `agent.js` | Exposed both on `window` |
| `filesystem-runtime.js` | `fs_download_file` called `resolveFile(path)` even when `content` arg was provided — failed without an authorized File System Access API root | Added early-exit branch: when `content` is set, create blob directly and skip `resolveFile` entirely |
| `prompts/system.md` | No guidance on when to prefer browser downloads vs writing files | Added rule 14: prefer `fs_download_file` with `content` for exports/reports; only use `fs_write_file` when saving to local folder |
| `state.js` | `runtime_fileDiff` missing from `enabledTools` init despite being registered | Added `runtime_fileDiff: true` |
| `tool-execution.js` | Risk map contained `runtime_deleteFile`, `runtime_renamePath`, `runtime_makeDirectory` — tool names that don't exist in the registry | Removed dead entries |
| `tools/groups/filesystem.js` | Fallback tool list had stale names from pre-refactor (`fs_request_root`, `fs_delete`, `fs_rename`, `fs_search`, `fs_find`) | Replaced with actual registry names |

## Documentation

Architecture deep-dive: [`docs/agentic-search-arch.html`](https://samuelishida.github.io/js-agent/agentic-search-arch.html)