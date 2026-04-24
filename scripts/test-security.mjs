// scripts/test-security.mjs
// Unit tests for security-hardening.js

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile('src/app/tools/security-hardening.js', 'utf8');
globalThis.window = globalThis;
vm.runInThisContext(code, { filename: 'security-hardening.js' });

const SH = globalThis.window.AgentSecurityHardening;
assert.ok(SH, 'AgentSecurityHardening should be exported');

// ── Symlink Detection ───────────────────────────────────────────────────────
assert.equal(SH.isSymlinkPath('/home/user/file.lnk'), true, 'detects .lnk symlink');
assert.equal(SH.isSymlinkPath('/home/user/file.txt'), false, 'normal file is not symlink');
assert.equal(SH.isSymlinkPath('/home/user/link->target'), true, 'detects arrow symlink');
assert.equal(SH.isSymlinkPath('/home/user/[text](url)'), true, 'detects markdown link');

const symlinkResult = SH.detectSymlinkInPath('/home/user/file.lnk');
assert.equal(symlinkResult.isSymlink, true, 'detectSymlinkInPath finds symlink');
assert.equal(symlinkResult.segment, 'file.lnk', 'correct segment');

const noSymlinkResult = SH.detectSymlinkInPath('/home/user/file.txt');
assert.equal(noSymlinkResult.isSymlink, false, 'no symlink in normal path');

// ── URL-encoded Path Normalization ──────────────────────────────────────────
assert.equal(SH.normalizeUrlEncodedPath('/path%20with%20spaces'), '/path with spaces', 'decodes URL encoding');
assert.equal(SH.normalizeUrlEncodedPath('/path%2520double'), '/path double', 'decodes double URL encoding');
assert.equal(SH.containsUrlEncoding('/path%20encoded'), true, 'detects URL encoding');
assert.equal(SH.containsUrlEncoding('/path/normal'), false, 'no encoding in normal path');

// ── CSP Headers ─────────────────────────────────────────────────────────────
const csp = SH.generateCSPHeaders();
assert.ok(csp['Content-Security-Policy'], 'CSP header exists');
assert.ok(csp['Content-Security-Policy'].includes("default-src 'self'"), 'CSP has default-src');
assert.ok(csp['X-Frame-Options'] === 'DENY', 'X-Frame-Options is DENY');
assert.ok(csp['X-Content-Type-Options'] === 'nosniff', 'X-Content-Type-Options is nosniff');

// ── Request Body Limits ─────────────────────────────────────────────────────
const largeBody = 'x'.repeat(15 * 1024 * 1024);
const bodyCheck = SH.validateRequestBody(largeBody);
assert.equal(bodyCheck.valid, false, 'rejects oversized body');
assert.ok(bodyCheck.reason.includes('exceeds'), 'reason mentions exceeds');

const smallBody = 'small request';
const smallCheck = SH.validateRequestBody(smallBody);
assert.equal(smallCheck.valid, true, 'accepts small body');

const truncated = SH.truncateRequestBody(largeBody, 100);
assert.equal(truncated.length, 100, 'truncates to max size');

// ── Per-endpoint Rate Limiting ─────────────────────────────────────────────
SH.resetEndpointRateLimit('/api/test');
for (let i = 0; i < 30; i++) {
  const result = SH.checkEndpointRateLimit('/api/test');
  assert.equal(result.allowed, true, `request ${i + 1} allowed`);
}
const blocked = SH.checkEndpointRateLimit('/api/test');
assert.equal(blocked.allowed, false, '31st request blocked');
assert.ok(blocked.retryAfter > 0, 'retryAfter is positive');

SH.resetEndpointRateLimit('/api/test');
const afterReset = SH.checkEndpointRateLimit('/api/test');
assert.equal(afterReset.allowed, true, 'works after reset');

// ── Terminal Auth ─────────────────────────────────────────────────────────
const auth = SH.generateTerminalAuthToken('session-123');
assert.ok(auth.token, 'token generated');
assert.ok(auth.expiresAt > Date.now(), 'expires in future');

const validCheck = SH.validateTerminalAuthToken(auth.token);
assert.equal(validCheck.valid, true, 'token is valid');
assert.equal(validCheck.sessionId, 'session-123', 'correct session');

const invalidCheck = SH.validateTerminalAuthToken('invalid-token');
assert.equal(invalidCheck.valid, false, 'invalid token rejected');

SH.revokeTerminalAuthToken(auth.token);
const afterRevoke = SH.validateTerminalAuthToken(auth.token);
assert.equal(afterRevoke.valid, false, 'revoked token rejected');

console.log('All security hardening tests passed ✅');
