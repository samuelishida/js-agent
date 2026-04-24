function renderToolGroups() {
  const host = document.getElementById('tool-groups');
  if (!host) return;

  const groups = Object.values(window.AgentSkillGroups || {});
  host.innerHTML = groups.map(group => `
    <div class="tool-group">
      <div class="tool-group-label">${escHtml(group.label)}</div>
      <div class="tool-list">
        ${group.tools.map(tool => `
          <div class="tool-toggle ${enabledTools[tool.name] ? 'active' : ''}" id="tool-${tool.name}" onclick="toggleTool('${tool.name}')">
            <span class="tool-name">${escHtml(tool.signature)}</span>
            <span class="tool-dot"></span>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

function toggleTool(name) {
  enabledTools[name] = !enabledTools[name];
  document.getElementById(`tool-${name}`)?.classList.toggle('active', enabledTools[name]);
  try {
    localStorage.setItem('agent_enabled_tools', JSON.stringify(enabledTools));
  } catch { /* quota / private browsing — ignore */ }
}

function loadPersistedEnabledTools() {
  try {
    const stored = JSON.parse(localStorage.getItem('agent_enabled_tools') || 'null');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const key of Object.keys(enabledTools)) {
        if (Object.prototype.hasOwnProperty.call(stored, key)) {
          enabledTools[key] = !!stored[key];
        }
      }
    }
  } catch { /* private browsing / quota — ignore */ }
}

// -- LLM ROUTER: Gemini or Local ----------------------------------------------
