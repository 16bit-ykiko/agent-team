---
name: deploy
description: Build and restart the production agent-team server safely from inside a session, watch the deploy log, and verify the server came back. Read BEFORE any build/restart/redeploy or when asked whether the server restarted.
---

# Deploy

Production is `agent-team-server.service` (systemd --user), `node dist/server.js` on port 9800, started via `scripts/start-server.sh`. Every agent session — including the one running this request — is a child process of that server. A restart kills the requesting session mid-turn, so restarts are always deferred and detached.

## Confirm who you are

```bash
pid=$(systemctl --user show -p MainPID --value agent-team-server); echo server=$pid
pgrep -P "$pid" | wc -l                       # live agent sessions (you are one)
grep -qa "AGENT_TEAM" /proc/$$/environ && echo "running inside the server"
```

A "busy agent" seen in the UI while you are working is usually you. Never conclude the server is idle from the panel.

## Redeploy

Only when the user asked for a restart in this turn. Finish all edits, run `npm run check && npm test` first, then:

```bash
setsid nohup scripts/deploy-deferred.sh 10 >/dev/null 2>&1 < /dev/null &
```

The script sleeps, runs `npm run build`, and `systemctl --user restart agent-team-server`, logging to `~/.cache/agent-team-deploy.log`. It lives in the repo on purpose: `/tmp` gets wiped and a script placed there once silently never ran. End your turn promptly after scheduling — the delay only has to outlast your final message.

If the user said "先别重启" (don't restart yet), commit and stop; schedule nothing.

## Verify (next turn, or when asked "重启了吗")

```bash
tail -20 ~/.cache/agent-team-deploy.log        # "=== build ok, restarting" / "=== restarted"
systemctl --user show -p ActiveEnterTimestamp -p MainPID agent-team-server
git -C dist log -1 2>/dev/null; ls -l --time-style=+%T dist/server.js
```

Compare `ActiveEnterTimestamp` with the log's timestamp and `dist/server.js` mtime with your last commit. If the log has no entry after your commit, the deferred script did not run: reschedule, don't assume.

## Testing a build without touching production

Start a second instance on another port and drive it yourself:

```bash
AGENT_TEAM_PORT=9801 node dist/server.js > /tmp/agent-team-9801.log 2>&1 &
```

Stop it by PID (`kill $!`), never with `pkill -f` on the command line — that pattern matches your own shell.

## Never

- `systemctl restart` / `kill` the server inline.
- Restart without `npm run check && npm test` green.
- Trust "没有活跃的进程" without `pgrep -P` — the count has been wrong before.
