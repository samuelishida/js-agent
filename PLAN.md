# JS Agent “Modern Browser Agent” Enhancement Plan

## Summary
Build JS Agent into a full browser-first agent platform inspired by Hermes Agent’s strongest ideas: MCP-native tools, real browser automation, durable searchable sessions, curated memory, toolsets, scheduled tasks, plugins, and stronger multi-step orchestration. Hermes’ public docs highlight the target capabilities: self-improving memory/skills, MCP discovery, browser automation, toolsets, cron, and searchable sessions ([Hermes README](https://github.com/NousResearch/hermes-agent), [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp), [Browser](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser/), [Tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/), [Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)).

Current JS Agent already has a useful base: a browser loop, tool registry, skills, memory, attachments, MCP HTTP bridge, Electron wrapper, and dev-server runtime. The upgrade should keep that browser-first spirit but replace the “simple harness” with durable platform subsystems.

## Key Changes
- **Agent Runtime Core:** Introduce a `RunGraph` runtime that tracks goals, tasks, tool calls, observations, retries, blockers, confirmations, artifacts, and final evidence. The loop should stop being “rounds over messages” and become “planner → task queue → executor → verifier → finalizer,” while still rendering chat normally.

- **Toolsets and Capability Registry:** Replace the flat `enabledTools` map with named toolsets: `safe`, `web`, `browser`, `filesystem`, `code`, `mcp:<server>`, `memory`, `scheduler`, `media`, `developer`, and `all`. This matches Hermes’ toolset model and gives JS Agent clean per-session/per-platform controls.

- **MCP v1 Upgrade:** Expand the current thin HTTP-only MCP bridge in [mcp-client.js](/e:/Code/Agent/src/app/llm/mcp-client.js:1) and [mcp-bridge.js](/e:/Code/Agent/src/tools/mcp-bridge.js:1) into a full MCP manager. Support remote HTTP/SSE through the proxy, local stdio MCP servers through the dev server/Electron sidecar, per-server tool filtering, `/reload-mcp`, resources/prompts listing, dynamic `tools/list_changed`, secrets stored server-side, and a visible MCP status/settings panel.

- **Browser Agent Tools:** Add a real browser automation subsystem using Playwright/CDP from the dev server or Electron. Expose tools: `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_press`, `browser_back`, `browser_screenshot`, `browser_extract`, `browser_upload_file`, `browser_downloads`, and `browser_close`. Snapshots should return accessibility-tree refs like `@e1`, with screenshots available for vision models.

- **Durable Sessions and Recall:** Move sessions from localStorage-only [session-manager.js](/e:/Code/Agent/src/app/core/session-manager.js:1) to IndexedDB with an inverted text index. Store message history, tool calls, artifacts, model config, system prompt snapshot, token estimates, parent session links after compaction, and searchable summaries. Add `session_search(query)` and “recall before asking me again” guidance.

- **Memory System:** Split memory into `USER.md`-style profile memory and `MEMORY.md`-style project/agent memory, with bounded budgets, dedupe, replacement, and a visible review UI. Keep the existing runtime memory module, but add curation: proposed memories should be scored, merged, and auditable before long-term insertion.

- **Attachments and Artifacts:** Finish attachment support as a first-class artifact system. Attachments, generated PDFs, screenshots, downloads, and tool outputs should all become `Artifact` records with ids, MIME, size, source, preview, full content handle, and retention policy. Tools should reference artifact ids instead of copying large payloads into prompts.

- **Scheduler:** Add a `cronjob`-style tool for browser/Electron/dev-server runs: create, list, pause, resume, run, update, remove. Browser-only schedules run while the tab is open; Electron/dev-server schedules persist and run in the background. Jobs can attach skills/toolsets and deliver results to chat, file, webhook, or MCP-connected destinations.

- **Plugin System:** Add lightweight plugin manifests for skills, tools, UI panels, toolsets, and MCP server presets. Browser plugins can be declarative only; Electron/dev-server plugins may include local JS modules loaded by the sidecar with explicit user approval.

- **Evaluation Harness:** Add scenario tests for agent behavior, not just syntax. Each eval defines prompt, enabled toolsets, fixtures, expected tool sequence, artifact assertions, and final-answer checks. This catches failures like the attachment PDF flow where static checks pass but the harness breaks at runtime.

## Implementation Phases
- **Phase 1: Stabilize the Harness.** Fix current known breakpoints first: tool-call validation context, attachment ids/full-text reads, artifact ids, file-generation skill/runtime mismatch, and provider attachment handling. Add runtime tests for “attach HTML → create PDF.”

- **Phase 2: Runtime Graph.** Add `RunGraph`, `Task`, `Observation`, `Artifact`, and `RunEvent` types. Keep the existing chat UI but drive execution from the graph. Add event logging and a collapsible run inspector.

- **Phase 3: MCP Manager.** Replace current MCP bridge with a managed subsystem: server config, status, reload, tool filtering, resources/prompts, stdio sidecar, remote HTTP/SSE, dynamic refresh, and security gating.

- **Phase 4: Browser Automation.** Add Playwright/CDP sidecar tools, isolated browser sessions, accessibility snapshots, screenshots, downloads/uploads, dialog handling, and cleanup. Use web search/fetch for simple reads; use browser tools for interaction.

- **Phase 5: Durable Memory and Sessions.** Migrate localStorage sessions into IndexedDB, add searchable session recall, memory curation UI, bounded profile/project memory, and session lineage after compaction.

- **Phase 6: Agentic Platform Features.** Add scheduler, plugin manifests, richer subagents/workers, artifact gallery, model/tool routing policies, and scenario eval dashboards.

## Public Interfaces
- Add `window.AgentRuntime.startRun({ message, attachments, toolsets, mode })`, returning a `runId` and streaming `RunEvent`s.

- Add `window.AgentArtifacts` with `register`, `get`, `preview`, `readText`, `download`, `forget`, and `list`.

- Add `window.AgentMcpManager` with `addServer`, `reload`, `listServers`, `listTools`, `listResources`, `callTool`, and `setToolFilter`.

- Add agent tools: `session_search`, `artifact_list`, `artifact_read`, `browser_*`, `cronjob`, `plugin_list`, `plugin_enable`, and `mcp_reload`.

## Test Plan
- Add end-to-end evals for: attached HTML to PDF, browser login/form flow, MCP filesystem server discovery, MCP tool filtering, session recall, memory curation, scheduled task execution, artifact download, and interrupted/retried runs.

- Add security tests for MCP SSRF blocking, stdio command approval, browser session cleanup, prompt injection from web/MCP/tool output, attachment size caps, and destructive tool confirmation.

- Add regression tests that execute real runtime paths rather than substring checks, especially around tool-call validation, repair, compaction, and provider multimodal message conversion.

## Assumptions
- Preserve browser-first/no-bundler UX for the web app, but allow Electron/dev-server sidecar features for MCP stdio, browser automation, persistent scheduler, and local execution.

- Prioritize local/private operation by default: no external tool gateway dependency, but keep OpenRouter/cloud providers as model lanes.

- Build this as incremental PRs. Do not attempt the whole Hermes-sized platform in one pass; land stable foundations first, then add power features.
