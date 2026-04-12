#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 5500);
const ROOT = process.cwd();
const OLLAMA_BASE = 'https://ollama.com';
const API_PREFIX = '/api/ollama/v1';
const TERMINAL_PREFIX = '/api/terminal';
const DIAGNOSTICS_PREFIX = '/api/diagnostics';

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

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
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
    return JSON.parse(text);
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
      const command = 'npx tsc --noEmit --pretty false';
      const result = await runCommand(command, ROOT, 60000);
      const filtered = relPath
        ? result.output
            .split(/\r?\n/)
            .filter(line => !relPath || line.toLowerCase().includes(relPath.toLowerCase()))
            .join('\n')
            .trim()
        : result.output;
      resultText = filtered || `No diagnostics returned${relPath ? ` for ${relPath}` : ''}.`;
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
      send(res, 200, content, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    if (parsedUrl.pathname.startsWith(API_PREFIX)) {
      await proxyOllama(req, res, parsedUrl);
      return;
    }
    if (parsedUrl.pathname === TERMINAL_PREFIX) {
      await handleTerminal(req, res);
      return;
    }
    if (parsedUrl.pathname === DIAGNOSTICS_PREFIX) {
      await handleDiagnostics(req, res);
      return;
    }
    serveStatic(req, res, parsedUrl);
  } catch (error) {
    send(res, 500, `Server error: ${error.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`[dev-server] running at http://127.0.0.1:${PORT}`);
  console.log(`[dev-server] proxy route: ${API_PREFIX} -> ${OLLAMA_BASE}/v1`);
  console.log(`[dev-server] compat routes: ${TERMINAL_PREFIX}, ${DIAGNOSTICS_PREFIX}`);
  if (!process.env.OLLAMA_API_KEY) {
    console.log('[dev-server] no OLLAMA_API_KEY env var detected; browser Authorization header will be forwarded if provided.');
  }
});
