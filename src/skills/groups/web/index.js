(() => {
  window.AgentSkillGroups = window.AgentSkillGroups || {};
  if (window.AgentSkills?.skillGroups?.web) {
    window.AgentSkillGroups.web = window.AgentSkills.skillGroups.web;
    return;
  }

  window.AgentSkillGroups.web = {
    label: 'Web & Context',
    tools: [
      { name: 'web_search', signature: 'web_search(query)' },
      { name: 'web_fetch', signature: 'web_fetch(url) // src alias' },
      { name: 'read_page', signature: 'read_page(url)' },
      { name: 'http_fetch', signature: 'http_fetch(url)' },
      { name: 'extract_links', signature: 'extract_links(...)' },
      { name: 'page_metadata', signature: 'page_metadata(url)' }
    ]
  };
})();
