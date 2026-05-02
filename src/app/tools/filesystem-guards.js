;(function() {
  function normalizePathInput(value) {
    return String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '').trim();
  }

  function containsGlobPattern(value) {
    return /[*?[\]{}]/.test(String(value || ''));
  }

  function containsVulnerableUncPathLight(value) {
    var text = String(value || '');
    return text.startsWith('\\\\') || text.startsWith('//');
  }

  function hasSuspiciousWindowsPathPattern(value) {
    var text = String(value || '');
    if (!text) return false;
    var firstColon = text.indexOf(':');
    if (firstColon >= 0) {
      var secondColon = text.indexOf(':', firstColon + 1);
      if (secondColon !== -1) return true;
    }
    if (text.startsWith('\\\\?\\') || text.startsWith('\\\\.\\') || text.startsWith('//?/') || text.startsWith('//./')) return true;
    // Windows 8.3 short names: ~1, ~2, etc. (hex digits after tilde)
    if (/~[\dA-Fa-f]{1,4}(?=[\\/]|$)/.test(text)) return true;
    if (/[.\s]+$/.test(text) && !/^\.{1,2}$/.test(text.replace(/.*[\\/]/, ''))) return true;
    if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(text)) return true;
    if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(text)) return true;
    return false;
  }

  function isDangerousRemovalPath(pathValue) {
    var normalized = String(pathValue || '').replace(/[\\/]+/g, '/').trim();
    if (!normalized) return true;
    if (normalized === '*' || normalized.endsWith('/*')) return true;
    var withoutTrailingSlash = normalized === '/' ? normalized : normalized.replace(/\/$/, '');
    if (withoutTrailingSlash === '/') return true;
    if (/^[A-Za-z]:\/?$/.test(withoutTrailingSlash)) return true;
    var parent = withoutTrailingSlash.includes('/')
      ? withoutTrailingSlash.slice(0, withoutTrailingSlash.lastIndexOf('/')) || '/'
      : '';
    if (parent === '/') return true;
    if (/^[A-Za-z]:\/[^/]+$/.test(withoutTrailingSlash)) return true;
    return false;
  }

  function getFilesystemOperationType(toolName) {
    var tool = String(toolName || '').trim();
    var writeTools = new Set(['fs_write_file','file_write','write_file','file_edit','edit_file','fs_copy_file','fs_move_file','fs_delete_path','fs_rename_path','fs_mkdir','fs_touch','fs_save_upload','fs_append_file']);
    if (writeTools.has(tool)) return 'write';
    if (tool === 'fs_download_file') return 'create';
    if (tool.startsWith('fs_') || tool === 'file_read' || tool === 'read_file' || tool === 'glob' || tool === 'grep') return 'read';
    return 'none';
  }

  function extractFilesystemPathsFromArgs(toolName, args) {
    var tool = String(toolName || '').trim();
    var normalizedArgs = (args && typeof args === 'object' && !Array.isArray(args)) ? Object.assign({}, args) : {};
    var values = [];
    var push = function(name, value) {
      var path = normalizePathInput(value);
      if (!path) return;
      values.push({ arg: name, path: path });
    };
    var generalKeys = ['path','filePath','sourcePath','destinationPath','new_path','newPath','root','directory'];
    for (var ki = 0; ki < generalKeys.length; ki++) {
      var key = generalKeys[ki];
      if (Object.prototype.hasOwnProperty.call(normalizedArgs, key)) push(key, normalizedArgs[key]);
    }
    if (tool === 'fs_rename_path' && normalizedArgs.newName) {
      var sourcePath = normalizePathInput(normalizedArgs.path);
      var parent = sourcePath.replace(/[\\/]+/g, '/').split('/').slice(0, -1).join('/');
      var candidate = parent ? parent + '/' + normalizedArgs.newName : String(normalizedArgs.newName);
      push('newName', candidate);
    }
    return values;
  }

  function validateFilesystemCallGuard(call) {
    var operationType = getFilesystemOperationType(call && call.tool);
    if (operationType === 'none') return { allowed: true };
    // fs_download_file without a path is a pure browser Blob download — no FS auth needed
    if (String(call && call.tool || '') === 'fs_download_file') {
      var dlArgs = (call && call.args) || {};
      // Content-based or bare-filename downloads don't touch the filesystem
      if (!dlArgs.path) return { allowed: true };
      // If path is provided, fall through to normal path validation below
    }
    var paths = extractFilesystemPathsFromArgs(call && call.tool, call && call.args);
    if (!paths.length && operationType !== 'read') {
      return { allowed: false, reason: 'A valid filesystem path is required for this write operation.' };
    }
    for (var i = 0; i < paths.length; i++) {
      var item = paths[i];
      var path = item.path;
      if (containsVulnerableUncPathLight(path)) return { allowed: false, reason: 'UNC network path \'' + path + '\' requires explicit manual approval.', path: path };
      if (path.startsWith('~') && !/^~(?:\/|\\|$)/.test(path)) return { allowed: false, reason: 'Tilde expansion variant in \'' + path + '\' requires manual approval.', path: path };
      if (path.includes('$') || path.includes('%') || path.startsWith('=')) return { allowed: false, reason: 'Shell expansion syntax in \'' + path + '\' requires manual approval.', path: path };
      if (hasSuspiciousWindowsPathPattern(path)) return { allowed: false, reason: 'Suspicious Windows path pattern detected in \'' + path + '\'.', path: path };
      if ((operationType === 'write' || operationType === 'create') && containsGlobPattern(path)) return { allowed: false, reason: 'Glob patterns are blocked for write operations (\'' + path + '\'). Use an exact path.', path: path };
    }
    if (String(call && call.tool || '') === 'fs_delete_path') {
      var target = normalizePathInput(call && call.args && call.args.path);
      if (isDangerousRemovalPath(target)) return { allowed: false, reason: 'Refusing dangerous delete target \'' + (target || '(empty)') + '\'.', path: target };
    }
    return { allowed: true };
  }

  window.AgentFsGuards = {
    normalizePathInput: normalizePathInput,
    containsGlobPattern: containsGlobPattern,
    containsVulnerableUncPathLight: containsVulnerableUncPathLight,
    hasSuspiciousWindowsPathPattern: hasSuspiciousWindowsPathPattern,
    isDangerousRemovalPath: isDangerousRemovalPath,
    getFilesystemOperationType: getFilesystemOperationType,
    extractFilesystemPathsFromArgs: extractFilesystemPathsFromArgs,
    validateFilesystemCallGuard: validateFilesystemCallGuard
  };
})();