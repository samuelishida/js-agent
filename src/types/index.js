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
 * @property {Attachment[]} [attachments] - Optional file/image attachments
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

/**
 * @typedef {Object} Attachment
 * @property {string} id - Generated id
 * @property {string} name - File name
 * @property {string} mimeType - MIME type
 * @property {number} size - Byte size
 * @property {'file'|'image'} kind - Kind
 * @property {'user'|'tool'} source - Who attached
 * @property {'pending'|'ready'|'error'} status - Status
 * @property {string} [textPreview] - Capped text preview
 * @property {string} [dataUrl] - Image data URL (images only)
 */

// ─── Skill Types ──────────────────────────────────────────────

/**
 * @typedef {Object} SkillEntry
 * @property {string} name - Skill name
 * @property {string} description - Skill description
 * @property {Object} [frontmatter] - Parsed YAML frontmatter
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

// ─── RunGraph Types ─────────────────────────────────────────────

/**
 * @typedef {'pending'|'running'|'completed'|'failed'|'stopped'|'max_rounds'} RunStatus
 */

/**
 * @typedef {'pending'|'running'|'completed'|'failed'|'retry'|'cancelled'} TaskStatus
 */

/**
 * @typedef {'generated'|'downloaded'|'attached'|'tool_result'|'inline'} ArtifactKind
 */

/**
 * @typedef {Object} RunGraph
 * @property {string} id - Run id
 * @property {string} sessionId - Session id
 * @property {string} [rootTaskId] - Root task id
 * @property {RunStatus} status - Run status
 * @property {string} goal - User goal / first message
 * @property {string} userMessage - Original user message
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 * @property {number} rounds - Round count
 * @property {Record<string, Task>} tasks - Tasks by id
 * @property {Observation[]} observations - Observations
 * @property {Artifact[]} artifacts - Artifacts
 * @property {RunEvent[]} events - Events
 * @property {{tokensIn?: number, tokensOut?: number, toolCalls?: number, durationMs?: number}} metrics - Metrics
 * @property {string[]} errors - Error messages
 * @property {string} [finalAnswer] - Final answer text
 */

/**
 * @typedef {Object} Task
 * @property {string} id - Task id
 * @property {string} [parentId] - Parent task id
 * @property {'root'|'llm'|'tool'|'repair'|'confirmation'|'compaction'|'final_answer'} kind - Task kind
 * @property {string} title - Human-readable title
 * @property {TaskStatus} status - Task status
 * @property {number} round - Round number
 * @property {string} [toolName] - Tool name (for tool tasks)
 * @property {Record<string, any>} [toolArgs] - Tool arguments
 * @property {string} startedAt - ISO timestamp
 * @property {string} [endedAt] - ISO timestamp
 * @property {string[]} [resultObservationIds] - Linked observation ids
 * @property {string[]} [artifactIds] - Linked artifact ids
 * @property {string} [error] - Error message
 * @property {string} [retryOf] - Original task id if this is a retry
 */

/**
 * @typedef {Object} Observation
 * @property {string} id - Observation id
 * @property {string} taskId - Source task id
 * @property {number} round - Round number
 * @property {'tool_result'|'llm_output'|'compaction'|'repair'|'confirmation'|'error'|'final_answer'} source - Source
 * @property {string} summary - Compact summary
 * @property {string} content - Raw content (may be large)
 * @property {string} contentHash - SHA-256-like truncated hash for dedup
 * @property {string} promptSafeContent - Content suitable for prompt injection
 * @property {boolean} isError - Whether this is an error observation
 * @property {string} createdAt - ISO timestamp
 * @property {Record<string, any>} [metadata] - Extra metadata
 */

