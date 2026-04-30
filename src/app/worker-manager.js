// ── Worker Manager ──
// Creates and manages Web Workers for sandbox isolation.
// Workers are created lazily on first use and reused.

;(function() {
  let sandboxWorker = null;
  let taskIdCounter = 0;

  function createWorker(url) {
    try {
      return new Worker(url, { type: 'classic' });
    } catch (e) {
      console.warn('[WorkerManager] Failed to create worker:', url, e?.message);
      return null;
    }
  }

  function getSandboxWorker() {
    if (sandboxWorker) return sandboxWorker;
    sandboxWorker = createWorker('/src/tools/sandboxWorker.js');
    return sandboxWorker;
  }

  function postToWorker(worker, msg) {
    return new Promise((resolve, reject) => {
      if (!worker) { reject(new Error('Worker not available')); return; }
      const taskId = ++taskIdCounter;
      const timer = setTimeout(() => {
        worker.removeEventListener('message', handler);
        reject(new Error('Worker timeout'));
      }, 30000);

      function handler(event) {
        const data = event.data || {};
        if (data.taskId === taskId) {
          worker.removeEventListener('message', handler);
          clearTimeout(timer);
          if (data.type === 'error') reject(new Error(data.error || 'Worker error'));
          else resolve(data.result || data);
        }
      }

      worker.addEventListener('message', handler);
      worker.postMessage({ ...msg, taskId });
    });
  }

  function executeSandboxed(tool, args) {
    const worker = getSandboxWorker();
    // Pass terminal auth token to worker (worker has no window access)
    if (window.__terminalToken && worker) {
      try { worker.postMessage({ type: '__config', terminalToken: window.__terminalToken }); } catch {}
    }
    return postToWorker(worker, { tool, args });
  }

  function terminateAll() {
    if (sandboxWorker) { sandboxWorker.terminate(); sandboxWorker = null; }
  }

  window.AgentWorkers = {
    getSandboxWorker,
    executeSandboxed,
    terminateAll
  };
})();