# JS Agent

Browser-first multi-step AI agent. No bundler. Local or cloud LLM. Modular tool runtime with 88 tools across 5 runtime families. Skills on-demand via `skill_search`/`skill_load`.

## Running

Do not open `index.html` directly. Dev server proxies Ollama Cloud requests (browsers block cross-origin POST to `https://ollama.com`).

```bash
node proxy/dev-server.js
# open http://127.0.0.1:5500

OLLAMA_API_KEY="your-key" node proxy/dev-server.js
PORT=8080 node proxy/dev-server.js
```

Node.js 18+ required. No `npm install` — dev server uses built-ins. Chrome/Edge for File System Access API.

### First-time setup (OpenRouter — recommended)

1. Settings → **OpenRouter** → paste API key → **Save** ([get free key](https://openrouter.ai/keys))
2. Select model (free marked `:free`)
3. Check **"Use OpenRouter as active provider"** → start chatting

### First-time setup (Ollama Cloud)

1. Settings → **Ollama** → paste API key → **Save** ([get key](https://ollama.com/settings/api-keys))
2. **Probe** to detect local models
3. Select model → **Enable Ollama** → start chatting

## Desktop App (Electron)

Native desktop build. Embeds dev server. Zero frontend changes.

```bash
npm install               # install Electron + electron-builder
npm run electron          # dev mode (auto-opens DevTools)
npm run electron:build    # build production installers
```

**Windows:** `release/JS Agent Setup.exe` + portable `.exe`  
**macOS:** `release/JS Agent.dmg` + `.zip`  
**Linux:** `release/JS Agent.AppImage` + `.deb`

Electron wrapper:
- `electron/main.js` — starts embedded server on random port, loads UI
- `electron/preload.js` — exposes `window.electronAPI` for native dialogs + external links

Native APIs:
- `window.electronAPI.openFileDialog(options)` — system file picker
- `window.electronAPI.saveFileDialog(options)` — system save dialog
- `window.electronAPI.openExternal(url)` — open URL in default browser
- `window.electronAPI.getAppVersion()` — app version

## Agent Loop

```
User message
  → preflight (intent hints, query plan, deferred prefetches)
  → buildSystemPrompt (orchestrator merges templates + live tool list)
  → LLM call (cloud or local lane)
    → stream reasoning chunks to UI (thinking display)
    → detect final-answer intent from thinking content
  → parse tool calls → execute batches (parallel when safe)
  → apply tool-result context budget
  → inject runtime continuation reminders
  → microcompact older tool results; summarize if context over limit
  → repeat until final answer or round limit
```

### Thinking Display

Reasoning content streamed to UI as collapsible "Thinking…" blocks. Visibility into model reasoning before tool calls or final answers.

Guardrails:
- `thinkingIndicatesFinalAnswer()` — detects when model decided on final answer, prevents unnecessary tool-call-repair loops
- **Deferred-action detection** — skips false-positive guardrails when thinking confirms real final answer
- **Empty-visible fallback** — thinking content used as final answer when model produces only thinking

### Error Recovery

Multiple recovery layers prevent early give-ups:

- **HINT tone on recoverable errors** — `runtime_generateFile` errors use "this is recoverable, just retry!" tone, showing corrected usage inline
- **Tool-call repair** — malformed tool calls repaired automatically; skipped when model already gave final answer (detects apology/final-answer text: "I apologize", "I cannot")
- **Thinking-aware repair** — `shouldAttemptToolCallRepair` checks thinking content before repair, preventing false loops
- **Rule 16 (system.md)** — requires `skill_load` before first tool use, prevents model skipping file-generation skill and hitting avoidable format errors

## Project Structure

```text
Agent/
├── index.html              # bootstrap — defer tags are dependency graph
├── assets/                 # CSS
├── prompts/                # system.md, orchestrator.md, repair.md, summarize.md, safety_guidelines.md
├── proxy/dev-server.js     # static server + Ollama Cloud proxy
├── electron/               # Electron desktop app wrapper
│   ├── main.js             # main process — embedded server + BrowserWindow
│   ├── preload.js          # secure bridge for native APIs
│   └── README.md           # desktop build docs
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
    │   └── algorithmic-art/, pdf/, xlsx/, ...          (17 .md skill dirs)
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

Scripts load with `defer`; execution order = declaration order — no bundler.

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

`constants.js` must precede all modules that read `window.CONSTANTS`. Tools assembled before orchestrator describes available tools.

## Tools

`window.AgentTools.registry` composed from four runtime module families:

- **Web:** `web_search`, `web_fetch`, `read_page`, `http_fetch`, `extract_links`, `page_metadata`, `geo_current_location`, `weather_current`
- **Device/browser:** `clipboard_read/write`, `storage_get/set/list_keys`, `notification_send`, `tab_broadcast/listen`
- **Filesystem:** `fs_list_dir`, `fs_tree`, `fs_walk`, `fs_read_file`, `fs_preview_file`, `fs_write_file`, `fs_append_file`, `fs_edit`, `fs_search_name`, `fs_search_content`, `fs_glob`, `fs_grep`, `fs_stat`, `fs_exists`, `fs_copy_file`, `fs_move_file`, `fs_delete_path`, `fs_rename_path`, `fs_mkdir`, `fs_touch`, `fs_download_file`, `fs_upload_pick`
- **Data/planning:** `parse_json`, `parse_csv`, `todo_write`, `task_create/get/list/update`, `worker_batch/list/get`, `ask_user_question`, `memory_write/search/list`, `tool_search`, `snapshot_tool_catalog`
- **Skills:** `skill_search`, `skill_load` — on-demand methodology discovery (replaces passive pre-loading)
- **GitHub:** `github_search_code`, `github_get_pr`, `github_list_prs`, `github_create_issue`, `github_get_file`, `github_list_issues`
- **Runtime compat:** `runtime_readFile`, `runtime_writeFile`, `runtime_editFile`, `runtime_multiEdit`, `runtime_listDir`, `runtime_glob`, `runtime_searchCode`, `runtime_runTerminal`, `runtime_generateFile`, `runtime_webFetch`, `runtime_getDiagnostics`, `runtime_fileDiff`, `runtime_spawnAgent`

Tools carry execution metadata (`readOnly`, `concurrencySafe`, `risk`). Read-only concurrent tools run in parallel; risky or write tools run sequentially.

## Skills

Skills = **methodology and expertise** — not executable tools. `.md` files providing domain knowledge, workflows, and guidelines. Discovered on-demand via two tools:

- `skill_search(query)` — search available skills by keyword, returns scored matches
- `skill_load(name)` — load full methodology content by name

Replaces old passive-injection model. LLM decides when to pull expertise, saving context tokens.

| Resource | Function | Who Controls? | Example |
|----------|----------|---------------|---------|
| **Tools** | Actions / Execution | Model (active call) | `runtime_generateFile(path, content)` |
| **Skills** | Expertise / Methodology | Model (on-demand via `skill_search`/`skill_load`) | "How to generate a DOCX file" |
| **MCP** | Standardization / Connection | Infrastructure | Connect Slack to Claude |

`window.AgentSkillLoader` manages 16 built-in skills from `src/skills/`:

- **algorithmic-art** — p5.js generative art with seeded randomness
- **brand-guidelines** — Brand colors and typography styling
- **canvas-design** — Visual art in .png/.pdf
- **doc-coauthoring** — Structured documentation co-authoring
- **docx** — Read/edit existing Word documents (creation → file-generation)
- **file-generation** — Generate DOCX, PDF, XLSX, PPTX via Node.js scripts
- **frontend-design** — Production-grade frontend UI
- **internal-comms** — Company communication formats
- **mcp-builder** — MCP server creation guide
- **pdf** — Read/process existing PDFs (creation → file-generation)
- **pptx** — Read/edit existing PowerPoint (creation → file-generation)
- **skill-creator** — Create and improve skills
- **theme-factory** — 10 pre-set themes for styling
- **web-artifacts-builder** — React + Tailwind + shadcn/ui artifacts
- **webapp-testing** — Playwright-based web testing
- **xlsx** — Read/analyze existing spreadsheets (creation → file-generation)

All file generation uses **pure JavaScript** (no Python). Skills cached in localStorage after first load.

## Deploy to Production (Render.com — Free Tier)

### CI/CD

![CI](https://github.com/samuelishida/js-agent/workflows/CI/badge.svg)

Every push to `main` triggers:
- JS syntax check (`npm run check:js`)
- Smoke tests (`npm run test:smoke`)
- Tools smoke tests (`npm run test:tools-smoke`)
- Matrix across Node 18, 20, 22

### One-click deploy

1. Fork repo on GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect GitHub repo
4. Render auto-detects `render.yaml`:
   - **Build Command**: `npm run check:js`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. Add env vars: `OPENROUTER_API_KEY` = your key, `OLLAMA_API_KEY` = (optional)
6. Click **Deploy**

Live at `https://js-agent-xxx.onrender.com` within 2 minutes.

### Manual deploy (any Node.js host)

```bash
git clone https://github.com/YOUR_USER/js-agent.git
cd js-agent
npm install
cp .env.example .env
# Edit .env with OPENROUTER_API_KEY
npm start
```

Server listens on `PORT` (default 5500) and serves SPA + API proxy.

### Health check

```bash
curl https://your-app.onrender.com/api/health
# → {"ok":true,"uptime":123,"version":"0.1.0",...}
```

## Model Routing

Four lanes in `llm.js`:
- **`openrouter`** — OpenRouter.ai (OpenAI-compatible API, 100+ models)
- **`local`** — LM Studio / llama.cpp at custom host
- **`ollama`** — Local Ollama or Ollama Cloud via proxy
- **`cloud`** — Direct browser API calls (Gemini, OpenAI, Claude, Azure)

Local failures fall back to cloud. OpenRouter recommended for new users — free API key, access to state-of-the-art models.

### OpenRouter setup

1. Get free key at [openrouter.ai/keys](https://openrouter.ai/keys)
2. Paste in Settings → **OpenRouter** → API Key → **Save**
3. Select model from dropdown (free use `:free` suffix)
4. Check **"Use OpenRouter as active provider"**

Topbar badge shows active OpenRouter model ID.

### Ollama local model routing

Two-endpoint fallback:

1. **`/v1/chat/completions`** (OpenAI-compatible) — primary, most reliable
2. **`/api/chat`** (native Ollama) — fallback, `stream: true` to avoid timeouts

Cloud Ollama routes through dev server proxy at `/api/ollama/v1`.

All local Ollama calls use streaming to prevent timeout errors.

## Context Management

- **Context budget:** configurable ~5k–640k tokens (slider: 4–512 KB, ≈750 tokens/KB; default ~32k). Max output tokens scale with model context (~25% of effective context)
- **Tool-result budget:** 20 KB inline max, 5 KB preview chunks, keeps 15 recent results. Search tools get 50% boost
- **Microcompact:** older `<tool_result>` blocks replaced with digests each round
- **LLM summarization:** triggered at 82% of limit; cached and reused (`context_summary` scope). Deterministic tail-compression fallback if summarization fails
- **Time-based clearing:** stale results cleared after 20 min inactivity
- **Token-aware thresholds:** context compaction uses actual token estimates via `estimateTokens` + character-ratio hybrid

### Model context size inference

`local-backend.js` infers context window from model name:

- Explicit suffix: `qwen3.5:9b-256k` → 256k context
- Size bracket: `:70b` → 128k, `:30b` → 32k, `:14b` → 16k, `:<14b` → 8k default
- Ollama `/api/show` probe: reads `num_ctx` from model parameters

`max_tokens = min(context_size, context_budget) * 0.25`, floor 512.

### Round + loop limits

- **Round limit:** configurable 1–100 rounds per run (default: 5; slider in Runtime Settings)
- **Context budget slider:** 4–512 KB range ≈ ~5k–640k tokens; displayed as approximate token count in topbar badge

## Safety

Tool outputs untrusted. Loop detects prompt-injection patterns in tool results and injects `<system-reminder>` blocks into continuation prompts. Permission denials accumulate per run; repeated denials escalate permission mode (`default` → `ask` → `deny_write`).

### Prompt injection hardening

Multiple defence layers:

- **Skill content sanitization** — control-channel tags (`<tool_call>`, `<system-reminder>`, `[SYSTEM OVERRIDE]`) stripped from skill `.md` content before injection into system prompt
- **Natural-language injection detection** — `extractPromptInjectionSignals()` detects jailbreak patterns (DAN mode, "ignore previous instructions", "you are now", etc.) in tool results and user input
- **Centralized patterns** — `INJECTION_PATTERNS` in `constants.js` consolidates all heuristics in one location

### Filesystem path validation

`tool-execution.js` guards against path traversal:

- Shell expansion (`$HOME`, backticks, `|`, `&`) rejected
- UNC paths (`\\server\share`, `//server/share`) blocked
- Windows 8.3 short names (`~1`, `~A`) detected and blocked
- Glob patterns on write operations rejected
- Dangerous removal paths (`/`, `/etc`, `C:\`) blocked

### File generation safety

`runtime_generateFile` enforces `.js`/`.cjs`/`.mjs` extension when content provided. Prevents Node.js executing non-JS paths (`.pdf`, `.docx`) which would throw `ERR_UNKNOWN_FILE_EXTENSION`.

## Verification

```bash
npm run test:smoke          # 122 checks — runtime, LLM utils, context, all modules
npm run test:tools-smoke    # tools, snapshot, memory
npm run test:security       # security hardening tests
npm run test:skills-smoke   # skill script validation (24 scripts, 16 SKILL.md files)
npm run check:js            # syntax-check 35 core source files
npm run check:skills-scripts # syntax-check 24 skill scripts
```

```bash
npm run build:snapshot      # regenerate src/tools/generated/snapshot-data.js
```

## Documentation

Architecture deep-dive: [`docs/agentic-search-arch.html`](https://samuelishida.github.io/js-agent/agentic-search-arch.html)
