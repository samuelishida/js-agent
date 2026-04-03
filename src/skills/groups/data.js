(() => {
  window.AgentSkillGroups = window.AgentSkillGroups || {};
  if (window.AgentSkills?.skillGroups?.data) {
    window.AgentSkillGroups.data = window.AgentSkills.skillGroups.data;
    return;
  }

  window.AgentSkillGroups.data = {
    label: 'Data & Analysis',
    tools: [
      { name: 'csv_parse', signature: 'csv_parse(text, delimiter?)' },
      { name: 'json_query', signature: 'json_query(data, path)' },
      { name: 'json_transform', signature: 'json_transform(data, map)' },
      { name: 'table_stats', signature: 'table_stats(rows)' },
      { name: 'table_group_by', signature: 'table_group_by(rows, key)' },
      { name: 'table_sort', signature: 'table_sort(rows, key, dir?)' },
      { name: 'text_regex_extract', signature: 'text_regex_extract(text, pattern, flags?)' },
      { name: 'text_regex_replace', signature: 'text_regex_replace(text, pattern, replacement, flags?)' },
      { name: 'text_template_render', signature: 'text_template_render(template, data)' }
    ]
  };
})();