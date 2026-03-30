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
}

function isLocalModeActive() {
  return localBackend.enabled && !!localBackend.url;
}

function canUseCloud() {
  return !!apiKey;
}

function canUseGemini() {
  return canUseCloud();
}

// -- SYSTEM PROMPT -------------------------------------------------------------
async function buildSystemPrompt(userMessage = '') {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  const available = Object.entries(enabledTools)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

  return orchestrator.buildSystemPrompt({
    userMessage,
    maxRounds: getMaxRounds(),
    ctxLimit: getCtxLimit(),
    enabledTools: available
  });
}

async function buildDirectAnswerRepairPrompt(userMessage) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  return orchestrator.buildRepairPrompt(userMessage);
}

// -- LLM ROUTER: Gemini or Local ----------------------------------------------
