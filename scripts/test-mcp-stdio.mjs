// scripts/test-mcp-stdio.mjs
// Tests MCP stdio sidecar endpoints and browser transport.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const FIXTURE = path.join(repoRoot, 'scripts', 'mcp-stdio-fixture.mjs');

// ── Fixture MCP server (JSON-RPC over stdio) ───────────────────────────────
const fixtureCode = `import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const req = JSON.parse(line);
  let result;

  if (req.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', serverInfo: { name: 'test', version: '1.0' }, capabilities: { tools: {}, resources: {}, prompts: {} } };
  } else if (req.method === 'tools/list') {
    result = { tools: [{ name: 'test_tool', inputSchema: {} }] };
  } else if (req.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'ok' }] };
  } else if (req.method === 'resources/list') {
    result = { resources: [] };
  } else if (req.method === 'prompts/list') {
    result = { prompts: [] };
  } else {
    result = { error: 'unknown method' };
  }

  const response = JSON.stringify({ jsonrpc: '2.0', id: req.id, result });
  console.log(response);
});`;

// Write fixture if not present
if (!fs.existsSync(FIXTURE)) {
  fs.writeFileSync(FIXTURE, fixtureCode, 'utf8');
}

// ── Helpers ────────────────────────────────────────────────────────────────

function httpPost(path, bodyObj, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    Object.assign(headers, extraHeaders);
    const req = request({ hostname: '127.0.0.1', port, path, method: 'POST', headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: extraHeaders }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.end();
  });
}

function group(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log('  \u2713 ' + name);
    return { name, ok: true };
  }).catch(err => {
    console.log('  \u2717 ' + name);
    console.log('    ' + err.message);
    return { name, ok: false, error: err.message };
  });
}

// ── Start dev server ──────────────────────────────────────────────────────

let port;

// Find free port
{
  const tmp = (await import('node:net')).createServer();
  await new Promise(resolve => tmp.listen(0, () => resolve()));
  port = tmp.address().port;
  await new Promise(resolve => tmp.close(() => resolve()));
}

const token = 'test-terminal-token-123';

// Ensure token file exists for dev-server
const tokenFile = path.join(repoRoot, '.terminal-token');
const savedToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : null;
fs.writeFileSync(tokenFile, token, 'utf8');

const proc = spawn('node', ['proxy/dev-server.js'], {
  cwd: repoRoot,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});

await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('dev-server did not start')), 5000);
  proc.stdout.on('data', d => { if (String(d).includes('running at')) { clearTimeout(to); resolve(); } });
  proc.stderr.on('data', d => { if (String(d).includes('running at')) { clearTimeout(to); resolve(); } });
});

// Restore token
if (savedToken !== null) fs.writeFileSync(tokenFile, savedToken, 'utf8');
else fs.unlinkSync(tokenFile);

// ── Tests ──────────────────────────────────────────────────────────────────
console.log('MCP stdio Tests\n');

const results = [];

let sessionId;

results.push(await group('create stdio session', async () => {
  const res = await httpPost('/api/mcp-stdio/create', {
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    cwd: repoRoot
  }, { Authorization: `Bearer ${token}` });
  assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
  const data = JSON.parse(res.body);
  assert.ok(data.id, 'session id returned');
  assert.strictEqual(data.state, 'running');
  sessionId = data.id;
}));

results.push(await group('initialize through call', async () => {
  const res = await httpPost(`/api/mcp-stdio/call/${sessionId}`, {
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '0.0.1' }, capabilities: {} }
  }, { Authorization: `Bearer ${token}` });
  assert.strictEqual(res.status, 200, `got ${res.status}: ${res.body}`);
  const data = JSON.parse(res.body);
  assert.ok(data, 'result returned');
}));

results.push(await group('list tools', async () => {
  const res = await httpPost(`/api/mcp-stdio/call/${sessionId}`, {
    method: 'tools/list', params: {}
  }, { Authorization: `Bearer ${token}` });
  assert.strictEqual(res.status, 200, `got ${res.status}: ${res.body}`);
  const data = JSON.parse(res.body);
  assert.ok(Array.isArray(data.tools), 'tools array');
}));

results.push(await group('call tool', async () => {
  const res = await httpPost(`/api/mcp-stdio/call/${sessionId}`, {
    method: 'tools/call', params: { name: 'test_tool', arguments: {} }
  }, { Authorization: `Bearer ${token}` });
  assert.strictEqual(res.status, 200, `got ${res.status}: ${res.body}`);
  const data = JSON.parse(res.body);
  assert.ok(data, 'result returned');
}));

results.push(await group('list sessions', async () => {
  const res = await httpGet('/api/mcp-stdio/list', { Authorization: `Bearer ${token}` });
  assert.strictEqual(res.status, 200, `got ${res.status}: ${res.body}`);
  const data = JSON.parse(res.body);
  assert.ok(Array.isArray(data) && data.length >= 1, 'sessions list');
  assert.ok(data.find(s => s.id === sessionId), 'session in list');
}));

results.push(await group('kill session', async () => {
  const res = await httpPost(`/api/mcp-stdio/kill/${sessionId}`, {}, { Authorization: `Bearer ${token}` });
  assert.strictEqual(res.status, 200, `got ${res.status}: ${res.body}`);
  const data = JSON.parse(res.body);
  assert.strictEqual(data.ok, true);
}));

results.push(await group('bad origin rejected', async () => {
  // Create a temp session then test call with bad origin
  const create = await httpPost('/api/mcp-stdio/create', {
    command: process.platform === 'win32' ? process.execPath.replace(/\\/g, '/') : process.execPath,
    args: [FIXTURE]
  }, { Authorization: `Bearer ${token}` });
  const sid = JSON.parse(create.body).id;
  const res = await httpPost(`/api/mcp-stdio/call/${sid}`, {
    method: 'tools/list', params: {}
  }, { Authorization: `Bearer ${token}`, Origin: 'http://evil.com' });
  assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
  // cleanup
  await httpPost(`/api/mcp-stdio/kill/${sid}`, {}, { Authorization: `Bearer ${token}` });
}));

results.push(await group('bad token rejected', async () => {
  const res = await httpPost('/api/mcp-stdio/create', {
    command: process.platform === 'win32' ? process.execPath.replace(/\\/g, '/') : process.execPath,
    args: [FIXTURE]
  }, { Authorization: 'Bearer bad-token' });
  assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
}));

results.push(await group('shell metacharacters rejected', async () => {
  const res = await httpPost('/api/mcp-stdio/create', {
    command: 'node; rm -rf /'
  }, { Authorization: `Bearer ${token}` });
  assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
}));

results.push(await group('npx command rejected', async () => {
  const res = await httpPost('/api/mcp-stdio/create', {
    command: 'npx -y @modelcontextprotocol/server-filesystem /'
  }, { Authorization: `Bearer ${token}` });
  assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
}));

proc.kill('SIGTERM');

// ── Summary ─────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} passed`);
if (passed < total) {
  process.exitCode = 1;
} else {
  console.log('All MCP stdio tests passed.\n');
}
