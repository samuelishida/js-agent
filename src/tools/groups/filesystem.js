(() => {
  window.AgentToolGroups = window.AgentToolGroups || {};
  if (window.AgentTools?.toolGroups?.filesystem) {
    window.AgentToolGroups.filesystem = window.AgentTools.toolGroups.filesystem;
    return;
  }

  window.AgentToolGroups.filesystem = {
    label: 'Files & Workspace',
    tools: [
      { name: 'fs_list_roots', signature: 'fs_list_roots()' },
      { name: 'fs_pick_directory', signature: 'fs_pick_directory()' },
      { name: 'fs_list_dir', signature: 'fs_list_dir(path)' },
      { name: 'fs_walk', signature: 'fs_walk(path?, maxDepth?, maxResults?, includeFiles?, includeDirectories?, includeHidden?, excludeNames?)' },
      { name: 'fs_read_file', signature: 'fs_read_file(path)' },
      { name: 'fs_write_file', signature: 'fs_write_file(path, content)' },
      { name: 'fs_mkdir', signature: 'fs_mkdir(path)' },
      { name: 'fs_touch', signature: 'fs_touch(path)' },
      { name: 'fs_delete_path', signature: 'fs_delete_path(path, recursive?)' },
      { name: 'fs_rename_path', signature: 'fs_rename_path(path, newName)' },
      { name: 'fs_move_file', signature: 'fs_move_file(sourcePath, destinationPath)' },
      { name: 'fs_copy_file', signature: 'fs_copy_file(sourcePath, destinationPath)' },
      { name: 'fs_stat', signature: 'fs_stat(path)' },
      { name: 'fs_exists', signature: 'fs_exists(path)' },
      { name: 'fs_search_name', signature: 'fs_search_name(pattern, path?)' },
      { name: 'fs_search_content', signature: 'fs_search_content(query, path?, glob?)' },
      { name: 'fs_glob', signature: 'fs_glob(path?, pattern, maxResults?)' },
      { name: 'fs_grep', signature: 'fs_grep(query, path?, glob?, contextLines?)' },
      { name: 'fs_tree', signature: 'fs_tree(path, maxDepth?)' },
      { name: 'fs_download_file', signature: 'fs_download_file(path?, content?, filename?)' },
      { name: 'fs_upload_pick', signature: 'fs_upload_pick()' },
      { name: 'fs_preview_file', signature: 'fs_preview_file(path)' }
    ]
  };
})();