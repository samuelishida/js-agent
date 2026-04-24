/**
 * Structured error handling for the agent
 * Central error class that carries code, origin, and stack
 */

export class AgentError extends Error {
  /** Error code for programmatic handling */
  code: string;
  /** Origin of the error (tool name, module, etc.) */
  origin: string;
  /** Full stack trace */
  #stack: string;
  /** Additional context about where/why the error occurred */
  context?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code?: string;
      origin?: string;
      stack?: string;
      context?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
    this.name = 'AgentError';
    this.code = options.code || 'AGENT_ERROR';
    this.origin = options.origin || 'unknown';
    this.#stack = options.stack ?? new Error().stack ?? '';
    this.context = options.context || {};

    // Preserve prototype chain
    Object.setPrototypeOf(this, AgentError.prototype);
  }

  override get stack(): string {
    return this.#stack ?? super.stack ?? '';
  }

  /**
   * Create error from caught exception with context
   */
  static from<T extends Error>(
    error: T,
    context: Record<string, unknown> = {}
  ): AgentError {
    return new AgentError(
      error.message || 'An unexpected error occurred',
      {
        code: error.name || 'UNKNOWN_ERROR',
        origin: (context as any).origin || 'unknown',
        stack: error.stack,
        context
      }
    );
  }

  /**
   * Create error for specific error codes
   */
  static create(code: string, message: string, context?: Record<string, unknown>): AgentError {
    return new AgentError(message, { code, context });
  }

  /**
   * Common error codes
   */
  static MAX_OUTPUT_TOKENS = new AgentError(
    'Maximum output tokens exceeded',
    { code: 'MAX_OUTPUT_TOKENS', context: { limit: 2200 } }
  );

  static TOOL_CALL_FAILED = new AgentError(
    'Tool call failed',
    { code: 'TOOL_CALL_FAILED' }
  );

  static PERMISSION_DENIED = new AgentError(
    'Permission denied',
    { code: 'PERMISSION_DENIED' }
  );

  static RUN_STOPPED = new AgentError(
    'Run stopped by user',
    { code: 'RUN_STOPPED' }
  );

  static CONTEXT_OVERFLOW = new AgentError(
    'Context budget exceeded',
    { code: 'CONTEXT_OVERFLOW' }
  );

  static SANDBOX_ESCAPE = new AgentError(
    'Sandbox escape attempt detected',
    { code: 'SANDBOX_ESCAPE' }
  );

  static RATE_LIMIT_EXCEEDED = new AgentError(
    'Rate limit exceeded',
    { code: 'RATE_LIMIT_EXCEEDED' }
  );
}
