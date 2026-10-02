# Agent Team

A self-hosted panel for running a team of coding agents. Each project has a
long-lived **lead** you plan the work with; when you decide on something, the
lead starts **workers** in the repository or a git worktree, and every one of
them is a conversation you can open and join — from a browser, or from a phone
where the panel installs as a home-screen app.

It drives the agent CLIs you already have: **Claude** through
`@anthropic-ai/claude-agent-sdk` and **Codex** through `@openai/codex-sdk`.
There is no model of its own here; this is the orchestration and the UI around
the CLIs.

## How the team works

- **Projects and leads** — a project is a repository with a lead session. You
  talk the work over with the lead; it starts worker sessions with a
  complete, self-contained task through the panel's own MCP tools, in the
  repository or one of a few worktrees it reuses rather than making one per
  session. It never starts work you did not ask for.
- **Autonomous workers** — a worker decides what it can itself and asks you,
  in its own session, what is yours to decide; the sidebar marks it
  "your turn". When the task is done it reports to the lead with
  `finish_task`; `report_progress` is only for news that changes the lead's
  plans. The lead steps back: it does not relay, chase or poll.
- **An objectives board** — objectives with tasks, decisions and dependencies,
  kept current by the workers as they go and read by the lead to talk things
  over with you. A list by area and a dependency graph; each objective is a
  TOML file under `.agent-team/projects/`, editable by hand, with the
  project's notes beside it.
- **A shared, searchable history** — every message, thinking block, tool call
  (input, output and how long it ran) and subagent run of every session is
  stored in `history.db`. Leads and workers search it like grep
  (`search_history`, `read_entry`, `read_session`) and query it with
  read-only SQL (`query_history`): counts, grouping, one tool's calls across
  sessions.
- **Across projects** — leads message each other's projects
  (`list_projects`, `message_project`).
- **Surviving restarts and limits** — a turn a server restart cut off is
  carried on by the panel itself; a turn stopped by the five-hour limit is
  retried after the window resets; a weekly limit on the default account
  fails over to another configured account.
- Leads and workers write to you in Simplified Chinese (code, identifiers
  and commits stay English); the instruction is in
  `service/src/project/tools.ts`.

## The panel

- **Workspaces** — a folder plus the agents working in it, project or not.
  Each agent keeps a separate session, so two agents in the same repo do not
  share context.
- **A transcript that shows the work**, not just the answer: thinking blocks,
  tool calls with their run times, subagent and background-task cards, and a
  per-message row with effort level and context usage. Long histories page
  in lazily.
- **Side panels**, floating or pinned beside the chat:
  - _Agents_ — from a lead, every session of the project in a two-line card
    to unfold; from any other session, that session alone: its agents'
    models and context, background tasks and wake-ups, and the buttons to
    stop them.
  - _Files_ — the workspace's tree and its uncommitted changes as diffs; a
    file a reply names opens here.
  - _Objectives_ — the project's board.
