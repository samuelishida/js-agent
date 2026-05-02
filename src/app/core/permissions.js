// ── Permission compatibility layer ───────────────────────────────────────────
// This app still loads with plain defer scripts, so extracted runtime helpers
// must publish onto window instead of using ESM exports.
;(function() {
  const C = () => window.CONSTANTS || {};

  let runPermissionMode = 'default';
  let runPermissionDenials = [];
  let runSessionContext = {};
  const hooks = new Map();

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

  function resetRunPermissionState() {
    runPermissionMode = 'default';
    runPermissionDenials = [];
    runSessionContext = {};
  }

  function updateRunSessionContext(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return runSessionContext;
    runSessionContext = { ...runSessionContext, ...patch };
    return runSessionContext;
  }

  function registerAgentHook(name, handler) {
    const key = String(name || '').trim();
    if (!key) return;
    if (typeof handler === 'function') {
      hooks.set(key, handler);
      return;
    }
    hooks.delete(key);
  }

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
