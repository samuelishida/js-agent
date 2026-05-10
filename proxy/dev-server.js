#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 5500);
const ROOT = process.cwd();
const SANDBOX_DIR = path.join(ROOT, 'agent-sandbox');

// Ensure sandbox directory exists for runtime_generateFile output
try { fs.mkdirSync(SANDBOX_DIR, { recursive: true }); } catch {}
const OLLAMA_BASE = 'https://ollama.com';
const OPENROUTER_BASE = 'https://openrouter.ai';
const API_PREFIX = '/api/ollama/v1';
const OPENROUTER_PREFIX = '/api/openrouter';
const GNEWS_PREFIX = '/api/gnews';
const GNEWS_BASE = 'https://news.google.com';
const TERMINAL_PREFIX = '/api/terminal';
const DIAGNOSTICS_PREFIX = '/api/diagnostics';
const HEALTH_PREFIX = '/api/health';
const ENV_PREFIX = '/api/env';
const MCP_PROXY_PREFIX = '/api/mcp-proxy';
const MCP_SSE_PREFIX = '/api/mcp-sse-proxy';
const MCP_STDIO_PREFIX = '/api/mcp-stdio';


function isPathInsideRoot(root, candidate) {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(normalizedRoot, candidate);
  const rel = path.relative(normalizedRoot, normalizedCandidate);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function getOpenRouterApiKey() {
  return process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY || '';
}

// Terminal auth token — persisted across restarts so browser sessions survive server reloads.
// Prevents non-browser callers from running terminal commands even if they know the URL.
const TOKEN_FILE = path.join(ROOT, '.terminal-token');
let TERMINAL_TOKEN;
try {
  TERMINAL_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
} catch {
  TERMINAL_TOKEN = randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TERMINAL_TOKEN, 'utf-8');
}

// Dangerous command patterns blocked server-side (defence-in-depth; client also filters).
const DANGEROUS_CMD_PATTERNS = [
  /\brm\s+(-[rRf]+\s+\/|\/\s+-[rRf]+)/,   // rm -rf /
  /:\s*\(\s*\)\s*\{\s*:\s*\|/,              // fork bomb  :(){ :|:& };:
  /\bdd\b.+\bof\s*=\s*\/dev\//i,            // dd to raw disk
  /\bmkfs\b/i,                              // format filesystem
  /\bformat\s+[a-z]:\s*$/i,                // Windows format drive
  /\b(shutdown|reboot|halt|poweroff)\b/i,  // system shutdown
  />\s*\/dev\/(sda|hda|nvme)/i             // overwrite block device
];

function isDangerousCommand(cmd) {
  const s = String(cmd || '');
  return DANGEROUS_CMD_PATTERNS.some(re => re.test(s));
}

// Check whether the request originates from localhost (same machine as the server).
function isLocalhostOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true; // no origin = same-origin or non-browser
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 100;
const ipHits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const hits = ipHits.get(ip) || [];
  const recent = hits.filter(t => t > windowStart);
  ipHits.set(ip, recent);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  return true;
}

function send(res, status, body, headers = {}) {
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
  };
  res.writeHead(status, { ...securityHeaders, ...headers });
  res.end(body);
}

