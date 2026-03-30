# JS Agent

Browser-based multi-step agent with hosted and local model routing, modular skills, persistent sessions, and optional filesystem access.

## Overview

JS Agent runs entirely in the browser. It sends chat history to a model, detects `<tool_call>` blocks in the reply, executes the requested skill, injects the result back into context, and repeats until the model answers directly or the round limit is reached.

Key capabilities:

- Hosted Gemini model support
- Local model routing through LM Studio, Ollama, and llama.cpp style endpoints
- Web, clipboard, weather, parsing, and filesystem skills
- Persistent conversations and cached tool results in `localStorage`
- Context summarization when the session grows too large
- Collapsible workspace UI with modular app and style architecture

## Project Structure

```text
Agent/
|- index.html                     # App shell
|- assets/
|  |- styles.css                 # CSS entrypoint
|  `- styles/
|     |- base.css                # tokens, layout, header
|     |- sidebar.css             # sidebar, controls, stats
|     |- chat.css                # chat stream, messages, notices
|     |- input.css               # composer and footer controls
|     `- responsive.css          # responsive layout rules
|- prompts/
|  |- system.md
|  |- repair.md
|  |- summarize.md
|  `- orchestrator.md
|- src/
|  |- app.js                     # compatibility stub
|  |- app/
|  |  |- state.js               # shared state, sessions, sidebar state
|  |  |- local-backend.js       # local backend probing and activation
|  |  |- tools.js               # tool panel rendering and prompt helpers
|  |  |- llm.js                 # hosted/local model routing and sanitization
|  |  `- agent.js               # loop orchestration, UI events, init
|  |- core/
|  |  |- orchestrator.js        # prompt composition and skill dispatch
|  |  |- prompt-loader.js       # prompt loading with built-in fallback content
|  |  `- regex.js               # tool-call extraction and validation
|  `- skills/
|     |- shared.js              # skill implementations and registry
|     |- web.js
|     |- device.js
|     |- data.js
|     |- filesystem.js
|     `- index.js
`- docs/
   `- agentic-search-arch.html  # architecture reference
```

## Backends

The app can route requests to either hosted Gemini models or local OpenAI-compatible endpoints.

Default local probes:

- LM Studio: `http://localhost:1234`
- Ollama: `http://localhost:11434`
- llama.cpp: `http://localhost:8080`
- Generic local server: `http://localhost:5000`

Probe flow:

1. Try model-list endpoints such as `/v1/models` or `/api/tags`
2. Fall back to opaque `no-cors` detection
3. Fall back to a minimal chat request for reachability

If local routing is enabled, the UI switches model execution to the local backend. Otherwise it uses the selected Gemini model.

Recommended local model (current best result):

- `mistralai/devstral-small-2-2512`

## Skills

Skills are registered in `src/skills/shared.js` under `window.AgentSkills.registry`.

Main groups:

- Web and context: search, page reading, metadata, HTTP fetch, link extraction
- Device and browser: datetime, geolocation, weather, clipboard, localStorage helpers
- Filesystem: directory picking, file read/write, upload, download, preview, search
- Data: calculator, JSON parsing, CSV parsing

Notable behavior:

- `fs_write_file` falls back to browser download when direct filesystem access is unavailable
- `web_search` combines multiple sources and reports diagnostics when providers fail
- malformed tool-call JSON is parsed with a resilient fallback extractor

## Runtime Behavior

Each turn follows this pattern:

1. Build system prompt and initial context
2. Call the active model
3. Parse tool call or final answer
4. Execute one tool when requested
5. Inject `<tool_result>` into context
6. Repeat until completion or round limit

Rendering pipeline:

- The model reply is treated as Markdown
- The app renders Markdown to HTML and sanitizes output before display

Configurable runtime controls in the UI:

- Planning depth
- Context budget
- Response pacing

When the accumulated context exceeds the limit, the app summarizes the conversation and rebuilds the message array with compact context.

## Sessions and Cache

Conversation state is stored in `localStorage`.

Persisted data includes:

- sessions and message history
- per-session stats
- selected local backend preferences
- sidebar collapsed/open state
- cached tool results with a short TTL

## Running the App

Open `index.html` in a Chromium-based browser.

There is no build step and no package manager requirement.

Notes:

- Chrome or Edge is recommended for filesystem features
- LM Studio or Ollama should have CORS enabled for browser access
- Gemini API keys are stored in browser `localStorage`

## Architecture Reference

Open `docs/agentic-search-arch.html` for the interactive architecture diagram and flow reference.
