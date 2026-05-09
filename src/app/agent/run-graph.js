/**
 * src/app/agent/run-graph.js
 * RunGraph: structured, event-driven execution journal for each agent run.
 * Publishes window.AgentRunGraph
 */

(() => {
  'use strict';

  /** @type {Map<string, import('../../types/index.js').RunGraph>} */
  const runs = new Map();

  const RUNS_STORAGE_KEY = 'agent_run_graphs_v1';
  const MAX_PERSISTED_RUNS = 20;

  /**
   * Generate a short unique id.
   * @returns {string}
   */
  function makeId() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * Simple hash for dedup.
   * @param {string} s
   * @returns {string}
   */
  function hashString(s) {
    let h = 0;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36).padStart(7, '0');
  }

  function nowISO() {
    return new Date().toISOString();
  }

  /**
   * Persist compact run records to localStorage.
   */
  function persistRuns() {
    try {
      const arr = Array.from(runs.values())
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, MAX_PERSISTED_RUNS)
        .map(r => ({
          id: r.id,
          sessionId: r.sessionId,
          status: r.status,
          goal: r.goal,
          userMessage: r.userMessage,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          rounds: r.rounds,
          metrics: r.metrics,
          errors: r.errors.slice(-10),
          finalAnswer: r.finalAnswer ? String(r.finalAnswer).slice(0, 500) : undefined,
          taskIds: Object.keys(r.tasks).slice(0, 50),
          observationIds: r.observations.slice(0, 50).map(o => o.id),
          artifactIds: r.artifacts.slice(0, 50).map(a => a.id),
          events: r.events.slice(-80)
        }));
      localStorage.setItem(RUNS_STORAGE_KEY, JSON.stringify(arr));
    } catch { /* storage may be full / unavailable */ }
  }

  /**
   * Load persisted compact run records.
   */
  function loadRuns() {
    try {
      const raw = JSON.parse(localStorage.getItem(RUNS_STORAGE_KEY) || '[]');
      if (!Array.isArray(raw)) return;
      for (const r of raw) {
        if (!r?.id) continue;
        runs.set(r.id, {
          id: r.id,
          sessionId: r.sessionId || '',
          rootTaskId: r.rootTaskId || undefined,
          status: /** @type {import('../../types/index.js').RunStatus} */ (r.status || 'pending'),
          goal: r.goal || '',
          userMessage: r.userMessage || '',
          createdAt: r.createdAt || nowISO(),
          updatedAt: r.updatedAt || nowISO(),
          rounds: Number(r.rounds) || 0,
          tasks: {},
          observations: [],
          artifacts: [],
          events: Array.isArray(r.events) ? r.events : [],
          metrics: r.metrics || {},
          errors: Array.isArray(r.errors) ? r.errors : [],
          finalAnswer: r.finalAnswer
        });
      }
    } catch { /* ignore corrupt storage */ }
  }

  /**
   * Deep-clone a plain object (safe for JSON-like structures).
   * @param {any} obj
   * @returns {any}
   */
  function clone(obj) {
    return typeof obj === 'object' && obj !== null ? JSON.parse(JSON.stringify(obj)) : obj;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Create a new RunGraph.
   * @param {Object} opts
   * @param {string} opts.sessionId
   * @param {string} [opts.goal]
   * @param {string} [opts.userMessage]
   * @returns {import('../../types/index.js').RunGraph}
   */
  function createRun({ sessionId, goal, userMessage }) {
    const id = `run_${makeId()}`;
    const run = {
      id,
      sessionId: String(sessionId || ''),
      status: 'running',
      goal: String(goal || userMessage || ''),
      userMessage: String(userMessage || ''),
      createdAt: nowISO(),
      updatedAt: nowISO(),
      rounds: 0,
      tasks: {},
      observations: [],
      artifacts: [],
      events: [],
      metrics: {},
      errors: [],
      finalAnswer: undefined
    };
    runs.set(id, run);
    emitEvent(run, { type: 'run_started', level: 'info', message: 'Run started' });
    persistRuns();
    return run;
  }

  /**
   * Start a task.
   * @param {import('../../types/index.js').RunGraph} run
   * @param {Object} opts
   * @param {string} [opts.parentId]
   * @param {import('../../types/index.js').Task['kind']} opts.kind
   * @param {string} opts.title
   * @param {number} opts.round
   * @param {string} [opts.toolName]
   * @param {Record<string,any>} [opts.toolArgs]
   * @param {string} [opts.retryOf]
   * @returns {import('../../types/index.js').Task}
   */
  function startTask(run, { parentId, kind, title, round, toolName, toolArgs, retryOf }) {
    const id = `task_${makeId()}`;
    const task = {
      id,
      parentId: parentId || undefined,
      kind,
      title: String(title || ''),
      status: 'running',
      round: Number(round) || 0,
      toolName: toolName || undefined,
      toolArgs: clone(toolArgs),
      startedAt: nowISO(),
      resultObservationIds: [],
      artifactIds: [],
      retryOf: retryOf || undefined
    };
    run.tasks[id] = task;
    run.updatedAt = nowISO();
    emitEvent(run, { type: 'task_started', taskId: id, round, level: 'info', message: `Task started: ${title}`, data: { kind, toolName } });
    persistRuns();
    return task;
  }

  /**
   * Complete a task.
   * @param {import('../../types/index.js').RunGraph} run
   * @param {string} taskId
   * @param {Object} [opts]
   * @param {string[]} [opts.observationIds]
   * @param {string[]} [opts.artifactIds]
   */
  function completeTask(run, taskId, { observationIds, artifactIds } = {}) {
    const task = run.tasks[taskId];
    if (!task) return;
    task.status = 'completed';
    task.endedAt = nowISO();
    if (observationIds) task.resultObservationIds.push(...observationIds);
    if (artifactIds) task.artifactIds.push(...artifactIds);
    run.updatedAt = nowISO();
    emitEvent(run, { type: 'task_completed', taskId, round: task.round, level: 'info', message: `Task completed: ${task.title}` });
    persistRuns();
  }

  /**
   * Fail a task.
   * @param {import('../../types/index.js').RunGraph} run
   * @param {string} taskId
   * @param {string} error
   */
  function failTask(run, taskId, error) {
    const task = run.tasks[taskId];
    if (!task) return;
    task.status = 'failed';
    task.endedAt = nowISO();
    task.error = String(error || '');
    run.errors.push(task.error);
    run.updatedAt = nowISO();
    emitEvent(run, { type: 'task_failed', taskId, round: task.round, level: 'error', message: `Task failed: ${task.title} — ${task.error}` });
    persistRuns();
  }

  /**
   * Retry a task (creates new task linked to original).
   * @param {import('../../types/index.js').RunGraph} run
   * @param {string} taskId
   * @param {number} round
   * @returns {import('../../types/index.js').Task | null}
   */
  function retryTask(run, taskId, round) {
    const old = run.tasks[taskId];
    if (!old) return null;
    old.status = 'retry';
    const next = startTask(run, {
      parentId: old.parentId,
      kind: old.kind,
      title: `Retry: ${old.title}`,
      round,
      toolName: old.toolName,
      toolArgs: old.toolArgs,
      retryOf: old.id
    });
    emitEvent(run, { type: 'task_retry', taskId: next.id, round, level: 'warn', message: `Retrying task ${old.id} as ${next.id}` });
    persistRuns();
    return next;
  }

  /**
   * Add an observation.
   * @param {import('../../types/index.js').RunGraph} run
   * @param {Object} opts
   * @param {string} opts.taskId
   * @param {number} opts.round
   * @param {import('../../types/index.js').Observation['source']} opts.source
   * @param {string} opts.summary
   * @param {string} [opts.content]
   * @param {boolean} [opts.isError]
   * @param {Record<string,any>} [opts.metadata]
   * @returns {import('../../types/index.js').Observation}
   */
  function addObservation(run, { taskId, round, source, summary, content, isError, metadata }) {
    const raw = String(content || summary || '');
    const id = `obs_${makeId()}`;
    const obs = {
      id,
      taskId: String(taskId || ''),
      round: Number(round) || 0,
      source,
      summary: String(summary || '').slice(0, 400),
      content: raw,
      contentHash: hashString(raw),
      promptSafeContent: String(summary || '').slice(0, 2000),
      isError: !!isError,
      createdAt: nowISO(),
      metadata: clone(metadata)
    };
    run.observations.push(obs);
    run.updatedAt = nowISO();
    emitEvent(run, { type: 'observation_added', taskId, round, level: isError ? 'error' : 'info', message: obs.summary, data: { observationId: id, source } });
    persistRuns();
    return obs;
  }

  /**
   * Register an artifact in the graph.
   * @param {import('../../types/index.js').RunGraph} run
   * @param {Object} opts
   * @param {string} [opts.taskId]
   * @param {import('../../types/index.js').ArtifactKind} opts.kind
   * @param {string} opts.name
   * @param {string} opts.mimeType
   * @param {number} opts.size
   * @param {string} opts.source
   * @param {string} [opts.preview]
   * @param {string} [opts.contentRef]
   * @param {string} [opts.downloadName]
   * @param {Record<string,any>} [opts.metadata]
   * @returns {import('../../types/index.js').Artifact}
   */
  function registerArtifact(run, { taskId, kind, name, mimeType, size, source, preview, contentRef, downloadName, metadata }) {
    const id = `art_${makeId()}`;
    const artifact = {
      id,
      taskId: taskId || undefined,
      kind,
      name: String(name || 'artifact'),
      mimeType: String(mimeType || 'application/octet-stream'),
      size: Number(size) || 0,
      source: String(source || ''),
      preview: preview ? String(preview).slice(0, 500) : undefined,
      contentRef: contentRef || undefined,
      downloadName: downloadName || undefined,
      createdAt: nowISO(),
      metadata: clone(metadata)
    };
    run.artifacts.push(artifact);
    if (taskId && run.tasks[taskId]) {
      run.tasks[taskId].artifactIds = run.tasks[taskId].artifactIds || [];
      run.tasks[taskId].artifactIds.push(id);
    }
    run.updatedAt = nowISO();
    emitEvent(run, { type: 'artifact_registered', taskId, level: 'info', message: `Artifact registered: ${artifact.name}`, data: { artifactId: id, kind, size } });
    persistRuns();
    return artifact;
  }

  /**
   * Emit a run event.
   * @param {import('../../types/index.js').RunGraph} run
   * @param {Object} opts
   * @param {import('../../types/index.js').RunEvent['type']} opts.type
   * @param {number} [opts.round]
   * @param {string} [opts.taskId]
   * @param {string} [opts.message]
   * @param {import('../../types/index.js').RunEvent['level']} [opts.level]
   * @param {Record<string,any>} [opts.data]
   * @returns {import('../../types/index.js').RunEvent}
   */
  function emitEvent(run, { type, round, taskId, message, level, data }) {
    const evt = {
      id: `evt_${makeId()}`,
      runId: run.id,
      type,
      timestamp: nowISO(),
      round: round !== undefined ? Number(round) : undefined,
      taskId: taskId || undefined,
      message: message ? String(message).slice(0, 400) : undefined,
      level: level || 'info',
      data: clone(data)
    };
    run.events.push(evt);
    run.updatedAt = nowISO();
    return evt;
  }

  /**
   * Set run terminal status.
   * @param {import('../../types/index.js').RunGraph} run
   * @param {import('../../types/index.js').RunStatus} status
   * @param {string} [finalAnswer]
   */
  function setTerminalStatus(run, status, finalAnswer) {
    run.status = status;
    run.updatedAt = nowISO();
    if (finalAnswer !== undefined) run.finalAnswer = finalAnswer;
    const evtType = /** @type {import('../../types/index.js').RunEvent['type']} */ (
      status === 'completed' ? 'run_completed' :
      status === 'failed' ? 'run_failed' :
      status === 'stopped' ? 'run_stopped' :
      status === 'max_rounds' ? 'run_max_rounds' :
      'run_completed'
    );
    emitEvent(run, { type: evtType, level: status === 'completed' ? 'info' : 'warn', message: `Run ${status}`, data: { rounds: run.rounds } });
    persistRuns();
  }

  /**
   * Get active (most recent non-terminal) run.
   * @returns {import('../../types/index.js').RunGraph | null}
   */
  function getActiveRun() {
    const arr = Array.from(runs.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const active = arr.find(r => r.status === 'running');
    return active || arr[0] || null;
  }

  /**
   * Get a run by id.
   * @param {string} runId
   * @returns {import('../../types/index.js').RunGraph | null}
   */
  function getRun(runId) {
    return runs.get(String(runId || '')) || null;
  }

  /**
   * List runs, newest first.
   * @param {Object} [opts]
   * @param {number} [opts.limit=20]
   * @returns {import('../../types/index.js').RunGraph[]}
   */
  function listRuns({ limit = 20 } = {}) {
    return Array.from(runs.values())
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Number(limit) || 20));
  }

  /**
   * Serialize a run to JSON (with large content optionally stripped).
   * @param {string} runId
   * @param {Object} [opts]
   * @param {boolean} [opts.stripContent=false]
   * @returns {string|null}
   */
  function serializeRun(runId, { stripContent = false } = {}) {
    const run = runs.get(String(runId || ''));
    if (!run) return null;
    const out = clone(run);
    if (stripContent) {
      out.observations = out.observations.map(o => ({ ...o, content: '', promptSafeContent: o.promptSafeContent || '' }));
    }
    return JSON.stringify(out, null, 2);
  }

  /**
   * Build a prompt-safe summary of a run for compaction / planning.
   * @param {string} runId
   * @returns {string}
   */
  function summarizeRunForPrompt(runId) {
    const run = runs.get(String(runId || ''));
    if (!run) return '';
    const tasks = Object.values(run.tasks);
    const lines = [
      `Run ${run.id} | status: ${run.status} | rounds: ${run.rounds}`,
      `Goal: ${run.goal.slice(0, 200)}`,
      `Tasks (${tasks.length}):`,
      ...tasks.map(t => `  [${t.status}] ${t.kind}${t.toolName ? `(${t.toolName})` : ''} — ${t.title.slice(0, 120)}${t.error ? ` | ERROR: ${t.error.slice(0, 120)}` : ''}`),
      `Observations (${Math.min(run.observations.length, 10)} shown):`,
      ...run.observations.slice(-10).map(o => `  [${o.source}] ${o.summary.slice(0, 200)}${o.isError ? ' (ERROR)' : ''}`),
      `Artifacts (${run.artifacts.length}):`,
      ...run.artifacts.map(a => `  ${a.kind}: ${a.name} (${a.mimeType}, ${a.size} bytes)`),
      run.finalAnswer ? `Final answer: ${String(run.finalAnswer).slice(0, 300)}` : ''
    ].filter(Boolean);
    return lines.join('\n');
  }

  // ── Bootstrap ───────────────────────────────────────────────────────────

  loadRuns();

  window.AgentRunGraph = {
    createRun,
    startTask,
    completeTask,
    failTask,
    retryTask,
    addObservation,
    registerArtifact,
    emitEvent,
    setTerminalStatus,
    getActiveRun,
    getRun,
    listRuns,
    serializeRun,
    summarizeRunForPrompt,
    // internal / testing helpers
    __internal__: { runs, persistRuns, loadRuns }
  };
})();
