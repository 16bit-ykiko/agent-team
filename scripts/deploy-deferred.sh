#!/bin/bash
# Build and restart the server after a short delay, detached from the caller.
# Used when the request comes from an agent running inside this very server:
# the delay lets its turn finish before the restart kills the session.
# Usage: setsid nohup scripts/deploy-deferred.sh [delay-seconds] >/dev/null 2>&1 < /dev/null &
sleep "${1:-10}"
cd "$(dirname "$0")/.." || exit 1
LOG="$HOME/.cache/agent-team-deploy.log"
mkdir -p "$(dirname "$LOG")"
{
  echo "=== $(date) build $(git rev-parse --short HEAD)"
  npm run build 2>&1 && echo "=== build ok, restarting" && systemctl --user restart agent-team-server && echo "=== restarted"
} >> "$LOG" 2>&1
