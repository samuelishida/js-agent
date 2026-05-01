(() => {
  window.AgentToolGroups = window.AgentToolGroups || {};
  if (window.AgentTools?.toolGroups?.data) {
    window.AgentToolGroups.data = window.AgentTools.toolGroups.data;
    return;
  }

  window.AgentToolGroups.data = {
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