/**
 * @typedef {Object} Artifact
 * @property {string} id - Artifact id
 * @property {string} [taskId] - Source task id
 * @property {ArtifactKind} kind - Artifact kind
 * @property {string} name - File name
 * @property {string} mimeType - MIME type
 * @property {number} size - Byte size
 * @property {string} source - Source tool / module
 * @property {string} [preview] - Text preview
 * @property {string} [contentRef] - Reference to stored content (artifact store key)
 * @property {string} [downloadName] - Suggested download name
 * @property {string} createdAt - ISO timestamp
 * @property {Record<string, any>} [metadata] - Extra metadata
 */

/**
 * @typedef {Object} RunEvent
 * @property {string} id - Event id
 * @property {string} runId - Run id
 * @property {'run_started'|'run_completed'|'run_failed'|'run_stopped'|'run_max_rounds'|'round_started'|'pre_llm_compaction'|'llm_started'|'llm_completed'|'tool_calls_parsed'|'repair_attempted'|'confirmation_pending'|'round_continued'|'round_finalized'|'tool_started'|'tool_completed'|'tool_failed'|'observation_added'|'artifact_registered'|'task_started'|'task_completed'|'task_failed'|'task_retry'} type - Event type
 * @property {string} timestamp - ISO timestamp
 * @property {number} [round] - Round number
 * @property {string} [taskId] - Task id
 * @property {string} [message] - Human-readable message
 * @property {'debug'|'info'|'warn'|'error'} [level] - Log level
 * @property {Record<string, any>} [data] - Structured data
 */

// Export nothing — this file is only for JSDoc
export {};

// ─── MCP Types ────────────────────────────────────────────────

/**
 * @typedef {'http'|'stdio'|'sse'|'streamable_http'} McpTransport
 */

/**
 * @typedef {Object} McpToolFilter
 * @property {'all'|'none'|'include'} mode - Filter mode
 * @property {string[]} [names] - Tool names to include when mode is 'include'
 */

/**
 * @typedef {Object} McpResourceFilter
 * @property {'all'|'none'|'include'} mode - Filter mode
 * @property {string[]} [uris] - Resource URIs to include when mode is 'include'
 */

/**
 * @typedef {Object} McpPromptFilter
 * @property {'all'|'none'|'include'} mode - Filter mode
 * @property {string[]} [names] - Prompt names to include when mode is 'include'
 */

/**
 * @typedef {Object} McpServerConfigV2
 * @property {string} id - Server id
 * @property {string} name - Server display name
 * @property {McpTransport} transport - Transport type
 * @property {boolean} enabled - Whether enabled
 * @property {string} [url] - Server URL (for http/sse)
 * @property {string} [command] - Command to spawn (for stdio)
 * @property {string[]} [args] - Command arguments (for stdio)
 * @property {Record<string,string>} [env] - Environment variables (for stdio)
 * @property {Record<string,string>} [headers] - HTTP headers (for http)
 * @property {string} [authRef] - Reference to stored auth secret
 * @property {McpToolFilter} [toolFilter] - Tool filter
 * @property {McpResourceFilter} [resourceFilter] - Resource filter
 * @property {McpPromptFilter} [promptFilter] - Prompt filter
 * @property {string} [riskPolicy] - Risk policy override
 * @property {number} createdAt - Creation timestamp
 * @property {number} updatedAt - Last update timestamp
 */

/**
 * @typedef {Object} McpServerStatus
 * @property {string} serverId - Server id
 * @property {'idle'|'connecting'|'connected'|'error'|'disconnected'} state - Connection state
 * @property {string} [protocolVersion] - MCP protocol version
 * @property {Object} [serverInfo] - Server info from initialize
 * @property {Object} [capabilities] - Server capabilities
 * @property {Object[]} tools - Available tools snapshot
 * @property {Object[]} resources - Available resources snapshot
 * @property {Object[]} prompts - Available prompts snapshot
 * @property {string} [lastError] - Last error message
 * @property {number} [lastRefreshAt] - Last refresh timestamp
 * @property {number} [latencyMs] - Last request latency
 * @property {number} refreshRevision - Monotonic refresh counter
 */
