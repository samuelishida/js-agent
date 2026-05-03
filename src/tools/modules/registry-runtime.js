(() => {
  window.AgentToolModules = window.AgentToolModules || {};

  window.AgentToolModules.createRegistryRuntime = function createRegistryRuntime(handlers = {}) {
    function defineTool({ name, signature, description, run, retries = 1, fallbacks }) {
      return {
        name,
        signature,
        description,
        retries,
        run,
        ...(Array.isArray(fallbacks) && fallbacks.length ? { fallbacks: [...fallbacks] } : {})
      };
    }

    function buildRegistryFromGroups(groups) {
      const next = {};
      for (const group of Object.values(groups)) {
        for (const tool of group.tools) {
          next[tool.name] = {
            name: tool.name,
            description: tool.description,
            retries: tool.retries,
            run: tool.run,
            ...(tool.fallbacks ? { fallbacks: [...tool.fallbacks] } : {})
          };
        }
      }
      return next;
    }

    function buildToolGroupsForUi(groups) {
      const uiGroups = Object.fromEntries(
        Object.entries(groups).map(([groupKey, group]) => [
          groupKey,
          {
            label: group.label,
            tools: group.tools.map(tool => ({
              name: tool.name,
              signature: tool.signature
            }))
          }
        ])
      );

      const builtinsByGroup = {
        device: [{ name: 'datetime', signature: 'datetime()' }],
        data: [{ name: 'calc', signature: 'calc(expression)' }]
      };

      for (const [groupKey, builtinTools] of Object.entries(builtinsByGroup)) {
        if (!uiGroups[groupKey]) continue;
        const existing = new Set(uiGroups[groupKey].tools.map(tool => tool.name));
        for (const tool of builtinTools) {
          if (!existing.has(tool.name)) {
            uiGroups[groupKey].tools.unshift(tool);
          }
        }
      }

      return uiGroups;
    }

    const groupedTools = {
      web: {
        label: 'Web & Context',
        tools: [
          defineTool({
            name: 'web_search',
            signature: 'web_search(query)',
            description: 'Performs live search tools and returns concise findings.',
            run: handlers.web_search
          }),
          defineTool({
            name: 'web_fetch',
            signature: 'web_fetch(url) // src alias',
            description: 'Alias of http_fetch for src compatibility.',
            run: handlers.web_fetch
          }),
          defineTool({
            name: 'read_page',
            signature: 'read_page(url)',
            description: 'Fetches and extracts readable page content from a URL.',
            run: handlers.read_page
          }),
          defineTool({
            name: 'http_fetch',
            signature: 'http_fetch(url)',
            description: 'Fetches an HTTP resource and returns a readable response preview.',
            run: handlers.http_fetch
          }),
          defineTool({
            name: 'extract_links',
            signature: 'extract_links(...)',
            description: 'Extracts links from a URL or a block of text.',
            run: handlers.extract_links
          }),
          defineTool({
            name: 'page_metadata',
            signature: 'page_metadata(url)',
            description: 'Extracts title and metadata from a web page.',
            run: handlers.page_metadata
          })
        ]
      },
      device: {
        label: 'Device & Browser',
        tools: [
          defineTool({
            name: 'geo_current_location',
            signature: 'geo_current_location()',
            description: 'Gets the current browser geolocation coordinates.',
            run: handlers.geo_current_location
          }),
          defineTool({
            name: 'weather_current',
            signature: 'weather_current()',
            description: 'Gets the current weather for the current or provided coordinates.',
            run: handlers.weather_current,
            fallbacks: ['geo_current_location']
          }),
          defineTool({
            name: 'clipboard_read',
            signature: 'clipboard_read()',
            description: 'Reads text from the system clipboard when supported.',
            run: handlers.clipboard_read
          }),
          defineTool({
            name: 'clipboard_write',
            signature: 'clipboard_write(text)',
            description: 'Writes text to the system clipboard when supported.',
            run: handlers.clipboard_write
          }),
          defineTool({
            name: 'storage_list_keys',
            signature: 'storage_list_keys()',
            description: 'Lists localStorage keys available to the app.',
            run: handlers.storage_list_keys
          }),
          defineTool({
            name: 'storage_get',
            signature: 'storage_get(key)',
            description: 'Reads a value from localStorage.',
            run: handlers.storage_get
          }),
          defineTool({
            name: 'storage_set',
            signature: 'storage_set(key, value)',
            description: 'Writes a value to localStorage.',
            run: handlers.storage_set
          }),
          defineTool({
            name: 'notification_request_permission',
            signature: 'notification_request_permission()',
            description: 'Requests native browser notification permission from the user. Use once before sending notifications if permission is still unknown.',
            run: handlers.notification_request_permission
          }),
          defineTool({
            name: 'notification_send',
            signature: 'notification_send(title, body?, tag?, silent?)',
            description: 'Sends a native browser notification. Use when a long task finishes, when an important result needs attention, or when the user explicitly asks to be notified.',
            run: handlers.notification_send
          }),
          defineTool({
            name: 'tab_broadcast',
            signature: 'tab_broadcast(topic, payload?)',
            description: 'Publishes a message to other open tabs running this agent. Use to share results or coordinate work across multiple windows.',
            run: handlers.tab_broadcast
          }),
          defineTool({
            name: 'tab_listen',
            signature: 'tab_listen(topic, timeout_ms?)',
            description: 'Waits for a broadcast message on a specific topic from another tab and returns the payload or a timeout error.',
            run: handlers.tab_listen
          })
        ]
      },
      filesystem: {
        label: 'Local Files',
        tools: [
          defineTool({
            name: 'fs_list_roots',
            signature: 'fs_list_roots()',
            description: 'Lists the currently selected local directory roots.',
            run: handlers.fs_list_roots
          }),
          defineTool({
            name: 'fs_authorize_folder',
            signature: 'fs_authorize_folder() // explains/validates folder authorization flow',
            description: 'Reports folder authorization status and tells the user how to authorize a directory from the Files panel when needed.',
            run: handlers.fs_authorize_folder
          }),
          defineTool({
            name: 'fs_pick_directory',
            signature: 'fs_pick_directory() // direct disk access when supported',
            description: 'Prompts the user to pick a local directory root for direct file operations. This must be triggered from a direct user gesture, such as clicking the Authorize Folder button in the Files panel.',
            run: handlers.fs_pick_directory
          }),
          defineTool({
            name: 'fs_list_dir',
            signature: 'fs_list_dir(path)',
            description: 'Lists entries inside a selected local directory.',
            run: handlers.fs_list_dir,
            fallbacks: ['fs_authorize_folder', 'fs_pick_directory']
          }),
          defineTool({
            name: 'fs_tree',
            signature: 'fs_tree(path)',
            description: 'Recursively lists a local directory tree.',
            run: handlers.fs_tree
          }),
          defineTool({
            name: 'fs_walk',
            signature: 'fs_walk(path?, maxDepth?, maxResults?, includeFiles?, includeDirectories?, includeHidden?, excludeNames?)',
            description: 'Performs bounded recursive filesystem discovery with depth and result limits.',
            run: handlers.fs_walk
          }),
          defineTool({
            name: 'fs_exists',
            signature: 'fs_exists(path)',
            description: 'Checks whether a file or directory exists.',
            run: handlers.fs_exists
          }),
          defineTool({
            name: 'fs_stat',
            signature: 'fs_stat(path)',
            description: 'Returns metadata about a file or directory.',
            run: handlers.fs_stat
          }),
          defineTool({
            name: 'fs_read_file',
            signature: 'fs_read_file(path, offset?, length?)',
            description: 'Opens and reads a local file as text, with optional chunking via offset and length.',
            run: handlers.fs_read_file
          }),
          defineTool({
            name: 'fs_preview_file',
            signature: 'fs_preview_file(path)',
            description: 'Returns preview information or text preview for a supported local file.',
            run: handlers.fs_preview_file
          }),
          defineTool({
            name: 'fs_search_name',
            signature: 'fs_search_name(pattern, path?)',
            description: 'Searches local files and folders by name pattern.',
            run: handlers.fs_search_name
          }),
          defineTool({
            name: 'fs_search_content',
            signature: 'fs_search_content(pattern, path?)',
            description: 'Searches inside local text files for matching content.',
            run: handlers.fs_search_content
          }),
          defineTool({
            name: 'fs_glob',
            signature: 'fs_glob(path?, pattern, includeDirectories?, maxResults?)',
            description: 'Matches local paths using glob patterns (*, **, ?).',
            run: handlers.fs_glob
          }),
          defineTool({
            name: 'fs_grep',
            signature: 'fs_grep(path?, pattern, isRegexp?, caseSensitive?, maxResults?)',
            description: 'Searches local file contents and returns path:line matches.',
            run: handlers.fs_grep
          }),
          defineTool({
            name: 'fs_upload_pick',
            signature: 'fs_upload_pick()',
            description: 'Opens the browser upload picker and registers selected files for the session.',
            run: handlers.fs_upload_pick
          }),
          defineTool({
            name: 'fs_save_upload',
            signature: 'fs_save_upload(uploadName, destinationPath)',
            description: 'Saves a previously picked upload into the selected local directory.',
            run: handlers.fs_save_upload
          }),
          defineTool({
            name: 'fs_download_file',
            signature: 'fs_download_file(filename, content?, path?, storageKey?)',
            description: 'Triggers a browser download. Provide filename + content (text or base64) to download without filesystem access. Provide filename + path to download a local file. Provide filename + storageKey to download from localStorage. No directory root needed when content or storageKey is provided. NOTE: Do NOT use this after runtime_generateFile — it already auto-downloads.',
            run: handlers.fs_download_file
          }),
          defineTool({
            name: 'fs_mkdir',
            signature: 'fs_mkdir(path)',
            description: 'Creates a local directory path.',
            run: handlers.fs_mkdir
          }),
          defineTool({
            name: 'fs_touch',
            signature: 'fs_touch(path)',
            description: 'Creates an empty file if it does not exist.',
            run: handlers.fs_touch
          }),
          defineTool({
            name: 'fs_write_file',
            signature: 'fs_write_file(path, content)',
            description: 'Creates or overwrites a local text file. If direct filesystem access is unavailable, it falls back to a browser download using the requested filename.',
            run: handlers.fs_write_file
          }),
          defineTool({
            name: 'fs_append_file',
            signature: 'fs_append_file(path, content)',
            description: 'Appends content to an existing local text file. Use this to build large files incrementally when content would otherwise exceed model output limits.',
            run: handlers.fs_append_file
          }),
          defineTool({
            name: 'fs_copy_file',
            signature: 'fs_copy_file(sourcePath, destinationPath)',
            description: 'Copies a local file from one path to another.',
            run: handlers.fs_copy_file
          }),
          defineTool({
            name: 'fs_move_file',
            signature: 'fs_move_file(sourcePath, destinationPath)',
            description: 'Moves a local file from one path to another.',
            run: handlers.fs_move_file
          }),
          defineTool({
            name: 'fs_delete_path',
            signature: 'fs_delete_path(path)',
            description: 'Deletes a local file or directory under the selected root.',
            run: handlers.fs_delete_path
          }),
          defineTool({
            name: 'fs_rename_path',
            signature: 'fs_rename_path(path, newName)',
            description: 'Renames a local file or directory.',
            run: handlers.fs_rename_path
          }),
          defineTool({
            name: 'file_read',
            signature: 'file_read(path, offset?, length?) // src alias',
            description: 'Alias of fs_read_file for src compatibility.',
            run: handlers.file_read
          }),
          defineTool({
            name: 'read_file',
            signature: 'read_file(path, offset?, length?) // src alias',
            description: 'Alias of fs_read_file for src compatibility.',
            run: handlers.read_file
          }),
          defineTool({
            name: 'file_write',
            signature: 'file_write(path, content) // src alias',
            description: 'Alias of fs_write_file for src compatibility.',
            run: handlers.file_write
          }),
          defineTool({
            name: 'write_file',
            signature: 'write_file(path, content) // src alias',
            description: 'Alias of fs_write_file for src compatibility.',
            run: handlers.write_file
          }),
          defineTool({
            name: 'file_edit',
            signature: 'file_edit(path, oldText, newText, replaceAll?) // src-style edit',
            description: 'Edits a local file by replacing oldText with newText.',
            run: handlers.file_edit
          }),
          defineTool({
            name: 'edit_file',
            signature: 'edit_file(path, oldText, newText, replaceAll?) // src alias',
            description: 'Alias of file_edit for src compatibility.',
            run: handlers.edit_file
          }),
          defineTool({
            name: 'glob',
            signature: 'glob(path?, pattern) // src alias',
            description: 'Alias of fs_glob for src compatibility.',
            run: handlers.glob
          }),
          defineTool({
            name: 'grep',
            signature: 'grep(path?, pattern) // src alias',
            description: 'Alias of fs_grep for src compatibility.',
            run: handlers.grep
          })
        ]
      },
      data: {
        label: 'Data',
        tools: [
          defineTool({
            name: 'parse_json',
            signature: 'parse_json(text)',
            description: 'Validates and pretty-prints JSON input.',
            run: handlers.parse_json
          }),
          defineTool({
            name: 'parse_csv',
            signature: 'parse_csv(text)',
            description: 'Parses CSV text and returns a structured preview.',
            run: handlers.parse_csv
          }),
          defineTool({
            name: 'todo_write',
            signature: 'todo_write(items[] | text)',
            description: 'Stores a todo list in local browser state.',
            run: handlers.todo_write
          }),
          defineTool({
            name: 'task_create',
            signature: 'task_create(title, description?, status?)',
            description: 'Creates a persisted task record.',
            run: handlers.task_create
          }),
          defineTool({
            name: 'task_get',
            signature: 'task_get(id)',
            description: 'Retrieves a persisted task by id.',
            run: handlers.task_get
          }),
          defineTool({
            name: 'task_list',
            signature: 'task_list(status?, limit?)',
            description: 'Lists persisted tasks with optional status filter.',
            run: handlers.task_list
          }),
          defineTool({
            name: 'task_update',
            signature: 'task_update(id, ...fields)',
            description: 'Updates an existing persisted task.',
            run: handlers.task_update
          }),
          defineTool({
            name: 'worker_batch',
            signature: 'worker_batch(goal?, tasks?, max_workers?, include_context?, max_tokens?, temperature?)',
            description: 'Runs bounded parallel worker prompts using the active LLM lane and stores run history.',
            run: handlers.worker_batch
          }),
          defineTool({
            name: 'worker_list',
            signature: 'worker_list(limit?)',
            description: 'Lists recent worker_batch runs and aggregate status.',
            run: handlers.worker_list
          }),
          defineTool({
            name: 'worker_get',
            signature: 'worker_get(run_id | id)',
            description: 'Retrieves details and outputs for a specific worker run.',
            run: handlers.worker_get
          }),
          defineTool({
            name: 'ask_user_question',
            signature: 'ask_user_question(question, options?)',
            description: 'Asks the user for clarification in chat-friendly format.',
            run: handlers.ask_user_question
          }),
          defineTool({
            name: 'memory_write',
            signature: 'memory_write(text, tags?, importance?)',
            description: 'Stores a durable long-term memory preference/fact for future runs.',
            run: handlers.memory_write
          }),
          defineTool({
            name: 'memory_search',
            signature: 'memory_search(query, limit?)',
            description: 'Searches durable long-term memory entries relevant to the query.',
            run: handlers.memory_search
          }),
          defineTool({
            name: 'memory_list',
            signature: 'memory_list(limit?)',
            description: 'Lists recent long-term memory entries.',
            run: handlers.memory_list
          }),
          defineTool({
            name: 'tool_search',
            signature: 'tool_search(query, limit?)',
            description: 'Searches available tools by name and description.',
            run: handlers.tool_search
          }),
          defineTool({
            name: 'snapshot_tool_catalog',
            signature: 'snapshot_tool_catalog(query?, limit?)',
            description: 'Lists imported bundled tools extracted from clawd-code-main.',
            run: handlers.snapshot_tool_catalog
          })
        ]
      }
    };

    return {
      registry: buildRegistryFromGroups(groupedTools),
      toolGroups: buildToolGroupsForUi(groupedTools)
    };
  };
})();
