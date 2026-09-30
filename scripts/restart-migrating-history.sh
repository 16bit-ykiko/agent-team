#!/bin/bash
# One-time restart onto history.db (scripts/migrate-history.ts): builds, then
# stops the server, finishes the migration and starts the new build. Those
# steps run in a unit of their own: stopping the server kills everything in
# its cgroup, this script included when an agent started it. If the migration
# fails before changing any workspace file, the previous build is put back.
# Delete with migrate-history.ts.
# Usage: setsid nohup scripts/restart-migrating-history.sh [delay-seconds] >/dev/null 2>&1 < /dev/null &
sleep "${1:-10}"
cd "$(dirname "$0")/.." || exit 1
LOG="$HOME/.cache/agent-team-deploy.log"
mkdir -p "$(dirname "$LOG")"
{
  echo "=== $(date) build $(git rev-parse --short HEAD), moving the histories"
  rm -rf dist.prev && cp -a dist dist.prev &&
    npm run build 2>&1 && echo "=== build ok, restarting through agent-team-migrate-history" &&
    systemd-run --user --collect --unit=agent-team-migrate-history \
      -p WorkingDirectory="$PWD" -E PATH="$PATH" -E HOME="$HOME" -E LOG="$LOG" \
      bash -c '
        {
          systemctl --user stop agent-team-server && echo "=== stopped"
          npm run migrate:history -- --base . --finish
          status=$?
          if [ $status -eq 0 ]; then
            echo "=== histories moved"
          elif [ $status -eq 2 ]; then
            echo "=== migration FAILED, no workspace file changed: previous build restored"
            rm -rf dist && mv dist.prev dist
          else
            echo "=== migration FAILED halfway (status $status): the new build will refuse to start"
          fi
          systemctl --user start agent-team-server && echo "=== restarted"
        } >> "$LOG" 2>&1'
} >> "$LOG" 2>&1
