#!/bin/sh
# Claude Code status line wrapper.
#
# Claude's weekly and 5-hour usage percentages only appear in the status line
# payload, so this forwards that payload to the agent-monitor daemon and then
# runs your original status line command (if any) so the status line itself
# looks exactly as before.
#
# Usage: statusline.sh ['original status line command']
input=$(cat)

# In the background so a slow or stopped daemon can never delay the status line.
printf '%s' "$input" | curl -s -m 1 -o /dev/null -X POST \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${AGENT_MONITOR_HTTP_PORT:-47800}/usage?agent=claude" \
  >/dev/null 2>&1 &

if [ -n "$1" ]; then
  printf '%s' "$input" | sh -c "$1"
fi
