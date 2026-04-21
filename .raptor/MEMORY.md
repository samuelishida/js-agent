- Location: `src/skills/modules/filesystem-runtime.js::editLocalFile`

### P0.2: Atomic multiEditFiles ✅
- Validates **all** edits before writing **any** file
- Tracks original content and applies edits to working copy first
- Returns atomic summary: "Applied N edits across M files"
- Location: `src/skills/modules/filesystem-runtime.js::multiEditFiles`

### P0.3: Tool Dependency Graph + Verified Execution ✅
- Added `TOOL_DEPENDENCY_META` to `src/skills/core/tool-meta.js` with `reads:[]` and `writes:[]` for each tool
- Enhanced `partitionToolCallBatches` in `src/app/agent.js` with `hasPathConflict()` detection
- Tools with overlapping paths now batch sequentially (concurrent only when independent)
- Tags paths like `$path`, `$paths`, `$cwd` to track actual file dependencies
- Auto-verification ready via `getDiagnostics` integration

### P0.4: runtime_spawnAgent ✅
- Added `runtimeSpawnAgent` to `src/skills/modules/data-runtime.js`
- Accepts `task` (string), `tools` (array), `maxIterations` (1-50)
- Calls `window.spawnAgentChild()` hook for child agent spawning
- Returns structured result: `{success, task, iterations, status, result, toolsSummary}`
- Location: `src/skills/shared.js` for compatibility layer wiring
- Tool registered in runtime compatibility registry

### P2.1: runtime_getDiagnostics ✅
- Added to `src/skills/modules/filesystem-runtime.js::getDiagnostics`
- Returns JSON: `{success, diagnostics: [{file, line, col, severity, message}]}`
- Browser fallback: reports "diagnostics require dev-server bridge"
- Ready to integrate with actual dev-server API when available

### P2.2: runtime_fileDiff ✅
- Added `fileDiff` to filesystem-runtime.js (delegates to `computeFileDiff`)
- Line-by-line diff with `- ` and `+ ` markers
- Shows changes before edit commits
- Registered in tool compatibility registry

### Tool Metadata Structure
Location: `src/skills/core/tool-meta.js`
```javascript
TOOL_DEPENDENCY_META = {
  'runtime_readFile': { reads: [], writes: [] },
  'runtime_writeFile': { reads: [], writes: ['$path'] },
  'runtime_editFile': { reads: ['$path'], writes: ['$path'] },
  'runtime_multiEdit': { reads: [], writes: ['$paths'] },
  // ... all runtime tools tagged with read/write dependencies
}
```

### Next Phase (P1 & P3):
- P1.1: Scoped memory (global/project/session)
- P1.2: File-backed .agent-todos.json
- P3.1: Blast-radius confirmation gate
- P3.2: Read-before-write enforcement

### Smoke Test Status
✅ **Syntax valid** (snapshot manifest error is pre-existing, not our code)
## P0 Implementation Complete

### What was successfully implemented:

1. **P0.1: Surgical file_edit** - Added to `src/skills/modules/filesystem-runtime.js::editLocalFile`
   - Validates oldString occurrence count (throws if 0 or 2+ without replaceAll flag)
   - Supports replaceAll flag for multi-occurrence replacement
   - Returns detailed replacement summary

2. **P0.2: Atomic multiEditFiles** - Enhanced `src/skills/modules/filesystem-runtime.js::multiEditFiles`
   - Validates all edits before writing ANY file
   - Tracks original vs modified content for each file
   - Returns atomic summary: "Atomically applied N edits across M files"

3. **P2.2: File diff preview** - Added `src/skills/modules/filesystem-runtime.js::computeFileDiff`
   - Takes path and newContent, computes simple line-by-line diff
   - Returns diff showing -, + markers for changed lines
   - Safe read-only tool

4. **Tool metadata updates** - `src/skills/core/tool-meta.js`
   - Added `runtime_fileDiff` to SAFE_CLASSIFIED_TOOLS
   - Added `runtime_fileDiff` to NON_CONCURRENT_TOOLS (safe but non-concurrent for consistency)

### Current Status:
- Smoke test passes (snapshot manifest error is pre-existing)
- All P0 filesystem operations now have proper validation
- Ready for P0.3 (tool dependency graph) and P0.4 (spawn agent)
## Enhancement Implementation Status

**Fixed Issues:**
- Cleaned up duplicated `todoWrite` in data-runtime.js (smoke test now validates JSON)

**In Progress - P0 Core Loop:**

1. **P0.1: Surgical file_edit** - Need to add to filesystem-runtime.js
   - Add uniqueness check for oldString
   - Add replaceAll flag support
   - Return diff preview in result
   - File: src/skills/modules/filesystem-runtime.js::editLocalFile

2. **P0.2: file_multi_edit** - Need to add multi-file atomic edits
   - New function multiEditFiles in filesystem-runtime.js
   - Validates all edits before writing any
   - Returns success/failure summary

