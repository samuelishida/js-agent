// src/app/tools/security-hardening.js
// Security hardening utilities: symlink detection, URL-encoded path normalization,
// CSP headers, request body limits, per-endpoint rate limiting, terminal auth.

(function() {
  'use strict';

  // ── Symlink Detection ───────────────────────────────────────────────────────
  function isSymlinkPath(pathValue) {
    const text = String(pathValue || '');
    // Detecta padrões comuns de symlink em paths
    if (/\.(lnk|sym|link)$/i.test(text)) return true;
    if (/->|→|⇒/.test(text)) return true;
    if (/\[.*\]\(.*\)/.test(text)) return true; // markdown link syntax
    return false;
  }

  function detectSymlinkInPath(pathValue) {
    const normalized = String(pathValue || '').replace(/[\\/]+/g, '/').trim();
    const segments = normalized.split('/').filter(Boolean);
    for (const segment of segments) {
      if (isSymlinkPath(segment)) {
        return { isSymlink: true, segment, reason: `Symlink detected in segment: ${segment}` };
      }
    }
    return { isSymlink: false };
  }

  // ── URL-encoded Path Normalization ──────────────────────────────────────────
  function normalizeUrlEncodedPath(pathValue) {
    let text = String(pathValue || '');
    try {
      // Decodifica múltiplas camadas de URL encoding
      let prev;
      do {
        prev = text;
        text = decodeURIComponent(text);
      } while (text !== prev && /%[0-9A-Fa-f]{2}/.test(text));
    } catch {
      // Se falhar o decode, retorna o original
    }
    // Remove null bytes e caracteres de controle
    text = text.replace(/\x00/g, '').replace(/[\x01-\x1f\x7f]/g, '');
    // Normaliza separadores
    text = text.replace(/[\\/]+/g, '/').trim();
    return text;
  }

  function containsUrlEncoding(pathValue) {
    return /%[0-9A-Fa-f]{2}/.test(String(pathValue || ''));
  }

  // ── CSP Headers ─────────────────────────────────────────────────────────────
  function generateCSPHeaders() {
    return {
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self' https://*.googleapis.com https://*.openai.com https://*.anthropic.com https://*.azure.com https://openrouter.ai",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
  }

  function applyCSPHeaders(response) {
    const headers = generateCSPHeaders();
    for (const [key, value] of Object.entries(headers)) {
      if (response.headers) {
        response.headers.set(key, value);
      }
    }
    return response;
  }

  // ── Request Body Limits ────────────────────────────────────────────────────
  const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

  function validateRequestBody(body, maxSize = DEFAULT_MAX_BODY_SIZE) {
    const size = typeof body === 'string' ? body.length : JSON.stringify(body).length;
    if (size > maxSize) {
      return {
        valid: false,
        reason: `Request body exceeds maximum size of ${maxSize} bytes (${size} bytes)`,
        size,
        maxSize
      };
    }
    return { valid: true, size, maxSize };
  }

  function truncateRequestBody(body, maxSize = DEFAULT_MAX_BODY_SIZE) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (text.length <= maxSize) return body;
    const truncated = text.slice(0, maxSize);
    return typeof body === 'string' ? truncated : JSON.parse(truncated);
  }

  // ── Per-endpoint Rate Limiting ─────────────────────────────────────────────
  const endpointRateLimits = new Map();
  const DEFAULT_ENDPOINT_LIMIT = { maxRequests: 30, windowMs: 60000 }; // 30 req/min

  function checkEndpointRateLimit(endpoint, options = {}) {
    const { maxRequests = 30, windowMs = 60000 } = options;
    const now = Date.now();
    const key = String(endpoint || 'default');

    if (!endpointRateLimits.has(key)) {
      endpointRateLimits.set(key, { requests: [], windowStart: now });
    }

    const limit = endpointRateLimits.get(key);

    // Limpa requests antigos fora da janela
    limit.requests = limit.requests.filter(time => now - time < windowMs);

    if (limit.requests.length >= maxRequests) {
      const oldestRequest = limit.requests[0];
      const retryAfter = Math.ceil((oldestRequest + windowMs - now) / 1000);
      return {
        allowed: false,
        retryAfter,
        remaining: 0,
        limit: maxRequests,
        windowMs
      };
    }

    limit.requests.push(now);

    return {
      allowed: true,
      remaining: maxRequests - limit.requests.length,
      limit: maxRequests,
      windowMs
    };
  }

  function resetEndpointRateLimit(endpoint) {
    const key = String(endpoint || 'default');
    endpointRateLimits.delete(key);
  }

  function getEndpointRateLimitStatus(endpoint) {
    const key = String(endpoint || 'default');
    const limit = endpointRateLimits.get(key);
    if (!limit) return { requests: 0, limit: DEFAULT_ENDPOINT_LIMIT.maxRequests };
    const now = Date.now();
    const activeRequests = limit.requests.filter(time => now - time < DEFAULT_ENDPOINT_LIMIT.windowMs);
    return {
      requests: activeRequests.length,
      limit: DEFAULT_ENDPOINT_LIMIT.maxRequests,
      remaining: Math.max(0, DEFAULT_ENDPOINT_LIMIT.maxRequests - activeRequests.length)
    };
  }

  // ── Terminal Auth ─────────────────────────────────────────────────────────
  const terminalAuthTokens = new Map();
  const TERMINAL_AUTH_TTL_MS = 5 * 60 * 1000; // 5 minutos

  function generateTerminalAuthToken(sessionId) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const expiresAt = Date.now() + TERMINAL_AUTH_TTL_MS;
    terminalAuthTokens.set(token, { sessionId, expiresAt });
    return { token, expiresAt };
  }

  function validateTerminalAuthToken(token) {
    if (!token) return { valid: false, reason: 'No token provided' };
    const auth = terminalAuthTokens.get(token);
    if (!auth) return { valid: false, reason: 'Invalid token' };
    if (Date.now() > auth.expiresAt) {
      terminalAuthTokens.delete(token);
      return { valid: false, reason: 'Token expired' };
    }
    return { valid: true, sessionId: auth.sessionId };
  }

  function revokeTerminalAuthToken(token) {
    return terminalAuthTokens.delete(token);
  }

  function cleanupExpiredTerminalTokens() {
    const now = Date.now();
    for (const [token, auth] of terminalAuthTokens.entries()) {
      if (now > auth.expiresAt) {
        terminalAuthTokens.delete(token);
      }
    }
  }

  // Limpa tokens expirados a cada 5 minutos
  if (typeof setInterval !== 'undefined') {
    setInterval(cleanupExpiredTerminalTokens, TERMINAL_AUTH_TTL_MS);
  }

  // ── Export ────────────────────────────────────────────────────────────────
  window.AgentSecurityHardening = {
    // Symlink detection
    isSymlinkPath,
    detectSymlinkInPath,
    // URL-encoded path normalization
    normalizeUrlEncodedPath,
    containsUrlEncoding,
    // CSP headers
    generateCSPHeaders,
    applyCSPHeaders,
    // Request body limits
    validateRequestBody,
    truncateRequestBody,
    DEFAULT_MAX_BODY_SIZE,
    // Per-endpoint rate limiting
    checkEndpointRateLimit,
    resetEndpointRateLimit,
    getEndpointRateLimitStatus,
    // Terminal auth
    generateTerminalAuthToken,
    validateTerminalAuthToken,
    revokeTerminalAuthToken,
    cleanupExpiredTerminalTokens
  };
})();
