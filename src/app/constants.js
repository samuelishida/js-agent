// Centralized constants — replaces magic numbers inline in agent.js
// and sibling modules. Both patterns are supported: named import (for future
// bundler migration) and window property (for current defer-tag loading).
(function() {
  const C = {
    // ── Tool result context budget ───────────────────────────────────
    TOOL_RESULT_CONTEXT_BUDGET: {
      inlineMaxChars: 20000,
      previewChars: 5000,
      keepRecentResults: 15
    },

    // ── Context compaction ────────────────────────────────────────────
    CONTEXT_COMPACTION_POLICY: {
      thresholdRatio: 0.82,
      reserveChars: 4000,
      minRoundGap: 2,
      maxConsecutiveFailures: 3
    },

    // ── Time-based microcompact ────────────────────────────────────────
    TIME_BASED_MICROCOMPACT_POLICY: {
      inactivityMs: 20 * 60 * 1000,
      keepRecentResults: 4
    },

    // ── Permission system ────────────────────────────────────────────
    PERMISSION_DENIAL_LIMIT: 30,
    PROMPT_INJECTION_SIGNAL_LIMIT: 40,
    PERMISSION_ESCALATION_THRESHOLDS: {
      ask: 3,
      denyWrite: 6
    },

    // ── Loop guardrails ──────────────────────────────────────────────
    MAX_CONSECUTIVE_NON_ACTION_ROUNDS: 6,

    // ── Tool result replacement storage ──────────────────────────────
    TOOL_RESULT_REPLACEMENTS_STORAGE_KEY: 'agent_tool_result_replacements_v1',

    // ── Steering ─────────────────────────────────────────────────────
    STEERING_CHAR_LIMIT: 60,

    // ── Retry / repair ───────────────────────────────────────────────
    MAX_OUTPUT_TOKEN_RECOVERY_ATTEMPTS: 3,
    TOOL_CALL_REPAIR_MAX_TOKENS: 450,
    TOOL_CALL_REPAIR_TEMPERATURE: 0.1,
    TOOL_CALL_REPAIR_TIMEOUT_MS_LOCAL: 70000,
    TOOL_CALL_REPAIR_TIMEOUT_MS_CLOUD: 22000,
    TOOL_CALL_REPAIR_RETRIES_LOCAL: 0,
    TOOL_CALL_REPAIR_RETRIES_CLOUD: 1,

    // ── LLM call defaults ────────────────────────────────────────────
    DEFAULT_MAX_TOKENS_LOCAL: 4096,
    DEFAULT_MAX_TOKENS_CLOUD: 4096,
    DEFAULT_TIMEOUT_MS_LOCAL: 120000,
    DEFAULT_TIMEOUT_MS_CLOUD: 35000,
    DEFAULT_RETRIES_LOCAL: 0,
    DEFAULT_RETRIES_CLOUD: 2,

    // ── Compaction summary ───────────────────────────────────────────
    SUMMARY_MAX_TOKENS: 700,
    SUMMARY_TEMPERATURE: 0.2,
    SUMMARY_TIMEOUT_MS: 28000,
    SUMMARY_RETRIES: 1,
    SUMMARY_CACHE_TTL_MS: 6 * 60 * 60 * 1000,
    SUMMARY_CACHE_MAX_ENTRIES: 200,
    SUMMARY_CACHE_MAX_BYTES: 1_500_000,

    // ── Runtime cache scopes ─────────────────────────────────────────
    CACHE_SCOPE_TOOL_HOT: 'tool_hot',
    CACHE_SCOPE_TOOL_RESULT_DIGEST: 'tool_result_digest',
    CACHE_SCOPE_TOOL_RESULT_ARCHIVE: 'tool_result_archive',
    CACHE_SCOPE_CONTEXT_SUMMARY: 'context_summary',
    TOOL_RESULT_DIGEST_TTL_MS: 24 * 60 * 60 * 1000,
    TOOL_RESULT_ARCHIVE_TTL_MS: 24 * 60 * 60 * 1000,
    TOOL_RESULT_ARCHIVE_MAX_ENTRIES: 300,
    TOOL_RESULT_ARCHIVE_MAX_BYTES: 3_000_000,
    TOOL_RESULT_DIGEST_MAX_ENTRIES: 800,
    TOOL_RESULT_DIGEST_MAX_BYTES: 2_000_000,
    TOOL_HOT_TTL_READONLY_MS: 10 * 60 * 1000,
    TOOL_HOT_TTL_WRITABLE_MS: 60 * 1000,
    TOOL_HOT_MAX_ENTRIES_READONLY: 500,
    TOOL_HOT_MAX_ENTRIES_WRITABLE: 120,
    TOOL_HOT_MAX_BYTES: 2_000_000,

    // ── Child agent spawning ─────────────────────────────────────────
    CHILD_AGENT_MAX_ITERATIONS: 50,
    CHILD_AGENT_MAX_TOKENS: 800,
    CHILD_AGENT_TEMPERATURE: 0.3,
    CHILD_AGENT_TIMEOUT_MS: 22000,
    CHILD_AGENT_RETRIES: 1,

    // ── Worker runtime ───────────────────────────────────────────────
    WORKER_MAX_TASKS: 10,
    WORKER_MAX_WORKERS: 4,
    WORKER_DEFAULT_MAX_TOKENS: 900,
    WORKER_DEFAULT_TEMPERATURE: 0.2,
    WORKER_TIMEOUT_MS: 30000,
    WORKER_RETRIES: 1,
    WORKER_OUTPUT_MAX_CHARS: 5000,
    WORKER_ERROR_MAX_CHARS: 300,
    WORKER_RUNS_STORAGE_KEY: 'agent_worker_runs_v1',
    WORKER_RUNS_LIMIT: 40,

    // ── Message truncation ───────────────────────────────────────────
    SESSION_TITLE_MAX_CHARS: 48,
    MEMORY_CONTENT_MAX_CHARS: 200,
    WORKER_CONTEXT_SNIPPET_MAX_CHARS: 2400,
    QUERY_PLAN_MAX_CHARS: 180,
    HINTS_MAX_CHARS: 180,
    NOTE_MAX_CHARS: 120,
    NOTIFICATION_TITLE_MAX_CHARS: 64,
    NOTIFICATION_BODY_MAX_CHARS: 200,
    TOOL_RESULT_PREVIEW_MAX_CHARS: 120,
    TOOL_RESULT_DIGEST_HEAD_CHARS: 900,
    TOOL_RESULT_DIGEST_TAIL_CHARS: 500,
    TOOL_RESULT_ARCHIVE_TRUNCATE_CHARS: 40000,
    DETAILED_ERROR_MAX_CHARS: 12000,

    // ── Debounce / timers ────────────────────────────────────────────
    SESSION_SAVE_DEBOUNCE_MS: 2000,
    TOOL_CACHE_TTL_MS: 10 * 60 * 1000,
    PROBE_TIMEOUT_MS: 5000,
    PREFETCH_TIMEOUT_MS: 1200,
    PREFETCH_WAIT_MS: 1400,

    // ── Prompt injection patterns ───────────────────────────────────
    INJECTION_PATTERNS: {
      BLOCKED_CMD_REGEX: /rm\s+(-rf?|\/s)\s+[/\\]|^ Remove-Item\s+[/\\]|del\s+\/[sq]\s+[/\\]/i,
      BLOCKED_DISK_OPS_REGEX: /(?:format|fdisk|diskpart)\s/i,
      CONTROL_CHANNEL_TAG_REGEX: /<tool_call\s*>|<system-reminder\s*>|\[SYSTEM\s+OVERRIDE\]/i,
      INJECTION_TAG_STRIP_REGEX: /<tool_call>[\s\S]*?<\/tool_call>/gi,
      REMINDER_TAG_STRIP_REGEX: /<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/gi,
      DENIAL_TAG_STRIP_REGEX: /<permission_denials[^>]*>[\s\S]*?<\/permission_denials>/gi,
    },

    // ── String sanitization ──────────────────────────────────────────
    SANITIZE_STRING_ARGS: ['path', 'filePath', 'sourcePath', 'destinationPath', 'content', 'query', 'text'],

    // ── Web search normalization (semantic dedup) ────────────────────
    WEB_SEARCH_STOPWORDS: new Set([
      'de', 'da', 'do', 'das', 'dos', 'para', 'por', 'com', 'na', 'no', 'nas', 'nos', 'em', 'e', 'a', 'o'
    ]),

    // ── Storage keys ────────────────────────────────────────────────
    TASKS_STORAGE_KEY: 'agent_tasks_v1',
    TODOS_STORAGE_KEY: 'agent_todos_v1',
    RUNTIME_MEMORY_GLOBAL_KEY: 'runtime_memory_global_v1',
    RUNTIME_MEMORY_PROJECT_PREFIX: 'runtime_memory_project_v1',

    // ── Misc ─────────────────────────────────────────────────────────
    MAX_TOOL_CALLS_PER_REPLY: 5,
    MAX_STORED_REPLACEMENTS: 300,
    DEFAULT_ROUND_LIMIT: 10,
    DEFAULT_CTX_LIMIT_CHARS: 128000,
    MAX_CTX_LIMIT_CHARS: 256000,
    DEFAULT_DELAY_MS: 500,

    // ── Rate limiting ───────────────────────────────────────────────
    RATE_LIMIT_CONFIG: {
      web_search: { maxCallsPerMinute: 30, windowMs: 60000 },
      web_fetch: { maxCallsPerMinute: 10, windowMs: 60000 },
      runtime_webFetch: { maxCallsPerMinute: 10, windowMs: 60000 },
      fs_read_file: { maxCallsPerMinute: 60, windowMs: 60000 },
      runtime_readFile: { maxCallsPerMinute: 60, windowMs: 60000 },
      fs_walk: { maxCallsPerMinute: 30, windowMs: 60000 },
      runtime_runTerminal: { maxCallsPerMinute: 10, windowMs: 60000 },
      runtime_writeFile: { maxCallsPerMinute: 20, windowMs: 60000 },
      runtime_editFile: { maxCallsPerMinute: 20, windowMs: 60000 },
      runtime_multiEdit: { maxCallsPerMinute: 15, windowMs: 60000 },
      runtime_spawnAgent: { maxCallsPerMinute: 5, windowMs: 60000 },
      fs_write_file: { maxCallsPerMinute: 20, windowMs: 60000 },
      fs_delete_path: { maxCallsPerMinute: 10, windowMs: 60000 }
    },
  };

  window.AgentConstants = C;
  window.CONSTANTS = C; // convenience alias used across extracted modules
})();