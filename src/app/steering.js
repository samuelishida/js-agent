// ── Steering buffer ───────────────────────────────────────────────────────────
// Allows injecting mid-flight guidance via steer() or an external hook.
// The agent loop drains this buffer each iteration and injects messages as new
// User turns so the LLM sees them immediately.
;(function() {
  const steeringBuffer = [];

  function pushSteering(msg) {
    const text = String(msg || '').trim();
    if (text) steeringBuffer.push(text);
  }

  function drainSteering() {
    return steeringBuffer.splice(0, steeringBuffer.length);
  }

  function clearSteering() {
    const drained = drainSteering();
    const status = document.getElementById('steering-status');
    if (status) status.textContent = 'Steering buffer cleared.';
    return drained;
  }

  function sendSteering() {
    const input = document.getElementById('steering-input');
    const text = input.value.trim();
    if (text) {
      pushSteering(text);
      input.value = '';
      const status = document.getElementById('steering-status');
      const C = window.CONSTANTS;
      if (status) status.textContent = `Injected: ${text}${text.length > (C?.STEERING_CHAR_LIMIT || 60) ? '…' : ''}`;
    }
  }

  // Expose globally so UI / external code can inject steering at runtime.
  window.AgentSteering = {
    push: pushSteering,
    drain: drainSteering,
    clear: clearSteering,
    send: sendSteering
  };
  window.clearSteering = clearSteering;
  window.sendSteering = sendSteering;

  // ── Tool call steering / rewriting ────────────────────────────────────────────
  // Intercepts and rewrites known-bad model-generated tool inputs BEFORE they
  // reach the executor — a defence-in-depth layer on top of system-prompt rules.
  function steerToolCall(toolName, args) {
    const C = window.CONSTANTS || {};
    // Block catastrophic shell commands regardless of tool name.
    if (typeof args.command === 'string') {
      const cmd = args.command;
      const blockedCmd = C?.INJECTION_PATTERNS?.BLOCKED_CMD_REGEX;
      const blockedDisk = C?.INJECTION_PATTERNS?.BLOCKED_DISK_OPS_REGEX;
      if ((blockedCmd && blockedCmd.test(cmd)) || (blockedDisk && blockedDisk.test(cmd))) {
        args.command = 'echo BLOCKED: refusing to delete root filesystem';
        return;
      }
    }

    // Strip control-channel tags the model may have injected into string args,
    // preventing prompt injection through crafted filenames or query strings.
    const patterns = C?.INJECTION_PATTERNS || {};
    const sanitizeStringArg = val => val
      .replace(patterns.INJECTION_TAG_STRIP_REGEX || /<tool_call>[\s\S]*?<\/tool_call>/gi, '')
      .replace(patterns.REMINDER_TAG_STRIP_REGEX || /<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
      .replace(patterns.DENIAL_TAG_STRIP_REGEX || /<permission_denials[^>]*>[\s\S]*?<\/permission_denials>/gi, '')
      .trim();

    const keys = C?.SANITIZE_STRING_ARGS || ['path', 'filePath', 'sourcePath', 'destinationPath', 'content', 'query', 'text'];
    for (const key of keys) {
      if (typeof args[key] === 'string') {
        args[key] = sanitizeStringArg(args[key]);
      }
    }
  }

  window.steerToolCall = steerToolCall;
})();
