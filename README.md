# JS Agent

> Browser-native agentic loop with local LLM routing, modular skills, and filesystem access.

A zero-dependency, single-origin JavaScript agent that runs entirely in the browser. Started as a prototype to simulate a corporate LLM environment (Gemini endpoint + auth constraints), then evolved into a full skill-driven agent with local backend support, persistent sessions, and direct filesystem access via the File System Access API.

---

## What it does

The agent runs a `while (round < MAX_ROUNDS)` loop against any OpenAI-compatible LLM endpoint — Gemini, LM Studio, Ollama, or llama.cpp. On each round it:

1. Sends the message history to the LLM
2. Parses the response for a `<tool_call>` block via regex
3. Executes the matched skill (search, fs, clipboard, weather, calc, etc.)
4. Injects the result back into context as a tool message
5. Repeats until the model replies without a tool call, or `MAX_ROUNDS` is hit
6. Compresses context via a summarization call when `CTX_LIMIT` is exceeded

Final answers are expected as HTML fragments and are sanitized before rendering.

---

## Structure

```
Agent/
├── index.html                  # App shell + sidebar + chat UI
├── assets/styles.css           # All styles
├── src/
│   ├── app.js                  # Bootstrap, agentic loop, session state, LLM router, UI
│   ├── core/
│   │   ├── orchestrator.js     # Prompt composition, skill dispatch, fallback chains
│   │   ├── prompt-loader.js    # fetch() loader with built-in fallbacks for file:// usage
│   │   └── regex.js            # Tool-call extraction, reasoning-leak detection, output validation
│   └── skills/
│       ├── shared.js           # All skill implementations + registry
│       ├── web.js              # Web skill group metadata
│       ├── device.js           # Device/browser skill group metadata
│       ├── data.js             # Data/parsing skill group metadata
│       ├── filesystem.js       # Filesystem skill group metadata
│       └── index.js            # AgentSkillGroups namespace init
├── prompts/
│   ├── system.md               # Main system prompt (template with {{vars}})
│   ├── repair.md               # Injected when model leaks chain-of-thought
│   ├── summarize.md            # Context compression prompt
│   └── orchestrator.md         # Orchestration policy
└── docs/
    └── agentic-search-arch.html  # Interactive architecture diagram (EN/PT-BR)
```

---

## Backends

The app probes local ports on load and auto-activates the first one found. Preferences persist in `localStorage`.

| Backend    | Default port | Endpoint                 |
|------------|-------------|--------------------------|
| LM Studio  | 1234        | `/v1/chat/completions`   |
| Ollama     | 11434       | `/api/chat`              |
| llama.cpp  | 8080        | `/v1/chat/completions`   |
| Gemini     | —           | `generativelanguage.googleapis.com` |

**CORS requirement:** LM Studio and Ollama must have CORS enabled for `file://` or `localhost` origins. In LM Studio: Settings → Local Server → enable CORS. In Ollama: set `OLLAMA_ORIGINS=*`.

The probe uses three fallback strategies in order:
1. `GET /v1/models` — reads model list if CORS is open
2. `GET /v1/models` with `mode: no-cors` — detects opaque response (server reachable, CORS closed)
3. `POST /v1/chat/completions` with a minimal payload — catches servers that only respond to chat requests

---

## Skills

Skills are registered in `src/skills/shared.js` under `window.AgentSkills.registry`. Each entry has `name`, `description`, `run(args, context)`, optional `retries`, and optional `fallbacks` chain.

### Web & Context
| Skill | Description |
|-------|-------------|
| `web_search(query)` | DuckDuckGo + Wikipedia + Wikidata + FX rates in parallel |
| `read_page(url)` | Direct fetch → Jina reader proxy fallback |
| `http_fetch(url, method)` | Raw HTTP resource fetch |
| `extract_links(url\|text)` | Extracts all `href` and inline URLs |
| `page_metadata(url)` | title, description, canonical |

