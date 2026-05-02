#!/usr/bin/env bash
# Render.com Deploy Script
#
# Usage:
#   ./deploy-render.sh                    # Manual deploy via Render API
#   RENDER_API_KEY=... ./deploy-render.sh # With inline API key
#
# Prerequisites:
#   1. Create a Render API key at: https://dashboard.render.com/api-keys
#   2. Set RENDER_API_KEY environment variable
#   3. Set RENDER_SERVICE_ID to your web service ID (found in Render dashboard)
#
# For automatic deploys on push to main, connect your GitHub repo in Render dashboard.
# Render will use render.yaml to build and deploy automatically.

set -e

# Load env vars from .env if present
if [ -f .env ]; then
  echo "Loading environment from .env..."
  set -a
  source .env
  set +a
fi

# Validate required env vars
if [ -z "$RENDER_API_KEY" ]; then
  echo "Error: RENDER_API_KEY is not set."
  echo "Get your API key at: https://dashboard.render.com/api-keys"
  echo ""
  echo "Usage:"
  echo "  RENDER_API_KEY=your_key RENDER_SERVICE_ID=svc_xxx ./deploy-render.sh"
  exit 1
fi

if [ -z "$RENDER_SERVICE_ID" ]; then
  echo "Error: RENDER_SERVICE_ID is not set."
  echo "Find your service ID in the Render dashboard URL:"
  echo "  https://dashboard.render.com/service/<SERVICE_ID>"
  echo ""
  echo "Usage:"
  echo "  RENDER_API_KEY=your_key RENDER_SERVICE_ID=svc_xxx ./deploy-render.sh"
  exit 1
fi

# Get commit SHA
COMMIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

echo "Triggering deploy..."
echo "  Service ID: $RENDER_SERVICE_ID"
echo "  Commit:     ${COMMIT_SHA:-manual}"

# Trigger deploy via Render API
RESPONSE=$(curl -s -X POST "https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Content-Type: application/json" \
  $([ -n "$COMMIT_SHA" ] && echo "-d \"{\\\"commitSlug\\\": \\\"${COMMIT_SHA}\\\", \\\"clearCache\\\": \\\"nocache\\\"}\"" || echo "-d '{}" )
)

if echo "$RESPONSE" | grep -q '"id"'; then
  DEPLOY_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo ""
  echo "Deploy triggered successfully!"
  echo "  Deploy ID: $DEPLOY_ID"
  echo "  Monitor:   https://dashboard.render.com/services/${RENDER_SERVICE_ID}/deploys/${DEPLOY_ID}"
else
  echo "Deploy trigger failed:"
  echo "$RESPONSE"
  exit 1
fi
