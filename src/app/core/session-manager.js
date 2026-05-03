// src/app/core/session-manager.js
// Session CRUD: create, read, update, delete, activate, persist.
// Reads/writes window.chatSessions and window.activeSessionId (set up by state.js).

/** @typedef {import('../../types/index.js').SessionMessage} SessionMessage */

/** @type {string} */
const CHAT_SESSIONS_KEY = 'agent_chat_sessions_v1';
/** @type {string} */
const ACTIVE_SESSION_KEY = 'agent_active_session_v1';
/** @type {number} */
const SESSION_SCHEMA_VERSION = 2;

/**
 * Normalize session stats.
 * @param {any} value - Raw stats
 * @returns {{rounds: number, tools: number, resets: number, msgs: number}} Normalized stats
 */
function normalizeSessionStats(value) {
  return {
    rounds: Number(value?.rounds || 0),
    tools: Number(value?.tools || 0),
    resets: Number(value?.resets || 0),
    msgs: Number(value?.msgs || 0)
  };
}

/**
 * Load sessions from localStorage.
 * @returns {Array<{id: string, title: string, createdAt: string, updatedAt: string, messages: SessionMessage[], stats: Object, context: Object}>} Sessions
 */
function loadSessions() {
  const normalizeStats = stats => ({
    rounds: Number(stats?.rounds || 0),
    tools: Number(stats?.tools || 0),
    resets: Number(stats?.resets || 0),
    msgs: Number(stats?.msgs || 0)
  });

  const normalizeSession = (session, index = 0) => {
    const fallbackId = `session_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      id: String(session?.id || fallbackId),
      title: makeSessionTitle(session?.title || 'New session'),
      createdAt: String(session?.createdAt || new Date().toISOString()),
      updatedAt: String(session?.updatedAt || session?.createdAt || new Date().toISOString()),
      messages: Array.isArray(session?.messages) ? session.messages : [],
      stats: normalizeStats(session?.stats),
      context: {
        compactions: Number(session?.context?.compactions || 0),
        lastCompactedAt: session?.context?.lastCompactedAt || null,
        permissionMode: String(session?.context?.permissionMode || 'default'),
        permissionDenialsCount: Number(session?.context?.permissionDenialsCount || 0),
        lastPermissionDeniedAt: session?.context?.lastPermissionDeniedAt || null,
        queryTracking: session?.context?.queryTracking && typeof session.context.queryTracking === 'object'
          ? session.context.queryTracking
          : null
      }
    };
  };

  try {
    const stored = JSON.parse(localStorage.getItem(CHAT_SESSIONS_KEY) || '[]');
    if (Array.isArray(stored)) return stored.map((session, index) => normalizeSession(session, index));
    if (stored && typeof stored === 'object' && Array.isArray(stored.sessions)) {
      return stored.sessions.map((session, index) => normalizeSession(session, index));
    }
    return [];
  } catch { return []; }
}

/**
 * Save sessions to localStorage.
 * @returns {void}
 */
function saveSessions() {
  const payload = JSON.stringify({ version: SESSION_SCHEMA_VERSION, sessions: window.chatSessions || [] });
  try {
    localStorage.setItem(CHAT_SESSIONS_KEY, payload);
  } catch {
    try {
      const slim = (window.chatSessions || []).map(s => ({
        ...s,
        messages: s.messages.slice(-5).map(m => ({ role: m.role, content: String(m.content||'').slice(0, 200) }))
      }));
      localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify({ version: SESSION_SCHEMA_VERSION, sessions: slim }));
    } catch {
      console.warn('[Sessions] Could not persist sessions (storage quota exceeded or blocked).');
    }
  }
}

/**
 * Make a session title from source text.
 * @param {string} [sourceText='New session'] - Source text
 * @returns {string} Session title
 */
function makeSessionTitle(sourceText = 'New session') {
  return String(sourceText || 'New session').trim().slice(0, 48) || 'New session';
}

/**
 * Create a new session.
 * @param {string} [initialTitle='New session'] - Initial title
 * @returns {{id: string, title: string, createdAt: string, updatedAt: string, messages: SessionMessage[], stats: Object, context: Object}} New session
 */
function createSession(initialTitle = 'New session') {
  const session = {
    id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: makeSessionTitle(initialTitle),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    stats: { rounds: 0, tools: 0, resets: 0, msgs: 0 },
    context: {
      compactions: 0,
      lastCompactedAt: null,
      permissionMode: 'default',
      permissionDenialsCount: 0,
      lastPermissionDeniedAt: null,
      queryTracking: null
    }
  };
  window.chatSessions = [session, ...(window.chatSessions || [])];
  window.activeSessionId = session.id;
  localStorage.setItem(ACTIVE_SESSION_KEY, session.id);
  saveSessions();
  return session;
}

/**
 * Reset live session state.
 * @returns {void}
 */
function resetLiveSessionState() {
  window.messages = [];
  window.sessionStats = { rounds: 0, tools: 0, resets: 0, msgs: 0 };
}

/**
 * Clear current session and create new.
 * @returns {void}
 */
function clearSession() {
  createSession();
  resetLiveSessionState();
  if (typeof updateStats === 'function') updateStats();
  if (typeof updateCtxBar === 'function') updateCtxBar();
  if (typeof renderChatFromMessages === 'function') renderChatFromMessages();
  if (typeof renderSessionList === 'function') renderSessionList();
  if (typeof setStatus === 'function') setStatus('ok', 'idle');
}

/**
 * Get the active session.
 * @returns {{id: string, title: string, createdAt: string, updatedAt: string, messages: SessionMessage[], stats: Object, context: Object}|null} Active session
 */
function getActiveSession() {
  return (window.chatSessions || []).find(session => session.id === window.activeSessionId) || null;
}

let _saveSessionsTimer = null;

/**
 * Schedule a debounced save of sessions.
 * @returns {void}
 */
function scheduleSaveSessions() {
  if (_saveSessionsTimer) clearTimeout(_saveSessionsTimer);
  _saveSessionsTimer = setTimeout(() => {
    _saveSessionsTimer = null;
    saveSessions();
  }, 2000);
}

/**
 * Flush pending session save immediately.
 * @returns {void}
 */
function flushSaveSessions() {
  if (_saveSessionsTimer) {
    clearTimeout(_saveSessionsTimer);
    _saveSessionsTimer = null;
    saveSessions();
  }
}

/**
 * Sync session state with active session.
 * @returns {void}
 */
function syncSessionState() {
  let session = getActiveSession();
  if (!session) session = createSession();
  session.updatedAt = new Date().toISOString();
  session.messages = window.messages;
  session.stats = window.sessionStats;
  scheduleSaveSessions();
  if (typeof renderSessionList === 'function') renderSessionList();
}

/**
 * Activate a session by ID.
 * @param {string} sessionId - Session ID
 * @returns {void}
 */
function activateSession(sessionId) {
  const session = (window.chatSessions || []).find(item => item.id === sessionId);
  if (!session) return;
  window.activeSessionId = session.id;
  localStorage.setItem(ACTIVE_SESSION_KEY, session.id);
  window.messages = Array.isArray(session.messages) ? session.messages : [];
  window.sessionStats = session.stats || { rounds: 0, tools: 0, resets: 0, msgs: 0 };
  if (typeof renderSessionList === 'function') renderSessionList();
  if (typeof renderChatFromMessages === 'function') renderChatFromMessages();
  if (typeof updateStats === 'function') updateStats();
  if (typeof updateCtxBar === 'function') updateCtxBar();
  if (typeof setStatus === 'function') setStatus('ok', 'session loaded');
}

/**
 * Delete a session by ID.
 * @param {string} sessionId - Session ID
 * @returns {void}
 */
function deleteSession(sessionId) {
  const nextSessions = (window.chatSessions || []).filter(session => session.id !== sessionId);
  if (nextSessions.length === (window.chatSessions || []).length) return;
  window.chatSessions = nextSessions;

  if (!window.chatSessions.length) {
    const created = createSession();
    resetLiveSessionState();
    window.activeSessionId = created.id;
  } else if (window.activeSessionId === sessionId) {
    window.activeSessionId = window.chatSessions[0].id;
    localStorage.setItem(ACTIVE_SESSION_KEY, window.activeSessionId);
    saveSessions();
    activateSession(window.activeSessionId);
    if (typeof updateStats === 'function') updateStats();
    if (typeof updateCtxBar === 'function') updateCtxBar();
    if (typeof setStatus === 'function') setStatus('ok', 'session deleted');
    return;
  }

  localStorage.setItem(ACTIVE_SESSION_KEY, window.activeSessionId);
  saveSessions();
  if (typeof renderSessionList === 'function') renderSessionList();
  if (typeof renderChatFromMessages === 'function') renderChatFromMessages();
  if (typeof updateStats === 'function') updateStats();
  if (typeof updateCtxBar === 'function') updateCtxBar();
  if (typeof setStatus === 'function') setStatus('ok', 'session deleted');
}

/**
 * Delete all sessions.
 * @returns {void}
 */
function deleteAllSessions() {
  window.chatSessions = [];
  localStorage.removeItem(CHAT_SESSIONS_KEY);
  const created = createSession();
  resetLiveSessionState();
  window.activeSessionId = created.id;
  localStorage.setItem(ACTIVE_SESSION_KEY, created.id);
  if (typeof renderSessionList === 'function') renderSessionList();
  if (typeof renderChatFromMessages === 'function') renderChatFromMessages();
  if (typeof updateStats === 'function') updateStats();
  if (typeof updateCtxBar === 'function') updateCtxBar();
  if (typeof setStatus === 'function') setStatus('ok', 'all sessions deleted');
}

window.AgentSessionManager = {
  loadSessions,
  saveSessions,
  makeSessionTitle,
  createSession,
  resetLiveSessionState,
  clearSession,
  getActiveSession,
  scheduleSaveSessions,
  flushSaveSessions,
  syncSessionState,
  activateSession,
  deleteSession,
  deleteAllSessions
};
