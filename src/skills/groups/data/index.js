(() => {
  window.AgentSkillGroups = window.AgentSkillGroups || {};
  if (window.AgentSkills?.skillGroups?.data) {
    window.AgentSkillGroups.data = window.AgentSkills.skillGroups.data;
    return;
  }

  window.AgentSkillGroups.data = {
    label: 'Data',
    tools: [
      { name: 'calc', signature: 'calc(expression)' },
      { name: 'parse_json', signature: 'parse_json(text)' },
      { name: 'parse_csv', signature: 'parse_csv(text)' },
      { name: 'todo_write', signature: 'todo_write(items[] | text)' },
      { name: 'task_create', signature: 'task_create(title, description?, status?)' },
      { name: 'task_get', signature: 'task_get(id)' },
      { name: 'task_list', signature: 'task_list(status?, limit?)' },
      { name: 'task_update', signature: 'task_update(id, ...fields)' },
      { name: 'ask_user_question', signature: 'ask_user_question(question, options?)' },
      { name: 'tool_search', signature: 'tool_search(query, limit?)' }
    ]
  };
})();
