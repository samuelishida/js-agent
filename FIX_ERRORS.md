# Fix for Current Errors

## The Problem

You're seeing these errors:
- ❌ `GET http://127.0.0.1:5500/Agent/src/skills/generated/snapshot-data.js 404`
- ❌ `POST http://127.0.0.1:5500/api/ollama/v1/chat/completions 405`
- ❌ `CORS blocked: 'https://ollama.com/v1/chat/completions'`

## The Root Cause

The dev-server isn't running (or was started from the wrong directory).

## The Fix

### Option 1: Use the startup script (EASIEST) ✅

```bash
cd "/media/samuel/PNY 1TB/Code/Agent"
./start-agent.sh
```

Then enter your API key when prompted.

### Option 2: Manual startup

```bash
cd "/media/samuel/PNY 1TB/Code/Agent"  # ⚠️ MUST be in this directory
export OLLAMA_API_KEY="5a44ef02cc0647f3b17cc2c88b4829d2.DtDWeoABBmLuExfrYMJ7X44l"
node proxy/dev-server.js
```

Expected output:
```
[dev-server] running at http://127.0.0.1:5500
[dev-server] proxy route: /api/ollama/v1 -> https://ollama.com/v1
```

### Step 3: Open in browser

Visit: http://127.0.0.1:5500

### Step 4: Configure Ollama Cloud

1. Click Settings (⚙️) in the bottom-left
2. Under "Cloud Model" select: **Ollama Cloud**
3. The Ollama Cloud controls will appear
4. Paste your API key and click **Save**
5. Select a model from the dropdown
6. Send a message!

## Verify It's Working

✅ No "404 Not Found" errors
✅ No "405 Method Not Allowed" errors  
✅ No "CORS blocked" errors
✅ Messages complete successfully

## Still Having Issues?

1. **Check the server is running**: You should see output in the terminal where you ran `node proxy/dev-server.js`
2. **Check the directory**: Confirm you're in `/media/samuel/PNY 1TB/Code/Agent` when starting the server
3. **Kill and restart**: Stop the server (Ctrl+C) and start it again
4. **Check your API key**: Make sure it's valid at https://ollama.com/account/api-keys
5. **Refresh the browser**: Press Ctrl+R (Cmd+R on Mac) to reload the page

## Quick Checklist

- [ ] Running server from `/media/samuel/PNY 1TB/Code/Agent`
- [ ] OLLAMA_API_KEY is set in the environment
- [ ] Server shows "running at http://127.0.0.1:5500"
- [ ] Browser shows http://127.0.0.1:5500 (not /Agent/...)
- [ ] Ollama Cloud is selected in Settings
- [ ] API key is saved in Settings
- [ ] Model is selected in dropdown
