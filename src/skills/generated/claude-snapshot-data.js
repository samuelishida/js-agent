(() => {
  window.AgentClaudeSnapshotData = {
  "generatedAt": "2026-04-05T09:40:59.940Z",
  "sourceRoot": "claude-code-main/src",
  "outputRoot": "dist/claude-code-main/src",
  "stats": {
    "transpiledFiles": 1902,
    "copiedFiles": 0,
    "bundledSkills": 14
  },
  "bundledSkills": [
    {
      "name": "batch",
      "description": "Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree agents that each open a PR.",
      "whenToUse": "Use when the user wants to make a sweeping, mechanical change across many files (migrations, refactors, bulk renames) that can be decomposed into independent parallel units.",
      "argumentHint": "<instruction>",
      "userInvocable": true,
      "disableModelInvocation": true,
      "file": "src/skills/bundled/batch.ts",
      "promptTemplate": "# Batch: Parallel Work Orchestration\n\nYou are orchestrating a large, parallelizable change across this codebase.\n\n## User Instruction\n\n<expr>\n\n## Phase 1: Research and Plan (Plan Mode)\n\nCall the \\",
      "usage": ""
    },
    {
      "name": "assistant-api",
      "description": "Build apps with the Assistant API or the model provider SDK.\n",
      "whenToUse": "",
      "argumentHint": "",
      "userInvocable": true,
      "disableModelInvocation": false,
      "file": "src/skills/bundled/claudeApi.ts",
      "promptTemplate": "",
      "usage": ""
    },
    {
      "name": "assistant-in-chrome",
      "description": "Automates your Chrome browser to interact with web pages - clicking elements, filling forms, capturing screenshots, reading console logs, and navigating sites. Opens pages in new tabs within your existing Chrome session. Requires site-level permissions before executing (configured in the extension).",
      "whenToUse": "When the user wants to interact with web pages, automate browser tasks, capture screenshots, read console logs, or perform any browser-based actions. Always invoke BEFORE attempting to use any mcp__assistant-in-chrome__* tools.",
      "argumentHint": "",
      "userInvocable": true,
      "disableModelInvocation": false,
      "file": "src/skills/bundled/claudeInChrome.ts",
      "promptTemplate": "",
      "usage": ""
    },
    {
      "name": "debug",
      "description": "process",
      "whenToUse": "",
      "argumentHint": "[issue description]",
      "userInvocable": true,
      "disableModelInvocation": true,
      "file": "src/skills/bundled/debug.ts",
      "promptTemplate": "",
      "usage": ""
    },
    {
      "name": "keybindings-help",
      "description": "Use when the user wants to customize keyboard shortcuts, rebind keys, add chord bindings, or modify ~/.assistant/keybindings.json. Examples: \"rebind ctrl+s\", \"add a chord shortcut\", \"change the submit key\", \"customize keybindings\".",
      "whenToUse": "",
      "argumentHint": "",
      "userInvocable": false,
      "disableModelInvocation": false,
      "file": "src/skills/bundled/keybindings.ts",
      "promptTemplate": "",
      "usage": ""
    },
    {
      "name": "loop",
      "description": "Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo, defaults to 10m)",
      "whenToUse": "When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval (e.g. \"check the deploy every 5 minutes\", \"keep running /babysit-prs\"). Do NOT invoke for one-off tasks.",
      "argumentHint": "[interval] <prompt>",
      "userInvocable": true,
      "disableModelInvocation": false,
      "file": "src/skills/bundled/loop.ts",
      "promptTemplate": "# /loop — schedule a recurring prompt\n\nParse the input below into \\",
      "usage": ""
    },
    {
      "name": "lorem-ipsum",
      "description": "Generate filler text for long context testing. Specify token count as argument (e.g., /lorem-ipsum 50000). Outputs approximately the requested number of tokens. Ant-only.",
      "whenToUse": "",
      "argumentHint": "[token_count]",
      "userInvocable": true,
      "disableModelInvocation": false,
      "file": "src/skills/bundled/loremIpsum.ts",
      "promptTemplate": "",
      "usage": ""
    },
    {
      "name": "remember",
      "description": "Review auto-memory entries and propose promotions to CLAUDE.md, CLAUDE.local.md, or shared memory. Also detects outdated, conflicting, and duplicate entries across memory layers.",
      "whenToUse": "Use when the user wants to review, organize, or promote their auto-memory entries. Also useful for cleaning up outdated or conflicting entries across CLAUDE.md, CLAUDE.local.md, and auto-memory.",
      "argumentHint": "",
      "userInvocable": true,
      "disableModelInvocation": false,
      "file": "src/skills/bundled/remember.ts",
      "promptTemplate": "",
      "usage": ""
    },
    {
      "name": "schedule",
      "description": "Create, update, list, or run scheduled remote agents (triggers) that execute on a cron schedule.",
      "whenToUse": "When the user wants to schedule a recurring remote agent, set up automated tasks, create a cron job for the agent runtime, or manage their scheduled agents/triggers.",
      "argumentHint": "",
      "userInvocable": true,
      "disableModelInvocation": false,
      "file": "src/skills/bundled/scheduleRemoteAgents.ts",
      "promptTemplate": "# Schedule Remote Agents\n\nYou are helping the user schedule, update, list, or run **remote** the agent runtime agents. These are NOT local cron jobs — each trigger spawns a fully isolated remote session (CCR) in the model provider's cloud infrastructure on a cron schedule. The agent runs in a sandboxed environment with its own git checkout, tools, and optional MCP connections.\n\n## First Step\n\n<expr>\n<expr>\n\n## What You Can Do\n\nUse the \\",
      "usage": ""
    },
    {
      "name": "simplify",
      "description": "Review changed code for reuse, quality, and efficiency, then fix any issues found.",
      "whenToUse": "",
      "argumentHint": "",
      "userInvocable": true,
      "disableModelInvocation": false,
      "file": "src/skills/bundled/simplify.ts",
      "promptTemplate": "",
      "usage": ""
    },
    {
      "name": "skillify",
      "description": "Capture this session's repeatable process into a skill. Call at end of the process you want to capture with an optional description.",
      "whenToUse": "",
      "argumentHint": "[description of the process you want to capture]",
      "userInvocable": true,
      "disableModelInvocation": true,
      "file": "src/skills/bundled/skillify.ts",
      "promptTemplate": "",
      "usage": ""
    },
    {
      "name": "stuck",
      "description": "[VENDOR-ONLY] Investigate frozen/stuck/slow the agent runtime sessions on this machine and post a diagnostic report to #assistant-code-feedback.",
      "whenToUse": "",
      "argumentHint": "",
      "userInvocable": true,
      "disableModelInvocation": false,
      "file": "src/skills/bundled/stuck.ts",
      "promptTemplate": "",
      "usage": ""
    },
    {
      "name": "update-config",
      "description": "Use this skill to configure the the agent runtime harness via settings.json. Automated behaviors (\"from now on when X\", \"each time X\", \"whenever X\", \"before/after X\") require hooks configured in settings.json - the harness executes these, not Assistant, so memory/preferences cannot fulfill them. Also use for: permissions (\"allow X\", \"add permission\", \"move permission to\"), env vars (\"set X=Y\"), hook troubleshooting, or any changes to settings.json/settings.local.json files. Examples: \"allow npm commands\", \"add bq permission to global settings\", \"move permission to user settings\", \"set DEBUG=true\", \"when assistant stops show X\". For simple settings like theme/model, use Config tool.",
      "whenToUse": "",
      "argumentHint": "",
      "userInvocable": true,
      "disableModelInvocation": false,
      "file": "src/skills/bundled/updateConfig.ts",
      "promptTemplate": "",
      "usage": ""
    },
    {
      "name": "verify",
      "description": "DESCRIPTION",
      "whenToUse": "",
      "argumentHint": "",
      "userInvocable": true,
      "disableModelInvocation": false,
      "file": "src/skills/bundled/verify.ts",
      "promptTemplate": "",
      "usage": ""
    }
  ],
  "promptSnippets": {
    "defaultAgentPrompt": "You are an agent for the agent runtime, this agent CLI. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.",
    "actionsSection": "# Executing actions with care\n\nCarefully consider the reversibility and blast radius of actions. Generally you can freely take local, reversible actions like editing files or running tests. But for actions that are hard to reverse, affect shared systems beyond your local environment, or could otherwise be risky or destructive, check with the user before proceeding. The cost of pausing to confirm is low, while the cost of an unwanted action (lost work, unintended messages sent, deleted branches) can be very high. For actions like these, consider the context, the action, and user instructions, and by default transparently communicate the action and ask for confirmation before proceeding. This default can be changed by user instructions - if explicitly asked to operate more autonomously, then you may proceed without confirmation, but still attend to the risks and consequences when taking actions. A user approving an action (like a git push) once does NOT mean that they approve it in all contexts, so unless actions are authorized in advance in durable instructions like CLAUDE.md files, always confirm first. Authorization stands for the scope specified, not beyond. Match the scope of your actions to what was actually requested.\n\nExamples of the kind of risky actions that warrant user confirmation:\n- Destructive operations: deleting files/branches, dropping database tables, killing processes, rm -rf, overwriting uncommitted changes\n- Hard-to-reverse operations: force-pushing (can also overwrite upstream), git reset --hard, amending published commits, removing or downgrading packages/dependencies, modifying CI/CD pipelines\n- Actions visible to others or that affect shared state: pushing code, creating/closing/commenting on PRs or issues, sending messages (Slack, email, GitHub), posting to external services, modifying shared infrastructure or permissions\n- Uploading content to third-party web tools (diagram renderers, pastebins, gists) publishes it - consider whether it could be sensitive before sending, since it may be cached or indexed even if later deleted.\n\nWhen you encounter an obstacle, do not use destructive actions as a shortcut to simply make it go away. For instance, try to identify root causes and fix underlying issues rather than bypassing safety checks (e.g. --no-verify). If you discover unexpected state like unfamiliar files, branches, or configuration, investigate before deleting or overwriting, as it may represent the user's in-progress work. For example, typically resolve merge conflicts rather than discarding changes; similarly, if a lock file exists, investigate what process holds it rather than deleting it. In short: only take risky actions carefully, and when in doubt, ask before acting. Follow both the spirit and letter of these instructions - measure twice, cut once.",
    "autonomousSection": "# Autonomous work\n\nYou are running autonomously. You will receive \\",
    "hooksSection": "Users may configure 'hooks', shell commands that execute in response to events like tool calls, in settings. Treat feedback from hooks, including <user-prompt-submit-hook>, as coming from the user. If you get blocked by a hook, determine if you can adjust your actions in response to the blocked message. If not, ask the user to check their hooks configuration.",
    "remindersSection": "- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are automatically added by the system, and bear no direct relation to the specific tool results or user messages in which they appear.\n- The conversation has unlimited context through automatic summarization.",
    "functionResultClearingSection": "# Function Result Clearing\n\nOld tool results will be automatically cleared from context to free up space. The <expr> most recent results are always kept.",
    "summarizeToolResultsSection": "When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.",
    "prefixes": []
  },
  "notes": [
    "Snapshot transpiled from TypeScript/TSX to JS with import extension rewrite.",
    "Prompt snippets were sanitized to remove direct provider branding.",
    "This manifest is for adapting architecture patterns, not running vendor runtime unchanged."
  ]
};
})();
