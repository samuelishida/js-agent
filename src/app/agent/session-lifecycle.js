// src/app/agent/session-lifecycle.js
// Session lifecycle, stop control, UI helpers, and run guards.

let stopRequested = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function requestStop() {
  if (!window.isBusy) return;
  stopRequested = true;
  setStatus('busy', 'stopping…');
  const inputStatus = document.getElementById('input-status');
  if (inputStatus) inputStatus.textContent = 'stopping…';
  window.AgentLLMControl?.abortActiveLlmRequest?.();
  window.AgentSkills?.abortAllTabListeners?.('Run stopped by user.');
}

function throwIfStopRequested() {
  if (!stopRequested) return;
  const error = new Error('RUN_STOPPED');
  error.code = 'RUN_STOPPED';
  throw error;
}

function setStopButtonState(running) {
  const stopBtn = document.getElementById('btn-stop');
  if (!stopBtn) return;
  stopBtn.disabled = !running;
  stopBtn.style.display = running ? 'flex' : 'none';
  const sendBtn = document.getElementById('btn-send');
  if (sendBtn) sendBtn.style.display = running ? 'none' : 'flex';
}

function resetRunGuards() {
  window.AgentToolExecution?.resetRunToolState?.();
  window.AgentRateLimiter?.resetRateLimiter?.();
  window.AgentCompaction?.resetCompactionState?.();
  window.AgentPermissions?.resetRunPermissionState?.();
  window.AgentCompaction?.resetPromptInjectionState?.();
  stopRequested = false;
}

async function sendMessage() {
  if (window.isBusy) return;
  if (!runtimeReady()) {
    addMessage('error', 'Agent bootstrap failed: required modules were not loaded.', null);
    return;
  }
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;

  if (!isLocalModeActive()) {
    const cloudReadiness = typeof getCloudReadiness === 'function'
      ? getCloudReadiness()
      : { ready: canUseCloud(), reason: 'Cloud provider is not ready.' };
    if (!cloudReadiness.ready) {
      addMessage('error', cloudReadiness.reason || 'Cloud provider is not ready.', null);
      return;
    }
  } else if (typeof isOllamaReady === 'function') {
    const ollamaReadiness = isOllamaReady();
    if (!ollamaReadiness.ready) {
      addMessage('error', ollamaReadiness.reason, null);
      return;
    }
  }

  input.value = '';
  autoResize(input);
  window.isBusy = true;
  stopRequested = false;
  resetRunGuards();
  broadcastBusyState(true);
  const sendBtn = document.getElementById('btn-send');
  if (sendBtn) sendBtn.disabled = true;
  setStopButtonState(true);
  const inputStatus = document.getElementById('input-status');
  if (inputStatus) inputStatus.textContent = 'processing…';

  const curSession = getActiveSession() || createSession(text);
  if (!curSession.messages?.length) {
    curSession.title = makeSessionTitle(text);
  }
  addMessage('user', text, null);
  saveSessions();
  renderSessionList();

  try {
    await agentLoop(text);
  } catch (e) {
    hideThinking();
    if (e?.code === 'RUN_STOPPED' || e?.name === 'AbortError') {
      addNotice('Run stopped by user.');
      setStatus('ok', 'stopped');
    } else {
      addMessage('error', e.message, null);
      setStatus('error', 'error');
    }
    syncSessionState();
  } finally {
    window.isBusy = false;
    broadcastBusyState(false);
    if (sendBtn) sendBtn.disabled = false;
    setStopButtonState(false);
    if (inputStatus) inputStatus.textContent = `${window.sessionStats.msgs} message${window.sessionStats.msgs!==1?'s':''} sent`;
    input.focus();
  }
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function useExample(btn) {
  const input = document.getElementById('msg-input');
  input.value = btn.textContent;
  autoResize(input);
  input.focus();
}

window.requestStop = requestStop;
window.sendMessage = sendMessage;
window.handleKey = handleKey;
window.autoResize = autoResize;
window.useExample = useExample;
window.setStatus = setStatus;