function sanitizeHeaders(headers) {
  const safe = { ...headers };
  delete safe.host;
  delete safe.origin;
  delete safe.referer;
  delete safe.connection;
  delete safe['content-length'];
  return safe;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyOllama(req, res, parsedUrl) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'authorization,content-type',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }

  const suffix = parsedUrl.pathname.slice(API_PREFIX.length) || '';
  const upstreamPath = `/v1${suffix}${parsedUrl.search || ''}`;
  const upstreamUrl = new URL(upstreamPath, OLLAMA_BASE);
  const method = String(req.method || 'GET').toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? null : await readRequestBody(req);
  const headers = sanitizeHeaders(req.headers);

  if (!headers.authorization && process.env.OLLAMA_API_KEY) {
    headers.authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
  }
  if (body) headers['content-length'] = String(body.length);

  const options = {
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || 443,
    path: upstreamUrl.pathname + upstreamUrl.search,
    method,
    headers
  };

  const upstreamReq = https.request(options, upstreamRes => {
    const passHeaders = {};
    const contentType = upstreamRes.headers['content-type'];
    if (contentType) passHeaders['Content-Type'] = contentType;
    passHeaders['Cache-Control'] = 'no-store';
    passHeaders['Access-Control-Allow-Origin'] = '*';

    res.writeHead(upstreamRes.statusCode || 502, passHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', err => {
    send(res, 502, JSON.stringify({ error: `Proxy error: ${err.message}` }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  });

  if (body) upstreamReq.write(body);
  upstreamReq.end();
}

function resolveSafeCwd(rawCwd = '') {
  const trimmed = String(rawCwd || '').trim();
  const candidate = path.resolve(ROOT, trimmed || '.');
  return isPathInsideRoot(ROOT, candidate) ? candidate : path.resolve(ROOT);
}

function readJsonBody(req) {
  return readRequestBody(req).then(buffer => {
    const text = String(buffer || '').trim();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { throw new Error('Request body is not valid JSON'); }
  });
}

function runCommand(command, cwd, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > 120000) stdout = stdout.slice(-120000);
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 120000) stderr = stderr.slice(-120000);
    });

    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          code: 124,
          output: `Command timed out after ${timeoutMs}ms.\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`.trim()
        });
        return;
      }

      resolve({
        ok: code === 0,
        code: Number(code || 0),
        output: `Exit code: ${Number(code || 0)}\n\nSTDOUT:\n${stdout || '(empty)'}\n\nSTDERR:\n${stderr || '(empty)'}`.trim()
      });
    });
  });
}

