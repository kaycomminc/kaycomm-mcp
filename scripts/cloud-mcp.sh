#!/bin/bash
# Starts the kaycomm MCP server over stdio inside a Claude cloud session.
# Proof of concept for running routines without Railway. Does nothing locally.
if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  echo "kaycomm-cloud only runs in cloud sessions" >&2
  exit 1
fi
cd "$(dirname "$0")/.." || exit 1
# Install deps on first start; all npm output goes to stderr so stdout stays clean for MCP.
if [ ! -d node_modules/@modelcontextprotocol ]; then
  npm ci --no-audit --no-fund --loglevel=error 1>&2 || exit 1
fi
unset PORT   # no PORT = stdio transport
exec node server.js
