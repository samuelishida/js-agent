// src/types/agent.d.ts
// Zero-build type definitions for the JS Agent project.
// This file is NOT loaded at runtime — it provides IDE support only.

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
  AgentRegex: any;
  AgentPrompts: any;
  AgentOrchestrator: any;

  // Skills
  AgentSkills: any;
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
  AgentToolExecution: any;
  AgentCompaction: any;
  AgentPermissions: any;
  AgentRateLimiter: any;
  AgentSteering: any;
  AgentWorkers: any;
  AgentFsGuards: any;
  AgentMemory: any;
  AgentRuntimeCache: any;
  AgentLLMControl: any;
  AgentChildAgent: any;
  AgentReplyAnalysis: any;
  AgentUIRender: any;
  AgentRegistry: any;

  // Extracted agent modules (Phase 3)
  AgentRoundController: any;
  AgentErrorRecovery: any;
  AgentToolCallRepair: any;

  // Extracted state modules (Phase 5)
  AgentSessionManager: any;
  AgentToolCache: any;
  AgentProviderState: any;

  // LLM utilities + providers (Phase 4)
  AgentLLMUtils: any;
  AgentLLMProviderOllama: any;
  AgentLLMProviderOpenRouter: any;
  AgentLLMProviderLocal: any;
  AgentLLMProviderOpenAI: any;
  AgentLLMProviderClawd: any;
  AgentLLMProviderAzure: any;
  AgentLLMProviderGemini: any;

  // Security hardening (Phase 7)
  AgentSecurityHardening: any;

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