async function handleTerminal(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  // Enforce terminal auth token
  const authHeader = String(req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== TERMINAL_TOKEN) {
    send(res, 401, JSON.stringify({ error: 'Unauthorized: invalid or missing terminal token' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const command = String(body.command || '').trim();
    if (!command) {
      send(res, 400, JSON.stringify({ error: 'command is required' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }
    if (command.length > 4096) {
      send(res, 400, JSON.stringify({ error: 'Command too long (max 4096 chars)' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }
    if (isDangerousCommand(command)) {
      send(res, 400, JSON.stringify({ error: 'Command blocked: matches dangerous pattern' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    const cwd = resolveSafeCwd(body.cwd);
    const result = await runCommand(command, cwd, 60000);
    send(res, result.ok ? 200 : 200, JSON.stringify({
      ok: result.ok,
      code: result.code,
      result: `$ ${command}\nCWD: ${cwd}\n\n${result.output}`
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ error: `Terminal error: ${error.message}` }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
  }
}

async function handleTerminalMultipart(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  // Enforce terminal auth token
  const authHeader = String(req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== TERMINAL_TOKEN) {
    send(res, 401, JSON.stringify({ error: 'Unauthorized: invalid or missing terminal token' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const command = String(body.command || '').trim();
    if (!command) {
      send(res, 400, JSON.stringify({ error: 'command is required' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }
    if (command.length > 4096) {
      send(res, 400, JSON.stringify({ error: 'Command too long (max 4096 chars)' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }
    if (isDangerousCommand(command)) {
      send(res, 400, JSON.stringify({ error: 'Command blocked: matches dangerous pattern' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    // Handle inline files array: [{path, content: base64, mode}]
    const files = body.files;
    if (Array.isArray(files) && files.length > 0) {
      for (const file of files) {
        const filePath = String(file.path || '').trim();
        const content = String(file.content || '');
        const fileMode = parseInt(String(file.mode || '0644'), 8);
        if (!filePath || !content) continue;
        const absPath = path.resolve(ROOT, filePath);
        if (!isPathInsideRoot(ROOT, absPath)) continue;
        // content is base64
        try {
          const buffer = Buffer.from(content, 'base64');
          const dir = path.dirname(absPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(absPath, buffer);
          if (fileMode) fs.chmodSync(absPath, fileMode);
        } catch (e) { /* skip failed file write */ }
      }
    }

    const cwd = resolveSafeCwd(body.cwd);
    const result = await runCommand(command, cwd, 60000);
    send(res, result.ok ? 200 : 200, JSON.stringify({
      ok: result.ok,
      code: result.code,
      result: `$ ${command}\nCWD: ${cwd}\n\n${result.output}`
    }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ error: `Terminal error: ${error.message}` }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
  }
}

async function handleDiagnostics(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const relPath = String(body.path || '').trim();
    const severity = String(body.severity || 'all').trim().toLowerCase();
    const absPath = relPath ? path.resolve(ROOT, relPath) : '';
    if (absPath && !isPathInsideRoot(ROOT, absPath)) {
      send(res, 400, JSON.stringify({ error: 'path must stay within the workspace root' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    let resultText = '';
    if (absPath && /\.json$/i.test(absPath)) {
      try {
        JSON.parse(await fs.promises.readFile(absPath, 'utf-8'));
        resultText = `No JSON diagnostics for ${relPath}.`;
      } catch (error) {
        resultText = `JSON parse error in ${relPath}: ${error.message}`;
      }
    } else if (absPath && /\.(js|cjs|mjs)$/i.test(absPath)) {
      const command = `node --check "${absPath}"`;
      const result = await runCommand(command, ROOT, 30000);
      resultText = result.ok ? `No diagnostics for ${relPath}.` : result.output;
    } else {
      resultText = `No type-checking available for ${relPath}. Only .js and .json files are checked.`;
    }

    if (severity === 'error') {
      resultText = resultText
        .split(/\r?\n/)
        .filter(line => /error/i.test(line) || !line.trim())
        .join('\n')
        .trim() || resultText;
    }

    send(res, 200, JSON.stringify({ ok: true, result: resultText }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ error: `Diagnostics error: ${error.message}` }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
  }
}

function resolveFilePath(parsedUrl) {
  let reqPath = decodeURIComponent(parsedUrl.pathname || '/');
  if (reqPath === '/') reqPath = '/index.html';
  const abs = path.resolve(ROOT, `.${reqPath}`);
  if (!isPathInsideRoot(ROOT, abs)) return null;
  return abs;
}

function serveStatic(req, res, parsedUrl) {
  const absPath = resolveFilePath(parsedUrl);
  if (!absPath) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.stat(absPath, (statErr, stats) => {
    if (statErr || !stats) {
      send(res, 404, 'Not Found');
      return;
    }

    const filePath = stats.isDirectory() ? path.join(absPath, 'index.html') : absPath;
    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        send(res, 404, 'Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      send(res, 200, content, {
        'Content-Type': contentType,
        'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      });
    });
  });
}

async function proxyOpenRouter(req, res, parsedUrl) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'authorization,content-type',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }

  if (!getOpenRouterApiKey()) {
    send(res, 503, JSON.stringify({ error: 'OpenRouter API key not configured on server' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  const suffix = parsedUrl.pathname.slice(OPENROUTER_PREFIX.length) || '';
  const upstreamPath = `/api/v1${suffix}${parsedUrl.search || ''}`;
  const upstreamUrl = new URL(upstreamPath, OPENROUTER_BASE);
  const method = String(req.method || 'POST').toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? null : await readRequestBody(req);
  const headers = sanitizeHeaders(req.headers);

  // Inject server-side key — client never sees the raw key
  headers.authorization = `Bearer ${getOpenRouterApiKey()}`;
  headers['http-referer'] = `http://localhost:${PORT}`;
  headers['x-title'] = 'JS Agent';
  if (body) headers['content-length'] = String(body.length);

  const options = {
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || 443,
    path: upstreamUrl.pathname + upstreamUrl.search,
    method,
    headers
  };

  const upstreamReq = https.request(options, upstreamRes => {
    const passHeaders = {};
    const contentType = upstreamRes.headers['content-type'];
    if (contentType) passHeaders['Content-Type'] = contentType;
    passHeaders['Cache-Control'] = 'no-store';
    passHeaders['Access-Control-Allow-Origin'] = '*';
    res.writeHead(upstreamRes.statusCode || 502, passHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', err => {
    send(res, 502, JSON.stringify({ error: `OpenRouter proxy error: ${err.message}` }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  });

  if (body) upstreamReq.write(body);
  upstreamReq.end();
}

// ── MCP proxy helpers ──────────────────────────────────────────────────────

function isPrivateNetwork(url) {
  const hostname = String(url || '').trim().toLowerCase();
  // Extract hostname from a full URL if needed
  let h;
  try { h = new URL(url).hostname.toLowerCase(); } catch { h = hostname; }
  // Private IPv4 ranges
  if (/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.)/.test(h)) return true;
  if (h === 'localhost') return false; // localhost is explicitly allowed below
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 ULA
  return false;
}

function isLocalhost(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase(); } catch { h = String(url).toLowerCase(); }
  return /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/.test(h);
}

async function handleMcpProxy(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  if (!isLocalhostOrigin(req)) {
    send(res, 403, JSON.stringify({ error: 'Forbidden' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const serverUrl = String(body.serverUrl || '').trim();
    const method = String(body.method || '').trim();
    const params = body.params || {};
    const authHeader = String(body.authHeader || body.headers?.Authorization || '').trim();

    if (!serverUrl || !method) {
      send(res, 400, JSON.stringify({ error: 'serverUrl and method are required' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    const parsed = new URL(serverUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      send(res, 400, JSON.stringify({ error: 'serverUrl must use http or https' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    // SSRF: block private network targets unless explicitly trusted local
    const trustedLocal = body.trustedLocal === true;
    if (!isLocalhost(serverUrl) && isPrivateNetwork(serverUrl) && !trustedLocal) {
      send(res, 403, JSON.stringify({ error: 'SSRF: private network targets are blocked' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(rpcBody).toString()
    };
    if (authHeader) headers['Authorization'] = authHeader;

    const upstreamModule = parsed.protocol === 'https:' ? https : http;
    const upstreamReq = upstreamModule.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
      timeout: 15000
    }, upstreamRes => {
      let data = '';
      upstreamRes.on('data', chunk => { data += chunk.toString(); });
      upstreamRes.on('end', () => {
        send(res, 200, data, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*'
        });
      });
    });

    upstreamReq.on('error', err => {
      send(res, 502, JSON.stringify({ error: `MCP proxy error: ${err.message}` }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
    });
    upstreamReq.write(rpcBody);
    upstreamReq.end();
  } catch (error) {
    send(res, 500, JSON.stringify({ error: `MCP proxy error: ${error.message}` }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
  }
}

// ── MCP SSE proxy helpers ──────────────────────────────────────────────────

/** @type {Map<string, { endpoint: string, eventSource: http.IncomingMessage, resolvers: Map<number|string, Function>, parser: import('http').IncomingMessage, createdAt: number, lastUsedAt: number }>} */
const _sseSessions = new Map();
const SSE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SSE_MAX_SESSIONS = 20;
const SSE_MAX_BODY_BYTES = 2 * 1024 * 1024;

function _sseKey(serverUrl, authHeader) {
  return `${serverUrl}||${authHeader || ''}`;
}

function _closeSseSession(key) {
  const session = _sseSessions.get(key);
  if (!session) return;
  try { session.parser.destroy(); } catch {}
  _sseSessions.delete(key);
}

async function handleMcpSseProxy(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  if (!isLocalhostOrigin(req)) {
    send(res, 403, JSON.stringify({ error: 'Forbidden' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const serverUrl = String(body.serverUrl || '').trim();
    const method = String(body.method || '').trim();
    const params = body.params || {};
    const authHeader = String(body.authHeader || body.headers?.Authorization || '').trim();

    if (!serverUrl || !method) {
      send(res, 400, JSON.stringify({ error: 'serverUrl and method are required' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    const parsed = new URL(serverUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      send(res, 400, JSON.stringify({ error: 'serverUrl must use http or https' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    // SSRF
    const trustedLocal = body.trustedLocal === true;
    if (!isLocalhost(serverUrl) && isPrivateNetwork(serverUrl) && !trustedLocal) {
      send(res, 403, JSON.stringify({ error: 'SSRF: private network targets are blocked' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    const key = _sseKey(serverUrl, authHeader);
    let session = _sseSessions.get(key);

    if (session) {
      session.lastUsedAt = Date.now();
    } else {
      // Open SSE GET to serverUrl
      const upstreamModule = parsed.protocol === 'https:' ? https : http;
      const getPath = parsed.pathname + parsed.search;
      const getRes = await new Promise((resolve, reject) => {
        const getReq = upstreamModule.request({
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: getPath,
          method: 'GET',
          headers: {
            'Accept': 'text/event-stream',
            ...(authHeader ? { 'Authorization': authHeader } : {})
          },
          timeout: 15000
        }, upstreamRes => {
          if (upstreamRes.statusCode !== 200) {
            resolve({ error: `SSE endpoint returned HTTP ${upstreamRes.statusCode}` });
            return;
          }
          resolve({ ok: true, res: upstreamRes });
        });
        getReq.on('error', err => reject(err));
        getReq.on('timeout', () => { getReq.destroy(); reject(new Error('SSE connect timeout')); });
        getReq.end();
      });

      if (getRes.error) {
        send(res, 502, JSON.stringify({ error: getRes.error }), {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        return;
      }

      session = {
        endpoint: null,
        parser: getRes.res,
        resolvers: new Map(),
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      };

      // Evict oldest if over limit
      if (_sseSessions.size >= SSE_MAX_SESSIONS) {
        const oldest = [..._sseSessions.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
        if (oldest) _closeSseSession(oldest[0]);
      }
      _sseSessions.set(key, session);

      // Parse SSE events
      let buffer = '';
      getRes.res.on('data', chunk => {
        buffer += chunk.toString();
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const evt of events) {
          const lines = evt.split('\n');
          let eventName = 'message';
          let dataLines = [];
          for (const line of lines) {
            if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
          }
          const data = dataLines.join('\n');
          if (eventName === 'endpoint' && !session.endpoint) {
            let endpoint = data;
            // Resolve relative endpoint against server origin
            if (endpoint && !endpoint.startsWith('http')) {
              endpoint = new URL(endpoint, `${parsed.protocol}//${parsed.host}`).href;
            }
            session.endpoint = endpoint;
            // Resolve any pending waiters for endpoint
            const waiters = session.endpointWaiters;
            if (waiters) {
              for (const w of waiters) w.resolve(endpoint);
              session.endpointWaiters = [];
            }
            continue;
          }
          if (eventName === 'message' && data) {
            try {
              const msg = JSON.parse(data);
              if (msg.id !== undefined && session.resolvers.has(msg.id)) {
                const resolve = session.resolvers.get(msg.id);
                session.resolvers.delete(msg.id);
                resolve({ ok: true, result: msg.result, error: msg.error });
              }
            } catch { /* ignore non-JSON events */ }
          }
        }
      });

      getRes.res.on('close', () => {
        for (const [id, resolve] of session.resolvers) {
          resolve({ ok: false, error: { code: -32000, message: 'SSE connection closed' } });
        }
        session.resolvers.clear();
        _sseSessions.delete(key);
      });

      getRes.res.on('error', () => {
        for (const [id, resolve] of session.resolvers) {
          resolve({ ok: false, error: { code: -32000, message: 'SSE connection error' } });
        }
        session.resolvers.clear();
        _sseSessions.delete(key);
      });

      // Wait for endpoint event
      let endpoint = session.endpoint;
      if (!endpoint) {
        endpoint = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('SSE endpoint event timeout')), 10000);
          if (!session.endpointWaiters) session.endpointWaiters = [];
          session.endpointWaiters.push({
            resolve: (ep) => { clearTimeout(timer); resolve(ep); },
            reject: (err) => { clearTimeout(timer); reject(err); }
          });
        });
      }
      session.endpoint = endpoint;
    }

    // POST JSON-RPC to endpoint
    const reqId = body.id !== undefined ? body.id : (Date.now() + Math.floor(Math.random() * 100000));
    const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params });
    if (Buffer.byteLength(rpcBody) > SSE_MAX_BODY_BYTES) {
      send(res, 400, JSON.stringify({ error: 'Request body too large' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    const postParsed = new URL(session.endpoint);
    const upstreamModule = postParsed.protocol === 'https:' ? https : http;

    const postRes = await new Promise((resolve, reject) => {
      const postReq = upstreamModule.request({
        hostname: postParsed.hostname,
        port: postParsed.port || (postParsed.protocol === 'https:' ? 443 : 80),
        path: postParsed.pathname + postParsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rpcBody).toString(),
          ...(authHeader ? { 'Authorization': authHeader } : {})
        },
        timeout: 15000
      }, upstreamRes => {
        let data = '';
        upstreamRes.on('data', chunk => { data += chunk.toString(); });
        upstreamRes.on('end', () => {
          // Some SSE servers return JSON-RPC directly in the POST response
          try {
            const msg = JSON.parse(data);
            resolve({ ok: true, result: msg.result, error: msg.error, direct: true });
          } catch {
            resolve({ ok: true, result: null, error: null, direct: false });
          }
        });
      });
      postReq.on('error', err => reject(err));
      postReq.on('timeout', () => { postReq.destroy(); reject(new Error('POST timeout')); });
      postReq.write(rpcBody);
      postReq.end();
    });

    if (postRes.direct && (postRes.result !== undefined || postRes.error !== undefined)) {
      send(res, 200, JSON.stringify({ jsonrpc: '2.0', id: reqId, result: postRes.result, error: postRes.error }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    // Wait for SSE response by matching id
    const sseResult = await new Promise((resolve, reject) => {
      session.resolvers.set(reqId, resolve);
      const timer = setTimeout(() => {
        session.resolvers.delete(reqId);
        resolve({ ok: false, error: { code: -32000, message: 'SSE response timeout' } });
      }, 15000);
    });

    if (!sseResult.ok) {
      send(res, 502, JSON.stringify({ jsonrpc: '2.0', id: reqId, error: sseResult.error }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    send(res, 200, JSON.stringify({ jsonrpc: '2.0', id: reqId, result: sseResult.result, error: sseResult.error }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
  } catch (error) {
    send(res, 502, JSON.stringify({ error: `MCP SSE proxy error: ${error.message}` }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
  }
}

// Idle cleanup timer for SSE sessions
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of _sseSessions) {
    if (now - session.lastUsedAt > SSE_IDLE_TIMEOUT_MS) {
      _closeSseSession(key);
    }
  }
}, 60000);

async function proxyGoogleNews(req, res, parsedUrl) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }

  const suffix = parsedUrl.pathname.slice(GNEWS_PREFIX.length) || '';
  const upstreamUrl = new URL(`${suffix}${parsedUrl.search || ''}`, GNEWS_BASE);

  const options = {
    protocol: 'https:',
    hostname: upstreamUrl.hostname,
    port: 443,
    path: upstreamUrl.pathname + upstreamUrl.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; js-agent-proxy/1.0)',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    }
  };

  const upstreamReq = https.request(options, upstreamRes => {
    const passHeaders = {};
    const contentType = upstreamRes.headers['content-type'];
    if (contentType) passHeaders['Content-Type'] = contentType;
    passHeaders['Cache-Control'] = 'no-store';
    passHeaders['Access-Control-Allow-Origin'] = '*';
    res.writeHead(upstreamRes.statusCode || 502, passHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', err => {
    send(res, 502, JSON.stringify({ error: `Google News proxy error: ${err.message}` }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  });

  upstreamReq.end();
}

async function handleHealth(req, res) {
  const health = {
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '0.1.0',
    node: process.version,
    env: process.env.NODE_ENV || 'development'
  };
  send(res, 200, JSON.stringify(health), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
}

async function handleEnv(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }
  if (req.method !== 'GET') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }
  // Restrict sensitive env data to localhost origins only.
  // External pages (DNS rebinding, malicious sites) cannot read the token or key presence.
  if (!isLocalhostOrigin(req)) {
    send(res, 403, JSON.stringify({ error: 'Forbidden' }), {
      'Content-Type': 'application/json; charset=utf-8'
    });
    return;
  }
  const env = {
    hasOpenRouterKey: !!getOpenRouterApiKey(),
    terminalToken: TERMINAL_TOKEN
  };
  const corsOrigin = req.headers.origin || `http://localhost:${PORT}`;
  send(res, 200, JSON.stringify(env), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': corsOrigin,
    'Vary': 'Origin'
  });
}

// ── MCP stdio sidecar helpers ──────────────────────────────────────────────

/** @type {Map<string, { id: string, process: import('child_process').ChildProcess, stdoutBuffer: string, stderrRing: string[], pendingResolves: Map<number, Function>, state: 'running'|'dead', createdAt: number }>} */
const _stdioSessions = new Map();

function isAllowedStdioCommand(cmd) {
  const base = path.basename(cmd);
  if (['node', 'python', 'python3', 'uvx'].includes(base)) return true;
  if (cmd.startsWith('/')) return true;
  if (/^[A-Z]:\\/i.test(cmd)) return true;
  return false;
}

function hasShellMetacharacters(str) {
  return /[;|&$`"<>(){}[\]*?]/.test(str);
}

async function handleMcpStdioCreate(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type,authorization',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  const authHeader = String(req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== TERMINAL_TOKEN) {
    send(res, 401, JSON.stringify({ error: 'Unauthorized: invalid or missing terminal token' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }
  if (!isLocalhostOrigin(req)) {
    send(res, 403, JSON.stringify({ error: 'Forbidden' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const command = String(body.command || '').trim();
    if (!command) {
      send(res, 400, JSON.stringify({ error: 'command is required' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }
    if (!isAllowedStdioCommand(command)) {
      send(res, 400, JSON.stringify({ error: 'Command not allowed' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }
    if (hasShellMetacharacters(command)) {
      send(res, 400, JSON.stringify({ error: 'Command contains shell metacharacters' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }
    const args = Array.isArray(body.args) ? body.args : [];
    if (args.some(a => hasShellMetacharacters(String(a || '')))) {
      send(res, 400, JSON.stringify({ error: 'Args contain shell metacharacters' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    const cwd = resolveSafeCwd(body.cwd);
    const env = body.env && typeof body.env === 'object' ? body.env : {};

    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });

    const id = randomUUID();
    /** @type {any} */
    const session = {
      id,
      process: child,
      stdoutBuffer: '',
      stderrRing: [],
      pendingResolves: new Map(),
      state: 'running',
      createdAt: Date.now()
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', chunk => {
      if (session.state === 'dead') return;
      session.stdoutBuffer += chunk;
      if (session.stdoutBuffer.length > 1024 * 1024) {
        session.state = 'dead';
        child.kill('SIGKILL');
        for (const resolver of session.pendingResolves.values()) {
          resolver({ jsonrpc: '2.0', error: { code: -32000, message: 'Stdout buffer exceeded 1MB' } });
        }
        session.pendingResolves.clear();
        return;
      }
      let lines = session.stdoutBuffer.split('\n');
      session.stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && session.pendingResolves.has(msg.id)) {
            const resolver = session.pendingResolves.get(msg.id);
            session.pendingResolves.delete(msg.id);
            resolver(msg);
          }
        } catch { /* not JSON-RPC, ignore */ }
      }
    });

    child.stderr.on('data', chunk => {
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        session.stderrRing.push(line);
        if (session.stderrRing.length > 50) session.stderrRing.shift();
      }
    });

    child.on('error', () => {
      session.state = 'dead';
      for (const resolver of session.pendingResolves.values()) {
        resolver({ jsonrpc: '2.0', error: { code: -32000, message: 'Process error' } });
      }
      session.pendingResolves.clear();
    });

    child.on('exit', () => {
      session.state = 'dead';
      for (const resolver of session.pendingResolves.values()) {
        resolver({ jsonrpc: '2.0', error: { code: -32000, message: 'Process exited' } });
      }
      session.pendingResolves.clear();
    });

    _stdioSessions.set(id, session);
    send(res, 200, JSON.stringify({ id, state: 'running' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ error: `MCP stdio create error: ${error.message}` }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
  }
}

async function handleMcpStdioList(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type,authorization',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }
  if (req.method !== 'GET') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  const authHeader = String(req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== TERMINAL_TOKEN) {
    send(res, 401, JSON.stringify({ error: 'Unauthorized: invalid or missing terminal token' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }
  if (!isLocalhostOrigin(req)) {
    send(res, 403, JSON.stringify({ error: 'Forbidden' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  const list = [..._stdioSessions.values()].map(s => ({
    id: s.id,
    command: s.process.spawnfile,
    state: s.state,
    createdAt: s.createdAt
  }));
  send(res, 200, JSON.stringify(list), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
}

async function handleMcpStdioKill(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type,authorization',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  const authHeader = String(req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== TERMINAL_TOKEN) {
    send(res, 401, JSON.stringify({ error: 'Unauthorized: invalid or missing terminal token' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }
  if (!isLocalhostOrigin(req)) {
    send(res, 403, JSON.stringify({ error: 'Forbidden' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  const id = req.url.split('/').pop();
  const session = _stdioSessions.get(id);
  if (!session) {
    send(res, 404, JSON.stringify({ error: 'Session not found' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }
  session.state = 'dead';
  session.process.kill('SIGTERM');
  _stdioSessions.delete(id);
  send(res, 200, JSON.stringify({ ok: true }), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
}

async function handleMcpStdioCall(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'content-type,authorization',
      'Access-Control-Max-Age': '86400'
    });
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  const authHeader = String(req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== TERMINAL_TOKEN) {
    send(res, 401, JSON.stringify({ error: 'Unauthorized: invalid or missing terminal token' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }
  if (!isLocalhostOrigin(req)) {
    send(res, 403, JSON.stringify({ error: 'Forbidden' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  const id = req.url.split('/').pop();
  const session = _stdioSessions.get(id);
  if (!session) {
    send(res, 404, JSON.stringify({ error: 'Session not found' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }
  if (session.state !== 'running') {
    send(res, 410, JSON.stringify({ error: 'Session is dead' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const method = String(body.method || '');
    const params = body.params || {};
    if (!method) {
      send(res, 400, JSON.stringify({ error: 'method is required' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    const reqId = Date.now() + Math.floor(Math.random() * 100000);
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params });

    const promise = new Promise((resolve) => {
      session.pendingResolves.set(reqId, resolve);
    });

    session.process.stdin.write(rpc + '\n');

    const result = await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
    ]);

    session.pendingResolves.delete(reqId);

    if (result?.error) {
      send(res, 500, JSON.stringify({ error: result.error.message || result.error }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      });
      return;
    }

    send(res, 200, JSON.stringify(result?.result ?? result), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ error: `MCP stdio call error: ${error.message}` }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp)) {
      send(res, 429, JSON.stringify({ error: 'Too many requests' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': '60'
      });
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    if (parsedUrl.pathname.startsWith(API_PREFIX)) {
      await proxyOllama(req, res, parsedUrl);
      return;
    }
    if (parsedUrl.pathname.startsWith(OPENROUTER_PREFIX)) {
      await proxyOpenRouter(req, res, parsedUrl);
      return;
    }
    if (parsedUrl.pathname === MCP_PROXY_PREFIX) {
      await handleMcpProxy(req, res);
      return;
    }
    if (parsedUrl.pathname === MCP_SSE_PREFIX) {
      await handleMcpSseProxy(req, res);
      return;
    }
    if (parsedUrl.pathname === MCP_STDIO_PREFIX || parsedUrl.pathname.startsWith(MCP_STDIO_PREFIX + '/')) {
      if (parsedUrl.pathname === MCP_STDIO_PREFIX + '/create') {
        await handleMcpStdioCreate(req, res);
      } else if (parsedUrl.pathname === MCP_STDIO_PREFIX + '/list') {
        await handleMcpStdioList(req, res);
      } else if (parsedUrl.pathname.startsWith(MCP_STDIO_PREFIX + '/kill/')) {
        await handleMcpStdioKill(req, res);
      } else if (parsedUrl.pathname.startsWith(MCP_STDIO_PREFIX + '/call/')) {
        await handleMcpStdioCall(req, res);
      } else {
        send(res, 404, JSON.stringify({ error: 'Not found' }), { 'Content-Type': 'application/json; charset=utf-8' });
      }
      return;
    }
    if (parsedUrl.pathname.startsWith(GNEWS_PREFIX)) {
      await proxyGoogleNews(req, res, parsedUrl);
      return;
    }
    if (parsedUrl.pathname === TERMINAL_PREFIX) {
      await handleTerminal(req, res);
      return;
    }
    if (parsedUrl.pathname === TERMINAL_PREFIX + '-files') {
      await handleTerminalMultipart(req, res);
      return;
    }
    if (parsedUrl.pathname === DIAGNOSTICS_PREFIX) {
      await handleDiagnostics(req, res);
      return;
    }
    if (parsedUrl.pathname === HEALTH_PREFIX) {
      await handleHealth(req, res);
      return;
    }
    if (parsedUrl.pathname === ENV_PREFIX) {
      await handleEnv(req, res);
      return;
    }
    serveStatic(req, res, parsedUrl);
  } catch (error) {
    send(res, 500, `Server error: ${error.message}`);
  }
});

server.listen(PORT, () => {
  const boundPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  console.log(`[dev-server] running at http://127.0.0.1:${boundPort}`);
  console.log(`[dev-server] proxy route: ${API_PREFIX} -> ${OLLAMA_BASE}/v1`);
  console.log(`[dev-server] proxy route: ${GNEWS_PREFIX} -> ${GNEWS_BASE}`);
  console.log(`[dev-server] compat routes: ${TERMINAL_PREFIX}, ${DIAGNOSTICS_PREFIX}, ${ENV_PREFIX}`);
  if (!process.env.OLLAMA_API_KEY) {
    console.log('[dev-server] no OLLAMA_API_KEY env var detected; browser Authorization header will be forwarded if provided.');
  }
  if (getOpenRouterApiKey()) {
    console.log('[dev-server] OPENROUTER_API_KEY detected; proxying via /api/openrouter (key never sent to browser)');
  }
  console.log(`[dev-server] terminal auth token generated (shared via /api/env to localhost only)`);
});
