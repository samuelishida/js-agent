export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // Fail closed: if CORS_ORIGIN is not configured and a cross-origin request
    // arrives, block it. Without this guard any website can proxy requests through
    // this worker and consume the operator's OLLAMA_API_KEY.
    // To allow all origins explicitly, set CORS_ORIGIN='*' in the Worker env.
    const allowOrigin = env.CORS_ORIGIN || (origin ? null : '*');
    if (!allowOrigin) {
      return new Response(
        JSON.stringify({ error: 'Proxy requires CORS_ORIGIN to be set in the Worker environment.' }),
        { status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowOrigin, request)
      });
    }

    if (!url.pathname.startsWith('/v1/')) {
      return json(
        { error: 'Not found. Use /v1/... paths.' },
        404,
        allowOrigin,
        request
      );
    }

    const upstreamUrl = `https://ollama.com${url.pathname}${url.search}`;
    const upstreamHeaders = new Headers(request.headers);

    upstreamHeaders.delete('host');
    upstreamHeaders.delete('origin');
    upstreamHeaders.delete('referer');

    const incomingAuth = request.headers.get('Authorization');
    if (!incomingAuth && env.OLLAMA_API_KEY) {
      upstreamHeaders.set('Authorization', `Bearer ${env.OLLAMA_API_KEY}`);
    }

    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: mayHaveBody(request.method) ? request.body : undefined,
      redirect: 'follow'
    });

    const responseHeaders = new Headers();
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) responseHeaders.set('Content-Type', contentType);
    responseHeaders.set('Cache-Control', 'no-store');

    const cors = corsHeaders(allowOrigin, request);
    for (const [k, v] of cors.entries()) {
      responseHeaders.set(k, v);
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders
    });
  }
};

function mayHaveBody(method) {
  return !['GET', 'HEAD'].includes(String(method || '').toUpperCase());
}

function corsHeaders(allowOrigin, request) {
  const requestHeaders = request.headers.get('Access-Control-Request-Headers') || 'authorization,content-type';
  return new Headers({
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': requestHeaders,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin, Access-Control-Request-Headers'
  });
}

function json(body, status, allowOrigin, request) {
  const headers = corsHeaders(allowOrigin, request);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}
