(() => {
  window.AgentSkillGroups = window.AgentSkillGroups || {};
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
      { name: 'storage_set', signature: 'storage_set(key, value)' }
    ]
  };
})();
