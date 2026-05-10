/**
 * src/app/agent/run-inspector.js
 * Collapsible run inspector UI. Shows current run timeline, tasks, observations, artifacts, events.
 * Publishes window.AgentRunInspector
 */

(() => {
  'use strict';

  const CONTAINER_ID = 'run-inspector-container';
  const PANEL_ID = 'run-inspector-panel';
  const TOGGLE_ID = 'run-inspector-toggle';

  function ensureContainer() {
    let container = document.getElementById(CONTAINER_ID);
    if (container) return container;

    container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.className = 'run-inspector-container';

    const toggle = document.createElement('button');
    toggle.id = TOGGLE_ID;
    toggle.className = 'run-inspector-toggle';
    toggle.textContent = 'Run';
    toggle.title = 'Toggle run inspector';
    toggle.onclick = () => {
      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        const isOpen = panel.classList.toggle('open');
        toggle.textContent = isOpen ? 'Close' : 'Run';
      }
    };

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'run-inspector-panel';

    container.appendChild(toggle);
    container.appendChild(panel);
    document.body.appendChild(container);
    return container;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function statusColor(status) {
    switch (status) {
      case 'running': return 'var(--accent, #4a90d9)';
      case 'completed': return '#2ecc71';
      case 'failed': return '#e74c3c';
      case 'retry': return '#f39c12';
      case 'pending': return '#95a5a6';
      case 'cancelled': return '#7f8c8d';
      default: return 'inherit';
    }
  }

  function renderRun(run) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (!run) {
      panel.innerHTML = '<div style="color:var(--text-secondary);padding:8px;">No active run.</div>';
      return;
    }

    const tasks = Object.values(run.tasks || {});
    const byRound = tasks.reduce((acc, t) => {
      const r = t.round || 0;
      acc[r] = acc[r] || [];
      acc[r].push(t);
      return acc;
    }, /** @type {Record<number, any[]>} */ ({}));

    const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);

    const artifacts = (run.artifacts || []).slice(-20);
    const observations = (run.observations || []).slice(-20);
    const events = (run.events || []).slice(-40);

    let html = '';

    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">`;
    html += `  <strong>Run ${escapeHtml(run.id.slice(-8))}</strong>`;
    html += `  <span style="color:${statusColor(run.status)};font-weight:600;">${escapeHtml(run.status)}</span>`;
    html += `</div>`;

    html += `<div style="color:var(--text-secondary);margin-bottom:6px;">`;
    html += `Rounds: ${run.rounds || 0} · Tasks: ${tasks.length} · Artifacts: ${run.artifacts?.length || 0}`;
    html += `</div>`;

    if (run.errors?.length) {
      html += `<div style="background:#fff0f0;border:1px solid #e74c3c;border-radius:4px;padding:6px;margin-bottom:6px;color:#c0392b;">`;
      html += `<strong>Errors (${run.errors.length}):</strong><br>`;
      html += run.errors.slice(-3).map(e => escapeHtml(e)).join('<br>');
      html += `</div>`;
    }

    // Rounds
    html += `<div style="margin-top:8px;"><strong>Rounds</strong></div>`;
    if (!rounds.length) {
      html += `<div style="color:var(--text-secondary);padding:4px;">No rounds yet.</div>`;
    }
    for (const r of rounds) {
      html += `<div style="margin:4px 0;border-left:2px solid var(--border);padding-left:6px;">`;
      html += `<div style="font-weight:600;color:var(--text-secondary);">Round ${r}</div>`;
      for (const t of byRound[r]) {
        const dur = t.startedAt && t.endedAt
          ? Math.max(0, new Date(t.endedAt).getTime() - new Date(t.startedAt).getTime())
          : null;
        html += `<div style="display:flex;gap:6px;align-items:baseline;margin:2px 0;">`;
        html += `  <span style="width:8px;height:8px;border-radius:50%;background:${statusColor(t.status)};display:inline-block;"></span>`;
        html += `  <span>${escapeHtml(t.toolName || t.kind)}${t.retryOf ? ' (retry)' : ''}</span>`;
        html += `  <span style="color:var(--text-secondary);font-size:10px;">${dur !== null ? dur + 'ms' : ''}</span>`;
        html += `</div>`;
        if (t.error) {
          html += `<div style="color:#e74c3c;font-size:11px;padding-left:14px;">${escapeHtml(t.error)}</div>`;
        }
      }
      html += `</div>`;
    }

    // Artifacts
    if (artifacts.length) {
      html += `<div style="margin-top:8px;"><strong>Artifacts</strong></div>`;
      for (const a of artifacts) {
        html += `<div style="display:flex;gap:6px;align-items:baseline;margin:2px 0;">`;
        html += `  <span style="font-size:10px;background:var(--bg-secondary);padding:1px 4px;border-radius:4px;">${escapeHtml(a.kind)}</span>`;
        html += `  <span>${escapeHtml(a.name)}</span>`;
        html += `  <span style="color:var(--text-secondary);font-size:10px;">${a.size} bytes</span>`;
        html += `</div>`;
      }
    }

    // Observations
    if (observations.length) {
      html += `<div style="margin-top:8px;"><strong>Observations</strong></div>`;
      for (const o of observations) {
        const color = o.isError ? '#e74c3c' : 'var(--text-secondary)';
        html += `<div style="color:${color};font-size:11px;margin:2px 0;padding:2px 4px;background:var(--bg-secondary);border-radius:4px;">`;
        html += `  [${escapeHtml(o.source)}] ${escapeHtml(o.summary)}`;
        html += `</div>`;
      }
    }

    // Recent events
    if (events.length) {
      html += `<div style="margin-top:8px;"><strong>Events</strong></div>`;
      for (const e of events) {
        const color = e.level === 'error' ? '#e74c3c' : e.level === 'warn' ? '#f39c12' : 'var(--text-secondary)';
        html += `<div style="color:${color};font-size:11px;margin:1px 0;">`;
        html += `  ${escapeHtml(e.type)}${e.round !== undefined ? ` (r${e.round})` : ''}: ${escapeHtml(e.message || '')}`;
        html += `</div>`;
      }
    }

    panel.innerHTML = html;
  }

  function update() {
    const run = window.AgentRunGraph ? window.AgentRunGraph.getActiveRun() : null;
    const toggle = document.getElementById(TOGGLE_ID);
    const panel = document.getElementById(PANEL_ID);
    if (!toggle || !panel) {
      ensureContainer();
      return;
    }
    // Auto-expand on errors if collapsed
    if (run?.errors?.length && !panel.classList.contains('open')) {
      panel.classList.add('open');
      toggle.textContent = 'Close';
    }
    renderRun(run);
  }

  // Poll for updates while a run is active
  let pollInterval = null;
  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(() => {
      const run = window.AgentRunGraph ? window.AgentRunGraph.getActiveRun() : null;
      if (run && run.status === 'running') {
        update();
      } else if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }, 800);
  }

  // Hook into agent.js start/stop via observing status changes
  const origSetStatus = window.setStatus;
  if (typeof origSetStatus === 'function') {
    window.setStatus = function(...args) {
      const result = origSetStatus.apply(this, args);
      const run = window.AgentRunGraph ? window.AgentRunGraph.getActiveRun() : null;
      if (run && run.status === 'running') startPolling();
      return result;
    };
  }

  window.AgentRunInspector = {
    ensureContainer,
    renderRun,
    update,
    startPolling
  };

  // Initialize on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { ensureContainer(); update(); });
  } else {
    ensureContainer();
    update();
  }
})();
