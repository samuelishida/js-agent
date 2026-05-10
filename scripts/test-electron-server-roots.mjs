import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function log(msg) { console.log(`  ${msg}`); }

async function createTempFixture() {
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'test-dev-server-'));
  const staticDir = path.join(tmpBase, 'static');
  const runtimeDir = path.join(tmpBase, 'runtime');
  fs.mkdirSync(staticDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<html><body>Test Static Root</body></html>');
  return { tmpBase, staticDir, runtimeDir, cleanup: () => fs.promises.rm(tmpBase, { recursive: true, force: true }) };
}

function startServerWithRoots(staticRoot, runtimeRoot, port = 0) {
  const env = { ...process.env, STATIC_ROOT: staticRoot, RUNTIME_ROOT: runtimeRoot, PORT: String(port) };
  const proc = spawn(process.execPath, [path.join(repoRoot, 'proxy', 'dev-server.js')], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let assignedPort = null;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server timeout')), 10000);
    proc.stdout.on('data', chunk => {
      const match = String(chunk).match(/\[dev-server\] running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        assignedPort = Number(match[1]);
        resolve(assignedPort);
      }
    });
    proc.stderr.on('data', chunk => process.stderr.write(`[server stderr] ${chunk}`));
    proc.on('error', reject);
  });

  return { proc, ready, close: () => { proc.kill('SIGTERM'); } };
}

async function fetchUrl(url) {
  const res = await fetch(url);
  const body = await res.text();
  return { status: res.status, body };
}

// ── Test 1: Separate roots serve static from STATIC_ROOT ──────────────────

async function testSeparateRoots() {
  log('Test 1: Separate roots serve static from STATIC_ROOT');
  const fixture = await createTempFixture();
  const server = startServerWithRoots(fixture.staticDir, fixture.runtimeDir);
  try {
    const port = await server.ready;
    const { status, body } = await fetchUrl(`http://127.0.0.1:${port}/`);
    assert.strictEqual(status, 200);
    assert.ok(body.includes('Test Static Root'), `Expected static content, got: ${body.slice(0, 200)}`);
    log('  PASS: index.html served from STATIC_ROOT');
    passed++;
  } catch (e) {
    log(`  FAIL: ${e.message}`);
    failed++;
  } finally {
    server.close();
    await fixture.cleanup();
  }
}

// ── Test 2: Token file in RUNTIME_ROOT ──────────────────────────────────────

async function testTokenFileLocation() {
  log('Test 2: Token file in RUNTIME_ROOT');
  const fixture = await createTempFixture();
  const server = startServerWithRoots(fixture.staticDir, fixture.runtimeDir);
  try {
    const port = await server.ready;
    const { status, body } = await fetchUrl(`http://127.0.0.1:${port}/api/env`);
    assert.strictEqual(status, 200);
    const env = JSON.parse(body);
    assert.ok(env.terminalToken, 'Expected terminalToken in response');
    const runtimeTokenFile = path.join(fixture.runtimeDir, '.terminal-token');
    assert.ok(fs.existsSync(runtimeTokenFile), 'Token file should exist in RUNTIME_ROOT');
    const staticTokenFile = path.join(fixture.staticDir, '.terminal-token');
    assert.ok(!fs.existsSync(staticTokenFile), 'Token file should NOT exist in STATIC_ROOT');
    log('  PASS: token file in RUNTIME_ROOT, not STATIC_ROOT');
    passed++;
  } catch (e) {
    log(`  FAIL: ${e.message}`);
    failed++;
  } finally {
    server.close();
    await fixture.cleanup();
  }
}

// ── Test 3: Terminal cwd isolation ──────────────────────────────────────────

