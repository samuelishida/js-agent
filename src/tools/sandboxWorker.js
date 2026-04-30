// ── Sandbox Worker for Dangerous Tools ──
// Runs in a Dedicated Web Worker. No access to window/DOM.
// Validates + sanitizes commands before proxying to dev server.

'use strict';

const DANGEROUS_CMD_PATTERNS = [
  /rm\s+(-rf?|\/s)\s+[/\\]/i,
  /Remove-Item\s+[/\\]/i,
  /del\s+\/[sq]\s+[/\\]/i,
  /(?:format|fdisk|diskpart|mkfs)\s/i,
  /sudo\s/i,
  /chmod\s+[7-9]\d{3}\s/i,
  /chown\s/i
];

const ESCAPE_PATTERNS = [
  /window\.location\s*=/i,
  /document\.write/i,
  /eval\s*\(/i,
  /new\s+Function\s*\(/i,
  /postMessage\s*\(/i,
  /parent\.window/i,
  /top\.window/i
];

const ALLOWED_TOOLS = new Set(['run_terminal', 'fswritefile', 'fsdelete']);

function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') return { valid: false, error: 'Invalid message format' };
  const tool = String(msg.tool || '').trim();
  if (!ALLOWED_TOOLS.has(tool)) return { valid: false, error: `Tool '${tool}' not allowed in sandbox` };
  const text = JSON.stringify(msg);
  for (const pattern of ESCAPE_PATTERNS) {
    if (pattern.test(text)) return { valid: false, error: `Escape attempt detected` };
  }
  return { valid: true };
}

function validateTerminalCommand(command) {
  if (!command || typeof command !== 'string') throw new Error('Command is required');
  for (const pattern of DANGEROUS_CMD_PATTERNS) {
    if (pattern.test(command)) throw new Error(`Blocked dangerous command pattern`);
  }
}

function validateFilePath(path) {
  if (!path || typeof path !== 'string') throw new Error('Path is required');
  if (path.replace(/\\/g, '/').includes('..')) throw new Error('Path traversal not allowed');
}

function validateFileContent(content, maxSize) {
  if (typeof content !== 'string') throw new Error('Content must be a string');
  if (content.length > maxSize) throw new Error(`Content exceeds ${maxSize} bytes`);
}

function sanitizeContent(content) {
  return content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/\bon\w+\s*=/gi, '');
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n[truncated: ${str.length - maxLen} chars]`;
}

async function executeTerminalSandbox(args) {
  const { command, cwd } = args || {};
  validateTerminalCommand(command);
  const headers = { 'Content-Type': 'application/json' };
  if (self._terminalToken) headers['Authorization'] = `Bearer ${self._terminalToken}`;
  const res = await fetch('/api/terminal', {
    method: 'POST',
    headers,
    body: JSON.stringify({ command, cwd: cwd || '' })
  });
  const data = await res.json();
  const output = String(data?.result || data?.output || '');
  return truncate(output, 5000);
}

async function executeFileWriteSandbox(args) {
  const { path, content } = args || {};
  validateFilePath(path);
  validateFileContent(content, 1048576);
  const sanitized = sanitizeContent(content);
  const res = await fetch('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content: sanitized })
  });
  return await res.json();
}

async function executeFileDeleteSandbox(args) {
  const { path, recursive } = args || {};
  validateFilePath(path);
  if (path.includes('*') || path.includes('?')) throw new Error('Glob patterns not allowed');
  if (path === '/' || /^[A-Za-z]:[/\\]?$/.test(path)) throw new Error('Root directory deletion not allowed');
  const res = await fetch('/api/files/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, recursive: !!recursive })
  });
  return await res.json();
}

self.onmessage = async function(event) {
  const msg = event.data;

  // Handle config messages from the main thread
  if (msg && msg.type === '__config') {
    if (msg.terminalToken) self._terminalToken = msg.terminalToken;
    return;
  }

  const valid = validateMessage(msg);
  if (!valid.valid) {
    self.postMessage({ type: 'error', error: valid.error });
    return;
  }

  const { tool, args } = msg;

  try {
    let result;
    if (tool === 'run_terminal') result = await executeTerminalSandbox(args);
    else if (tool === 'fswritefile') result = await executeFileWriteSandbox(args);
    else if (tool === 'fsdelete') result = await executeFileDeleteSandbox(args);
    else { self.postMessage({ type: 'error', error: `Unknown tool: ${tool}` }); return; }

    self.postMessage({ type: 'result', tool, result });
  } catch (err) {
    self.postMessage({ type: 'error', tool, error: truncate(String(err?.message || err), 300) });
  }
};

self.postMessage({ type: 'ready' });