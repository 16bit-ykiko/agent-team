# agent-team — Project Guide

A self-hosted panel that runs Claude (via `@anthropic-ai/claude-agent-sdk`) and Codex (via `@openai/codex-sdk`) agents in per-folder workspaces. `service/` is the Node server (HTTP + WebSocket, sessions, persistence, git), `webview/` the React client (Vite), `scripts/` the tooling. Everything is TypeScript.

Detailed knowledge lives in skills — load them at the moments their descriptions state, don't work from memory:

- **deploy** — before building, restarting, or checking the production server. You are usually running _inside_ that server.
- **capture-sdk** — the snap fixtures (`service/tests/snap/`): whenever behaviour depends on what the Claude CLI or `codex exec` actually emits. Record first, then code.
- **stream-debug** — before touching the event pipeline (`session/claude.ts` → `workspace/workspace.ts` → `state/stream.ts`/`chat/events.ts` → `chat/messages.tsx`): frame semantics and the event model.
- **add-model** — before adding or renaming a model in `config/presets.ts`.
- **review** — before committing anything non-trivial: independent reviewer subagents, findings verified before fixes.

## Hard Rules

- **Never add `"type": "module"` to the root `package.json`.** `dist/server.js` is a CommonJS bundle; that flag makes it crash on start. ESM-only directories carry their own `package.json`.
- **Never restart, kill, or redeploy the production server directly.** It is `agent-team-server.service` (systemd --user, port 9800) and the session running your request is one of its children. The only allowed path is `scripts/deploy-deferred.sh` (deploy skill), and only when the user asked for a restart in this turn.
- **Never skip, weaken, or `.skip` a failing test.** Fix the cause. Every UI change ships with a vitest test; every event-pipeline change is checked against the snap fixtures, and a `.snap.md` is only regenerated (`-u`) for diffs you can explain line by line.
- **Never guess the shape of an SDK stream.** If a fix depends on frame order or fields, capture the scenario (capture-sdk skill) and add the recording as a fixture.
- **Never start many real Claude/Codex sessions in a short time.** Captures and smoke tests hit the user's own account; bursts of sessions look like abuse and can get the account banned. Capture only the scenarios you need, one at a time, spaced out; never loop captures or run them in parallel.
- **Never push unverified code.** `npm run check && npm test && npm run build` locally before every push. Commit only when asked; push only when asked.
- Never `pkill -f` a pattern that can match your own shell (the server command line, `codex exec`, ...). Kill specific PIDs.

## Working Style

- Read the existing code path end to end before changing it: an event goes server session → workspace aggregation → WebSocket → client aggregation → renderer, and the server and client aggregations must agree (the replay test asserts it).
- Keep the layout the user has; restyle and add small structure, don't redesign. Cleaner and more modern, no clutter.
- Zero new comments by default. Add one only for a non-obvious why, an invariant nothing enforces, or an external quirk that cost real debugging. Never describe what changed.
- Apply cleanup instructions project-wide in one pass; grep for every occurrence.
- Small reversible changes: just do them. Protocol or persistence format changes, restarts, CI edits: confirm first.

## Layout

`service/src/` (Node server):

- `index.ts` — entry point; `server/` — `server.ts` (WebSocket protocol, workspace lifecycle, accounts, persistence), `auth.ts`, `http.ts` (static files, uploads), `quota.ts`, `system.ts`, `commands.ts` (slash commands handled locally)
- `session/` — `claude.ts` / `codex.ts`, one adapter per backend, both emit `StreamEvent`s; `host.ts` creates them
- `workspace/` — `workspace.ts` (message list, event aggregation), `state.ts` (persistence: `<id>.json` per workspace), `history-db.ts` (every message in `history.db`, only changed ones written), `history-index.ts` / `history-worker.ts` / `history-service.ts` (search index: messages cut into entries, trigram FTS, read-only SQL, in a worker thread; derived, rebuilt when deleted), `summary.ts` (summary pages sent before details are requested)
- `project/` — `manager.ts` (project leads, worker sessions, cross-project messages), `tools.ts` (the panel's MCP tools), `store.ts` (projects, objectives, notes under `.agent-team/projects/`), `issues.ts` / `issue-board.ts` (known defects, one TOML per module, apart from the objectives and linked to them; a fixed one is deleted)
- `config/` — `config.ts` (config.toml), `presets.ts` (agent and model lists, hand-maintained)
- `repo/` — `git.ts`, `scanner.ts` (branch/PR polling), `dirs.ts`

`webview/src/` (React client): `App.tsx` / `main.tsx` at the top; `state/` — `useServer.ts` (WebSocket client, types, reconnect/resync), `stream.ts` (client-side aggregation); `chat/` — `messages.tsx`, `events.ts` (timeline blocks), markdown, input helpers; `sidebar/`; `workspace/` (header, dialogs, avatars); `project/`; `viewport/`; `dev/` (replay demo, mock data, debug snapshots).

Tests and tooling:

- `service/tests/unit/` — unit tests for the server (frame mapping edge cases, config, git, state, projects); `fakes.ts` holds in-memory sessions
- `service/tests/snap/{claude,codex}/<name>.{ts,jsonl,snap.md}` — recorded real interactions (script + recording + pinned transcript), replayed by `snap.test.ts` through the real sessions
- `scripts/` — `deploy-deferred.sh`; `capture-sdk.ts` / `summarize-capture.ts` / `smoke-*.ts` run via `npm run capture|summarize|smoke:claude|smoke:codex`; `seed-demo.ts` (`npm run demo -- <dir>`) fills an empty dev data dir with a demo project to try the UI on, starting no session; `import-issues.ts` (`npm run import-issues -- <list dir> <out dir> [<objectives dir>]`) turns a hand-kept markdown bug list (clice's `temp/issues/`) into issue files plus a report, reading the list only; `vscode-icons.ts` (`npm run vscode-icons -- <vscode-icons dir> <vscode>/resources/app ~/.vscode/extensions`) takes the vscode-icons extension's file and folder icons (SVGs into `webview/public/file-icons/`, which file gets which into `webview/src/panels/vscode-icons.json`); `sarasa-font.ts` (`npm run sarasa-font -- <dir with the SarasaMonoSC TTFs>`) cuts the bundled UI font into per-character slices under `webview/src/fonts/`

## Build, Check, Test

- Node ≥ 24 (the history is in `node:sqlite`), npm workspaces rooted at the repo top level — `npm install` at the root only. TypeScript scripts run through `tsx` (`npm run capture -- …`), never compiled.
- `npm run check` — root `tsc` (scripts + cross-package test), per-workspace strict `tsc`, ESLint (`typescript-eslint` recommendedTypeChecked + react-hooks), prettier. Zero tolerance; no `eslint-disable` except `react-hooks/exhaustive-deps` with a stated reason.
- `npm test` — vitest in `service/` (`tests/unit` + `tests/snap`) then `webview/` (jsdom + testing-library).
- `npm run build` — Vite bundle then esbuild server bundle into `dist/`. The SDKs are `external`: the server resolves them from `node_modules` at runtime.
- CI (`.github/workflows/ci.yml`) runs check, test, build on every push and PR.

## Commits

Conventional style, lowercase, imperative: `fix: …`, `feat: …`, `test: …`, `chore: …`, `ui: …`, `docs: …`. One logical change per commit; mention the user-visible symptom in the subject when there is one.
