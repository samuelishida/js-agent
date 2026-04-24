// ── Rate Limiter for Per-Tool Call Limits ──
// Enforces configurable maxCallsPerMinute per tool

(() => {
  const C = () => window.CONSTANTS || {};

  // ── Rate limiter state ──
  const rateLimiter = new Map();

  function getRateLimitConfig(toolName) {
    const config = C().RATE_LIMIT_CONFIG || {};
    const toolConfig = config[toolName] || {};
    return {
      maxCallsPerMinute: Number(toolConfig.maxCallsPerMinute ?? 30),
      windowMs: Number(toolConfig.windowMs ?? 60000)
    };
  }

  function isRateLimited(toolName) {
    const config = getRateLimitConfig(toolName);
    if (!config.maxCallsPerMinute) {
      return { limited: false, remaining: Infinity };
    }

    const now = Date.now();
    let limiter = rateLimiter.get(toolName);

    if (!limiter) {
      limiter = {
        calls: [],
        lastReset: now
      };
      rateLimiter.set(toolName, limiter);
    }

    // Reset expired entries
    const windowMs = config.windowMs || 60000;
    limiter.calls = limiter.calls.filter(timestamp => now - timestamp < windowMs);

    // Check limit
    const callCount = limiter.calls.length;
    const remaining = Math.max(0, config.maxCallsPerMinute - callCount);

    if (callCount >= config.maxCallsPerMinute) {
      const resetTime = Math.ceil((windowMs - (now - limiter.calls[0])) / 1000);
      return {
        limited: true,
        remaining: 0,
        resetTime: resetTime
      };
    }

    // Record this call
    limiter.calls.push(now);

    return {
      limited: false,
      remaining: Math.max(0, remaining - 1)
    };
  }

  function resetRateLimiter() {
    rateLimiter.clear();
  }

  // ── Export ──
  window.AgentRateLimiter = {
    isRateLimited,
    resetRateLimiter
  };
})();
