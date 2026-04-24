/**
 * TypeScript declarations for existing JS modules
 * These allow TypeScript to understand the window.* globals
 */

declare global {
  interface Window {
    /** Tool call parser */
    AgentRegex?: {
      TOOL_BLOCK: RegExp;
      hasUnprocessedToolCall?: (text: string) => boolean;
      normalizeToolCallObject?: (call: unknown) => ToolCall | null;
    };

    /** Prompt loader */
    AgentPrompts?: {
      load: (name: string) => Promise<string>;
      get: (name: string) => string | null;
    };

    /** Orchestrator */
    AgentOrchestrator?: {
      buildSystemPrompt: (messages: Array<{ role: string; content: string }>) => string;
      hasReasoningLeak?: (text: string) => boolean;
    };

    /** Skills registry */
    AgentSkills?: {
      registry: Map<string, ToolMeta>;
      abortAllTabListeners?: (reason: string) => void;
      abortActiveLlmRequest?: () => void;
    };

    /** Runtime cache */
    AgentRuntimeCache?: {
      get: <T>(key: string, scope: string) => T | null;
      set: <T>(key: string, value: T, scope: string, ttlMs: number) => void;
      clear: (scope: string) => void;
    };

    /** Memory system */
    AgentMemory?: {
      write: (payload: unknown) => Promise<void>;
      search: (query: string) => Promise<unknown[]>;
      list: () => Promise<unknown[]>;
      extractFromTurn?: (params: { userMessage: string; assistantMessage: string }) => unknown;
      export?: () => string;
      import?: (json: string) => void;
    };

    /** Permissions */
    AgentPermissions?: {
      check: (tool: string, args: Record<string, unknown>) => Promise<{ allowed: boolean; reason?: string }>;
      resetRunPermissionState?: () => void;
    };

    /** Compaction */
    AgentCompaction?: {
      summarize: (text: string) => Promise<string>;
      resetCompactionState?: () => void;
      resetPromptInjectionState?: () => void;
    };

    /** Tool execution */
    AgentToolExecution?: {
      execute: (call: ToolCall) => Promise<ToolResult>;
      executeBatch: (calls: ToolCall[]) => Promise<ToolResult[]>;
      resetRunToolState?: () => void;
      getSemanticToolCallSignature?: (call: ToolCall) => string;
      normalizeToolCallObject?: (call: unknown) => ToolCall | null;
    };

    /** LLM control */
    AgentLLMControl?: {
      chat: (messages: Array<{ role: string; content: string }>, options?: { maxTokens?: number; temperature?: number }) => Promise<string>;
      abortActiveLlmRequest?: () => void;
    };

    /** Constants */
    CONSTANTS?: typeof import('./constants.ts').CONSTANTS;
  }
}

export {};
