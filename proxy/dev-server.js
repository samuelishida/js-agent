#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

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
  const candidate = trimmed
    ? path.resolve(ROOT, trimmed)
    : ROOT;
  const normalizedRoot = path.resolve(ROOT);
  return candidate.startsWith(normalizedRoot) ? candidate : normalizedRoot;
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
        if (!absPath.startsWith(path.resolve(ROOT))) continue;
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
    if (absPath && !absPath.startsWith(path.resolve(ROOT))) {
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
  if (!abs.startsWith(path.resolve(ROOT))) return null;
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

  if (!process.env.OPEN_ROUTER_API_KEY) {
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
  headers.authorization = `Bearer ${process.env.OPEN_ROUTER_API_KEY}`;
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
    const authHeader = String(body.authHeader || '').trim();

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
    hasOpenRouterKey: !!process.env.OPEN_ROUTER_API_KEY,
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
  if (process.env.OPEN_ROUTER_API_KEY) {
    console.log('[dev-server] OPEN_ROUTER_API_KEY detected; proxying via /api/openrouter (key never sent to browser)');
  }
  console.log(`[dev-server] terminal auth token generated (shared via /api/env to localhost only)`);
});
