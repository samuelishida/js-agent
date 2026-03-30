(() => {
  window.AgentSkillGroups = window.AgentSkillGroups || {};
  window.AgentSkillGroups.filesystem = {
    label: 'Local Files',
    tools: [
      { name: 'fs_list_roots', signature: 'fs_list_roots()' },
      { name: 'fs_authorize_folder', signature: 'fs_authorize_folder() // explains/validates folder authorization flow' },
      { name: 'fs_pick_directory', signature: 'fs_pick_directory() // direct disk access when supported' },
      { name: 'fs_list_dir', signature: 'fs_list_dir(path)' },
      { name: 'fs_tree', signature: 'fs_tree(path)' },
      { name: 'fs_exists', signature: 'fs_exists(path)' },
      { name: 'fs_stat', signature: 'fs_stat(path)' },
      { name: 'fs_read_file', signature: 'fs_read_file(path, offset?, length?)' },
      { name: 'fs_preview_file', signature: 'fs_preview_file(path)' },
      { name: 'fs_search_name', signature: 'fs_search_name(...)' },
      { name: 'fs_search_content', signature: 'fs_search_content(...)' },
      { name: 'fs_upload_pick', signature: 'fs_upload_pick()' },
      { name: 'fs_save_upload', signature: 'fs_save_upload(...)' },
      { name: 'fs_download_file', signature: 'fs_download_file(...) // browser download fallback/export' },
      { name: 'fs_mkdir', signature: 'fs_mkdir(path)' },
      { name: 'fs_touch', signature: 'fs_touch(path)' },
      { name: 'fs_write_file', signature: 'fs_write_file(...) // writes file or falls back to download' },
      { name: 'fs_copy_file', signature: 'fs_copy_file(...)' },
      { name: 'fs_move_file', signature: 'fs_move_file(...)' },
      { name: 'fs_delete_path', signature: 'fs_delete_path(path)' },
      { name: 'fs_rename_path', signature: 'fs_rename_path(...)' }
    ]
  };
})();

