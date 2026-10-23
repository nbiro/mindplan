#!/bin/bash
# Build dist/ so the MindPlan MCP server in .mcp.json (node dist/index.js) can start.
# Runs only in Claude Code cloud sessions; local checkouts build with npm run build.
set -euo pipefail
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
npm install --no-audit --no-fund
npm run build
