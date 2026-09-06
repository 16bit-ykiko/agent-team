# Agent Team

A web panel for running several coding agents side by side, each in its own
folder, each holding its own conversation. Point it at your projects, add a
couple of agents, and talk to them from a browser — including a phone, where it
installs as a home-screen app.

It drives the agent CLIs you already have: **Claude** through
`@anthropic-ai/claude-agent-sdk` and **Codex** through `@openai/codex-sdk`.
There is no model of its own here; this is the orchestration and the UI around
the CLIs.

## What it gives you

- **Workspaces** — a folder plus the agents working in it. Each agent keeps a
  separate session, so two agents in the same repo do not share context.
- **A transcript that shows the work**, not just the answer: thinking blocks,
  tool calls, sub-agent runs, and a per-message row with effort level and
  context usage. Long histories page in lazily.
- **Run state per agent** — idle, working, waiting on you, or sleeping until a
  scheduled wake-up, shown in the sidebar. The context figure is the size of
  the turn's last request against the model's window (for Codex, read from
  the thread's rollout), not a running total.
- **Slash commands** handled by the panel itself, on top of whatever the
  Claude CLI offers: `/effort <level>`, `/fast [on|off]` (Claude fast mode /
  Codex priority tier), `/goal <objective>` (Codex goals: the agent keeps
  working toward it across turns; `/goal clear` ends it), `/context`,
  `/usage`. The CLI's own command list is remembered across restarts.
- **Scheduled wake-ups** — an agent can put itself to sleep and come back
  later; the banner says what it is waiting for and when it returns.
- **Git awareness** — branch, dirty count and open PRs per folder.
- **Mobile-first UI** — installable PWA, safe-area aware, composer pinned above
  the keyboard. Coming back from the background re-syncs the open transcript
  and replaces a socket the phone silently dropped, so a turn that finished
  while the screen was off shows as finished.
- **Housekeeping** — workspaces idle past `archive_after_days` are archived:
  history leaves memory (still on disk) and idle CLI processes shut down.
  Sending a message restores them.

## Requirements

- Node.js 22+
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

| Variable              | Default | Meaning                        |
| --------------------- | ------- | ------------------------------ |
| `AGENT_TEAM_PORT`     | `9800`  | HTTP + WebSocket port          |
| `AGENT_TEAM_BASE_DIR` | cwd     | Where `.agent-team/` is stored |
| `AGENT_TEAM_DEBUG`    | unset   | `1` logs raw CLI payloads      |

State (workspaces, transcripts, debug snapshots) lives under
`.agent-team/` in the base directory.

## Available models

The model list is maintained by hand in
[`service/src/presets.ts`](service/src/presets.ts) — ids, labels, backend,
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
service/src/     Node server: HTTP + WebSocket, sessions, config, git, state
  claude-session.ts / codex-session.ts   one adapter per CLI backend
  presets.ts                             agent + model lists (hand-maintained)
webview/src/     React UI (Vite), one panel per workspace
scripts/         start script, deferred deploy, SDK capture + smoke tests, one-off migrations
.claude/         CLAUDE.md + skills: the rules and playbooks agents load when working here
```

## License

[Apache-2.0](LICENSE)
