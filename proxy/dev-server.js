#!/usr/bin/env node
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 5500);
const ROOT = process.cwd();
const OLLAMA_BASE = 'https://ollama.com';
const API_PREFIX = '/api/ollama/v1';

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
    serveStatic(req, res, parsedUrl);
  } catch (error) {
    send(res, 500, `Server error: ${error.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`[dev-server] running at http://127.0.0.1:${PORT}`);
  console.log(`[dev-server] proxy route: ${API_PREFIX} -> ${OLLAMA_BASE}/v1`);
  if (!process.env.OLLAMA_API_KEY) {
    console.log('[dev-server] no OLLAMA_API_KEY env var detected; browser Authorization header will be forwarded if provided.');
  }
});
