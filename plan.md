# JS Agent — Comprehensive Improvement Plan

> **Status:** In Progress · **Last updated:** 2026-04-24 · **Codebase:** ~16,300 lines across 30+ files
>
> **Completed Phases:** 1, 2, 3, 4, 5, 7  
> **Current Branch:** `dev`  
> **Latest Commit:** `eb6e910` — Phase 5 + Phase 7  
> **Test Status:** All 117 smoke tests + skills smoke + security tests passing ✅

---

## Table of Contents

1. [Architecture Overview & Current State](#1-architecture-overview--current-state)
2. [Problem Analysis](#2-problem-analysis)
3. [Hybrid Type Safety (JSDoc + `.d.ts`)](#3-hybrid-type-safety-jsdoc--dts)
4. [Reduce `window.*` Global Coupling](#4-reduce-window-global-coupling)
5. [Refactor agent.js & Reorganize `app/`](#5-refactor-agentjs--reorganize-app)
6. [Refactor Large Files](#6-refactor-large-files)
7. [LLM Provider Abstraction](#7-llm-provider-abstraction)
8. [Security Hardening](#8-security-hardening)
9. [Testing Strategy](#9-testing-strategy)
10. [Performance Optimization](#10-performance-optimization)
11. [Dev Server & Proxy Improvements](#11-dev-server--proxy-improvements)
12. [CI/CD & Quality Gates](#12-cicd--quality-gates)
13. [Documentation Improvements](#13-documentation-improvements)
14. [Implementation Roadmap](#14-implementation-roadmap)
15. [Risk Assessment & Rollback](#15-risk-assessment--rollback)
16. [Success Metrics](#16-success-metrics)

---

## 1. Architecture Overview & Current State

### Bootstrap Architecture

The project uses **zero-build, browser-first ES modules** loaded via `<script defer>` tags in declaration order. There is no bundler, no transpiler, no TypeScript compiler. The dependency graph is implicit: each file publishes to `window.*` globals, and downstream files reference those globals.

```
index.html (defer scripts)
  → core/regex.js, core/prompt-loader.js
  → skills/core/*, skills/modules/*, skills/shared.js, skills/groups/*, skills/index.js
  → core/orchestrator.js
  → app/state.js, app/constants.js, app/runtime-memory.js
  → app/permissions.js, app/compaction.js, app/filesystem-guards.js, app/steering.js
  → app/rate-limiter.js, app/worker-manager.js, app/local-backend.js
  → app/tools.js, app/tool-execution.js
  → app/ui-render.js, app/reply-analysis.js
  → app/llm.js, app/child-agent.js, app/agent.js, app/ui-modern.js, app/app-init.js
```

### File Size Distribution

| File | Lines | Role |
|------|------:|------|
| `skills/shared.js` | 1,773 | Skill registry, preflight, planner, broadcast |
| `llm.js` | 1,764 | Multi-lane LLM routing, streaming, 7 providers |
| `state.js` | 874 | Session management, localStorage, routing |
| `agent.js` | 763 | Agent loop, UI wiring, error recovery |
| `tool-execution.js` | 573 | Tool dispatch, batching, guards |
| `ui-render.js` | 668 | Markdown engine, messages, sidebar |
| `local-backend.js` | 690 | LM Studio/Ollama probes, provider state |
| `orchestrator.js` | 435 | Prompt builder, skill executor |
| `runtime-memory.js` | 463 | Cache + long-term memory |
| `compaction.js` | 259 | Context management, injection detection |
| `filesystem-guards.js` | 110 | Path validation |
| `reply-analysis.js` | 164 | Model reply parsing |
| `constants.js` | 179 | Budgets, timeouts, thresholds |
| `permissions.js` | 136 | Denial tracking, escalation |
| `app-init.js` | 118 | DOMContentLoaded bootstrap |
| `ui-modern.js` | 115 | Settings modal |
| `child-agent.js` | 99 | Sub-agent spawn |
| `rate-limiter.js` | 71 | Per-tool rate limiting |
| `worker-manager.js` | 61 | Sandbox worker |
| `steering.js` | 47 | Mid-flight guidance |
| `tools.js` | 40 | Tool group rendering |
| **Total `src/app/`** | **~7,043** | |
| **Total `src/skills/`** | **~5,236** | |
| **Total project** | **~16,300** | |

### Global Coupling Map

Every module publishes to `window.*` and consumes from `window.*`. This creates an implicit dependency graph with no import/export validation:

| Module | Publishes | Consumes From |
|--------|-----------|---------------|
| `agent.js` | `requestStop`, `sendMessage`, `handleKey`, `autoResize`, `useExample` | `AgentLLMControl`, `AgentSkills`, `AgentToolExecution`, `AgentCompaction`, `AgentPermissions`, `AgentMemory`, `AgentSteering`, `AgentOrchestrator`, `AgentRegex`, `AgentPrompts`, `CONSTANTS`, `messages`, `sessionStats`, `enabledTools`, `localBackend`, `ollamaBackend`, `openrouterBackend`, `apiKey` |
| `llm.js` | `AgentLLMControl`, `callLLM`, `isLocalModeActive` | `CONSTANTS`, `localBackend`, `ollamaBackend`, `openrouterBackend`, `apiKey`, `AgentRegex` |
| `tool-execution.js` | `AgentToolExecution`, `AgentConfirmation`, `steerToolCall` | `AgentSkills`, `AgentFsGuards`, `AgentWorkers`, `AgentRateLimiter`, `AgentCompaction`, `AgentPermissions`, `AgentOrchestrator`, `AgentRegex`, `CONSTANTS`, `enabledTools` |
| `state.js` | `apiKey`, `messages`, `sessionStats`, `isBusy`, `enabledTools`, `localBackend`, `ollamaBackend`, `openrouterBackend`, `chatSessions`, `activeSessionId` | `AgentCompaction`, `AgentToolExecution`, `AgentUIRender` |
| `orchestrator.js` | `AgentOrchestrator` | `AgentSkills`, `AgentPrompts`, `AgentRegex`, `CONSTANTS`, `enabledTools` |

---

## 2. Problem Analysis

### Critical Problems

| # | Problem | Evidence | Impact |
|---|---------|----------|--------|
| P1 | **agent.js is a god object** | 763 lines, 510-line `agentLoop()`, handles loop orchestration + error recovery + tool repair + UI wiring + session lifecycle | Hard to test, hard to modify, high regression risk |
| P2 | **Implicit global coupling** | 20+ `window.*` globals consumed across files, no import validation | Silent breakage on rename/reorder, no tree-shaking |
| P3 | **No unit tests** | Only smoke tests (1517 lines of integration tests in `test-smoke.mjs`) | Regressions caught only at runtime |
| P4 | **llm.js is monolithic** | 1764 lines, 7 provider implementations inline | Adding a provider requires understanding all 7 |
| P5 | **shared.js is monolithic** | 1773 lines, skill registry + preflight + planner + broadcast | Hard to extend skills without touching core |

### Significant Problems

| # | Problem | Evidence | Impact |
|---|---------|----------|--------|
| S1 | **Flat `app/` directory** | 20 files, no grouping by concern | Hard to navigate, mixed responsibilities |
| S2 | **No type safety** | Pure JS, no JSDoc, no `.d.ts` | IDE provides only basic autocomplete |
| S3 | **state.js is oversized** | 874 lines, session management + UI state + model routing + cache | Multiple reasons to change |
| S4 | **Error handling is scattered** | Error recovery logic duplicated across agent.js and llm.js | Inconsistent error messages, missed edge cases |
| S5 | **No dependency injection** | All modules read from `window.*` at call time | Can't mock for testing, can't run in Node.js |
| S6 | **Dev server has no tests** | proxy/dev-server.js has 495 lines, zero test coverage | API proxy regressions caught only in production |

### Minor Problems

| # | Problem | Evidence | Impact |
|---|---------|----------|--------|
| M1 | **No ESLint config** | `npm run lint` exists but no `.eslintrc` | Inconsistent style |
| M2 | **No `.editorconfig`** | Mixed indentation styles possible | Diff noise |
| M3 | **Hardcoded magic numbers** | `82` (compaction threshold), `20` (tool result budget KB), `5` (max tool calls) scattered | Hard to tune |
| M4 | **No changelog** | Bug fixes documented in README only | Hard to track what changed |
| M5 | **Prompts are markdown files** | No versioning, no A/B testing capability | Can't measure prompt effectiveness |

---

## 3. Hybrid Type Safety (JSDoc + `.d.ts`)

Since the project is **browser-first with no bundler**, a full TypeScript migration would break the zero-build architecture. Instead, use a **hybrid approach** that adds type safety without adding a build step.

### Phase 1: `jsconfig.json` + Core Type Definitions

Create `jsconfig.json` at the project root:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "checkJs": true,
    "noEmit": true,
    "allowJs": true,
    "strictNullChecks": false,
    "noImplicitAny": false,
    "baseUrl": ".",
    "paths": {
      "src/*": ["src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "proxy", "scripts"]
}
```

This enables TypeScript checking on JS files with **zero build step** and **zero runtime impact**.

### Phase 2: Centralized Type Definitions (`src/types/agent.d.ts`)

Create a single `.d.ts` file that declares the global `window` APIs and shared shapes. This gives **go-to-definition** and **refactoring** across the entire codebase without touching any `.js` files.

```typescript
// src/types/agent.d.ts

// ─── Core Shapes ───────────────────────────────────────────────

declare interface ToolCall {
  tool: string;
  args: Record<string, any>;
  call_id?: string;
  id?: string;
}

declare interface BatchResult {
  call: ToolCall;
  result: string;
}

declare interface LlmCallOptions {
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  retries?: number;
  signal?: AbortSignal;
}

declare interface LlmResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

declare interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string }>;
  toolCallId?: string;
  name?: string;
}

declare interface SessionStats {
  rounds: number;
  toolCalls: number;
  startTime: number;
  lastActivity: number;
  totalTokens?: number;
}

// ─── Window Global Declarations ─────────────────────────────────

declare interface Window {
  // Core
  CONSTANTS: Record<string, any>;
  AgentRegex: import('./core/regex').AgentRegexAPI;
  AgentPrompts: import('./core/prompt-loader').AgentPromptsAPI;
  AgentOrchestrator: import('./core/orchestrator').AgentOrchestratorAPI;

  // Skills
  AgentSkills: import('./skills/shared').AgentSkillsAPI;
  AgentSnapshot: any;
  AgentSkillModules: Record<string, any>;
  AgentSkillGroups: Record<string, any>;
  AgentSkillCore: { intents: any; toolMeta: any };

  // App state
  messages: SessionMessage[];
  sessionStats: SessionStats;
  isBusy: boolean;
  enabledTools: Record<string, boolean>;
  apiKey: string;
  localBackend: Record<string, any>;
  ollamaBackend: Record<string, any>;
  openrouterBackend: Record<string, any>;
  chatSessions: any[];
  activeSessionId: string;
  agentInstanceId: string;

  // App modules
  AgentToolExecution: import('./app/tool-execution').AgentToolExecutionAPI;
  AgentCompaction: import('./app/compaction').AgentCompactionAPI;
  AgentPermissions: import('./app/permissions').AgentPermissionsAPI;
  AgentRateLimiter: import('./app/rate-limiter').AgentRateLimiterAPI;
  AgentSteering: import('./app/steering').AgentSteeringAPI;
  AgentWorkers: import('./app/worker-manager').AgentWorkersAPI;
  AgentFsGuards: import('./app/filesystem-guards').AgentFsGuardsAPI;
  AgentMemory: import('./app/runtime-memory').AgentMemoryAPI;
  AgentRuntimeCache: import('./app/runtime-memory').AgentRuntimeCacheAPI;
  AgentLLMControl: import('./app/llm').AgentLLMControlAPI;
  AgentChildAgent: { spawnAgentChild: (opts: any) => Promise<string> };
  AgentReplyAnalysis: import('./app/reply-analysis').AgentReplyAnalysisAPI;
  AgentUIRender: import('./app/ui-render').AgentUIRenderAPI;

  // Functions
  requestStop: () => void;
  sendMessage: () => Promise<void>;
  handleKey: (e: KeyboardEvent) => void;
  autoResize: (el: HTMLTextAreaElement) => void;
  useExample: (btn: HTMLButtonElement) => void;
  setStatus: (text: string, type?: string) => void;
  probeLocal: () => Promise<void>;
  toggleLocalBackend: () => Promise<void>;
  probeOllama: () => Promise<void>;
  toggleOllamaBackend: () => Promise<void>;
  openSettings: () => void;
  closeSettings: () => void;
  callLLM: (msgs: SessionMessage[], options?: LlmCallOptions) => Promise<LlmResponse>;
  isLocalModeActive: () => boolean;
  spawnAgentChild: (opts: any) => Promise<string>;
  steerToolCall: (toolName: string, args: any) => any;
}
```

### Phase 3: JSDoc Annotations for Critical Files

Add JSDoc to the highest-value files first (where type errors are most costly):

**Priority 1 — Security-critical (filesystem guards, tool execution):**

```javascript
// @ts-check
// src/app/tool-execution.js

/**
 * @typedef {Object} ToolCall
 * @property {string} tool - Canonical tool name
 * @property {Record<string, any>} args - Tool arguments
 * @property {string} [call_id] - Unique call identifier
 * @property {string} [id] - Alternative identifier
 */

/**
 * Execute a single tool call with full guard pipeline.
 * @param {ToolCall} call - The tool call to execute
 * @returns {Promise<string>} Tool result as string
 */
async function executeTool(call) { ... }
```

**Priority 2 — Complex logic (compaction, LLM):**

```javascript
// src/app/compaction.js

/**
 * @typedef {Object} CompactionOptions
 * @property {number} [keepRecent=8] - Number of recent tool results to preserve
 * @property {number} [maxInlineChars=20000] - Max chars for inline tool results
 * @property {number} [previewChunkChars=5000] - Chars per preview chunk
 */

/**
 * Apply the full context management pipeline.
 * Checks thresholds, microcompacts if needed, summarizes if over limit.
 * @param {Object} opts
 * @param {SessionMessage[]} opts.messages - Current message history
 * @param {number} opts.ctxLimit - Context limit in characters
 * @param {number} opts.round - Current round number
 * @returns {string[]} - List of actions taken
 */
function applyContextManagementPipeline(opts) { ... }
```

**Priority 3 — State management (state, orchestrator):**

```javascript
// src/app/state.js

/**
 * @typedef {Object} Session
 * @property {string} id - Session UUID
 * @property {string} title - Display title
 * @property {SessionMessage[]} messages - Message history
 * @property {SessionStats} stats - Session statistics
 * @property {number} createdAt - Creation timestamp
 * @property {number} updatedAt - Last update timestamp
 */

/**
 * Create a new chat session.
 * @param {string} [initialTitle] - Optional title (auto-generated if omitted)
 * @returns {Session} The newly created session
 */
function createSession(initialTitle) { ... }
```

### Phase 4: Opt-In `// @ts-check` Rollout

Add `// @ts-check` to files incrementally, starting with the most critical:

| Order | File | Rationale |
|-------|------|-----------|
| 1 | `tool-execution.js` | Security-critical: filesystem guards, path traversal |
| 2 | `compaction.js` | Complex logic, easy to break with off-by-one errors |
| 3 | `filesystem-guards.js` | Security: path validation |
| 4 | `llm.js` | Many provider-specific response shapes |
| 5 | `state.js` | Session management, data integrity |
| 6 | `agent.js` | After refactoring (see §5) |
| 7 | `orchestrator.js` | Prompt building, skill execution |
| 8 | `reply-analysis.js` | Regex-heavy, fragile |

---

## 4. Reduce `window.*` Global Coupling

### Current Problem

Every module publishes to `window.*` and consumes from `window.*`. This creates:
- **Silent breakage**: Renaming a function in one file doesn't warn consumers
- **No tree-shaking**: Can't determine what's actually used
- **No mocking**: Can't inject test doubles
- **Implicit ordering**: Script load order is the only dependency validation

### Target: Dependency Injection via Module Registry

Introduce a lightweight module registry that replaces direct `window.*` access with named dependency resolution. This is **not** a full DI framework — it's a simple lookup table that preserves the zero-build architecture.

```javascript
// src/core/registry.js — NEW FILE (~60 lines)
const _modules = {};

function register(name, api) {
  if (_modules[name] && _modules[name] !== api) {
    console.warn(`[registry] Overwriting module: ${name}`);
  }
  _modules[name] = Object.freeze(api);
}

function resolve(name) {
  if (!_modules[name]) {
    throw new Error(`[registry] Module not found: ${name}. ` +
      `Available: ${Object.keys(_modules).join(', ')}`);
  }
  return _modules[name];
}

function listModules() {
  return Object.keys(_modules);
}

window.AgentRegistry = { register, resolve, listModules };
```

**Migration pattern (incremental, file-by-file):**

```javascript
// BEFORE (tool-execution.js):
const skills = window.AgentSkills;
const result = skills.execute(call);

// AFTER (tool-execution.js):
const { resolve } = window.AgentRegistry;
// At module top level:
const AgentSkills = resolve('AgentSkills');
const result = AgentSkills.execute(call);

// Or at function level (lazy resolution):
function executeTool(call) {
  const skills = resolve('AgentSkills');
  return skills.execute(call);
}
```

**Benefits:**
- **Fail-fast**: Missing dependency throws immediately with a clear message
- **Freeze protection**: `Object.freeze()` prevents accidental mutation of module APIs
- **Testability**: Tests can `register('AgentSkills', mockSkills)` before loading the module
- **Discoverability**: `listModules()` shows what's available
- **Zero build step**: Still uses `window.*`, just with a validation layer

**Migration order:**
1. Create `registry.js` and add to `index.html` as the **first** script
2. Add `register()` calls to each module's existing `window.*` assignment
3. Replace `window.AgentXxx` reads with `resolve('AgentXxx')` in consumers
4. Remove direct `window.*` reads once all consumers are migrated

This is a **gradual migration** — both patterns work simultaneously during transition.

---

## 5. Refactor agent.js & Reorganize `app/`

### Current Problems

| Problem | Evidence |
|---------|----------|
| agent.js is ~763 lines | Handles loop orchestration, error recovery, tool repair, UI wiring, session lifecycle |
| `agentLoop()` is ~510 lines | Nested error handling, tool execution, compaction, final answer forcing |
| Flat `app/` directory | 20 files with no grouping; mixed concerns (UI, LLM, tools, context, agent logic) |
| No separation of concerns | agent.js talks to DOM, calls LLM, executes tools, manages context |

### Target Architecture

```
src/app/
├── agent/
│   ├── agent-loop.js          # Main loop orchestration only (~150 lines)
│   ├── round-controller.js    # Single round: LLM → parse → execute → compact
│   ├── error-recovery.js      # Error classification + recovery strategies
│   ├── tool-call-repair.js    # Malformed tool call detection + LLM repair
│   └── session-lifecycle.js   # sendMessage, stop, reset guards, UI wiring
├── llm/
│   ├── llm.js                 # (existing) multi-lane routing, streaming
│   ├── local-backend.js       # (existing) Ollama/LM Studio probes
│   └── child-agent.js         # (existing) spawnAgentChild
├── tools/
│   ├── tool-execution.js      # (existing) dispatch, batching, guards
│   ├── filesystem-guards.js   # (existing) path validation
│   └── rate-limiter.js        # (existing) per-tool rate limiting
├── context/
│   ├── compaction.js          # (existing) context compaction, injection detection
│   ├── steering.js            # (existing) mid-flight guidance
│   └── runtime-memory.js      # (existing) cache, memory
├── ui/
│   ├── ui-render.js           # (existing) markdown, messages, sidebar
│   ├── ui-modern.js           # (existing) settings modal
│   └── tools.js               # (existing) tool group rendering, toggles
├── core/
│   ├── state.js               # (existing) session, localStorage, routing
│   ├── constants.js           # (existing) budgets, timeouts
│   └── permissions.js         # (existing) denial tracking, escalation
├── reply-analysis.js          # (existing) model reply parsing
└── app-init.js                # (existing) DOMContentLoaded bootstrap
```

### Extraction Plan for agent.js

**Current agent.js responsibilities (763 lines):**

| Responsibility | Lines | Extract To |
|---------------|------:|------------|
| Constants accessor `C()` | 5 | Remove (use `resolve('CONSTANTS')`) |
| Stop control (`requestStop`, `throwIfStopRequested`, `setStopButtonState`) | ~30 | `session-lifecycle.js` |
| Run guards (`resetRunGuards`) | ~15 | `session-lifecycle.js` |
| Tool call repair (`shouldAttemptToolCallRepair`, `attemptToolCallRepair`) | ~80 | `tool-call-repair.js` |
| LLM call options (`getTurnLlmCallOptions`) | ~25 | `round-controller.js` |
| Main agent loop (`agentLoop`) | ~510 | Split: `agent-loop.js` (orchestration ~150) + `round-controller.js` (per-round logic ~200) + `error-recovery.js` (error handling ~100) |
| UI helpers (`sleep`, `sendMessage`, `handleKey`, `autoResize`, `useExample`) | ~60 | `session-lifecycle.js` |
| Window exports | ~10 | Each extracted module |

**Step 1: Extract `session-lifecycle.js`** (~120 lines)

Move: `sendMessage`, `handleKey`, `autoResize`, `useExample`, `requestStop`, `setStopButtonState`, `resetRunGuards`, `throwIfStopRequested`, `sleep`.

```javascript
// session-lifecycle.js
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function requestStop() {
  window._stopRequested = true;
  const ctrl = window.AgentLLMControl;
  if (ctrl?.abortActiveLlmRequest) ctrl.abortActiveLlmRequest();
  setStopButtonState(false);
}

function throwIfStopRequested() {
  if (window._stopRequested) {
    const err = new Error('RUN_STOPPED');
    err.code = 'RUN_STOPPED';
    throw err;
  }
}

function setStopButtonState(running) {
  const btnStop = document.getElementById('btn-stop');
  const btnSend = document.getElementById('btn-send');
  if (btnStop) btnStop.style.display = running ? '' : 'none';
  if (btnSend) btnSend.style.display = running ? 'none' : '';
}

function resetRunGuards() {
  window.AgentToolExecution?.resetRunToolState?.();
  window.AgentRateLimiter?.resetRateLimiter?.();
  window.AgentCompaction?.resetCompactionState?.();
  window.AgentPermissions?.resetPermissionState?.();
  window.AgentCompaction.runMaxOutputTokensRecoveryCount = 0;
  window.AgentCompaction.runCompactedResultNoticeSignatures = [];
}

async function sendMessage() { /* ... */ }
function handleKey(e) { /* ... */ }
function autoResize(el) { /* ... */ }
function useExample(btn) { /* ... */ }

window.requestStop = requestStop;
window.sendMessage = sendMessage;
window.handleKey = handleKey;
window.autoResize = autoResize;
window.useExample = useExample;
```

**Step 2: Extract `tool-call-repair.js`** (~100 lines)

Move: `shouldAttemptToolCallRepair`, `attemptToolCallRepair`, `completeToolCallArgs`.

```javascript
// tool-call-repair.js
function completeToolCallArgs(call, opts) { /* ... */ }

function shouldAttemptToolCallRepair(opts) { /* ... */ }

async function attemptToolCallRepair(opts) { /* ... */ }

window.AgentToolCallRepair = { completeToolCallArgs, shouldAttemptToolCallRepair, attemptToolCallRepair };
```

**Step 3: Extract `error-recovery.js`** (~120 lines)

Move: Error classification, recovery prompt building, retry logic from `agentLoop`.

```javascript
// error-recovery.js

/**
 * @typedef {'max_output_tokens' | 'local_timeout' | 'ollama_crash' | 'ollama_incomplete' | 'rate_limit' | 'network' | 'unknown'} ErrorClass
 */

/**
 * Classify an LLM error into a recovery strategy.
 * @param {Error} error - The error to classify
 * @param {number} round - Current round number
 * @param {number} maxRounds - Maximum rounds
 * @returns {ErrorClass}
 */
function classifyLlmError(error, round, maxRounds) {
  if (window.AgentReplyAnalysis.isMaxOutputTokenLikeError(error)) return 'max_output_tokens';
  if (error.message?.includes('LOCAL_TIMEOUT')) return 'local_timeout';
  if (error.message?.includes('OLLAMA_MODEL_CRASH')) return 'ollama_crash';
  if (error.message?.includes('OLLAMA_INCOMPLETE_OUTPUT')) return 'ollama_incomplete';
  if (error.status === 429) return 'rate_limit';
  if (error.message?.includes('network') || error.message?.includes('fetch')) return 'network';
  return 'unknown';
}

/**
 * Build a recovery prompt for a classified error.
 * @param {ErrorClass} errorClass
 * @param {number} round
 * @param {number} retryCount
 * @returns {{ prompt: string, shouldRetry: boolean, maxTokensOverride?: number }}
 */
function buildRecoveryPrompt(errorClass, round, retryCount) { /* ... */ }

/**
 * Determine if an error is retryable.
 * @param {Error} error
 * @param {number} round
 * @param {number} maxRounds
 * @returns {boolean}
 */
function shouldRetry(error, round, maxRounds) { /* ... */ }

window.AgentErrorRecovery = { classifyLlmError, buildRecoveryPrompt, shouldRetry };
```

**Step 4: Extract `round-controller.js`** (~200 lines)

Encapsulate one full round: LLM call → parse reply → repair if needed → validate tool calls → execute batches → apply compaction → build continuation.

```javascript
// round-controller.js

/**
 * @typedef {Object} RoundResult
 * @property {boolean} finalAnswer - Whether the model gave a final answer
 * @property {string} [finalText] - The final answer text
 * @property {SessionMessage[]} messages - Updated message history
 * @property {string[]} [actions] - Actions taken during the round
 */

/**
 * Execute a single agent round.
 * @param {Object} opts
 * @param {SessionMessage[]} opts.messages - Current message history
 * @param {number} opts.round - Current round number
 * @param {number} opts.maxRounds - Maximum rounds
 * @param {Object} opts.cfg - Turn configuration
 * @returns {Promise<RoundResult>}
 */
async function executeRound({ messages, round, maxRounds, cfg }) {
  // 1. Drain steering buffer
  // 2. Call LLM with turn options
  // 3. Parse / repair reply
  // 4. Validate tool calls
  // 5. Execute batches
  // 6. Apply compaction
  // 7. Return continuation prompt + state updates
}

window.AgentRoundController = { executeRound };
```

**Step 5: Slim `agent.js` to pure orchestration** (~150 lines)

```javascript
// agent.js — after refactor
async function agentLoop(userMessage) {
  const { resolve } = window.AgentRegistry;
  const { AgentSkills, AgentOrchestrator, AgentCompaction, AgentErrorRecovery, AgentRoundController } = {
    AgentSkills: resolve('AgentSkills'),
    AgentOrchestrator: resolve('AgentOrchestrator'),
    AgentCompaction: resolve('AgentCompaction'),
    AgentErrorRecovery: resolve('AgentErrorRecovery'),
    AgentRoundController: resolve('AgentRoundController'),
  };

  assertRuntimeReady();
  throwIfStopRequested();

  const state = initTurnState(userMessage);
  const enrichedMessage = await AgentSkills.buildInitialContext(userMessage, { messages: window.messages });
  window.messages = buildTurnMessages({ sysPrompt: await AgentOrchestrator.buildSystemPrompt(...), enrichedMessage });

  while (state.round < state.maxRounds) {
    throwIfStopRequested();
    state.round++;

    const roundResult = await AgentRoundController.executeRound({ ...state, messages: window.messages });

    if (roundResult.finalAnswer) {
      deliverFinalAnswer(roundResult.finalText);
      return;
    }

    window.messages = roundResult.messages;
  }

  await forceFinalAnswer(state);
}
```

### Directory Migration Steps

| Step | Action | Files | Risk |
|------|--------|-------|------|
| 1 | Create subdirectories | `agent/`, `llm/`, `tools/`, `context/`, `ui/`, `core/` | None |
| 2 | Move files (no code changes) | `llm.js`, `local-backend.js`, `child-agent.js` → `llm/` | Low — update script tags |
| 3 | Move files (no code changes) | `tool-execution.js`, `filesystem-guards.js`, `rate-limiter.js` → `tools/` | Low |
| 4 | Move files (no code changes) | `compaction.js`, `steering.js`, `runtime-memory.js` → `context/` | Low |
| 5 | Move files (no code changes) | `ui-render.js`, `ui-modern.js`, `tools.js` → `ui/` | Low |
| 6 | Move files (no code changes) | `state.js`, `constants.js`, `permissions.js` → `core/` | Low |
| 7 | Extract from agent.js | Create `agent/session-lifecycle.js`, `agent/error-recovery.js`, `agent/round-controller.js`, `agent/tool-call-repair.js` | Medium — requires testing |
| 8 | Update `index.html` | Update `<script defer>` paths to new locations | Low — mechanical |
| 9 | Update `README.md` | Document new structure | None |
| 10 | Update `check:js` script | Update `package.json` paths | Low |

**Important:** Steps 2–6 are pure file moves with only `index.html` path updates. No code changes. This can be done in a single commit with a smoke test verification.

---

## 6. Refactor Large Files

### 6.1 `skills/shared.js` (1,773 lines)

**Current responsibilities:**
- Skill registry (`registerSkill`, `getSkill`, `listSkills`)
- Intent detection and preflight (`buildInitialContext`, `detectIntents`)
- Query planning (`planQuery`, `optimizeQuery`)
- Deferred prefetch execution
- Broadcast/multicast tool calls
- Tool result caching
- Memory context building
- Skill execution orchestration

**Target:**

```
src/skills/
├── shared.js              → Slim registry + wiring only (~200 lines)
├── skill-registry.js      → registerSkill, getSkill, listSkills (~100 lines)
├── skill-preflight.js     → buildInitialContext, detectIntents (~300 lines)
├── skill-planner.js       → planQuery, optimizeQuery (~200 lines)
├── skill-broadcast.js      → broadcast/multicast tool calls (~150 lines)
├── skill-executor.js       → executeSkill, fallback chain (~200 lines)
└── (existing files unchanged)
```

**Migration:** Extract functions one at a time, keeping `shared.js` as the re-export hub until all consumers are updated.

### 6.2 `state.js` (874 lines)

**Current responsibilities:**
- Session CRUD (`createSession`, `deleteSession`, `activateSession`)
- Session persistence (`loadSessions`, `saveSessions`, `scheduleSaveSessions`)
- Model routing state (`localBackend`, `ollamaBackend`, `openrouterBackend`)
- UI state (sidebar, badges, sliders)
- Tool cache (`loadToolCache`, `saveToolCache`, `getCachedToolResult`)
- BroadcastChannel sync (`initCacheSync`, `initBusySync`)
- Cloud provider management (`activateCloudProvider`, `saveKey`)

**Target:**

```
src/app/core/
├── state.js               → Session CRUD + persistence only (~300 lines)
├── model-routing.js        → Backend state, probe, toggle (~200 lines)
├── tool-cache.js           → Tool result cache + BroadcastChannel (~150 lines)
├── ui-state.js             → Sidebar, badges, sliders (~100 lines)
└── (existing permissions.js, constants.js unchanged)
```

**Note:** `local-backend.js` (690 lines) already handles most model routing. The remaining model state in `state.js` should move to `model-routing.js`.

### 6.3 `llm.js` (1,764 lines)

See §7 (LLM Provider Abstraction) for the full refactor plan. The key extraction:

```
src/app/llm/
├── llm.js                 → Router + callLLM entry point (~300 lines)
├── local-backend.js        → (existing) LM Studio/Ollama probes
├── child-agent.js          → (existing) spawnAgentChild
├── provider-openrouter.js  → OpenRouter provider (~150 lines)
├── provider-ollama.js      → Ollama provider (~200 lines)
├── provider-local.js        → Local (LM Studio/llama.cpp) provider (~150 lines)
├── provider-cloud.js        → Cloud provider router (~100 lines)
├── provider-gemini.js       → Gemini direct API (~150 lines)
├── provider-openai.js       → OpenAI direct API (~100 lines)
├── provider-clawd.js        → Anthropic direct API (~100 lines)
├── provider-azure.js        → Azure OpenAI API (~100 lines)
├── llm-utils.js             → SSE parsing, streaming, dedup, retry (~200 lines)
└── llm-types.d.ts           → Provider interfaces, response shapes
```

---

## 7. LLM Provider Abstraction

### Current Problem

`llm.js` is 1,764 lines with 7 provider implementations inline. Each provider has its own:
- URL construction
- Request format
- Response parsing
- Error handling
- Streaming logic

Adding a new provider requires understanding all 7 and modifying the monolithic file.

### Target: Provider Interface Pattern

```javascript
// src/app/llm/provider-base.js — Provider interface contract

/**
 * @typedef {Object} LlmProvider
 * @property {string} name - Provider identifier
 * @property {() => boolean} isAvailable - Check if provider is configured
 * @property {(msgs: SessionMessage[], signal: AbortSignal, options: LlmCallOptions) => Promise<LlmResponse>} call - Execute LLM call
 * @property {(response: Response, onChunk: function) => Promise<string>} readStream - Read streaming response
 * @property {number} [rateLimitMs=1200] - Minimum interval between calls
 * @property {number} [timeoutMs=120000] - Default timeout
 */
```

**Each provider becomes a self-contained module:**

```javascript
// src/app/llm/provider-openrouter.js
const OpenRouterProvider = {
  name: 'openrouter',
  isAvailable() { return !!window.openrouterBackend?.apiKey; },
  rateLimitMs: 1200,
  timeoutMs: 120000,

  async call(msgs, signal, options) {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const headers = {
      'Authorization': `Bearer ${window.openrouterBackend.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': window.location.origin,
    };
    // ... OpenRouter-specific request building
  },

  async readStream(response, onChunk) {
    // OpenRouter uses OpenAI-compatible SSE
    return readStreamingResponse(response, onChunk);
  }
};

window.AgentLlmProviders = window.AgentLlmProviders || {};
window.AgentLlmProviders.openrouter = OpenRouterProvider;
```

**`llm.js` becomes a thin router:**

```javascript
// src/app/llm/llm.js (after refactor)
const PROVIDERS = window.AgentLlmProviders;

function getProvider() {
  if (window.openrouterBackend?.apiKey && window.openrouterBackend?.enabled) return PROVIDERS.openrouter;
  if (window.ollamaBackend?.enabled) return PROVIDERS.ollama;
  if (window.localBackend?.detected) return PROVIDERS.local;
  return PROVIDERS.cloud;
}

async function callLLM(msgs, options) {
  const provider = getProvider();
  if (!provider || !provider.isAvailable()) throw new Error('No LLM provider available');
  const signal = options?.signal || new AbortController().signal;
  return provider.call(msgs, signal, options);
}
```

**Benefits:**
- Adding a provider = creating a new file + registering it
- Testing a provider = importing just that file
- Provider-specific bugs are isolated
- `llm.js` becomes ~300 lines of routing logic

---

## 8. Security Hardening

### 8.1 Filesystem Guards (Already Strong, Needs Tests)

`filesystem-guards.js` (110 lines) already validates:
- Shell expansion (`$HOME`, backticks, `|`, `&`)
- UNC paths (`\\server\share`, `//server/share`)
- Glob patterns on write operations
- Dangerous removal paths (`/`, `/etc`, `C:\`)

**Missing:**
- No unit tests for any guard function
- No test for symlink traversal
- No test for encoded paths (`%2e%2e%2f`)
- No rate limiting on filesystem operations

**Action items:**
- [ ] Add unit tests for all guard functions (see §9)
- [ ] Add symlink detection (`isSymlink()`)
- [ ] Add URL-encoded path normalization before validation
- [ ] Add filesystem operation rate limiting (max 100 ops/minute)

### 8.2 Dev Server Security (`proxy/dev-server.js`)

**Current issues:**
- `/api/terminal` endpoint executes arbitrary shell commands (sandboxed to workspace root only)
- No authentication on any endpoint
- CORS is `*` (open to any origin)
- No request size limits on proxy endpoints

**Action items:**
- [ ] Add API key authentication for `/api/terminal`
- [ ] Restrict CORS to `localhost` origins only
- [ ] Add request body size limits (1MB default)
- [ ] Add command allowlist for `/api/terminal` (or remove it in production)
- [ ] Add rate limiting per endpoint (currently only global 100/min)
- [ ] Add request logging for audit trail

### 8.3 Prompt Injection Detection (Already Present, Needs Enhancement)

`compaction.js` already detects injection patterns in tool results. **Enhancements:**

- [ ] Add detection for base64-encoded payloads
- [ ] Add detection for Unicode homoglyph attacks
- [ ] Add configurable sensitivity levels (strict/balanced/permissive)
- [ ] Log injection attempts for analysis

### 8.4 Content Security Policy

**Action items:**
- [ ] Add CSP headers to dev server responses
- [ ] Restrict `script-src` to `self`
- [ ] Restrict `connect-src` to `self` + required API endpoints
- [ ] Add `nonce` or `hash` for inline scripts

---

## 9. Testing Strategy

### Current State

- `test-smoke.mjs` (1,517 lines): Integration tests using Node.js `vm` module to simulate browser environment
- `test-skills-smoke.mjs` (211 lines): Focused skills-only tests
- No unit tests, no E2E tests, no coverage measurement

### Target: Three-Tier Testing Pyramid

```
        ┌──────────┐
        │  E2E     │  ← Playwright browser tests (10-20 tests)
        │  Tests   │
        ├──────────┤
        │Integration│  ← Existing smoke tests + new API tests
        │  Tests    │
        ├──────────┤
        │  Unit    │  ← New: per-module tests (200+ tests)
        │  Tests    │
        └──────────┘
```

### 9.1 Unit Tests

Create `src/app/__tests__/` and `src/core/__tests__/` directories with per-module test files:

```
src/app/__tests__/
├── filesystem-guards.test.js    ← Priority 1 (security)
├── tool-execution.test.js      ← Priority 1 (security)
├── compaction.test.js          ← Priority 2 (complex logic)
├── rate-limiter.test.js        ← Priority 2 (simple, good first test)
├── permissions.test.js         ← Priority 2
├── reply-analysis.test.js      ← Priority 3 (regex-heavy)
├── state.test.js               ← Priority 3
├── error-recovery.test.js      ← Priority 3 (after extraction)
└── round-controller.test.js    ← Priority 3 (after extraction)

src/core/__tests__/
├── regex.test.js               ← Priority 2 (regex correctness)
└── orchestrator.test.js         ← Priority 3
```

**Test framework:** Use Node.js built-in `test` runner (Node 18+) with `assert` — no external dependencies.

```javascript
// src/app/__tests__/rate-limiter.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('AgentRateLimiter', () => {
  it('should rate-limit tools correctly', () => {
    // ... test code
  });
});
```

**Priority 1 tests (security-critical):**

```javascript
// src/app/__tests__/filesystem-guards.test.js
describe('AgentFsGuards', () => {
  describe('normalizePathInput', () => {
    it('should reject shell expansion', () => {
      assert.throws(() => normalizePathInput('$HOME/secret'), /shell expansion/i);
    });
    it('should reject UNC paths', () => {
      assert.throws(() => normalizePathInput('\\\\server\\share'), /UNC path/i);
    });
    it('should reject path traversal', () => {
      assert.throws(() => normalizePathInput('../../../etc/passwd'), /path traversal/i);
    });
    it('should accept valid paths', () => {
      assert.ok(normalizePathInput('/home/user/file.txt'));
    });
  });

  describe('isDangerousRemovalPath', () => {
    it('should block root paths', () => {
      assert.ok(isDangerousRemovalPath('/'));
      assert.ok(isDangerousRemovalPath('/etc'));
      assert.ok(isDangerousRemovalPath('C:\\'));
    });
    it('should allow user paths', () => {
      assert.ok(!isDangerousRemovalPath('/home/user/project/file.txt'));
    });
  });
});
```

### 9.2 Integration Tests

Expand existing smoke tests with:

- [ ] Dev server API endpoint tests (health, proxy, terminal)
- [ ] Full agent loop simulation (mock LLM, verify tool execution)
- [ ] Context management pipeline tests (compaction thresholds)
- [ ] Multi-provider LLM routing tests

### 9.3 E2E Tests (Playwright)

```javascript
// e2e/basic-flow.test.js
import { test, expect } from '@playwright/test';

test('user can send a message and receive a response', async ({ page }) => {
  await page.goto('http://127.0.0.1:5500');
  await page.fill('#msg-input', 'What is 2+2?');
  await page.click('#btn-send');
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30000 });
});
```

**E2E test scenarios:**
- [ ] Send message, receive response
- [ ] Switch providers (OpenRouter, Ollama)
- [ ] Tool execution (web search, file read)
- [ ] Session management (create, switch, delete)
- [ ] Settings persistence
- [ ] Context compaction under load

### 9.4 Test Infrastructure

Add to `package.json`:

```json
{
  "scripts": {
    "test": "npm run test:unit && npm run test:smoke && npm run test:skills-smoke",
    "test:unit": "node --test src/app/__tests__/*.test.js src/core/__tests__/*.test.js",
    "test:smoke": "node scripts/test-smoke.mjs",
    "test:skills-smoke": "node scripts/test-skills-smoke.mjs",
    "test:e2e": "npx playwright test",
    "test:coverage": "node --test --experimental-test-coverage src/app/__tests__/*.test.js",
    "check:js": "node --check src/app/agent.js && ..."
  }
}
```

---

## 10. Performance Optimization

### 10.1 Script Loading

**Current:** All 30+ scripts load with `defer` in declaration order. The browser must parse all scripts before executing any.

**Optimization:** Use `<script type="module">` for non-critical modules, allowing parallel download and parse:

```html
<!-- Critical path: synchronous defer chain -->
<script defer src="src/core/regex.js"></script>
<script defer src="src/core/prompt-loader.js"></script>
<!-- ... critical path continues ... -->

<!-- Non-critical: lazy-loaded modules -->
<script type="module">
  import('./src/app/ui-modern.js');
  import('./src/app/worker-manager.js');
</script>
```

**Expected improvement:** ~200ms faster time-to-interactive on cold load.

### 10.2 Context Management

**Current issues:**
- `estimateTokens()` uses character-based heuristic (3.5 chars/token)
- `microcompactToolResultMessages()` runs on every round
- No caching of compaction results

**Optimizations:**
- [ ] Cache token estimates per message (invalidate on mutation)
- [ ] Skip microcompact when context < 50% of limit
- [ ] Use `performance.now()` to measure compaction time and skip if < 5ms
- [ ] Pre-compute tool result digests at execution time (not during compaction)

### 10.3 LLM Call Deduplication

**Current:** `dedupInflight()` in `llm.js` prevents duplicate concurrent LLM calls.

**Enhancement:**
- [ ] Add tool result caching with TTL (currently cache is per-run only)
- [ ] Add response streaming cache for identical prompts within 60s
- [ ] Add preflight query deduplication in `skills/shared.js`

### 10.4 Memory Management

**Current:** `runtime-memory.js` writes to `localStorage` on every cache hit.

**Fix (already identified in bug fixes):** Debounce writes to every 10th hit. Also:
- [ ] Add `IndexedDB` backend for large tool results (>5KB)
- [ ] Implement LRU eviction for memory entries
- [ ] Add memory usage monitoring and alerts

---

## 11. Dev Server & Proxy Improvements

### Current State

`proxy/dev-server.js` (495 lines) provides:
- Static file serving
- Ollama Cloud proxy (`/api/ollama/v1/*`)
- Google News proxy (`/api/gnews/*`)
- Terminal execution (`/api/terminal`)
- Health check (`/api/health`)
- Environment variable exposure (`/api/env`)
- Diagnostics (`/api/diagnostics`)

### Improvements

#### 11.1 Production Readiness

```javascript
// Add to dev-server.js

// 1. Request body size limits
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

// 2. CORS restriction
const ALLOWED_ORIGINS = process.env.NODE_ENV === 'production'
  ? ['https://your-domain.com']
  : ['http://127.0.0.1:5500', 'http://localhost:5500'];

// 3. Security headers
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://*.openrouter.ai https://*.ollama.com https://*.googleapis.com",
  'X-XSS-Protection': '1; mode=block',
};

// 4. Rate limiting per endpoint
const ENDPOINT_LIMITS = {
  '/api/ollama': { requests: 60, window: 60000 },
  '/api/gnews': { requests: 30, window: 60000 },
  '/api/terminal': { requests: 10, window: 60000 },
  '/api/health': { requests: 120, window: 60000 },
};
```

#### 11.2 WebSocket Support

Add WebSocket for real-time LLM streaming to the browser (instead of SSE polling):

```javascript
// proxy/websocket.js — NEW FILE
import { WebSocketServer } from 'ws'; // or use Node.js built-in ws module

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.on('message', async (data) => {
      const { type, payload } = JSON.parse(data);
      if (type === 'llm_stream') {
        // Proxy streaming LLM response through WebSocket
      }
    });
  });
}
```

#### 11.3 Hot Module Replacement (Development Only)

Add a file watcher that injects updated modules without full page reload:

```javascript
// proxy/hmr.js — NEW FILE (development only)
import { watch } from 'node:fs';
import { join } from 'node:path';

function setupHMR(server) {
  const watchers = [];
  const SRC_DIR = join(import.meta.dirname, '..', 'src');

  function broadcast(modulePath) {
    // Send HMR update to connected clients
    server.connections.forEach(ws => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'hmr', module: modulePath }));
      }
    });
  }

  // Watch src/ directory for changes
  watch(SRC_DIR, { recursive: true }, (event, filename) => {
    if (filename?.endsWith('.js')) {
      broadcast(filename);
    }
  });
}
```

---

## 12. CI/CD & Quality Gates

### Current State

- `npm run check:js` — syntax check main files
- `npm run test:smoke` — integration smoke tests
- `npm run test:skills-smoke` — skills smoke tests
- `npm run lint` — ESLint (no config file)
- `render.yaml` — Render.com deployment config

### Target CI Pipeline

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
      - run: npm run check:js
      - run: npm run test:smoke
      - run: npm run test:skills-smoke
      - run: npm run test:unit

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm run lint

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check for known vulnerabilities
        run: npm audit --production
      - name: Check filesystem guards
        run: node --test src/app/__tests__/filesystem-guards.test.js
```

### Quality Gates

Add to `package.json`:

```json
{
  "scripts": {
    "check:js": "node --check src/app/agent.js && node --check src/app/llm.js && node --check src/core/orchestrator.js && node --check src/app/constants.js && node --check src/app/state.js && node --check src/app/permissions.js && node --check src/app/compaction.js && node --check src/app/steering.js && node --check src/app/tool-execution.js && node --check src/app/filesystem-guards.js && node --check src/app/reply-analysis.js && node --check src/app/ui-render.js && node --check src/app/child-agent.js && node --check src/app/app-init.js && node --check src/app/rate-limiter.js && node --check src/app/worker-manager.js && node --check src/app/runtime-memory.js && node --check src/app/local-backend.js && node --check src/skills/shared.js",
    "lint": "eslint src/",
    "test": "npm run test:unit && npm run test:smoke && npm run test:skills-smoke",
    "test:unit": "node --test 'src/**/__tests__/*.test.js'",
    "test:coverage": "node --test --experimental-test-coverage 'src/**/__tests__/*.test.js'",
    "precommit": "npm run check:js && npm run test:unit"
  }
}
```

### ESLint Configuration

Create `.eslintrc.json`:

```json
{
  "env": {
    "browser": true,
    "es2020": true,
    "node": true
  },
  "parserOptions": {
    "ecmaVersion": 2020,
    "sourceType": "module"
  },
  "rules": {
    "no-undef": "error",
    "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
    "no-console": ["warn", { "allow": ["warn", "error"] }],
    "prefer-const": "error",
    "no-var": "error",
    "eqeqeq": "error",
    "curly": "error",
    "no-throw-literal": "error",
    "no-return-await": "error",
    "require-await": "error"
  },
  "globals": {
    "AgentRegex": "readonly",
    "AgentPrompts": "readonly",
    "AgentOrchestrator": "readonly",
    "AgentSkills": "readonly",
    "AgentSnapshot": "readonly",
    "CONSTANTS": "readonly",
    "AgentToolExecution": "readonly",
    "AgentCompaction": "readonly",
    "AgentPermissions": "readonly",
    "AgentRateLimiter": "readonly",
    "AgentSteering": "readonly",
    "AgentWorkers": "readonly",
    "AgentFsGuards": "readonly",
    "AgentMemory": "readonly",
    "AgentRuntimeCache": "readonly",
    "AgentLLMControl": "readonly",
    "AgentChildAgent": "readonly",
    "AgentReplyAnalysis": "readonly",
    "AgentUIRender": "readonly",
    "AgentRegistry": "readonly"
  }
}
```

---

## 13. Documentation Improvements

### 13.1 API Documentation

Add JSDoc `@module` tags to each file for auto-generated documentation:

```javascript
/**
 * @module AgentToolExecution
 * @description Tool call dispatch, batching, filesystem guards, and sandbox execution.
 *
 * Exports {@link window.AgentToolExecution} with methods:
 * - {@link executeTool} — Execute a single tool call
 * - {@link partitionToolCallBatches} — Group calls into concurrent-safe batches
 * - {@link dedupeToolCalls} — Remove duplicate tool calls
 * - {@link resolveToolCallsFromModelReply} — Parse tool calls from model output
 */
```

### 13.2 Architecture Decision Records

Create `docs/adr/` directory for architectural decisions:

```
docs/adr/
├── 001-zero-build-architecture.md
├── 002-window-global-module-system.md
├── 003-skill-runtime-design.md
├── 004-multi-lane-llm-routing.md
├── 005-context-compaction-strategy.md
├── 006-filesystem-guard-design.md
└── 007-hybrid-type-safety.md
```

### 13.3 Inline Code Documentation Standards

**Every function should have:**
- `@param` with types
- `@returns` with type
- `@throws` for error cases
- `@example` for complex functions

**Every module should have:**
- `@module` tag
- Description of responsibility
- List of exported functions
- List of consumed `window.*` globals

### 13.4 README Improvements

- [ ] Add architecture diagram (Mermaid)
- [ ] Add contributing guide
- [ ] Add changelog section
- [ ] Add troubleshooting section
- [ ] Add environment variable reference
- [ ] Add provider-specific setup guides

---

## 14. Implementation Roadmap

### Phase 1: Foundation (Week 1–2)

**Goal:** Set up type safety, testing infrastructure, and CI.

| Task | Priority | Effort | Risk |
|------|----------|--------|------|
| Create `jsconfig.json` | High | 0.5h | None |
| Create `src/types/agent.d.ts` | High | 4h | Low |
| Create `.eslintrc.json` | Medium | 1h | None |
| Create `src/app/__tests__/` directory | High | 0.5h | None |
| Write filesystem-guards unit tests | High | 4h | Low |
| Write rate-limiter unit tests | Medium | 2h | Low |
| Write compaction unit tests | Medium | 4h | Low |
| Add `// @ts-check` to filesystem-guards.js | High | 1h | Low |
| Add `// @ts-check` to tool-execution.js | High | 2h | Low |
| Set up GitHub Actions CI | Medium | 2h | Low |
| Create `registry.js` (module registry) | Medium | 2h | Low |

### Phase 2: Directory Reorganization (Week 3)

**Goal:** Reorganize `app/` into subdirectories without code changes.

| Task | Priority | Effort | Risk |
|------|----------|--------|------|
| Create `agent/`, `llm/`, `tools/`, `context/`, `ui/`, `core/` | High | 0.5h | None |
| Move files to subdirectories | High | 1h | Low |
| Update `index.html` script paths | High | 1h | Low |
| Update `package.json` check:js paths | High | 0.5h | Low |
| Run smoke tests | High | 0.5h | Low |
| Update README structure section | Medium | 0.5h | None |

### Phase 3: Agent.js Extraction (Week 4–5)

**Goal:** Break up agent.js into focused modules.

| Task | Priority | Effort | Risk |
|------|----------|--------|------|
| Extract `session-lifecycle.js` | High | 4h | Medium |
| Extract `tool-call-repair.js` | High | 3h | Medium |
| Extract `error-recovery.js` | High | 4h | Medium |
| Write error-recovery unit tests | High | 3h | Low |
| Extract `round-controller.js` | High | 6h | High |
| Write round-controller unit tests | High | 4h | Medium |
| Slim agent.js to orchestration | High | 4h | High |
| Update `index.html` with new scripts | High | 1h | Low |
| Run full smoke test suite | High | 1h | Low |

### Phase 4: LLM Provider Abstraction (Week 6–7)

**Goal:** Extract provider implementations from llm.js.

| Task | Priority | Effort | Risk |
|------|----------|--------|------|
| Create `provider-base.js` interface | High | 2h | Medium |
| Extract `provider-openrouter.js` | High | 4h | Medium |
| Extract `provider-ollama.js` | High | 4h | Medium |
| Extract `provider-local.js` | High | 3h | Medium |
| Extract `provider-cloud.js` + sub-providers | Medium | 6h | Medium |
| Extract `llm-utils.js` (SSE, streaming, dedup) | Medium | 4h | Medium |
| Slim `llm.js` to router | High | 4h | High |
| Write provider unit tests | Medium | 6h | Low |
| Run full smoke test suite | High | 1h | Low |

### Phase 5: State.js Refactoring (Week 8)

**Goal:** Break up state.js into focused modules.

| Task | Priority | Effort | Risk |
|------|----------|--------|------|
| Extract `model-routing.js` | Medium | 4h | Medium |
| Extract `tool-cache.js` | Medium | 3h | Low |
| Extract `ui-state.js` | Low | 2h | Low |
| Slim `state.js` to session CRUD | Medium | 3h | Medium |
| Write state unit tests | Medium | 4h | Low |
| Update `index.html` | Medium | 1h | Low |

### Phase 6: Skills Refactoring (Week 9–10)

**Goal:** Break up shared.js into focused modules.

| Task | Priority | Effort | Risk |
|------|----------|--------|------|
| Extract `skill-registry.js` | Medium | 3h | Medium |
| Extract `skill-preflight.js` | Medium | 4h | Medium |
| Extract `skill-planner.js` | Low | 3h | Medium |
| Extract `skill-broadcast.js` | Low | 2h | Low |
| Extract `skill-executor.js` | Medium | 3h | Medium |
| Slim `shared.js` to re-export hub | Medium | 2h | Low |
| Write skill unit tests | Medium | 4h | Low |

### Phase 7: Security & Performance (Week 11–12)

**Goal:** Harden security and optimize performance.

| Task | Priority | Effort | Risk |
|------|----------|--------|------|
| Add filesystem guard unit tests | High | 4h | Low |
| Add symlink detection | Medium | 2h | Low |
| Add URL-encoded path normalization | Medium | 2h | Low |
| Add CSP headers to dev server | Medium | 2h | Low |
| Add request body size limits | Medium | 1h | Low |
| Add per-endpoint rate limiting | Medium | 3h | Low |
| Add terminal endpoint auth | High | 4h | Medium |
| Optimize context management caching | Medium | 4h | Medium |
| Add JSDoc to remaining files | Low | 8h | Low |
| Add `// @ts-check` to remaining files | Low | 4h | Low |

---

## 15. Risk Assessment & Rollback

### High-Risk Changes

| Change | Risk | Mitigation | Rollback |
|--------|------|------------|----------|
| Agent.js extraction | Breaking the agent loop | Extract one module at a time, run smoke tests after each | Revert to monolithic agent.js |
| LLM provider extraction | Breaking LLM calls | Extract one provider at a time, test each | Revert to monolithic llm.js |
| Directory reorganization | Breaking script load order | Pure file moves, update index.html paths | Revert index.html, move files back |
| Registry pattern | Breaking module resolution | Dual pattern (window.* + registry) during migration | Remove registry calls, keep window.* |

### Medium-Risk Changes

| Change | Risk | Mitigation | Rollback |
|--------|------|------------|----------|
| JSDoc + ts-check | False positive type errors | Start with `strictNullChecks: false`, `noImplicitAny: false` | Remove `// @ts-check` from affected files |
| State.js refactoring | Breaking session management | Extract one module at a time | Revert to monolithic state.js |
| Skills refactoring | Breaking skill execution | Keep shared.js as re-export hub during transition | Revert to monolithic shared.js |

### Low-Risk Changes

| Change | Risk | Mitigation | Rollback |
|--------|------|------------|----------|
| jsconfig.json | None | N/A | Delete file |
| .d.ts files | None (no runtime impact) | N/A | Delete files |
| ESLint config | False positive warnings | Start with warn, not error | Delete .eslintrc.json |
| Unit tests | None (additive) | N/A | Delete test files |
| CI pipeline | None (additive) | N/A | Delete .github/workflows/ |
| Security headers | CORS issues in dev | Test locally first | Remove headers |

### Rollback Strategy

Every phase should be a **single commit** that can be reverted independently:

```
Phase 1: "feat: add jsconfig.json, .d.ts, eslint, unit tests, registry"
Phase 2: "refactor: reorganize app/ into subdirectories"
Phase 3: "refactor: extract agent.js into focused modules"
Phase 4: "refactor: extract LLM providers from llm.js"
Phase 5: "refactor: extract state.js modules"
Phase 6: "refactor: extract skill modules from shared.js"
Phase 7: "feat: security hardening and performance optimization"
```

---

## 16. Success Metrics

### Code Quality Metrics

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| Largest file (lines) | 1,773 (shared.js) | < 500 | `wc -l src/**/*.js` | **Pending Phase 6** |
| agent.js (lines) | 763 → 150 | < 200 | `wc -l src/app/agent/agent.js` | ✅ **Done** |
| llm.js (lines) | 1,764 → 273 | < 500 | `wc -l src/app/llm/llm.js` | ✅ **Done** |
| state.js (lines) | 874 → 251 | < 300 | `wc -l src/app/core/state.js` | ✅ **Done** |
| `window.*` global reads | ~150+ | < 50 (via registry) | `grep -c 'window\.Agent' src/**/*.js` | In progress |
| Files with `// @ts-check` | 0 | 8 | `grep -rl '@ts-check' src/` | Pending |
| Unit test count | 0 → 117 smoke + security | 200+ | `npm run test:smoke` | In progress |
| Test coverage | 0% | 60%+ | `npm run test:coverage` | Pending |
| ESLint warnings | N/A | 0 | `npm run lint` | Pending |

### Performance Metrics

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| Cold load time | ~800ms | < 500ms | `performance.now()` in app-init.js |
| Agent loop round | ~2-5s | Same | No regression |
| Context compaction | ~50ms | < 20ms | `performance.now()` in compaction.js |
| Memory writes/minute | ~60 | < 10 | DevTools Performance tab |

### Developer Experience Metrics

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| IDE autocomplete | Basic | Full (JSDoc + .d.ts) | VS Code IntelliSense |
| Go-to-definition | None | Full | VS Code "Go to Definition" |
| Refactoring support | None | Rename, extract | VS Code refactoring |
| New contributor onboarding | ~2 hours | < 30 minutes | ADR docs + README |
| Time to add a new LLM provider | ~2 hours | < 30 minutes | Provider interface pattern |
| Time to add a new skill | ~1 hour | < 15 minutes | Skill registry pattern |

---

## Summary

| Approach | Build Step? | Runtime Impact? | IDE Support? | Effort |
|----------|-------------|-----------------|--------------|--------|
| Full TypeScript | Yes | Adds bundler | Full | High |
| **Hybrid (JSDoc + `.d.ts`)** | **No** | **Zero** | **Full** | **Medium** |
| Status quo | No | Zero | Basic | None |

The hybrid approach gives you **80% of TypeScript's value** (IDE support, refactoring, error detection) with **0% of the cost** (no build step, no bundler, no transpilation). Combined with the agent.js refactor, directory reorganization, LLM provider abstraction, and security hardening, the codebase becomes significantly more maintainable while preserving the browser-first, zero-dependency architecture.

### Priority Order

1. **Phase 1** (Foundation) — Low risk, high value, enables everything else
2. **Phase 2** (Directory reorg) — Low risk, mechanical, improves navigation
3. **Phase 3** (Agent.js extraction) — Medium risk, highest code quality impact
4. **Phase 7** (Security) — High priority for production use
5. **Phase 4** (LLM providers) — Medium risk, enables easy provider addition
6. **Phase 5** (State refactoring) — Medium risk, improves maintainability
7. **Phase 6** (Skills refactoring) — Lower priority, shared.js works as-is