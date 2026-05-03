// src/app/worker-manager.js
// Worker Manager: creates and manages Web Workers for sandbox isolation.

;(function() {
  /** @type {Worker|null} */
  let sandboxWorker = null;
  /** @type {number} */
  let taskIdCounter = 0;

  /**
   * Create a Web Worker.
   * @param {string} url - Worker script URL
   * @returns {Worker|null} Worker or null
   */
  function createWorker(url) {
    try {
      return new Worker(url, { type: 'classic' });
    } catch (e) {
      console.warn('[WorkerManager] Failed to create worker:', url, e?.message);
      return null;
    }
  }

  /**
   * Get or create sandbox worker.
   * @returns {Worker|null} Sandbox worker
   */
  function getSandboxWorker() {
    if (sandboxWorker) return sandboxWorker;
    sandboxWorker = createWorker('/src/tools/sandboxWorker.js');
    return sandboxWorker;
  }

  /**
   * Post message to worker and await response.
   * @param {Worker} worker - Target worker
   * @param {Object} msg - Message to post
   * @returns {Promise<any>} Worker response
   */
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

  /**
   * Execute a tool in sandboxed worker.
   * @param {string} tool - Tool name
   * @param {Object} args - Tool arguments
   * @returns {Promise<any>} Execution result
   */
  function executeSandboxed(tool, args) {
    const worker = getSandboxWorker();
    // Pass terminal auth token to worker (worker has no window access)
    if (window.__terminalToken && worker) {
      try { worker.postMessage({ type: '__config', terminalToken: window.__terminalToken }); } catch {}
    }
    return postToWorker(worker, { tool, args });
  }

  /**
   * Terminate all workers.
   * @returns {void}
   */
  function terminateAll() {
    if (sandboxWorker) { sandboxWorker.terminate(); sandboxWorker = null; }
  }

  window.AgentWorkers = {
    getSandboxWorker,
    executeSandboxed,
    terminateAll
  };
})();