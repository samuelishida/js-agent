(() => {
  window.AgentSkillGroups = window.AgentSkillGroups || {};
  if (window.AgentSkills?.skillGroups?.device) {
    window.AgentSkillGroups.device = window.AgentSkills.skillGroups.device;
    return;
  }

  window.AgentSkillGroups.device = {
    label: 'Device & Browser',
    tools: [
      { name: 'datetime', signature: 'datetime()' },
      { name: 'geo_current_location', signature: 'geo_current_location()' },
      { name: 'weather_current', signature: 'weather_current()' },
      { name: 'clipboard_read', signature: 'clipboard_read()' },
      { name: 'clipboard_write', signature: 'clipboard_write(text)' },
      { name: 'storage_list_keys', signature: 'storage_list_keys()' },
      { name: 'storage_get', signature: 'storage_get(key)' },
      { name: 'storage_set', signature: 'storage_set(key, value)' },
      { name: 'notification_request_permission', signature: 'notification_request_permission()' },
      { name: 'notification_send', signature: 'notification_send(title, body?, tag?, silent?)' },
      { name: 'tab_broadcast', signature: 'tab_broadcast(topic, payload?)' },
      { name: 'tab_listen', signature: 'tab_listen(topic, timeout_ms?)' }
    ]
  };
})();