async function testTerminalCwdIsolation() {
  log('Test 3: Terminal cwd resolves to RUNTIME_ROOT');
  const fixture = await createTempFixture();
  const server = startServerWithRoots(fixture.staticDir, fixture.runtimeDir);
  try {
    const port = await server.ready;
    const { status, body } = await fetchUrl(`http://127.0.0.1:${port}/api/env`);
    const env = JSON.parse(body);
    const token = env.terminalToken;

    const res = await fetch(`http://127.0.0.1:${port}/api/terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ command: 'cd', cwd: '.' })
    });
    const result = JSON.parse(await res.text());
    assert.ok(result.result || result.ok, 'Expected successful terminal response');
    log('  PASS: terminal cwd isolated to RUNTIME_ROOT');
    passed++;
  } catch (e) {
    log(`  FAIL: ${e.message}`);
    failed++;
  } finally {
    server.close();
    await fixture.cleanup();
  }
}

// ── Test 4: Static path traversal blocked ───────────────────────────────────

async function testPathTraversal() {
  log('Test 4: Static path traversal blocked');
  const fixture = await createTempFixture();
  const server = startServerWithRoots(fixture.staticDir, fixture.runtimeDir);
  try {
    const port = await server.ready;
    const { status } = await fetchUrl(`http://127.0.0.1:${port}/../../../etc/passwd`);
    assert.ok(status === 403 || status === 404, `Expected 403 or 404, got ${status}`);
    log('  PASS: path traversal blocked');
    passed++;
  } catch (e) {
    log(`  FAIL: ${e.message}`);
    failed++;
  } finally {
    server.close();
    await fixture.cleanup();
  }
}

// ── Test 5: Default fallback (no env vars) ──────────────────────────────────

async function testDefaultFallback() {
  log('Test 5: Default fallback — both roots default to cwd');
  const env = { ...process.env };
  delete env.STATIC_ROOT;
  delete env.RUNTIME_ROOT;
  env.PORT = '0';
  const proc = spawn(process.execPath, [path.join(repoRoot, 'proxy', 'dev-server.js')], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let port = null;
  let startupLogs = '';
  try {
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server timeout')), 10000);
      proc.stdout.on('data', chunk => {
        const text = String(chunk);
        startupLogs += text;
        const match = text.match(/\[dev-server\] running at http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timeout); port = Number(match[1]); resolve(port); }
      });
      proc.stderr.on('data', chunk => { startupLogs += String(chunk); });
      proc.on('error', reject);
    });

    port = await ready;
    const { status, body } = await fetchUrl(`http://127.0.0.1:${port}/`);
    assert.strictEqual(status, 200);
    assert.ok(body.includes('JS Agent') || body.includes('agent'), 'Expected index.html content');
    log(`  PASS: default roots serve index.html from cwd`);
    passed++;
  } catch (e) {
    log(`  FAIL: ${e.message}`);
    log(`  Startup logs: ${startupLogs.slice(0, 500)}`);
    failed++;
  } finally {
    proc.kill('SIGTERM');
  }
}

// ── Test 6: Packaged app structure (both roots same dir) ────────────────────

async function testPackagedStructure() {
  log('Test 6: Packaged app structure — both roots same dir');
  const fixture = await createTempFixture();
  const unpackedDir = path.join(fixture.tmpBase, 'app.asar.unpacked');
  fs.mkdirSync(path.join(unpackedDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(unpackedDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(unpackedDir, 'index.html'), '<html><body>Packaged</body></html>');
  fs.writeFileSync(path.join(unpackedDir, 'src', 'app.js'), 'console.log("app")');

  const server = startServerWithRoots(unpackedDir, unpackedDir);
  try {
    const port = await server.ready;
    const { status, body } = await fetchUrl(`http://127.0.0.1:${port}/`);
    assert.strictEqual(status, 200);
    assert.ok(body.includes('Packaged'), `Expected "Packaged" in body`);
    const srcRes = await fetchUrl(`http://127.0.0.1:${port}/src/app.js`);
    assert.strictEqual(srcRes.status, 200);
    assert.ok(srcRes.body.includes('console.log'), `Expected app.js content`);
    log('  PASS: packaged structure serves static files');
    passed++;
  } catch (e) {
    log(`  FAIL: ${e.message}`);
    failed++;
  } finally {
    server.close();
    await fixture.cleanup();
  }
}

// ── Run all ─────────────────────────────────────────────────────────────────

async function run() {
  console.log('\nElectron server root separation tests\n');

  await testSeparateRoots();
  await testTokenFileLocation();
  await testTerminalCwdIsolation();
  await testPathTraversal();
  await testDefaultFallback();
  await testPackagedStructure();

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });