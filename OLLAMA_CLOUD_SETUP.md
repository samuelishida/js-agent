# Ollama Cloud Setup Guide

> **Looking for the easiest setup?** Try [OpenRouter](https://openrouter.ai/keys) first — free tier available, no local install needed. See the main README for OpenRouter setup.

## Starting the Dev Server

**⚠️ CRITICAL: Run the server from the Agent directory**

```bash
# Navigate to the Agent directory (MUST be in /media/samuel/PNY\ 1TB/Code/Agent)
cd "/media/samuel/PNY 1TB/Code/Agent"

# Set your Ollama Cloud API key
export OLLAMA_API_KEY="YOUR_OLLAMA_CLOUD_API_KEY"

# Start the server
node proxy/dev-server.js
```

You should see:
```
[dev-server] running at http://127.0.0.1:5500
[dev-server] proxy route: /api/ollama/v1 -> https://ollama.com/v1
```

Then open http://127.0.0.1:5500 in your browser.

## Troubleshooting

### Server won't start / "Cannot find module"
```bash
# Make sure you're in the Agent directory
cd "/media/samuel/PNY 1TB/Code/Agent"
node proxy/dev-server.js
```

### "404 Not Found" on script files or "Agent" in the path
- **Cause**: Server started from wrong directory
- **Fix**: 
  ```bash
  cd "/media/samuel/PNY 1TB/Code/Agent"  # Must be this exact directory
  node proxy/dev-server.js
  ```

### "Ollama Cloud API key is required"
- You haven't saved your API key in Settings
- Paste the key and click **Save** in the "Ollama Cloud API Key" field

### "Ollama Cloud authentication failed" (HTTP 401/403)
- Your API key is invalid or expired
- Check https://ollama.com/account/api-keys for your current key
- Generate a new key if needed
- Update the saved key in Settings

### "Access to fetch at 'https://ollama.com/v1/...' has been blocked by CORS"
- This is expected when the local proxy isn't available
- The browser cannot make direct requests to ollama.com due to CORS
- **Solution**: Make sure the dev-server is running from the correct directory (see "Server won't start" above)

### "POST http://127.0.0.1:5500/api/ollama/v1/chat/completions 405 (Method Not Allowed)"
- The local proxy isn't handling requests correctly
- **Likely cause**: Server was started from the wrong directory
- **Fix**: Stop the server and restart it from `/media/samuel/PNY 1TB/Code/Agent`

## How It Works

**Endpoint routing (automatic):**
1. Try same-origin proxy at `/api/ollama/v1` → `https://ollama.com/v1` (local forwarding)
2. If proxy is unavailable, try direct connection to `https://ollama.com/v1` (fails with CORS in browser)

**Authentication:**
- Your API key is sent via `Authorization: Bearer <your-key>` header
- The key is stored in browser `localStorage` (never sent to third parties)

**Model selection:**
- You manually select from a curated list of Ollama Cloud models
- Selection persists across page reloads
- The selected model is sent with each API request
