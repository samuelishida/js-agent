// src/app/context/steering.js
// Steering buffer: inject mid-flight guidance into the agent loop.

;(function() {
  /** @type {string[]} */
  var steeringBuffer = [];

  /**
   * Push a steering message.
   * @param {string} msg - Message to inject
   * @returns {void}
   */
  function pushSteering(msg) {
    var text = String(msg || '').trim();
    if (text) steeringBuffer.push(text);
  }

  /**
   * Drain all steering messages.
   * @returns {string[]} Drained messages
   */
  function drainSteering() {
    return steeringBuffer.splice(0, steeringBuffer.length);
  }

  /**
   * Clear the steering buffer.
   * @returns {string[]} Cleared messages
   */
  function clearSteering() {
    var drained = drainSteering();
    var status = document.getElementById('steering-status');
    if (status) status.textContent = 'Steering buffer cleared.';
    return drained;
  }

  /**
   * Send steering from input field.
   * @returns {void}
   */
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