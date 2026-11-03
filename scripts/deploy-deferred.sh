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
  npm run build 2>&1 || exit 1
  echo "=== build ok, restarting"
  if [[ "$(systemctl --user show -p LoadState --value agent-team-server 2>/dev/null)" == loaded ]]; then
    systemctl --user restart agent-team-server || exit 1
  elif [[ -x "$HOME/.local/bin/agent-team-service" ]]; then
    "$HOME/.local/bin/agent-team-service" restart || exit 1
  else
    echo "=== no supported service manager found; server was not restarted"
    exit 1
  fi
  echo "=== restarted"
} >> "$LOG" 2>&1