- **Run state per agent** — idle, working, waiting on background work, or
  sleeping until a scheduled wake-up. The context figure is the size of the
  turn's last request against the model's window (for Codex, read from the
  thread's rollout), not a running total.
- **Slash commands** handled by the panel itself, on top of whatever the
  Claude CLI offers: `/effort <level>`, `/fast [on|off]` (Claude fast mode /
  Codex priority tier), `/goal <objective>` (Codex goals: the agent keeps
  working toward it across turns; `/goal clear` ends it), `/context`,
  `/usage`. The CLI's own command list is remembered across restarts.
- **Scheduled wake-ups** — an agent can put itself to sleep and come back
  later; the banner says what it is waiting for and when it returns.
- **Git awareness** — branch, dirty count and open PRs per folder.
- **Search** across every workspace's messages from the sidebar.
- **Mobile-first UI** — installable PWA, safe-area aware, composer pinned above
  the keyboard. Coming back from the background re-syncs the open transcript
  and replaces a socket the phone silently dropped, so a turn that finished
  while the screen was off shows as finished. One bundled font (Sarasa Mono
  SC) for Latin and Chinese, so both line up the same on every device.
- **Housekeeping** — workspaces idle past `archive_after_days` are archived:
  history leaves memory (still on disk) and idle CLI processes shut down.
  Sending a message restores them.

## Requirements

- Node.js 24+ (the history is stored with `node:sqlite`)
- The agent CLIs you intend to use, on `PATH`:
  - [`claude`](https://docs.claude.com/en/docs/claude-code/overview)
  - [`codex`](https://developers.openai.com/codex/cli)

The server resolves `codex` via `which codex`, so the CLI on your `PATH` is the
one that runs — keep it current or new model ids will be rejected.

[pixi](https://pixi.sh) is used for the Node toolchain but is optional; plain
`npm` works too.

## Getting started

```bash
git clone https://github.com/16bit-ykiko/agent-team.git
cd agent-team
npm install

cp config.example.toml config.toml
$EDITOR config.toml          # see "Configuration" below

npm run build                # webview, then service
node dist/server.js          # http://localhost:9800
```

With pixi, `pixi run serve` builds and starts in one step.

### Development

```bash
pixi run dev-webview         # Vite dev server with HMR
npm run check                # tsc (strict) + ESLint + prettier, zero tolerance
npm test                     # service + webview (vitest)
npm run fmt                  # prettier
```

To try the UI without touching your own data, seed a demo — a project with a
lead, workers, history and a board; no session is started — into a separate
base directory and run a second instance on it:

```bash
npm run demo -- .agent-team/dev
cp config.example.toml .agent-team/dev/config.toml
AGENT_TEAM_PORT=9801 AGENT_TEAM_BASE_DIR=$PWD/.agent-team/dev node dist/server.js
```

CI (`.github/workflows/ci.yml`) runs `check`, `test` and `build` on every push
and pull request. Agent-facing project rules live in `.claude/CLAUDE.md`, with
task-specific playbooks under `.claude/skills/` (deploy, capture-sdk,
stream-debug, add-model, review).

Both backends' event mappings are tested against recorded real interactions
(`service/tests/snap/{claude,codex}/`): each fixture is a script (`<name>.ts`,
which also states what it verifies), the recording it produced
(`<name>.jsonl`) and the transcript the replay pins (`<name>.snap.md`).
`npm run capture -- <backend> <name>` records a fixture with your own login;
`npm run summarize -- <file.jsonl>` prints one line per frame. When a CLI
changes shape, re-record rather than guess.

## Configuration

Everything lives in `config.toml` (gitignored — `config.example.toml` is the
template). Accounts, providers and presets reload live on change; the port and
the auth cookie secret need a restart.

```toml
[auth]                       # omit the section to disable auth entirely
username = "agent"
password = "..."             # compared in plain text; use a long random one
session_secret = "..."       # openssl rand -hex 32
max_age_days = 30

[workspace]
archive_after_days = 14      # 0 disables archiving

[hosts.local]
label = "Local"
type = "local"

[accounts.work]              # extra Claude accounts, picked per agent
oauth_token = "sk-ant-oat01-..."   # from `claude setup-token`

[providers.deepseek]         # any Anthropic-compatible endpoint
api_key = "..."
base_url = "https://api.deepseek.com/anthropic"
```

A provider name must be a prefix of the model ids routed to it, so
`[providers.deepseek]` serves `deepseek-v4-pro`.

### Environment

| Variable              | Default | Meaning                           |
| --------------------- | ------- | --------------------------------- |
| `AGENT_TEAM_PORT`     | `9800`  | HTTP + WebSocket port             |
| `AGENT_TEAM_BASE_DIR` | cwd     | Where `.agent-team/` is stored    |
| `AGENT_TEAM_WEB_DIR`  | bundled | Where the built UI is served from |
| `AGENT_TEAM_DEBUG`    | unset   | `1` logs raw CLI payloads         |

State (workspaces, `history.db` and its search index, projects and their
boards, debug snapshots) lives under `.agent-team/` in the base directory.

## Available models

The model list is maintained by hand in
[`service/src/config/presets.ts`](service/src/config/presets.ts) — ids, labels, backend,
which reasoning-effort levels each one accepts, the default effort, and for
Codex the context window and fast service tier. Adding a model means adding
an entry there **and** making sure the CLI on your `PATH` is new enough to
know the id.

A `[1m]` suffix selects the large context window: for Claude it is part of
the model id the CLI accepts; for Codex (`gpt-6-astra[1m]`, `gpt-5.6-*[1m]`)
the id is stripped and the 872K window is set through `model_context_window`.
The numbers come from `~/.codex/models_cache.json`.

Agent identities (name, avatar, colour) are presets in the same file.

## Running it as a service

`scripts/start-server.sh` builds a `PATH` that works under systemd. A user unit
is enough:

```ini
[Service]
ExecStart=%h/workspace/agent-team/scripts/start-server.sh
Restart=always
```

If you expose it beyond localhost, put it behind TLS and keep `[auth]` on —
agents here run with full filesystem access to the folders you give them.

To redeploy from inside a session — an agent working on this repo cannot
restart the server mid-turn without killing itself —
`scripts/deploy-deferred.sh [seconds]` builds and restarts after a delay,
detached from the caller; it logs to `~/.cache/agent-team-deploy.log`.

## Layout

```
service/src/     Node server
  server/        HTTP + WebSocket, auth, uploads, quota
  session/       one adapter per CLI backend (claude.ts, codex.ts)
  workspace/     message list, event aggregation, persistence, search
  project/       project leads, worker sessions, objectives, the panel's MCP tools
  config/        config.toml, agent + model lists (presets.ts, hand-maintained)
  repo/          git status, PR lookups, directory completion
webview/src/     React UI (Vite)
  state/         WebSocket client and client-side aggregation
  chat/          transcript rendering, markdown, input helpers
  panels/        the side panels: agents, files, background work
  project/       the objectives board and dependency graph
  sidebar/ workspace/ viewport/ dev/ fonts/
scripts/         start script, deferred deploy, SDK capture + smoke tests, demo seed,
                 font and file-icon import
.claude/         CLAUDE.md + skills: the rules and playbooks agents load when working here
```

## License

[Apache-2.0](LICENSE)
