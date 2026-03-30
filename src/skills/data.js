(() => {
  window.AgentSkillGroups = window.AgentSkillGroups || {};
  window.AgentSkillGroups.data = {
    label: 'Data',
    tools: [
      { name: 'calc', signature: 'calc(expression)' },
      { name: 'parse_json', signature: 'parse_json(text)' },
      { name: 'parse_csv', signature: 'parse_csv(text)' }
    ]
  };
})();
