(() => {
  window.AgentSkillGroups = window.AgentSkillGroups || {};
  if (window.AgentSkills?.skillGroups?.filesystem) {
    window.AgentSkillGroups.filesystem = window.AgentSkills.skillGroups.filesystem;
    return;
  }

  window.AgentSkillGroups.filesystem = {
    label: 'Files & Workspace',
    tools: [
      { name: 'fs_request_root', signature: 'fs_request_root()' },
      { name: 'fs_list_roots', signature: 'fs_list_roots()' },
      { name: 'fs_select_root', signature: 'fs_select_root(root_path)' },
      { name: 'fs_list_dir', signature: 'fs_list_dir(path)' },
      { name: 'fs_walk', signature: 'fs_walk(path?, maxDepth?, maxResults?, includeFiles?, includeDirectories?, includeHidden?, excludeNames?)' },
      { name: 'fs_read_file', signature: 'fs_read_file(path)' },
      { name: 'fs_write_file', signature: 'fs_write_file(path, text)' },
      { name: 'fs_mkdir', signature: 'fs_mkdir(path)' },
      { name: 'fs_delete', signature: 'fs_delete(path, recursive?)' },
      { name: 'fs_rename', signature: 'fs_rename(path, new_path)' },
      { name: 'fs_stat', signature: 'fs_stat(path)' },
      { name: 'fs_search', signature: 'fs_search(path, pattern, max_results?)' },
      { name: 'fs_find', signature: 'fs_find(path, query, max_results?)' },
      { name: 'fs_glob', signature: 'fs_glob(path, glob, max_results?)' },
      { name: 'fs_tree', signature: 'fs_tree(path, max_depth?)' }
    ]
  };
})();