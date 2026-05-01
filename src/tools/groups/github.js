(() => {
  window.AgentToolGroups = window.AgentToolGroups || {};

  window.AgentToolGroups.github = {
    label: 'GitHub',
    tools: [
      { name: 'github_search_code',  signature: 'github_search_code(query, repo?, language?, per_page?)' },
      { name: 'github_get_pr',       signature: 'github_get_pr(repo, pr_number)' },
      { name: 'github_list_prs',     signature: 'github_list_prs(repo, state?, per_page?)' },
      { name: 'github_create_issue', signature: 'github_create_issue(repo, title, body?, labels?)' },
      { name: 'github_get_file',     signature: 'github_get_file(repo, path, ref?)' },
      { name: 'github_list_issues',  signature: 'github_list_issues(repo, state?, labels?, per_page?)' }
    ]
  };
})();
