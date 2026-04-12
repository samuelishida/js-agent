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

function isLocalModeActive() {
  return localBackend.enabled && !!localBackend.url;
}

function getSelectedCloudProvider() {
  const raw = String(document.getElementById('model-select')?.value || '').trim().toLowerCase();
  if (!raw) return 'gemini';
  const match = raw.match(/^([a-z0-9_-]+)\//i);
  return match ? String(match[1] || 'gemini').toLowerCase() : 'gemini';
}

function getCloudReadiness() {
  const provider = getSelectedCloudProvider();

  if (provider === 'ollama') {
    const endpoint = String(localStorage.getItem('agent_ollama_cloud_endpoint') || '').trim();
    // Ollama can run keyless when endpoint is same-origin proxy or left empty (auto proxy first).
    if (apiKey || !endpoint || endpoint.startsWith('/')) {
      return { ready: true, reason: '' };
    }

    return {
      ready: false,
      reason: 'Ollama Cloud direct endpoints require an API key. Set API key, or use a same-origin proxy endpoint like /api/ollama/v1.'
    };
  }

  if (provider === 'azure') {
    if (!apiKey) {
      return { ready: false, reason: 'Azure OpenAI requires an API key. Enter your key and click Save.' };
    }

    const endpoint = String(localStorage.getItem('agent_azure_openai_endpoint') || '').trim();
    const deployment = String(localStorage.getItem('agent_azure_openai_deployment') || '').trim();
    if (!endpoint || !deployment) {
      return {
        ready: false,
        reason: 'Azure OpenAI configuration missing. Set localStorage keys: agent_azure_openai_endpoint and agent_azure_openai_deployment.'
      };
    }

    return { ready: true, reason: '' };
  }

  if (!apiKey) {
    const providerLabel = provider === 'openai' ? 'OpenAI' : provider === 'clawd' ? 'Clawd' : 'Cloud';
    return { ready: false, reason: `${providerLabel} requires an API key. Enter your key and click Save.` };
  }

  return { ready: true, reason: '' };
}

function canUseCloud() {
  return getCloudReadiness().ready;
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

async function buildDirectAnswerRepairPrompt(userMessageOrOptions, extraOptions = {}) {
  assertRuntimeReady();
  const { orchestrator } = getRuntimeModules();
  const options = (typeof userMessageOrOptions === 'object' && userMessageOrOptions !== null)
    ? userMessageOrOptions
    : { userMessage: userMessageOrOptions, ...extraOptions };
  return orchestrator.buildRepairPrompt(options);
}

// -- LLM ROUTER: Gemini or Local ----------------------------------------------
