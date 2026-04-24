/**
 * Centralized constants with TypeScript types
 * Replaces magic numbers and strings scattered across modules
 */

export interface ToolResultContextBudget {
  inlineMaxChars: number;
  previewChars: number;
  keepRecentResults: number;
}

export interface ContextCompactionPolicy {
  thresholdRatio: number;
  reserveChars: number;
  minRoundGap: number;
  maxConsecutiveFailures: number;
}

export interface TimeBasedMicrocompactPolicy {
  inactivityMs: number;
  keepRecentResults: number;
}

export interface PermissionEscalationThresholds {
  ask: number;
  denyWrite: number;
}

export interface LLMCallDefaults {
  maxTokensLocal: number;
  maxTokensCloud: number;
  timeoutMsLocal: number;
  timeoutMsCloud: number;
  retriesLocal: number;
  retriesCloud: number;
}

export interface SummaryConfig {
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  retries: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  cacheMaxBytes: number;
}

export interface ToolResultDigestConfig {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
}

export interface ToolHotConfig {
  ttlReadonlyMs: number;
  ttlWritableMs: number;
  maxEntriesReadonly: number;
  maxEntriesWritable: number;
  maxBytes: number;
}

export interface ChildAgentConfig {
  maxIterations: number;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  retries: number;
}

export interface WorkerConfig {
  maxTasks: number;
  maxWorkers: number;
  defaultMaxTokens: number;
  defaultTemperature: number;
  timeoutMs: number;
  retries: number;
}

export interface RetryConfig {
  max: number;
  backoffMs: number;
}

export interface ToolMeta {
  readOnly?: boolean;
  concurrencySafe?: boolean;
  risk?: 'low' | 'medium' | 'high';
  version?: string;
  retry?: RetryConfig;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ToolResult {
  tool: string;
  result: unknown;
  callId: string;
  timestamp: number;
  durationMs?: number;
  error?: string;
}

export interface AgentState {
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  toolResults: ToolResult[];
  roundCount: number;
  maxRounds: number;
  status: 'idle' | 'running' | 'completed' | 'error';
  error?: string;
}

export interface ErrorPayload {
  code: string;
  origin: string;
  stack?: string;
  context?: Record<string, unknown>;
}

/**
 * Constants object exported for window.CONSTANTS compatibility
 */
export const CONSTANTS = {
  // ── Tool result context budget ─────────────────────────────────────
  TOOL_RESULT_CONTEXT_BUDGET: {
    inlineMaxChars: 20000,
    previewChars: 5000,
    keepRecentResults: 15
  } as const satisfies ToolResultContextBudget,

  // ── Context compaction ────────────────────────────────────────────
  CONTEXT_COMPACTION_POLICY: {
    thresholdRatio: 0.82,
    reserveChars: 4000,
    minRoundGap: 2,
    maxConsecutiveFailures: 3
  } as const satisfies ContextCompactionPolicy,

  // ── Time-based microcompact ───────────────────────────────────────
  TIME_BASED_MICROCOMPACT_POLICY: {
    inactivityMs: 20 * 60 * 1000,
    keepRecentResults: 4
  } as const satisfies TimeBasedMicrocompactPolicy,

  // ── Permission system ────────────────────────────────────────────
  PERMISSION_DENIAL_LIMIT: 30,
  PROMPT_INJECTION_SIGNAL_LIMIT: 40,
  PERMISSION_ESCALATION_THRESHOLDS: {
    ask: 3,
    denyWrite: 6
  } as const satisfies PermissionEscalationThresholds,

  // ── Loop guardrails ──────────────────────────────────────────────
  MAX_CONSECUTIVE_NON_ACTION_ROUNDS: 6,

  // ── Tool result replacement storage ──────────────────────────────
  TOOL_RESULT_REPLACEMENTS_STORAGE_KEY: 'agent_tool_result_replacements_v1',

  // ── Steering ────────────────────────────────────────────────────
  STEERING_CHAR_LIMIT: 60,

  // ── Retry / repair ──────────────────────────────────────────────
  MAX_OUTPUT_TOKEN_RECOVERY_ATTEMPTS: 3,
  TOOL_CALL_REPAIR_MAX_TOKENS: 450,
  TOOL_CALL_REPAIR_TEMPERATURE: 0.1,
  TOOL_CALL_REPAIR_TIMEOUT_MS_LOCAL: 70000,
  TOOL_CALL_REPAIR_TIMEOUT_MS_CLOUD: 22000,
  TOOL_CALL_REPAIR_RETRIES_LOCAL: 0,
  TOOL_CALL_REPAIR_RETRIES_CLOUD: 1,

  // ── LLM call defaults ────────────────────────────────────────────
  DEFAULT_MAX_TOKENS_LOCAL: 1900,
  DEFAULT_MAX_TOKENS_CLOUD: 2200,
  DEFAULT_TIMEOUT_MS_LOCAL: 120000,
  DEFAULT_TIMEOUT_MS_CLOUD: 35000,
  DEFAULT_RETRIES_LOCAL: 0,
  DEFAULT_RETRIES_CLOUD: 2,

  // ── Compaction summary ──────────────────────────────────────────
  SUMMARY: {
    maxTokens: 700,
    temperature: 0.2,
    timeoutMs: 28000,
    retries: 1,
    cacheTtlMs: 6 * 60 * 60 * 1000,
    cacheMaxEntries: 200,
    cacheMaxBytes: 1_500_000
  } as const satisfies SummaryConfig,

  // ── Runtime cache scopes ────────────────────────────────────────
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

  // ── Child agent spawning ────────────────────────────────────────
  CHILD_AGENT: {
    maxIterations: 50,
    maxTokens: 800,
    temperature: 0.3,
    timeoutMs: 22000,
    retries: 1
  },

  // ── Worker runtime ──────────────────────────────────────────────
  WORKER: {
    maxTasks: 10,
    maxWorkers: 4,
    defaultMaxTokens: 900,
    defaultTemperature: 0.2,
    timeoutMs: 30000,
    retries: 1
  }
};
