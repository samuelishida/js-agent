#!/bin/bash
# Start the Ollama Cloud Agent with the dev-server proxy
# This script must be run from the Agent directory
#
# Usage:
#   ./start-agent.sh
#
# Or set your API key first:
#   export OLLAMA_API_KEY="your-key-here"
#   ./start-agent.sh

set -e

# Ensure we're in the Agent directory
AGENT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$AGENT_DIR"

# Check if we're in the right place
if [ ! -f "index.html" ] || [ ! -f "proxy/dev-server.js" ]; then
  echo "❌ Error: This script must be run from the Agent directory"
  echo "Current directory: $(pwd)"
  echo "Trying to find it..."
  if [ -d "Agent" ]; then
    cd Agent
  else
    echo "Could not find Agent/index.html"
    exit 1
  fi
fi

# Get API key if not already set
if [ -z "$OLLAMA_API_KEY" ]; then
  echo "📝 Enter your Ollama Cloud API key (or press Enter to skip):"
  read -r -s OLLAMA_API_KEY
  if [ -z "$OLLAMA_API_KEY" ]; then
    echo "⚠️  Warning: No API key set. You'll need to configure it in Settings."
  else
    export OLLAMA_API_KEY
    echo ""
  fi
fi

# Start the server
PORT="${PORT:-5500}"
export PORT

echo ""
echo "🚀 Starting Agent dev server..."
echo "   URL: http://127.0.0.1:$PORT"
echo "   Proxy: /api/ollama/v1 → https://ollama.com/v1"
if [ -n "$OLLAMA_API_KEY" ]; then
  echo "   API Key: ••••••••••••••••••••••••••${OLLAMA_API_KEY: -4}"
fi
echo ""

node proxy/dev-server.js
