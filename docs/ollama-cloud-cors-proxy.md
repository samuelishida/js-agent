# Ollama Cloud CORS Proxy (JS only)

This project runs in the browser, so direct calls to Ollama Cloud can fail due to CORS preflight restrictions.

Use this JavaScript Cloudflare Worker as a same-origin CORS proxy for Ollama Cloud.

## File

- `proxy/ollama-cloud-worker.js`

## Deploy (Cloudflare Workers)

1. Create a Worker and paste `proxy/ollama-cloud-worker.js`.
2. Add a Worker secret named `OLLAMA_API_KEY` (recommended).
3. Optional: set `CORS_ORIGIN` to your frontend origin (example: `http://127.0.0.1:5500`).
4. Deploy and copy your worker URL, for example:
   - `https://my-ollama-proxy.my-account.workers.dev`

## Configure this app

In Settings:

1. Choose model provider `ollama/...`.
2. Set Ollama Cloud Endpoint to:
   - `https://my-ollama-proxy.my-account.workers.dev/v1`

If you configured `OLLAMA_API_KEY` in the Worker, the browser app does not need to send the key.
