# JS Agent

Browser-first multi-step agent with hosted/local model routing, transition-based orchestration, modular skills, persistent sessions, and optional filesystem access.

## Overview

JS Agent runs fully in the browser.

For each user request it:

1. Builds system + contextual prompt state
2. Calls the active model (cloud or local)
3. Parses one or more `<tool_call>` blocks
4. Executes tool batches (parallel only when safe/read-only)
5. Injects `<tool_result>` blocks into context
6. Repeats until final answer or round limit

## Current Highlights

- Hosted and local model lanes with fail-fast local URL validation
- Transition-driven loop with deterministic anti-repeat controls
- Tool batching with concurrency-safe execution for read-only calls
- Source-compatible skill aliases (file/glob/grep/task/todo/tool-search families)
- Search pipeline with multi-provider fanout + readable web fallback
- Persistent sessions/tool cache + cross-tab cache and busy sync channels

## Project Structure

```text
Agent/
|- index.html
|- assets/
|  |- styles.css
|  `- styles/
|     |- base/
|     |  |- variables.css
|     |  |- typography.css
|     |  `- forms.css
|     |- components/
|     |  `- modal.css
|     |- layout/
|     |  |- topbar.css
|     |  |- sidebar.css
|     |  |- chat.css
|     |  `- input.css
|     `- utilities/
|        `- responsive.css
|- prompts/
|  |- system.md
|  |- repair.md
|  |- summarize.md
|  `- orchestrator.md
|- src/
|  |- app/
|  |  |- state.js
|  |  |- local-backend.js
|  |  |- tools.js
|  |  |- llm.js
|  |  `- agent.js
|  |- core/
|  |  |- orchestrator.js
|  |  |- prompt-loader.js
|  |  `- regex.js
|  `- skills/
|     |- shared.js
|     |- web.js
|     |- device.js
|     |- data.js
|     |- filesystem.js
|     `- index.js
`- docs/
   `- agentic-search-arch.html
```

## Model Routing

The runtime can route to:

- Cloud providers configured in UI (`gemini/*`, `openai/*`, `claude/*`, `azure/*`)
- Local OpenAI-compatible endpoints (LM Studio/Ollama-style)

Local routing behavior:

- URL is normalized and validated before use
- Invalid local URL fails fast with explicit configuration error
- Endpoint probing tries compatible paths and schemas
- Aborted requests are surfaced as abort/timeout, not endpoint incompatibility

## Skills

Skills are registered in `window.AgentSkills.registry` (implemented in `src/skills/shared.js`).

Primary capability families:

- Web/context: `web_search`, `web_fetch`, `read_page`, `http_fetch`, `extract_links`, `page_metadata`
- Device/browser: datetime, geolocation, weather, clipboard, storage, notifications, tab messaging
- Filesystem: root auth/list/read/write/copy/move/delete/rename/tree/stat/exists/search/upload/download
- Search utilities: `fs_glob`, `fs_grep`, and aliases `glob`, `grep`
- File aliases: `file_read`, `read_file`, `file_write`, `write_file`, `file_edit`, `edit_file`
- Planning/tasking: `todo_write`, `task_create`, `task_get`, `task_list`, `task_update`, `tool_search`, `ask_user_question`

### Search Reliability

`web_search` uses a multi-provider strategy and now includes:

- Better query variants for names/entities
- Intent-aware provider gating and diagnostics
- Readable fallback via `r.jina.ai` when APIs are blocked/empty
- Explicit verification warning for sensitive biographical claims with weak source diversity

## Runtime Controls

The settings modal exposes:

- Planning depth (max rounds)
- Context budget
- Response pacing
- Model/provider selection
- Local backend probing and enablement
- Tool enable/disable toggles

When context exceeds budget, the app compacts context with summarization and fallback compression.

## Persistence

Stored in `localStorage`:

- Conversation sessions and stats
- Tool cache (bucketed, versioned, TTL-aware)
- Active session and sidebar UI state
- Local backend preferences
- Task/todo stores for relevant skills

Cross-tab channels:

- Cache synchronization
- Busy-state synchronization
- Agent messaging topics (`tab_broadcast`/`tab_listen`)

## Running

Open `index.html` in a Chromium-based browser.

No build step is required.

Recommended:

- Chrome or Edge for full File System Access API support
- Local model server with browser-accessible CORS config
- API key configured in Settings for cloud lane

## Docs

Architecture and flow reference lives in `docs/agentic-search-arch.html`.
