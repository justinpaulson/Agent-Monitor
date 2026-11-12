#!/bin/sh
# Forwards an agent hook payload (JSON on stdin) to the agent-monitor daemon.
# Usage: notify.sh claude|codex
# Prints nothing and always exits 0 so it can never block or confuse the agent.
curl -s -m 1 -o /dev/null -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${AGENT_MONITOR_HTTP_PORT:-47800}/event?agent=${1:-claude}" \
  >/dev/null 2>&1
exit 0
