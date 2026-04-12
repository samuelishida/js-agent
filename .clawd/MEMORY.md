## session-facts (2026-04-06)
- The local and cloud LLM code paths are located in `src/app`.
- The user is interested in identifying potential flaws in the local vs cloud LLM routing.
- **CORRECTION**: NEVER read code outside especified folder for this project `D:\Code\Agent`.
- **CORRECTION**: WRONG: The assistant did not specify the exact files being reviewed. RIGHT: Clearly mention the specific files or 
components being analyzed in the project.

## session-facts (2026-04-06)
- The project is located in `D:\Code\Agent`.
- The source code for the JS agent is in `D:\Code\Agent\src\app`.
- **CORRECTION**: NEVER read code outside especified folder for this project `D:\Code\Agent`.
- **CORRECTION**: WRONG: The assistant mentioned reviewing the local/cloud routing code without specifying the correct folder. RIGHT: Focus on the `D:\Code\Agent\src\app` directory for the JS agent files.

## session-facts (2026-04-06)
- The project has a directory structure with specific folders for `src` and `proxy`.
- The local backend implementation is found in `src/app/local-backend.js`.
- The cloud vs local backend logic is searched using specific keywords in the codebase.
- **CORRECTION**: WRONG: The assistant did not specify the exact files being read. RIGHT: Always mention the specific files being analyzed for clarity.

## session-facts (2026-04-06)
- The local backend defaults to ENABLED if the key doesn't exist, causing potential hang-ups if the local server crashes.
- The function `getLaneForRequest()` in `llm.js` does not handle errors properly when the local URL is invalid.
- **CORRECTION**: WRONG: The assistant did not specify the exact lines of code where issues were found. RIGHT: Always reference specific lines and files when discussing code issues.

## session-facts (2026-04-06)
- The local backend defaults to ENABLED if the key doesn't exist, causing potential issues if the local server crashes.
- The function `getLaneForRequest()` in `llm.js` does not handle errors properly when the local URL is invalid.
- There is a message normalization bug in `llm.js` that needs to be addressed.
- **CORRECTION**: WRONG: The assistant suggested reading the file content first. RIGHT: The assistant should directly address the identified issues based on the review provided.

Summary
Features ported from extension.ts → agent.js
1. Steering buffer system — Full mid-session guidance injection. pushSteering(msg) / drainSteering() now exist, exposed via window.AgentSteering. Each agent loop iteration drains the buffer and injects steered messages as [USER STEERING] turns before the LLM call.
2. Tool call steering / input rewriting — steerToolCall(tool, args) runs before every tool execution and:

Blocks catastrophic shell commands (rm -rf /, fdisk, etc.)
Strips control-channel XML tags from file path arguments (prevents crafted filenames from injecting <tool_call> blocks into tool args)

3. Post-turn memory hook — window.AgentMemory.onTurnComplete() is called after every final answer (both normal and forced), fire-and-forget, allowing pluggable session-level memory extraction matching the extractAndStoreMemories pattern from the extension.

Bugs fixed / refactored
4. Prompt injection detection — expanded — Added 2 new detection rules:

[SYSTEM/ASSISTANT/USER OVERRIDE] and NEW SYSTEM PROMPT markers
Encoded injection patterns (base64/hex decode → instruct)
Fixed the existing control-tag pattern: was <tool_call> (would match the agent's own legitimate output in some edge cases), now <tool_call\s*> (tighter)

5. sanitizeToolResult() — new function — All tool results are now sanitized before they enter the message history. Control-channel XML is removed/replaced with [blocked] placeholders. This is the most important prompt injection fix — previously, a malicious web page or file could inject <tool_call> blocks that would be interpreted as agent instructions in subsequent rounds.
6. Tool result sanitization applied — The messages.push(tool_result) call now runs sanitizeToolResult(contextSafeResult) rather than passing the raw compacted result directly.

Remaining flaws identified (not yet patched due to tool limit)

stableStringify used in tool signatures — no depth limit; a deeply nested object in tool args could cause stack overflow. Should add max-depth guard.
sessionStorage for tool replacement persistence — loadPersistedToolResultReplacements trusts stored JSON without schema validation beyond basic shape check. Could be hardened.
Function('"use strict"; return (' + expr + ')')() in calc tool — the regex guard is reasonable but could be tightened (e.g. Object, Array, Math are allowed but they're safe; however toString, constructor chains could theoretically bypass). Should add a stricter allowlist-based evaluator.
orchestrator.buildRuntimeContinuationPrompt not shown — if the orchestrator builds this from tool results, those results should also pass through sanitizeToolResult before being included.
ok give me the code then with the todo list3:10 PMLet me read the current state of the patched files before outputting them:Ran 5 commands, edited 3 files, read a fileRan 5 commands, edited 3 files, read a fileHere's everything that landed in the file, organized as a todo list you can track against:

✅ Done — ported from extension.ts
Steering buffer (steeringBuffer, pushSteering, drainSteering) — mid-flight guidance injection. Exposed on window.AgentSteering = { push, drain } so UI code or external scripts can call it. The loop drains it at the top of every iteration and injects a [USER STEERING] user turn before the LLM call.
Tool call input steering (steerToolCall) — runs before every executeTool. Blocks catastrophic shell commands (rm -rf /, fdisk, diskpart) and strips control-channel XML from file path arguments so crafted filenames can't inject <tool_call> tags into the tool args themselves.
Post-turn memory hook — after every final answer (normal + max-rounds), calls window.AgentMemory?.onTurnComplete?.({userMessage, assistantMessage, messages}) fire-and-forget. Plug your memory extractor there.

✅ Done — bugs fixed
sanitizeToolResult() — new function, applied to every tool result before it enters messages. Strips <tool_call>, <system-reminder>, <permission_denials>, [SYSTEM OVERRIDE], and NEW SYSTEM PROMPT markers. This is the main prompt injection fix — previously a malicious file or webpage could inject agent control tags that would be re-interpreted in later rounds.
Prompt injection detector — 2 new rules — detects [SYSTEM/ASSISTANT/USER OVERRIDE] markers and encoded injection patterns (base64/hex decode → instruct). Tightened the existing control-tag regex to <tool_call\s*> so it doesn't false-positive on unrelated XML.
stableStringify depth guard — added _depth counter, bails with "[deep]" at depth 12. Prevents stack overflow if a model hallucinates deeply nested args.
calc tool hardened — replaced the bare Function('"use strict"; return (' + expr + ')')() call with new Function('Math', ...) that scopes only Math into scope. Added ^ → ** rewriting. Tightened the blocklist to include Object, Array, Promise, fetch, XMLHttp, :, !, @, #, ~, backtick.
loadPersistedToolResultReplacements hardened — rejects non-array values, coerces all fields to string, and drops any persisted replacement that itself contains injection payloads (so a poisoned sessionStorage entry can't restore a malicious compacted result).

🔲 Remaining / out of scope for this pass

orchestrator.buildRuntimeContinuationPrompt — if it interpolates raw tool result text, that text should also pass through sanitizeToolResult. Needs to be verified in src/core/orchestrator.js.
summarizeContext prompt — the hist string fed to the summarizer includes raw tool result content. Consider running sanitizeToolResult on each message content before joining into hist.
Steering UI button — the buffer is wired but there's no input widget in index.html yet. Add a small input next to Stop, or expose it via a slash command in the chat input.
AgentMemory.onTurnComplete implementation — the hook fires but the actual extraction logic (equivalent to extractAndStoreMemories from extension.ts) still needs to be written and attached.