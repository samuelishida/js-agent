(() => {
  window.AgentSkillModules = window.AgentSkillModules || {};

  window.AgentSkillModules.createFilesystemRuntime = function createFilesystemRuntime({
    state,
    formatToolResult,
    supportsFsAccess,
    supportsTextPreview
  }) {
    function assertFsAccess() {
      if (!supportsFsAccess()) {
        throw new Error('File System Access API is not supported in this browser.');
      }
    }

    function registerRoot(handle, label) {
      const rootId = label || handle.name || `root-${state.roots.size + 1}`;
      state.roots.set(rootId, handle);
      if (!state.defaultRootId) state.defaultRootId = rootId;
      return rootId;
    }

    function parseVirtualPath(path) {
      const raw = String(path || '').trim();
      if (!raw) return { rootId: state.defaultRootId, segments: [] };

      const normalized = raw.replace(/\\/g, '/').replace(/\/+/g, '/');

      const explicit = normalized.match(/^([^:]+):\/?(.*)$/);
      if (explicit && state.roots.has(explicit[1])) {
        return {
          rootId: explicit[1],
          segments: explicit[2].split('/').filter(Boolean)
        };
      }

      const windowsAbsolute = normalized.match(/^[A-Za-z]:\/(.+)$/);
      if (windowsAbsolute) {
        const absoluteSegments = windowsAbsolute[1].split('/').filter(Boolean);
        for (const rootId of state.roots.keys()) {
          const rootName = String(rootId || '').toLowerCase();
          const matchIndex = absoluteSegments.findIndex(segment => segment.toLowerCase() === rootName);
          if (matchIndex >= 0) {
            return {
              rootId,
              segments: absoluteSegments.slice(matchIndex + 1)
            };
          }
        }
      }

      const normalizedSegments = normalized.replace(/^\/+/, '').split('/').filter(Boolean);
      if (normalizedSegments.length) {
        const first = normalizedSegments[0].toLowerCase();
        for (const rootId of state.roots.keys()) {
          if (String(rootId || '').toLowerCase() === first) {
            return {
              rootId,
              segments: normalizedSegments.slice(1)
            };
          }
        }
      }

      return {
        rootId: state.defaultRootId,
        segments: normalized.replace(/^\/+/, '').split('/').filter(Boolean)
      };
    }

    async function ensureRoot(rootId) {
      const id = rootId || state.defaultRootId;
      const root = state.roots.get(id);
      if (!root) {
        throw new Error('No directory root selected. Ask the user to click "Authorize Folder" in the Files panel first.');
      }
      return { rootId: rootId || state.defaultRootId, root };
    }

    async function resolveDirectory(path, create = false) {
      const { rootId, segments } = parseVirtualPath(path);
      const { root } = await ensureRoot(rootId);
      let current = root;

      for (const segment of segments) {
        current = await current.getDirectoryHandle(segment, { create });
      }

      return { rootId, handle: current };
    }

    async function resolveFile(path, create = false) {
      const { rootId, segments } = parseVirtualPath(path);
      if (!segments.length) throw new Error('A file path is required.');
      const fileName = segments.pop();
      const { root } = await ensureRoot(rootId);
      let current = root;

      for (const segment of segments) {
        current = await current.getDirectoryHandle(segment, { create });
      }

      const handle = await current.getFileHandle(fileName, { create });
      return { rootId, parent: current, handle, fileName };
    }

    async function readFileAsText(handle) {
      const file = await handle.getFile();
      return file.text();
    }

    async function writeFile(handle, content) {
      const writer = await handle.createWritable();
      await writer.write(content);
      await writer.close();
    }

    async function collectEntries(directoryHandle) {
      const entries = [];
      for await (const [name, handle] of directoryHandle.entries()) {
        entries.push({ name, kind: handle.kind });
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    }

    async function walkDirectory(directoryHandle, basePath = '') {
      const items = [];
      for await (const [name, handle] of directoryHandle.entries()) {
        const fullPath = `${basePath}/${name}`.replace(/^\/+/, '/');
        items.push({ path: fullPath, kind: handle.kind, handle });
        if (handle.kind === 'directory') {
          items.push(...await walkDirectory(handle, fullPath));
        }
      }
      return items;
    }

    async function pickDirectory() {
      assertFsAccess();
      let handle;
      try {
        handle = await window.showDirectoryPicker();
      } catch (error) {
        if (/user gesture/i.test(String(error?.message || ''))) {
          throw new Error('Directory access requires a direct user gesture. Ask the user to click "Authorize Folder" in the Files panel.');
        }
        throw error;
      }
      const rootId = registerRoot(handle, handle.name);
      const entries = await collectEntries(handle);
      return formatToolResult('fs_pick_directory', `Root: ${rootId}\nEntries: ${entries.length}\n${entries.map(item => `${item.kind}: ${item.name}`).join('\n')}`);
    }

    async function authorizeFolder() {
      const roots = [...state.roots.keys()];
      if (roots.length) {
        const body = [
          `Authorized roots: ${roots.join(', ')}`,
          `Default root: ${state.defaultRootId || roots[0]}`,
          'You can proceed with fs_list_dir or fs_read_file using one of these roots.'
        ].join('\n');
        return formatToolResult('fs_authorize_folder', body);
      }

      return formatToolResult(
        'fs_authorize_folder',
        [
          'No folder is authorized yet.',
          'Action required: click "Authorize Folder" in the Files panel (user gesture required by browser security).',
          'After authorizing, call fs_list_roots and then fs_list_dir to continue.'
        ].join('\n')
      );
    }

    async function listDirectory({ path = '' }) {
      const { rootId, handle } = await resolveDirectory(path);
      const entries = await collectEntries(handle);
      return formatToolResult('fs_list_dir', `Root: ${rootId}\nPath: ${path || '/'}\n${entries.map(item => `${item.kind}: ${item.name}`).join('\n') || '(empty)'}`);
    }

    async function readLocalFile({ path, offset = 0, length = 12000, startLine = 0, endLine = 0 }) {
      const { handle } = await resolveFile(path, false);
      const text = await readFileAsText(handle);
      const safeStartLineArg = Number.isFinite(Number(startLine)) ? Math.max(1, Number(startLine)) : 0;
      const safeEndLineArg = Number.isFinite(Number(endLine)) ? Math.max(safeStartLineArg || 1, Number(endLine)) : 0;

      if (safeStartLineArg || safeEndLineArg) {
        const lines = String(text || '').split(/\r?\n/);
        const safeStartLine = safeStartLineArg || 1;
        const safeEndLine = safeEndLineArg || Math.min(lines.length, safeStartLine + 199);
        const chunk = lines.slice(safeStartLine - 1, safeEndLine).join('\n');

        return formatToolResult(
          `fs_read_file ${path}`,
          [
            `Path: ${path}`,
            `Start line: ${safeStartLine}`,
            `End line: ${Math.min(safeEndLine, lines.length)}`,
            `Returned lines: ${Math.max(0, Math.min(safeEndLine, lines.length) - safeStartLine + 1)}`,
            `Total lines: ${lines.length}`,
            '',
            chunk
          ].join('\n')
        );
      }

      const safeOffset = Math.max(0, Number(offset) || 0);
      const safeLength = Math.min(20000, Math.max(500, Number(length) || 12000));
      const chunk = text.slice(safeOffset, safeOffset + safeLength);
      const nextOffset = safeOffset + chunk.length;
      const hasMore = nextOffset < text.length;

      const header = [
        `Path: ${path}`,
        `Offset: ${safeOffset}`,
        `Returned chars: ${chunk.length}`,
        `Total chars: ${text.length}`,
        `Has more: ${hasMore ? 'yes' : 'no'}`,
        `Next offset: ${hasMore ? nextOffset : safeOffset}`
      ].join('\n');

      return formatToolResult(`fs_read_file ${path}`, `${header}\n\n${chunk}`);
    }

    async function pickUpload() {
      if (!window.showOpenFilePicker) {
        throw new Error('Open file picker is not supported in this browser.');
      }

      const handles = await window.showOpenFilePicker({ multiple: true });
      const names = [];
      for (const handle of handles) {
        state.uploads.set(handle.name, handle);
        names.push(handle.name);
      }

      return formatToolResult('fs_upload_pick', names.length ? names.join('\n') : 'No files selected.');
    }

    async function downloadFile({ path, content = '', filename = '' }) {
      let blob;
      let resolvedName = filename;

      if (path) {
        const { handle, fileName } = await resolveFile(path, false);
        const file = await handle.getFile();
        blob = file;
        resolvedName = resolvedName || fileName;
      } else {
        blob = new Blob([String(content)], { type: 'text/plain;charset=utf-8' });
        resolvedName = resolvedName || 'download.txt';
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = resolvedName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      return formatToolResult('fs_download_file', `Triggered browser download for ${resolvedName}`);
    }

    async function previewFile({ path }) {
      const { handle, fileName } = await resolveFile(path, false);
      const file = await handle.getFile();
      const type = file.type || 'application/octet-stream';

      if (type.startsWith('image/')) {
        return formatToolResult('fs_preview_file', `Image preview available\nName: ${fileName}\nType: ${type}\nSize: ${file.size} bytes`);
      }

      if (type === 'application/pdf') {
        return formatToolResult('fs_preview_file', `PDF preview available\nName: ${fileName}\nSize: ${file.size} bytes`);
      }

      if (supportsTextPreview(fileName)) {
        return formatToolResult('fs_preview_file', (await file.text()).slice(0, 4000));
      }

      return formatToolResult('fs_preview_file', `Preview metadata only\nName: ${fileName}\nType: ${type}\nSize: ${file.size} bytes`);
    }

    async function searchByName({ path = '', pattern }) {
      const { handle } = await resolveDirectory(path);
      const entries = await walkDirectory(handle, path || '');
      const needle = String(pattern || '').toLowerCase();
      const matches = entries.filter(item => item.path.toLowerCase().includes(needle)).slice(0, 100);

      return formatToolResult('fs_search_name', matches.length ? matches.map(item => `${item.kind}: ${item.path}`).join('\n') : 'No matches.');
    }

    async function searchByContent({ path = '', pattern }) {
      const { handle } = await resolveDirectory(path);
      const entries = await walkDirectory(handle, path || '');
      const needle = String(pattern || '');
      const matches = [];

      for (const entry of entries) {
        if (entry.kind !== 'file' || !supportsTextPreview(entry.handle.name)) continue;
        const text = await readFileAsText(entry.handle);
        if (text.includes(needle)) {
          matches.push(entry.path);
        }
        if (matches.length >= 50) break;
      }

      return formatToolResult('fs_search_content', matches.length ? matches.join('\n') : 'No content matches.');
    }

    function escapeRegexLiteral(value) {
      return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function globPatternToRegExp(pattern) {
      const source = String(pattern || '**/*').replace(/\\/g, '/').trim() || '**/*';
      let out = '^';

      for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        const next = source[i + 1];

        if (ch === '*' && next === '*') {
          out += '.*';
          i += 1;
          continue;
        }

        if (ch === '*') {
          out += '[^/]*';
          continue;
        }

        if (ch === '?') {
          out += '[^/]';
          continue;
        }

        out += escapeRegexLiteral(ch);
      }

      out += '$';
      return new RegExp(out, 'i');
    }

    async function globPaths({ path = '', pattern = '**/*', includeDirectories = false, maxResults = 200 }) {
      const { handle } = await resolveDirectory(path);
      const entries = await walkDirectory(handle, path || '');
      const matcher = globPatternToRegExp(pattern);
      const limit = Math.max(1, Math.min(1000, Number(maxResults) || 200));

      const matches = [];
      for (const entry of entries) {
        if (!includeDirectories && entry.kind !== 'file') continue;
        const normalizedPath = String(entry.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!normalizedPath) continue;
        if (!matcher.test(normalizedPath)) continue;
        matches.push(`${entry.kind}: /${normalizedPath}`);
        if (matches.length >= limit) break;
      }

      return formatToolResult(
        'fs_glob',
        `Path: ${path || '/'}\nPattern: ${pattern}\nMatches: ${matches.length}\n\n${matches.join('\n') || '(no matches)'}`
      );
    }

    async function grepPaths({ path = '', pattern, isRegexp = false, caseSensitive = false, maxResults = 200 }) {
      const rawPattern = String(pattern || '');
      if (!rawPattern.trim()) {
        throw new Error('grep requires a non-empty pattern.');
      }

      const flags = caseSensitive ? 'g' : 'gi';
      const matcher = new RegExp(isRegexp ? rawPattern : escapeRegexLiteral(rawPattern), flags);
      const { handle } = await resolveDirectory(path);
      const entries = await walkDirectory(handle, path || '');
      const limit = Math.max(1, Math.min(1000, Number(maxResults) || 200));
      const results = [];

      for (const entry of entries) {
        if (entry.kind !== 'file' || !supportsTextPreview(entry.handle.name)) continue;
        const text = await readFileAsText(entry.handle);
        const lines = String(text || '').split(/\r?\n/);

        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          matcher.lastIndex = 0;
          if (!matcher.test(line)) continue;
          results.push(`${entry.path}:${i + 1}: ${line.slice(0, 220)}`);
          if (results.length >= limit) break;
        }

        if (results.length >= limit) break;
      }

      return formatToolResult(
        'fs_grep',
        `Path: ${path || '/'}\nPattern: ${rawPattern}\nMatches: ${results.length}\n\n${results.join('\n') || '(no matches)'}`
      );
    }

    async function editLocalFile({ path, oldText, newText, oldString, newString, replaceAll = false }) {
      const targetPath = String(path || '').trim();
      if (!targetPath) throw new Error('file_edit requires a path.');

      const before = String(oldText ?? oldString ?? '');
      if (!before.length) throw new Error('file_edit requires oldText.');

      const replacement = String(newText ?? newString ?? '');
      const { handle } = await resolveFile(targetPath, false);
      const content = await readFileAsText(handle);
      if (!String(content).includes(before)) {
        throw new Error('file_edit could not find oldText in file.');
      }

      const updated = replaceAll
        ? String(content).split(before).join(replacement)
        : String(content).replace(before, replacement);

      await writeFile(handle, updated);

      return formatToolResult(
        'file_edit',
        `Edited file: ${targetPath}\nReplace all: ${replaceAll ? 'yes' : 'no'}\nOld length: ${before.length}\nNew length: ${replacement.length}`
      );
    }

    function countOccurrences(text, needle) {
      if (!needle) return 0;
      let count = 0;
      let index = 0;
      while (index !== -1) {
        index = String(text).indexOf(needle, index);
        if (index === -1) break;
        count += 1;
        index += Math.max(needle.length, 1);
      }
      return count;
    }

    async function multiEditFiles({ edits }) {
      if (!Array.isArray(edits) || !edits.length) {
        throw new Error('runtime_multiEdit requires a non-empty edits array.');
      }

      const workingCopies = new Map();
      const orderedPaths = [];

      for (const rawEdit of edits) {
        const edit = rawEdit && typeof rawEdit === 'object' ? rawEdit : {};
        const targetPath = String(edit.path || '').trim();
        const oldValue = String(edit.oldString ?? edit.oldText ?? '');
        const newValue = String(edit.newString ?? edit.newText ?? '');
        const replaceAll = edit.replaceAll === true;

        if (!targetPath) throw new Error('runtime_multiEdit: each edit requires path.');
        if (!oldValue) throw new Error(`runtime_multiEdit: edit for ${targetPath} requires oldString.`);

        if (!workingCopies.has(targetPath)) {
          const { handle } = await resolveFile(targetPath, false);
          workingCopies.set(targetPath, {
            handle,
            content: await readFileAsText(handle),
            applied: 0
          });
          orderedPaths.push(targetPath);
        }

        const entry = workingCopies.get(targetPath);
        const occurrenceCount = countOccurrences(entry.content, oldValue);
        if (!occurrenceCount) {
          throw new Error(`runtime_multiEdit: oldString not found in "${targetPath}". Re-read the file and include exact context.`);
        }
        if (!replaceAll && occurrenceCount > 1) {
          throw new Error(`runtime_multiEdit: oldString appears ${occurrenceCount} times in "${targetPath}". Add more context or set replaceAll:true.`);
        }

        entry.content = replaceAll
          ? entry.content.split(oldValue).join(newValue)
          : entry.content.replace(oldValue, newValue);
        entry.applied += 1;
      }

      for (const targetPath of orderedPaths) {
        const entry = workingCopies.get(targetPath);
        await writeFile(entry.handle, entry.content);
      }

      return formatToolResult(
        'runtime_multiEdit',
        orderedPaths.map(path => {
          const entry = workingCopies.get(path);
          return `Edited ${path} (${entry.applied} change${entry.applied === 1 ? '' : 's'})`;
        }).join('\n')
      );
    }

    async function searchCode({
      query,
      path = '',
      glob = '**/*',
      isRegex = false,
      caseSensitive = false,
      contextLines = 0,
      maxResults = 200
    } = {}) {
      const rawQuery = String(query || '').trim();
      if (!rawQuery) {
        throw new Error('runtime_searchCode requires query.');
      }

      const flags = caseSensitive ? 'g' : 'gi';
      const matcher = new RegExp(isRegex ? rawQuery : escapeRegexLiteral(rawQuery), flags);
      const globMatcher = glob ? globPatternToRegExp(glob) : null;
      const contextRadius = Math.max(0, Math.min(5, Number(contextLines) || 0));
      const limit = Math.max(1, Math.min(500, Number(maxResults) || 200));
      const { handle } = await resolveDirectory(path, false);
      const entries = await walkDirectory(handle, path || '');
      const results = [];

      for (const entry of entries) {
        if (entry.kind !== 'file' || !supportsTextPreview(entry.handle.name)) continue;
        const normalizedPath = String(entry.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (globMatcher && !globMatcher.test(normalizedPath)) continue;

        const text = await readFileAsText(entry.handle);
        const lines = String(text || '').split(/\r?\n/);

        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          matcher.lastIndex = 0;
          if (!matcher.test(line)) continue;

          const start = Math.max(0, i - contextRadius);
          const end = Math.min(lines.length - 1, i + contextRadius);
          for (let j = start; j <= end; j += 1) {
            const prefix = j === i ? '>' : ' ';
            results.push(`${prefix} ${entry.path}:${j + 1}: ${String(lines[j] || '').slice(0, 240)}`);
            if (results.length >= limit) break;
          }

          if (results.length >= limit) break;
        }

        if (results.length >= limit) break;
      }

      return formatToolResult(
        'runtime_searchCode',
        [
          `Path: ${path || '/'}`,
          `Query: ${rawQuery}`,
          `Glob: ${glob || '**/*'}`,
          `Regex: ${isRegex ? 'yes' : 'no'}`,
          `Case-sensitive: ${caseSensitive ? 'yes' : 'no'}`,
          `Matches: ${results.length}`,
          '',
          results.join('\n') || '(no matches)'
        ].join('\n')
      );
    }

    async function writeTextFile({ path, content }) {
      if (!supportsFsAccess()) {
        const fallbackName = String(path || 'download.txt').split(/[\\/]/).pop() || 'download.txt';
        return downloadFile({ content, filename: fallbackName });
      }

      const { handle } = await resolveFile(path, true);
      await writeFile(handle, String(content || ''));
      return formatToolResult('fs_write_file', `Wrote file: ${path}`);
    }

    async function copyFile({ sourcePath, destinationPath }) {
      const source = await resolveFile(sourcePath, false);
      const destination = await resolveFile(destinationPath, true);
      await writeFile(destination.handle, await readFileAsText(source.handle));
      return formatToolResult('fs_copy_file', `Copied ${sourcePath} -> ${destinationPath}`);
    }

    async function deletePath({ path, recursive = true }) {
      const parsed = parseVirtualPath(path);
      if (!parsed.segments.length) throw new Error('Refusing to delete the root directory.');

      const name = parsed.segments.pop();
      const parentPath = parsed.rootId ? `${parsed.rootId}:/${parsed.segments.join('/')}` : parsed.segments.join('/');
      const { handle: parent } = await resolveDirectory(parentPath, false);
      await parent.removeEntry(name, { recursive: !!recursive });
      return formatToolResult('fs_delete_path', `Deleted: ${path}`);
    }

    async function moveFile({ sourcePath, destinationPath }) {
      await copyFile({ sourcePath, destinationPath });
      await deletePath({ path: sourcePath, recursive: false });
      return formatToolResult('fs_move_file', `Moved ${sourcePath} -> ${destinationPath}`);
    }

    async function renamePath({ path, newName }) {
      const parsed = parseVirtualPath(path);
      if (!parsed.segments.length) throw new Error('A path is required.');
      const currentName = parsed.segments[parsed.segments.length - 1];
      parsed.segments[parsed.segments.length - 1] = newName;
      const destination = `${parsed.rootId}:/${parsed.segments.join('/')}`;
      const source = `${parsed.rootId}:/${[...parsed.segments.slice(0, -1), currentName].join('/')}`;
      return moveFile({ sourcePath: source, destinationPath: destination });
    }

    async function listRoots() {
      const roots = [...state.roots.keys()];
      if (!roots.length) {
        return formatToolResult('fs_list_roots', '(no roots selected)\nTip: call fs_authorize_folder for the next authorization step.');
      }

      const lines = roots.map(rootId => {
        const marker = rootId === state.defaultRootId ? ' (default)' : '';
        return `${rootId}${marker}`;
      });
      return formatToolResult('fs_list_roots', lines.join('\n'));
    }

    async function fileExists({ path }) {
      try {
        await resolveFile(path, false);
        return formatToolResult('fs_exists', `${path} = true`);
      } catch {
        try {
          await resolveDirectory(path, false);
          return formatToolResult('fs_exists', `${path} = true (directory)`);
        } catch {
          return formatToolResult('fs_exists', `${path} = false`);
        }
      }
    }

    async function statPath({ path }) {
      try {
        const { handle, fileName } = await resolveFile(path, false);
        const file = await handle.getFile();
        return formatToolResult('fs_stat', `Path: ${path}\nKind: file\nName: ${fileName}\nSize: ${file.size} bytes\nType: ${file.type || 'unknown'}\nLast modified: ${new Date(file.lastModified).toISOString()}`);
      } catch {
        const { handle } = await resolveDirectory(path, false);
        const entries = await collectEntries(handle);
        return formatToolResult('fs_stat', `Path: ${path || '/'}\nKind: directory\nEntries: ${entries.length}`);
      }
    }

    async function makeDirectory({ path }) {
      await resolveDirectory(path, true);
      return formatToolResult('fs_mkdir', `Created directory: ${path}`);
    }

    async function touchFile({ path }) {
      const { handle } = await resolveFile(path, true);
      const file = await handle.getFile();
      if (file.size === 0) {
        return formatToolResult('fs_touch', `Touched file: ${path}`);
      }
      return formatToolResult('fs_touch', `File already exists: ${path}`);
    }

    async function directoryTree({ path = '' }) {
      const { handle } = await resolveDirectory(path, false);
      const entries = await walkDirectory(handle, path || '');
      const lines = entries.slice(0, 200).map(entry => `${entry.kind}: ${entry.path}`);
      return formatToolResult('fs_tree', lines.join('\n') || '(empty)');
    }

    function normalizeNameList(value) {
      if (Array.isArray(value)) {
        return value
          .map(item => String(item || '').trim().toLowerCase())
          .filter(Boolean);
      }

      if (typeof value === 'string') {
        return value
          .split(',')
          .map(item => String(item || '').trim().toLowerCase())
          .filter(Boolean);
      }

      return [];
    }

    async function walkPaths(args = {}) {
      const path = String(args.path || '').trim();
      const resolvedDepth = args.max_depth ?? args.maxDepth ?? 5;
      const resolvedResults = args.max_results ?? args.maxResults ?? 800;
      const resolvedIncludeFiles = args.include_files ?? args.includeFiles;
      const resolvedIncludeDirs = args.include_dirs ?? args.includeDirectories;
      const resolvedOutputChars = args.max_output_chars ?? args.maxOutputChars ?? 15000;
      const resolvedIncludeHidden = args.include_hidden ?? args.includeHidden;
      const excludeNames = normalizeNameList(args.excludeNames || args.exclude_names);

      const safeDepth = Math.max(0, Math.min(20, Number(resolvedDepth) || 5));
      const limit = Math.max(1, Math.min(5000, Number(resolvedResults) || 800));
      const includeFilesFlag = resolvedIncludeFiles !== false;
      const includeDirsFlag = resolvedIncludeDirs === true;
      const outputCharLimit = Math.max(1000, Math.min(19000, Number(resolvedOutputChars) || 15000));
      const includeHiddenFlag = resolvedIncludeHidden === true;
      const excludedNames = new Set(excludeNames);

      const { handle } = await resolveDirectory(path, false);
      const lines = [];
      let truncated = false;
      let currentChars = 0;

      function pushLine(line) {
        const safeLine = String(line || '');
        const projected = currentChars + safeLine.length + 1;
        if (projected > outputCharLimit) {
          truncated = true;
          return false;
        }

        lines.push(safeLine);
        currentChars = projected;
        return true;
      }

      async function visit(dirHandle, basePath, depth) {
        if (lines.length >= limit) {
          truncated = true;
          return;
        }

        for await (const [name, child] of dirHandle.entries()) {
          const lowerName = String(name || '').toLowerCase();
          if (excludedNames.has(lowerName)) {
            continue;
          }

          if (!includeHiddenFlag && lowerName.startsWith('.')) {
            continue;
          }

          const fullPath = `${basePath}/${name}`.replace(/^\/+/, '/');
          const label = `${child.kind}: ${fullPath}`;

          if (child.kind === 'directory') {
            if (includeDirsFlag) {
              if (!pushLine(label)) return;
              if (lines.length >= limit) {
                truncated = true;
                return;
              }
            }

            if (depth < safeDepth) {
              await visit(child, fullPath, depth + 1);
              if (truncated) return;
            }
            continue;
          }

          if (includeFilesFlag) {
            if (!pushLine(label)) return;
            if (lines.length >= limit) {
              truncated = true;
              return;
            }
          }
        }
      }

      await visit(handle, path || '', 0);

      return formatToolResult(
        'fs_walk',
        [
          `Path: ${path || '/'}`,
          `Depth: ${safeDepth}`,
          `Include files: ${includeFilesFlag ? 'yes' : 'no'}`,
          `Include directories: ${includeDirsFlag ? 'yes' : 'no'}`,
          `Include hidden: ${includeHiddenFlag ? 'yes' : 'no'}`,
          `Excluded names: ${excludeNames.length ? excludeNames.join(', ') : '(none)'}`,
          `Results: ${lines.length}`,
          `Truncated: ${truncated ? 'yes' : 'no'}`,
          '',
          lines.join('\n') || '(no entries)'
        ].join('\n')
      );
    }

    async function savePickedUpload({ uploadName, destinationPath }) {
      const handle = state.uploads.get(String(uploadName || ''));
      if (!handle) {
        throw new Error('Upload not found in session. Run fs_upload_pick first.');
      }

      const file = await handle.getFile();
      const destination = await resolveFile(destinationPath, true);
      await writeFile(destination.handle, await file.arrayBuffer());
      return formatToolResult('fs_save_upload', `Saved upload ${uploadName} -> ${destinationPath}`);
    }

    return {
      authorizeFolder,
      listDirectory,
      readLocalFile,
      pickUpload,
      downloadFile,
      previewFile,
      searchByName,
      searchByContent,
      globPaths,
      grepPaths,
      searchCode,
      editLocalFile,
      multiEditFiles,
      writeTextFile,
      copyFile,
      deletePath,
      moveFile,
      renamePath,
      listRoots,
      fileExists,
      statPath,
      makeDirectory,
      touchFile,
      directoryTree,
      walkPaths,
      savePickedUpload,
      pickDirectory
    };
  };
})();
