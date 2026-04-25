// src/skills/skill-broadcast.js
// BroadcastChannel, cross-tab sync, notifications.
// Publishes: window.AgentSkillBroadcast

(() => {
  'use strict';

  const AGENT_CHANNEL = 'loopagent-v1';
  let broadcastChannel = null;
  const broadcastListeners = new Map();
  const activeTabListeners = new Set();

  const instanceId = (() => {
    const key = '_agent_instance_id_session';
    try {
      const stored = sessionStorage.getItem(key);
      if (stored) return stored;
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(key, id);
      return id;
    } catch { return Math.random().toString(36).slice(2); }
  })();

  function formatToolResult(title, body) {
    return `## ${title}\n\n${body}`.trim();
  }

  function supportsTabMessaging() {
    return 'BroadcastChannel' in window;
  }

  function getBroadcastChannel() {
    if (!supportsTabMessaging()) {
      throw new Error('BroadcastChannel is not supported in this browser.');
    }
    if (!broadcastChannel) {
      broadcastChannel = new BroadcastChannel(AGENT_CHANNEL);
      broadcastChannel.onmessage = event => {
        const { topic, payload, from } = event.data || {};
        if (!topic || from === instanceId) return;
        const callbacks = broadcastListeners.get(String(topic)) || new Set();
        callbacks.forEach(callback => callback(payload, String(topic)));
      };
    }
    return broadcastChannel;
  }

  let notificationPermissionState = ('Notification' in window && window.Notification?.permission) || 'unsupported';

  function notificationsSupported() {
    return 'Notification' in window;
  }

  async function ensureNotificationPermission() {
    if (!notificationsSupported()) {
      throw new Error('Notifications are not supported in this browser.');
    }
    notificationPermissionState = window.Notification.permission;
    if (notificationPermissionState === 'granted') return true;
    if (notificationPermissionState === 'denied') {
      throw new Error('Notification permission was denied. Reset it in browser settings to enable alerts.');
    }
    notificationPermissionState = await window.Notification.requestPermission();
    if (notificationPermissionState !== 'granted') {
      throw new Error('Notification permission was not granted.');
    }
    return true;
  }

  async function requestNotificationPermission() {
    if (!notificationsSupported()) {
      return formatToolResult('notification_request_permission', 'Notifications not supported in this browser.');
    }
    notificationPermissionState = await window.Notification.requestPermission();
    return formatToolResult('notification_request_permission', `Permission: ${notificationPermissionState}`);
  }

  async function sendNotification({ title, body, tag, silent }) {
    await ensureNotificationPermission();
    const safeTitle = String(title || 'JS Agent').slice(0, 64);
    const safeBody = String(body || '').slice(0, 200);
    new window.Notification(safeTitle, {
      body: safeBody,
      tag: String(tag || 'agent-notification'),
      silent: silent === true
    });
    return formatToolResult('notification_send', `Notification sent: "${safeTitle}"`);
  }

  function abortAllTabListeners(reason = 'Agent run stopped.') {
    for (const abort of [...activeTabListeners]) {
      try { abort(reason); } catch {}
    }
    activeTabListeners.clear();
  }

  window.addEventListener('beforeunload', () => abortAllTabListeners('Page unloaded.'), { once: true });

  async function tabBroadcast({ topic, payload }) {
    if (!topic) throw new Error('tab_broadcast: topic is required.');
    let safePayload = null;
    if (payload !== undefined && payload !== null) {
      try { safePayload = JSON.parse(JSON.stringify(payload)); }
      catch { throw new Error('tab_broadcast: payload must be JSON-serializable.'); }
    }
    const channel = getBroadcastChannel();
    channel.postMessage({ topic: String(topic), payload: safePayload, from: instanceId, timestamp: new Date().toISOString() });
    return formatToolResult('tab_broadcast', `Broadcast sent on topic "${String(topic)}".`);
  }

  async function tabListen({ topic, timeout_ms }) {
    if (!topic) throw new Error('tab_listen: topic is required.');
    const waitMs = Math.max(1, Number(timeout_ms) || 15000);
    const normalizedTopic = String(topic);
    getBroadcastChannel();

    if (!broadcastListeners.has(normalizedTopic)) {
      broadcastListeners.set(normalizedTopic, new Set());
    }
    const callbacks = broadcastListeners.get(normalizedTopic);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error(`tab_listen: no message on "${normalizedTopic}" within ${waitMs}ms.`));
      }, waitMs);

      function cleanup() {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        callbacks.delete(onMessage);
        activeTabListeners.delete(abortFn);
      }

      function onMessage(payload) {
        cleanup();
        resolve(formatToolResult('tab_listen', `Topic: ${normalizedTopic}\nPayload: ${JSON.stringify(payload ?? null, null, 2).slice(0, 2000)}`));
      }

      function abortFn(reason) {
        cleanup();
        reject(new Error(`tab_listen aborted: ${reason}`));
      }

      callbacks.add(onMessage);
      activeTabListeners.add(abortFn);
    });
  }

  window.AgentSkillBroadcast = {
    instanceId,
    broadcastChannel: () => broadcastChannel,
    broadcastListeners: () => broadcastListeners,
    activeTabListeners: () => activeTabListeners,
    formatToolResult,
    supportsTabMessaging,
    getBroadcastChannel,
    notificationsSupported,
    ensureNotificationPermission,
    requestNotificationPermission,
    sendNotification,
    abortAllTabListeners,
    tabBroadcast,
    tabListen
  };
})();