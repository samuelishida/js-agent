// ── Steering buffer ───────────────────────────────────────────────────────────
// Allows injecting mid-flight guidance via steer() or an external hook.
// The agent loop drains this buffer each iteration and injects messages as new
// User turns so the LLM sees them immediately.
;(function() {
  var steeringBuffer = [];

  function pushSteering(msg) {
    var text = String(msg || '').trim();
    if (text) steeringBuffer.push(text);
  }

  function drainSteering() {
    return steeringBuffer.splice(0, steeringBuffer.length);
  }

  function clearSteering() {
    var drained = drainSteering();
    var status = document.getElementById('steering-status');
    if (status) status.textContent = 'Steering buffer cleared.';
    return drained;
  }

  function sendSteering() {
    var input = document.getElementById('steering-input');
    if (!input) return;
    var text = input.value.trim();
    if (text) {
      pushSteering(text);
      input.value = '';
      var status = document.getElementById('steering-status');
      var C = window.CONSTANTS;
      if (status) status.textContent = 'Injected: ' + text + (text.length > (C && C.STEERING_CHAR_LIMIT || 60) ? '\u2026' : '');
    }
  }

  window.AgentSteering = {
    push: pushSteering,
    drain: drainSteering,
    clear: clearSteering,
    send: sendSteering
  };
  window.clearSteering = clearSteering;
  window.sendSteering = sendSteering;

  // steerToolCall has been moved to tool-execution.js where it's used.
  // window.steerToolCall is published there.
})();