### Device & Browser
| Skill | Description |
|-------|-------------|
| `datetime()` | Current local datetime (BRT) |
| `geo_current_location()` | Navigator geolocation |
| `weather_current()` | open-meteo.com via current coordinates |
| `clipboard_read()` | System clipboard read |
| `clipboard_write(text)` | System clipboard write |
| `storage_list_keys()` | Lists localStorage keys |
| `storage_get(key)` | Read localStorage |
| `storage_set(key, value)` | Write localStorage |

### Local Files (File System Access API — Chromium only)
| Skill | Description |
|-------|-------------|
| `fs_pick_directory()` | Opens directory picker, registers root |
| `fs_list_dir(path)` | Lists directory entries |
| `fs_tree(path)` | Recursive directory tree |
| `fs_read_file(path)` | Reads text file |
| `fs_write_file(path, content)` | Writes file; falls back to browser download |
| `fs_download_file(path\|content, filename)` | Triggers browser download |
| `fs_upload_pick()` | Opens file picker, registers uploads |
| `fs_save_upload(uploadName, destinationPath)` | Saves picked upload to disk |
| `fs_search_name(path, pattern)` | Filename search |
| `fs_search_content(path, pattern)` | Content search in text files |
| `fs_copy_file / fs_move_file / fs_delete_path / fs_rename_path` | File operations |
| `fs_exists / fs_stat / fs_mkdir / fs_touch` | Metadata and creation |

### Data
| Skill | Description |
|-------|-------------|
| `calc(expression)` | Safe JS expression eval |
| `parse_json(text)` | Validate and pretty-print JSON |
| `parse_csv(text)` | Parse and preview CSV |

---

## Preflight enrichment

Before the first LLM round, `buildInitialContext()` runs a preflight plan based on intent detected in the user message:

- **FX intent** (e.g. "cotação do dólar") → fetches live rate from `open.er-api.com` and injects into context
- **URL in message** → fetches the page and pre-loads content
- **Weather/filesystem/save/clipboard/parsing intents** → annotates recommended tools in a `<initial_context>` block

This reduces the number of agentic rounds needed on the first response.

---

## Context management

| Constraint | Default | Configurable |
|------------|---------|--------------|
| `max_rounds` | 10 | Sidebar slider (1–20) |
| `ctx_limit` | 100k chars | Sidebar slider (10k–200k) |
| `response_delay` | 0 ms | Sidebar slider (simulation) |

When context exceeds `ctx_limit`, the agent calls the LLM with `prompts/summarize.md` to compress history into a single block, then rebuilds the message array as `[system, summarized_context, current_query]`.

---

## Sessions

Chat sessions are persisted in `localStorage` under `agent_chat_sessions_v1`. Each session stores:
- message history (full `[{role, content}]` array)
- session stats (rounds, tool calls, context resets, messages)
- title derived from the first user message

Sessions can be switched, deleted individually, or cleared all at once from the sidebar.

Tool results are cached in `localStorage` with a 10-minute TTL (`agent_tool_cache_v1`) to avoid redundant calls within a session.

---

## Reasoning leak detection

`AgentRegex.looksLikeReasoningLeak()` detects when a model returns internal chain-of-thought instead of a tool call or a final answer (patterns like `"Let me…"`, `"The user is asking…"`, `"Okay, the user…"`). When detected, the agent injects `prompts/repair.md` into the next round and continues without surfacing the leak to the UI.

---

## Run

Open `index.html` in a Chromium-based browser.

```
# No build step. No npm. No bundler.
# Just open the file.
```

For local filesystem skills, Chrome or Edge is required (File System Access API). For local LLM routing, start LM Studio or Ollama with CORS enabled before opening the file.

For Gemini: enter your API key in the sidebar. It is stored only in `localStorage` and never sent anywhere other than `generativelanguage.googleapis.com`.

---

## Architecture reference

Open `docs/agentic-search-arch.html` for an interactive diagram of the full execution flow, component relationships, and annotated pseudocode for each loop phase. Includes EN/PT-BR toggle.
