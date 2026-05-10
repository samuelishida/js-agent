// src/app/ui/settings-mcp.js
// MCP Server settings UI

(function () {
  'use strict';

  const store = window.AgentMcpStore;
  const manager = window.AgentMcpManager;

  let unsubscribe = null;

  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getStatusColor(state) {
    switch (state) {
      case 'connected': return 'var(--green)';
      case 'connecting': return 'var(--amber)';
      case 'error': return 'var(--red)';
      case 'disconnected':
      case 'idle':
      default: return 'var(--text-tertiary)';
    }
  }

  function getStatusLabel(state) {
    switch (state) {
      case 'connected': return 'Connected';
      case 'connecting': return 'Connecting';
      case 'error': return 'Error';
      case 'disconnected': return 'Disconnected';
      case 'idle': return 'Idle';
      default: return state ? escHtml(state) : 'Idle';
    }
  }

  function formatDate(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      return d.toLocaleString();
    } catch (e) {
      return String(ts);
    }
  }

  function renderMcpSettings() {
    renderMcpServerCards();
    if (!unsubscribe && manager && manager.subscribe) {
      unsubscribe = manager.subscribe(() => {
        renderMcpServerCards();
      });
    }
  }

  function renderMcpServerCards() {
    const container = document.getElementById('mcp-server-list');
    if (!container) return;
    const servers = store ? store.loadServers() : [];
    if (!servers.length) {
      container.innerHTML = '<p class="settings-hint">No MCP servers configured.</p>';
      return;
    }
    container.innerHTML = servers.map((server) => {
      const status = manager ? manager.getStatus(server.id) : undefined;
      const state = status ? status.state : 'idle';
      const statusColor = getStatusColor(state);
      const statusLabel = getStatusLabel(state);
      const lastError = status && status.lastError ? escHtml(status.lastError) : '';
      const latency = status && status.latencyMs ? String(status.latencyMs) + 'ms' : '';
      const lastRefresh = status && status.lastRefreshAt ? formatDate(status.lastRefreshAt) : '';
      const tools = status?.tools || [];
      const caps = new Set();
      if (window.AgentMcpBridge?.classifyMcpToolCapability) {
        for (const t of tools) {
          const tags = window.AgentMcpBridge.classifyMcpToolCapability(t);
          for (const tag of tags) caps.add(tag);
        }
      }
      const capList = Array.from(caps).slice(0, 6).join(', ') || 'no tools loaded';

      return (
        '<div class="mcp-server-card" data-server-id="' + escHtml(server.id) + '">' +
          '<div class="mcp-server-header">' +
            '<span class="mcp-server-name">' + escHtml(server.name || server.id) + '</span>' +
            '<span class="mcp-badge-transport">' + escHtml(server.transport || 'http') + '</span>' +
            '<span class="mcp-badge-status" style="background:' + statusColor + ';color:#0f0f0f">' + statusLabel + '</span>' +
          '</div>' +
          (server.url ? '<div class="settings-hint">URL: ' + escHtml(server.url) + '</div>' : '') +
          (server.command ? '<div class="settings-hint">Cmd: ' + escHtml(server.command) + ' ' + escHtml((server.args || []).join(' ')) + '</div>' : '') +
          '<div class="settings-hint">Capabilities: ' + escHtml(capList) + '</div>' +
          (latency ? '<div class="settings-hint">Latency: ' + latency + '</div>' : '') +
          (lastRefresh ? '<div class="settings-hint">Last refresh: ' + lastRefresh + '</div>' : '') +
          (lastError ? '<div class="mcp-error-text">' + lastError + '</div>' : '') +
          '<div class="mcp-server-actions">' +
            '<label class="settings-checkbox" style="margin:0">' +
              '<input type="checkbox" ' + (server.enabled ? 'checked' : '') + ' onchange="onToggleEnabled(\'' + escHtml(server.id) + '\')" />' +
              '<span>Enabled</span>' +
            '</label>' +
            '<button class="btn-primary btn-sm" onclick="renderMcpToolsDrawer(\'' + escHtml(server.id) + '\')">Tools</button>' +
            '<button class="btn-primary btn-sm" onclick="renderMcpResourcesDrawer(\'' + escHtml(server.id) + '\')">Resources</button>' +
            '<button class="btn-primary btn-sm" onclick="renderMcpPromptsDrawer(\'' + escHtml(server.id) + '\')">Prompts</button>' +
            '<button class="btn-primary btn-sm" onclick="onTestConnection(\'' + escHtml(server.id) + '\')">Test</button>' +
            '<button class="btn-primary btn-sm" onclick="onRefreshServer(\'' + escHtml(server.id) + '\')">Refresh</button>' +
            '<button class="btn-secondary btn-sm" onclick="onRemoveServer(\'' + escHtml(server.id) + '\')">Remove</button>' +
          '</div>' +
          '<div id="mcp-test-result-' + escHtml(server.id) + '" class="settings-hint" style="margin-top:4px"></div>' +
          '<div id="mcp-tools-drawer-' + escHtml(server.id) + '" style="display:none;margin-top:8px;border:1px solid var(--border-default);padding:8px;border-radius:6px"></div>' +
          '<div id="mcp-resources-drawer-' + escHtml(server.id) + '" style="display:none;margin-top:8px;border:1px solid var(--border-default);padding:8px;border-radius:6px"></div>' +
          '<div id="mcp-prompts-drawer-' + escHtml(server.id) + '" style="display:none;margin-top:8px;border:1px solid var(--border-default);padding:8px;border-radius:6px"></div>' +
        '</div>'
      );
    }).join('');
  }

  function toggleTransportFields() {
    const transport = document.getElementById('mcp-add-transport') ? document.getElementById('mcp-add-transport').value : 'http';
    const urlGroup = document.getElementById('mcp-add-url-group');
    const cmdGroup = document.getElementById('mcp-add-cmd-group');
    const argsGroup = document.getElementById('mcp-add-args-group');
    if (urlGroup) urlGroup.style.display = (transport === 'http' || transport === 'sse') ? '' : 'none';
    if (cmdGroup) cmdGroup.style.display = transport === 'stdio' ? '' : 'none';
    if (argsGroup) argsGroup.style.display = transport === 'stdio' ? '' : 'none';
  }

  function toggleMcpAddForm() {
    const form = document.getElementById('mcp-add-server-form');
    const btn = document.getElementById('mcp-show-add-btn');
    if (!form) return;
    const showing = form.style.display !== 'none';
    form.style.display = showing ? 'none' : 'block';
    if (btn) btn.textContent = showing ? 'Add Server' : 'Hide Form';
    if (!showing) toggleTransportFields();
  }

  function validateAddForm() {
    const nameEl = document.getElementById('mcp-add-name');
    const transportEl = document.getElementById('mcp-add-transport');
    const urlEl = document.getElementById('mcp-add-url');
    const commandEl = document.getElementById('mcp-add-command');
    const errorEl = document.getElementById('mcp-add-error');
    if (!errorEl) return false;

    const name = nameEl ? nameEl.value.trim() : '';
    const transport = transportEl ? transportEl.value : 'http';
    const url = urlEl ? urlEl.value.trim() : '';
    const command = commandEl ? commandEl.value.trim() : '';

    if (!name) {
      errorEl.textContent = 'Name is required.';
      return false;
    }

    if (transport === 'http' || transport === 'sse') {
      if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
        errorEl.textContent = 'URL must start with http:// or https://.';
        return false;
      }
      if (transport === 'http' && /\/sse\/?$/i.test(url)) {
        errorEl.textContent = 'URL ends with /sse — select SSE transport instead of HTTP.';
        return false;
      }
    }

    if (transport === 'stdio') {
      const badChars = /[;|&$`"<>(){}[\]*?]/;
      if (badChars.test(command)) {
        errorEl.textContent = 'Command contains disallowed shell metacharacters.';
        return false;
      }
    }

    errorEl.textContent = '';
    return true;
  }

  function parseArgs(raw) {
    if (!raw) return [];
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.indexOf(',') !== -1) {
      return trimmed.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return trimmed.split(/\s+/).filter(Boolean);
  }

  function onUrlBlur() {
    const urlEl = document.getElementById('mcp-add-url');
    const transportEl = document.getElementById('mcp-add-transport');
    if (!urlEl || !transportEl) return;
    const url = urlEl.value.trim();
    if (/\/sse\/?$/i.test(url) && transportEl.value === 'http') {
      transportEl.value = 'sse';
      toggleTransportFields();
    }
  }

  function onAddServerSubmit(event) {
    event.preventDefault();
    if (!store) return;
    if (!validateAddForm()) return;

    const name = document.getElementById('mcp-add-name').value.trim();
    const transport = document.getElementById('mcp-add-transport').value || 'http';
    const enabled = !!(document.getElementById('mcp-add-enabled') && document.getElementById('mcp-add-enabled').checked);

    const cfg = {
      name: name,
      transport: transport,
      enabled: enabled
    };

    if (transport === 'http' || transport === 'sse') {
      cfg.url = document.getElementById('mcp-add-url').value.trim() || undefined;
    } else {
      cfg.command = document.getElementById('mcp-add-command').value.trim() || undefined;
      cfg.args = parseArgs(document.getElementById('mcp-add-args').value);
    }

    try {
      const result = store.addServer(cfg);
      if (result && result.id) {
        document.getElementById('mcp-add-name').value = '';
        document.getElementById('mcp-add-url').value = '';
        document.getElementById('mcp-add-command').value = '';
        document.getElementById('mcp-add-args').value = '';
        document.getElementById('mcp-add-error').textContent = '';
        toggleMcpAddForm();
        renderMcpServerCards();
        if (enabled && manager && manager.connect) {
          manager.connect(result.id).catch(function () {});
        }
      } else {
        document.getElementById('mcp-add-error').textContent = 'Failed to add server.';
      }
    } catch (e) {
      document.getElementById('mcp-add-error').textContent = (e && e.message) ? e.message : 'Error adding server.';
    }
  }

  function onRemoveServer(id) {
    if (!confirm('Remove this MCP server?')) return;
    if (manager && manager.disconnect) {
      manager.disconnect(id);
    }
    if (store) {
      store.removeServer(id);
    }
    renderMcpServerCards();
  }

  function onToggleEnabled(id) {
    if (!store || !manager) return;
    const servers = store.loadServers();
    let server = null;
    for (let i = 0; i < servers.length; i++) {
      if (servers[i].id === id) {
        server = servers[i];
        break;
      }
    }
    if (!server) return;
    const next = !server.enabled;
    store.setEnabled(id, next);
    if (next) {
      manager.connect(id).catch(function () {});
    } else {
      manager.disconnect(id);
    }
    renderMcpServerCards();
  }

  function onTestConnection(id) {
    const resultEl = document.getElementById('mcp-test-result-' + id);
    if (resultEl) resultEl.textContent = 'Testing...';
    if (!manager || !manager.connect) return;
    manager.connect(id)
      .then(function () {
        if (resultEl) resultEl.textContent = 'Connection OK';
        renderMcpServerCards();
      })
      .catch(function (err) {
        var msg = (err && err.message) ? err.message : String(err);
        if (resultEl) resultEl.textContent = 'Connection failed: ' + msg;
        renderMcpServerCards();
      });
  }

  function onRefreshServer(id) {
    if (!manager || !manager.reloadServer) return;
    manager.reloadServer(id).catch(function () {});
    renderMcpServerCards();
  }

  function renderMcpToolsDrawer(serverId) {
    const drawer = document.getElementById('mcp-tools-drawer-' + serverId);
    if (!drawer) return;
    const isOpen = drawer.style.display !== 'none';
    drawer.style.display = isOpen ? 'none' : 'block';
    if (isOpen) return;

    if (!manager) {
      drawer.innerHTML = '<div class="settings-hint">Manager not available.</div>';
      return;
    }

    manager.listTools(serverId).then(function (tools) {
      const config = store.loadServers().find(function (s) { return s.id === serverId; });
      const filter = config?.toolFilter || { mode: 'all' };
      const riskFn = manager._mapRisk || function () { return 'shared'; };
      const allowSet = new Set((filter.mode === 'include' && filter.names) ? filter.names.map(String) : []);

      drawer.innerHTML = tools.map(function (tool) {
        const risk = riskFn(tool);
        const riskColor = risk === 'safe' ? 'var(--green)' : risk === 'irreversible' ? 'var(--red)' : 'var(--amber)';
        const isAllowed = filter.mode === 'all' || (filter.mode === 'include' && allowSet.has(tool.name));
        return (
          '<div class="mcp-tool-row" style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-default)">' +
            '<input type="checkbox" ' + (isAllowed ? 'checked' : '') + ' onchange="onToggleTool(\'' + serverId + '\', \'' + escHtml(tool.name) + '\')" />' +
            '<span style="font-weight:500">' + escHtml(tool.name) + '</span>' +
            '<span style="font-size:11px;color:var(--text-secondary)">' + escHtml((tool.description || '').slice(0, 80)) + '</span>' +
            '<span style="margin-left:auto;font-size:10px;padding:1px 4px;border-radius:3px;background:' + riskColor + ';color:#0f0f0f">' + risk + '</span>' +
          '</div>'
        );
      }).join('') || '<div class="settings-hint">No tools available.</div>';

      drawer.innerHTML += (
        '<div style="display:flex;gap:8px;margin-top:8px">' +
          '<button class="btn-primary btn-sm" onclick="onEnableAllTools(\'' + serverId + '\')">Enable All</button>' +
          '<button class="btn-secondary btn-sm" onclick="onDisableAllTools(\'' + serverId + '\')">Disable All</button>' +
        '</div>'
      );
    }).catch(function (err) {
      drawer.innerHTML = '<div class="mcp-error-text">Failed to load tools: ' + escHtml(err?.message || err) + '</div>';
    });
  }

  function onToggleTool(serverId, toolName) {
    const config = store.loadServers().find(function (s) { return s.id === serverId; });
    const filter = config?.toolFilter || { mode: 'include', names: [] };
    const names = new Set(filter.names || []);
    if (names.has(toolName)) {
      names.delete(toolName);
    } else {
      names.add(toolName);
    }
    manager.setToolFilter(serverId, { mode: 'include', names: Array.from(names) });
    window.AgentMcpBridge?.unregisterMcpTools?.(serverId);
    window.AgentMcpBridge?.discoverAndRegisterMcpTools?.().catch(function () {});
    renderMcpServerCards();
  }

  function onEnableAllTools(serverId) {
    manager.setToolFilter(serverId, { mode: 'all' });
    window.AgentMcpBridge?.unregisterMcpTools?.(serverId);
    window.AgentMcpBridge?.discoverAndRegisterMcpTools?.().catch(function () {});
    renderMcpServerCards();
  }

  function onDisableAllTools(serverId) {
    manager.setToolFilter(serverId, { mode: 'none' });
    window.AgentMcpBridge?.unregisterMcpTools?.(serverId);
    window.AgentMcpBridge?.discoverAndRegisterMcpTools?.().catch(function () {});
    renderMcpServerCards();
  }

  function renderMcpResourcesDrawer(serverId) {
    const drawer = document.getElementById('mcp-resources-drawer-' + serverId);
    if (!drawer) return;
    const isOpen = drawer.style.display !== 'none';
    drawer.style.display = isOpen ? 'none' : 'block';
    if (isOpen) return;
    if (!manager?.listResources) {
      drawer.innerHTML = '<div class="settings-hint">Not available.</div>';
      return;
    }
    manager.listResources(serverId).then(function (resources) {
      drawer.innerHTML = resources.map(function (r) {
        return (
          '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-default)">' +
            '<span style="font-weight:500">' + escHtml(r.name || r.uri) + '</span>' +
            '<span style="font-size:11px;color:var(--text-secondary)">' + escHtml(r.uri) + '</span>' +
            '<button class="btn-primary btn-sm" style="margin-left:auto" onclick="onTestResource(\'' + serverId + '\', \'' + escHtml(r.uri) + '\')">Test</button>' +
          '</div>'
        );
      }).join('') || '<div class="settings-hint">No resources.</div>';
    }).catch(function (err) {
      drawer.innerHTML = '<div class="mcp-error-text">Failed to load resources: ' + escHtml(err?.message || err) + '</div>';
    });
  }

  function onTestResource(serverId, uri) {
    if (!manager?.readResource) return;
    const resultEl = document.getElementById('mcp-test-result-' + serverId);
    if (resultEl) resultEl.textContent = 'Reading resource...';
    manager.readResource(serverId, uri).then(function (res) {
      const text = (res?.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n') || JSON.stringify(res);
      if (resultEl) resultEl.textContent = text.slice(0, 400) + (text.length > 400 ? '...' : '');
    }).catch(function (err) {
      if (resultEl) resultEl.textContent = 'Resource error: ' + escHtml(err?.message || err);
    });
  }

  function renderMcpPromptsDrawer(serverId) {
    const drawer = document.getElementById('mcp-prompts-drawer-' + serverId);
    if (!drawer) return;
    const isOpen = drawer.style.display !== 'none';
    drawer.style.display = isOpen ? 'none' : 'block';
    if (isOpen) return;
    if (!manager?.listPrompts) {
      drawer.innerHTML = '<div class="settings-hint">Not available.</div>';
      return;
    }
    manager.listPrompts(serverId).then(function (prompts) {
      drawer.innerHTML = prompts.map(function (p) {
        return (
          '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-default)">' +
            '<span style="font-weight:500">' + escHtml(p.name) + '</span>' +
            '<span style="font-size:11px;color:var(--text-secondary)">' + escHtml((p.description || '').slice(0, 60)) + '</span>' +
            '<button class="btn-primary btn-sm" style="margin-left:auto" onclick="onTestPrompt(\'' + serverId + '\', \'' + escHtml(p.name) + '\')">Test</button>' +
          '</div>'
        );
      }).join('') || '<div class="settings-hint">No prompts.</div>';
    }).catch(function (err) {
      drawer.innerHTML = '<div class="mcp-error-text">Failed to load prompts: ' + escHtml(err?.message || err) + '</div>';
    });
  }

  function onTestPrompt(serverId, name) {
    if (!manager?.getPrompt) return;
    const resultEl = document.getElementById('mcp-test-result-' + serverId);
    if (resultEl) resultEl.textContent = 'Fetching prompt...';
    manager.getPrompt(serverId, name).then(function (res) {
      const text = (res?.messages || []).map(function (m) { return (m.role || '') + ': ' + (m.content?.text || m.content || ''); }).join('\n') || JSON.stringify(res);
      if (resultEl) resultEl.textContent = text.slice(0, 400) + (text.length > 400 ? '...' : '');
    }).catch(function (err) {
      if (resultEl) resultEl.textContent = 'Prompt error: ' + escHtml(err?.message || err);
    });
  }

  // Global exposure
  window.renderMcpSettings = renderMcpSettings;
  window.renderMcpServerCards = renderMcpServerCards;
  window.onAddServerSubmit = onAddServerSubmit;
  window.onRemoveServer = onRemoveServer;
  window.onToggleEnabled = onToggleEnabled;
  window.onTestConnection = onTestConnection;
  window.onRefreshServer = onRefreshServer;
  window.toggleTransportFields = toggleTransportFields;
  window.toggleMcpAddForm = toggleMcpAddForm;
  window.renderMcpToolsDrawer = renderMcpToolsDrawer;
  window.onToggleTool = onToggleTool;
  window.onEnableAllTools = onEnableAllTools;
  window.onDisableAllTools = onDisableAllTools;
  window.renderMcpResourcesDrawer = renderMcpResourcesDrawer;
  window.onTestResource = onTestResource;
  window.renderMcpPromptsDrawer = renderMcpPromptsDrawer;
  window.onTestPrompt = onTestPrompt;
  window.onUrlBlur = onUrlBlur;

  // Auto-render when settings modal opens
  const mcpSettingsObserver = new MutationObserver(function (mutations) {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (m.type === 'attributes' && m.attributeName === 'style') {
        const modal = document.getElementById('settings-modal');
        if (modal && modal.style.display !== 'none') {
          renderMcpSettings();
        }
      }
    }
  });
  document.addEventListener('DOMContentLoaded', function () {
    const modal = document.getElementById('settings-modal');
    if (modal) mcpSettingsObserver.observe(modal, { attributes: true });
  });
})();