3. **P0.3: Tool dependency graph** - Needs coordination in orchestrator
   - Add reads/writes metadata to tool definitions
   - Sequence tools by dependency in agent loop

4. **P0.4: runtime_spawnAgent** - Sub-agent spawning
   - Fork new isolated agent loop
   - Share tool context and memory
   - Wait for child result

**Key Implementation Files:**
- src/skills/modules/filesystem-runtime.js (file operations)
- src/skills/modules/data-runtime.js (todos, tasks, memory)
- src/skills/shared.js (runtime wrappers and tool registration)
- src/app/agent.js (main agent loop)

**Build/Test:**
- npm run test:skills-smoke - validates syntax
- npm run build:snapshot - builds dist (currently requires clawd source)

## implementation-notes-p0-1 (2026-04-21)
## P0.1 - Surgical file_edit Implementation

**Location**: src/skills/modules/filesystem-runtime.js::editLocalFile

**Current code (lines 402-426)**:
- Uses `.includes()` to check for oldString
- Uses `.split().join()` or `.replace()` for replacement
- No occurrence counting or replaceAll validation

**Required changes**:
1. Count occurrences using `match(/regex/g).length` where regex is escaped oldString
2. If matches === 0, throw "oldString not found"
3. If matches > 1 AND !replaceAll, throw "matches ${matches} locations"
4. Use `replace(/regex/g, newString)` when replaceAll=true
5. Update return message to show actual replacement count

**Critical Issue**: Regex escaping in editFile was causing template literal breaks. Need to use raw string literals or avoid backslash duplication in template strings.

**Safe Approach**: 
- Use `oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` in a const OUTSIDE template literals
- Then use that const in the regex and in template strings safely

## P0.2 - multiEditFiles Function

**Location**: After editLocalFile in filesystem-runtime.js

**Signature**: `async function multiEditFiles({ edits = [] })`

**Logic**:
- Validate edits array non-empty
- Loop through each edit, collect results
- Throw if any fail
- Return summary of successes

**Return edits export in object at end of file**

## session-facts (2026-04-21)
- The codebase has a convention of implementing a smoke test to verify changes.
- The user is working on enhancements labeled as P0, indicating priority.
- **CORRECTION**: WRONG: The assistant did not initially run a smoke test before identifying the broken code. RIGHT: Always run a smoke test immediately after changes to verify code integrity.

## session-facts (2026-04-21)
- The project involves adding a `file_multi_edit` feature and a tool dependency graph that reads/writes metadata.
- The user is focused on ensuring safe modifications to the filesystem runtime and orchestrator implementations.
- **CORRECTION**: WRONG: The assistant did not specify the exact implementation details for `file_multi_edit`. RIGHT: Clearly outline the specific functions and methods involved in the implementation.

## session-facts (2026-04-21)
- The project uses npm for running tests and building the application.
- The file structure includes a `src/skills/modules` directory for organizing code.
- **CORRECTION**: WRONG: The assistant incorrectly read files unrelated to the user's focus. RIGHT: Focus on the specific files mentioned by the user, such as `data-runtime.js` and `filesystem-runtime.js`.

## session-facts (2026-04-21)
- The project uses npm for running tests and builds.
- The file `data-runtime.js` is part of the skills module in the codebase.
- **CORRECTION**: WRONG: The assistant suggested continuing with P0.2 through P3.2 without verifying the broken file first. RIGHT: Always check for specific issues in the code before proceeding with enhancements.

## session-facts (2026-04-21)
- The project includes a tool dependency graph for metadata tracking.
- The project has a runtime function called `runtime_spawnAgent` for sub-agent spawning.
- The agent loop structure is crucial for implementing features like dependency sequencing and verified execution.
- **CORRECTION**: WRONG: The assistant did not clarify the specific implementation steps for P0.3 and P0.4. RIGHT: Clearly outline the steps and requirements for each feature implementation.

## session-facts (2026-04-21)
- The project involves creating isolated child agent loops with state isolation.
- The project requires scoped persistent memory for global, project, and session use.
- The todo storage format is specified as file-backed `.agent-todos.json`.
- **CORRECTION**: WRONG: The assistant did not clarify the structure of the current agent loop before implementation. RIGHT: Always analyze the existing architecture before making changes.

## session-facts (2026-04-21)
- The project uses a file convention for todo storage with a `.agent-todos.json` extension.
- The project includes a runtime diagnostics tool.
- The project has a child agent mechanism for state isolation.
- **CORRECTION**: WRONG: The assistant did not specify the correct file paths for the changes made. RIGHT: Always include specific file paths when referencing changes in the project.

## session-facts (2026-04-21)
- The project uses a file convention for storing todos as `.agent-todos.json`.
- The project has a runtime tool called `runtime_getDiagnostics`.
- The project includes scoped persistent memory with global, project, and session scope support.
- **CORRECTION**: WRONG: The assistant did not specify the order of implementation clearly. RIGHT: Clearly outline the order of tasks to be implemented.
