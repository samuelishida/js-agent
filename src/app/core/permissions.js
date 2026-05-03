// src/app/core/permissions.js
// Permission compatibility layer: hooks, denials, escalation, and evaluation.

;(function() {
  /** @type {Function} */
  const C = () => window.CONSTANTS || {};

  /** @type {string} */
  let runPermissionMode = 'default';
  /** @type {Array<{tool: string, reason: string, at: string}>} */
  let runPermissionDenials = [];
  /** @type {Object} */
  let runSessionContext = {};
  /** @type {Map<string, Function>} */
  const hooks = new Map();

  /**
   * Normalize a permission decision.
   * @param {any} decision - Raw decision
   * @returns {{allowed: boolean, decided: boolean, reason: string}} Normalized decision
   */
  function normalizeDecision(decision) {
    if (!decision || typeof decision !== 'object') {
      return { allowed: false, decided: true, reason: 'Invalid permission decision format.' };
    }

    return {
      allowed: decision.allowed === true,
      decided: !!decision.decided,
      reason: String(decision.reason || '')
    };
  }

  /**
   * Recalculate permission mode based on denial count.
   * @returns {void}
   */
  function recalculatePermissionMode() {
    const thresholds = C().PERMISSION_ESCALATION_THRESHOLDS || {};
    const denials = runPermissionDenials.length;

    if (denials >= Number(thresholds.denyWrite || 6)) {
      runPermissionMode = 'deny_write';
      return;
    }
    if (denials >= Number(thresholds.ask || 3)) {
      runPermissionMode = 'ask';
      return;
    }
    runPermissionMode = 'default';
  }

  /**
   * Reset run permission state.
   * @returns {void}
   */
  function resetRunPermissionState() {
    runPermissionMode = 'default';
    runPermissionDenials = [];
    runSessionContext = {};
  }

  /**
   * Update run session context.
   * @param {Object} [patch={}] - Context patch
   * @returns {Object} Updated context
   */
  function updateRunSessionContext(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return runSessionContext;
    runSessionContext = { ...runSessionContext, ...patch };
    return runSessionContext;
  }

  /**
   * Register an agent hook.
   * @param {string} name - Hook name
   * @param {Function} handler - Hook handler
   * @returns {void}
   */
  function registerAgentHook(name, handler) {
    const key = String(name || '').trim();
    if (!key) return;
    if (typeof handler === 'function') {
      hooks.set(key, handler);
      return;
    }
    hooks.delete(key);
  }

  /**
   * Emit an agent hook.
   * @param {string} name - Hook name
   * @param {Object} [payload={}] - Hook payload
   * @returns {any} Hook result
   */
  function emitAgentHook(name, payload = {}) {
    const key = String(name || '').trim();
    const handler = hooks.get(key);

    try {
      window.dispatchEvent(new CustomEvent(`agent:${key}`, {
        detail: { ...runSessionContext, ...payload, runPermissionMode }
      }));
    } catch {}

    if (typeof handler !== 'function') return null;
    try {
      return handler({ ...runSessionContext, ...payload, runPermissionMode });
    } catch (error) {
      console.warn(`[Permissions] Hook '${key}' failed:`, error?.message || error);
      return null;
    }
  }

  /**
   * Evaluate tool permission hook.
   * @param {import('../../types/index.js').ToolCall} call - Tool call
   * @param {Object} [context={}] - Evaluation context
   * @returns {Promise<{allowed: boolean, decided: boolean, reason: string}>} Permission result
   */
  async function evaluateToolPermissionHook(call, context = {}) {
    const handler = hooks.get('tool_permission');
    if (typeof handler !== 'function') {
      return { allowed: true, decided: false, reason: '' };
    }

    try {
      const result = await handler(call, {
        ...runSessionContext,
        ...context,
        runPermissionMode
      });
      return normalizeDecision(result);
    } catch (error) {
      return {
        allowed: false,
        decided: true,
        reason: error?.message || 'Permission hook failed.'
      };
    }
  }

  /**
   * Register a permission denial.
   * @param {import('../../types/index.js').ToolCall} call - Tool call
   * @param {Object} [denial={}] - Denial info
   * @returns {{tool: string, reason: string, at: string}|null} Registered denial
   */
  function registerPermissionDenial(call, denial = {}) {
    const limit = Number(C().PERMISSION_DENIAL_LIMIT || 30);
    runPermissionDenials = [
      ...runPermissionDenials,
      {
        tool: String(call?.tool || 'unknown'),
        reason: String(denial?.reason || 'Permission denied.'),
        at: new Date().toISOString()
      }
    ].slice(-limit);
    recalculatePermissionMode();
    return runPermissionDenials[runPermissionDenials.length - 1] || null;
  }

  /**
   * Check if a result is a permission denial.
   * @param {string} result - Tool result
   * @returns {boolean} True if denied
   */
  function isPermissionDeniedResult(result) {
    return /^ERROR:\s*PERMISSION_DENIED\b/i.test(String(result || ''));
  }

  window.AgentPermissions = {
    get runPermissionMode() { return runPermissionMode; },
    set runPermissionMode(value) {
      const next = String(value || 'default').trim();
      runPermissionMode = next || 'default';
    },
    get runPermissionDenials() { return runPermissionDenials; },
    get runSessionContext() { return runSessionContext; },
    resetRunPermissionState,
    updateRunSessionContext,
    registerAgentHook,
    emitAgentHook,
    evaluateToolPermissionHook,
    registerPermissionDenial,
    isPermissionDeniedResult
  };
})();
