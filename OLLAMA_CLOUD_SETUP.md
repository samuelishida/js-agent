# Ollama Cloud Setup Guide

## Overview

The Agent now uses a simplified UI for Ollama Cloud:
- **No more endpoint configuration** — the app automatically tries the same-origin proxy first, then falls back to `https://ollama.com/v1`
- **Simple API Key input** — just paste your Ollama Cloud API key
- **Model selector** — choose which model to use from a dropdown

## Quick Start

### 1. Open Settings
Click the settings icon (⚙️) in the bottom-left corner.

### 2. Select Ollama Cloud Provider
In the **Cloud Model** section, select `Ollama Cloud` from the dropdown.
- The "Ollama Cloud API Key" and "Ollama Cloud Model" controls will appear below

### 3. Save Your API Key
1. Paste your Ollama Cloud API key into the "Ollama Cloud API Key" field
2. Click **Save**

**Where to get your API key:**
- Visit https://ollama.com/account/api-keys
- Copy your API key
- Paste it into the Agent settings

### 4. Select a Model
1. Click the **Refresh** button to fetch available models from your Ollama Cloud account
2. Select a model from the "Ollama Cloud Model" dropdown
   - The selection auto-saves instantly

### 5. Send a Message
Start chatting! The Agent will use:
- Your Ollama Cloud API key for authentication
- The selected model for inference
- The same-origin proxy (`/api/ollama/v1`) if available, otherwise direct connection

## Troubleshooting

### "Ollama Cloud API key is required"
- You must save your API key in Settings before using Ollama Cloud

### "Ollama Cloud authentication failed"
- Double-check your API key is correct
- Verify the key hasn't expired on https://ollama.com/account/api-keys

### "Ollama Cloud request failed ... HTTP 401/403"
- Your API key is invalid or expired
- Generate a new key at https://ollama.com/account/api-keys

### "Ollama Cloud request failed due to CORS"
- The same-origin proxy is not running or not available
- The Agent will try direct connection to `https://ollama.com/v1` as fallback
- This should work in modern browsers with proper CORS headers

## Advanced: Local Proxy Setup

If you want to run a local proxy for added privacy or performance:

```bash
# Start the Agent dev server with Ollama Cloud proxy
cd "/media/samuel/PNY 1TB/Code/Agent"
export OLLAMA_API_KEY="your-ollama-cloud-api-key"
node proxy/dev-server.js
```

This serves:
- **UI**: http://127.0.0.1:5500
- **Proxy**: http://127.0.0.1:5500/api/ollama/v1

Then in Settings, you can optionally set:
- Ollama Cloud Endpoint: `/api/ollama/v1` (local proxy)

## How It Works

**Endpoint routing (automatic):**
1. Try same-origin proxy at `/api/ollama/v1` (if available)
2. Fall back to `https://ollama.com/v1` (direct connection)

**Authentication:**
- Your API key is sent via `Authorization: Bearer <your-key>` header
- The key is stored in browser `localStorage` (not transmitted to third parties)

**Model selection:**
- You choose which Ollama Cloud model to use
- Refresh button fetches real-time list from your account
- Selection persists across page reloads
