# JS Agent

<p align="center">
  <img src="assets/logo.svg" alt="js-agent logo" width="320">
</p>

Browser-first multi-step AI agent. No bundler. Local or cloud LLM. Modular tool runtime with 86 tools across 5 runtime families. Runs from a single dev server command.

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

- **Web:** `web_search`, `web_fetch`, `read_page`, `http_fetch`, `extract_links`, `page_metadata`, `geo_current_location`, `weather_current`
- **Device/browser:** `clipboard_read/write`, `storage_get/set/list_keys`, `notification_send`, `tab_broadcast/listen`
- **Filesystem:** `fs_list_dir`, `fs_tree`, `fs_walk`, `fs_read_file`, `fs_preview_file`, `fs_write_file`, `fs_append_file`, `fs_edit` (via compat), `fs_search_name`, `fs_search_content`, `fs_glob`, `fs_grep`, `fs_stat`, `fs_exists`, `fs_copy_file`, `fs_move_file`, `fs_delete_path`, `fs_rename_path`, `fs_mkdir`, `fs_touch`, `fs_download_file`, `fs_upload_pick` (File System Access API)
- **Data/planning:** `parse_json`, `parse_csv`, `todo_write`, `task_create/get/list/update`, `worker_batch/list/get`, `ask_user_question`, `memory_write/search/list`, `tool_search`, `snapshot_tool_catalog`
- **GitHub:** `github_search_code`, `github_get_pr`, `github_list_prs`, `github_create_issue`, `github_get_file`, `github_list_issues`
- **Runtime compat:** `runtime_readFile`, `runtime_writeFile`, `runtime_editFile`, `runtime_multiEdit`, `runtime_listDir`, `runtime_glob`, `runtime_searchCode`, `runtime_runTerminal`, `runtime_generateFile`, `runtime_webFetch`, `runtime_getDiagnostics`, `runtime_fileDiff`, `runtime_spawnAgent`

Tools carry execution metadata (`readOnly`, `concurrencySafe`, `risk`). Read-only concurrent tools run in parallel; risky or write tools run sequentially.

## Skills

Skills are **methodology and expertise** — not executable tools. They are `.md` files loaded at runtime that provide domain knowledge, workflows, and guidelines the LLM follows when relevant.

| Resource | Function | Who Controls? | Example |
|----------|----------|---------------|---------|
| **Tools** | Actions / Execution | Model (active call) | `create_jira_issue(title, desc)` |
| **Skills** | Expertise / Methodology | Model (as needed) | "How to review security code" |
| **MCP** | Standardization / Connection | Infrastructure | Connect Slack to Claude |

`window.AgentSkillLoader` auto-loads 17 built-in skills from `src/skills/`:

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

All file generation uses **pure JavaScript** (no Python). Skills are matched to user messages via keyword detection and injected into the system prompt as context blocks.

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
- Windows 8.3 short names (`~1`, `~A`, etc.) are detected and blocked
- Glob patterns on write operations are rejected
- Dangerous removal paths (`/`, `/etc`, `C:\`) are blocked

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