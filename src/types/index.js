// src/types/index.js
// Centralized JSDoc typedefs for the JS Agent project.
// This file is NOT loaded at runtime — it provides IDE support only.
// Import via: /** @typedef {import('./index.js').TypeName} TypeName */

// ─── Core Types ───────────────────────────────────────────────

/**
 * @typedef {Object} ToolCall
 * @property {string} tool - Tool name
 * @property {Record<string, any>} args - Tool arguments
 * @property {string} [call_id] - Optional call identifier
 * @property {string} [id] - Optional id
 */

/**
 * @typedef {Object} BatchResult
 * @property {ToolCall} call - The tool call
 * @property {string} result - Tool execution result
 */

/**
 * @typedef {Object} LlmCallOptions
 * @property {number} [maxTokens] - Maximum tokens to generate
 * @property {number} [temperature] - Sampling temperature
 * @property {number} [timeout] - Request timeout in ms
 * @property {number} [retries] - Number of retries
 * @property {AbortSignal} [signal] - Abort signal
 */

/**
 * @typedef {Object} LlmResponse
 * @property {string} content - Response content
 * @property {ToolCall[]} [toolCalls] - Tool calls in response
 * @property {string} [finishReason] - Finish reason
 * @property {{promptTokens: number, completionTokens: number, totalTokens: number}} [usage] - Token usage
 */

/**
 * @typedef {Object} SessionMessage
 * @property {'system'|'user'|'assistant'|'tool'} role - Message role
 * @property {string|Array<{type: string, text?: string}>} content - Message content
 * @property {string} [toolCallId] - Associated tool call id
 * @property {string} [name] - Tool name
 */

/**
 * @typedef {Object} SessionStats
 * @property {number} rounds - Number of rounds
 * @property {number} toolCalls - Number of tool calls
 * @property {number} startTime - Session start timestamp
 * @property {number} lastActivity - Last activity timestamp
 * @property {number} [totalTokens] - Total tokens used
 */

// ─── Skill Types ──────────────────────────────────────────────

/**
 * @typedef {Object} SkillEntry
 * @property {string} name - Skill name
 * @property {string} description - Skill description
 * @property {Object} frontmatter - Parsed YAML frontmatter
 * @property {string} content - Skill body content
 * @property {string} source - Source URL or identifier
 */

/**
 * @typedef {Object} SkillCacheEntry
 * @property {string} markdown - Full markdown content
 * @property {string} source - Source identifier
 * @property {number} timestamp - Cache timestamp
 */

/**
 * @typedef {Object} SkillSearchResult
 * @property {string} name - Skill name
 * @property {string} description - Skill description
 * @property {number} score - Match score
 */

// ─── Tool Types ─────────────────────────────────────────────────

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name - Tool name
 * @property {string} description - Tool description
 * @property {string} [signature] - Tool signature string
 * @property {Function} handler - Tool handler function
 */

/**
 * @typedef {Object} ToolGroup
 * @property {string} label - Group display label
 * @property {ToolDefinition[]} tools - Tools in this group
 */

// ─── Registry Types ───────────────────────────────────────────

/**
 * @typedef {Object} ModuleRegistry
 * @property {Function} register - Register a module
 * @property {Function} resolve - Resolve a module
 * @property {Function} listModules - List registered modules
 */

// ─── Orchestrator Types ─────────────────────────────────────

/**
 * @typedef {Object} BuildSystemPromptOptions
 * @property {string} userMessage - User message
 * @property {number} maxRounds - Maximum reasoning rounds
 * @property {number} ctxLimit - Context limit
 * @property {string[]} enabledTools - Enabled tool names
 */

/**
 * @typedef {Object} RuntimeContinuationOptions
 * @property {string} [toolSummary] - Tool use summary
 * @property {Array<{tool: string, reason: string}>} [permissionDenials] - Permission denials
 * @property {string[]} [compactionNotes] - Compaction notes
 * @property {string[]} [promptInjectionNotes] - Prompt injection notes
 */

// Export nothing — this file is only for JSDoc
export {};
