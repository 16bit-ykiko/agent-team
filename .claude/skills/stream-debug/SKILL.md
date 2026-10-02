---
name: stream-debug
description: Frame semantics of the Claude SDK stream and the event model that turns frames into the transcript (cards, steps, banners, summary pages, client/server aggregation). Read BEFORE editing service session/claude.ts or workspace/workspace.ts, webview state/stream.ts, chat/events.ts or chat/messages.tsx, or when a screenshot shows a rendering oddity.
---

# Stream debugging

Fixtures for every fact below live in `service/tests/snap/claude/` and `codex/` (capture-sdk skill); the `.snap.md` next to each recording is the transcript the pipeline produces from it.

Pipeline: SDK frames → `service/src/session/claude.ts` (frames → `StreamEvent`) → `service/src/workspace/workspace.ts` (`Workspace.applyInnerEvent`, message list, `contentOffset`) → WebSocket `stream_event` batches → `webview/src/state/stream.ts` (`applyEventsToMessage`, same aggregation client-side) → `webview/src/chat/events.ts` (`timelineBlocks`, `foldSubagents`) → `webview/src/chat/messages.tsx`. The server and client aggregations must produce the same transcript; `service/tests/snap/snap.test.ts` asserts that on every recorded fixture. Codex goes through `session/codex.ts` into the same event model.

## Frame facts (from recordings, not docs)

- **Quick Bash**: `assistant` tool_use → `user` tool_result. No task frames.
- **Run times** are our clock: a tool call from its tool_use to its tool_result (`durationMs`, merged into the call), a task from the call that started it to its `task_notification` (`subagent.durationMs`). A foreground command's `task_started` comes only after it has run a few seconds (fixture `claude/bash-long`), so a task never starts its clock there. The CLI's `usage.duration_ms` on agents counts from the first run, a resumed agent's idle time included.
- **Long foreground Bash** (a few seconds or more): CLI still emits `system/task_started` with `is_backgrounded: false`, then `task_notification`. This is _not_ a background task — no card. Cards for non-agent tasks only when `is_backgrounded === true`, or a later `task_updated` patch sets it, or the task appears in `background_tasks_changed`.
- **Background Bash** (`run_in_background`): `system/background_tasks_changed` arrives **before** `task_started`. Card = the command (from the tool_use input, keyed by tool_use id), tool_use stays in the folded tools box.
- **Background completion**: the CLI starts a _new turn_ with a second `system/init` and no user frame; a `task_notification` carries the summary. That is a wake-up (banner `wakeup`), not a new user message.
- **Resume after a restart with an orphaned background task** (fixture `claude/resume-orphan-bg`, after its `end` step): the CLI emits `task_notification` (status `stopped`, unknown task id) _before_ `system/init`, then a phantom `result` with `num_turns: 0`, `origin: {kind: "task-notification"}`, then a second `init` and the real turn. That result must not end our turn (`handleResult` skips it while `expectingTurn && awaitingFirstOutput`), or the prompt renders as "no output" and the reply as a wake-up. Real results never carry `origin`.
- **Agent (Task tool)**: `task_started` with `task_type: "agent"` / `subagent_type`; agents always get a card, and the card replaces the spawning tool_use (`spawnToolUseIds`). Subagent frames carry `parent_tool_use_id`; depth-2 frames carry the child's tool_use id, so the session wraps them per ancestor (`wrapToRoot`) as `subagent_progress` carriers with `_innerEvent`. Both aggregations recurse into nested carriers.
- **Agent resumed by SendMessage** (fixture `claude/resumed-agent-bg`): a finished agent sent a message gets a second `task_started` with the _same_ task id but the SendMessage call's `tool_use_id` (so do its `task_progress`/`task_notification`), while its own `assistant`/`user` frames still carry the _original_ Agent call's id as `parent_tool_use_id`. The session keeps that first id per task (`agentSpawnToolUse`) to route them. A background shell the subagent starts has `owned_by_subagent: true` and no parent field; only its tool_use (seen in the subagent's frames) ties it to the card.
- **Slash skill typed by the user** (`/hello`): no user frame at all. **Skill tool called by the model**: a `user` frame with `isSynthetic: true` containing the skill text — treat as a `skill` notice, never as a wake-up or a new user turn. `shouldQuery: false` frames append to the transcript without starting a turn.
- **Wake-up detection** (`session/claude.ts`): a user-shaped frame counts as a wake-up only when not processing, or while expecting a turn before any first output (`awaitingFirstOutput`), and it is not a tool_result, not synthetic, not `shouldQuery === false`.
- **Init frame**: carries `effort` and `fast_mode_state`; `/fast` sets `settings.fastMode`; warn when the state is not `on`.
- **Context stats**: from the last main-loop assistant `usage` (not the cumulative result usage). Codex: from the rollout's last `token_count` (`total_tokens - reasoning_output_tokens`, window from `model_context_window`).
- **Codex** (fixtures `codex/*`): commands are `item.started`/`item.completed` `command_execution` pairs by item id with `exit_code` and `aggregated_output`; a failure stream is `item.completed error` (non-fatal notice) → `error` → `turn.failed` → the SDK generator throws; `codex exec` keeps stdout open ~3 s after `turn.completed`; the terminal event waits for stream close, else the next send races a busy session. `item.started` for a command arrives as it starts (fixture `codex/command-time`: `sleep 2` → 1868 ms to `item.completed`), so a call's run time is that gap, a little short; item ids restart at `item_0` every turn.
- **Stop = interrupt** (fixture `claude/interrupt-bg`; `perTaskStopAffordance` declared in the query options): the foreground command gets a `task_notification` (stopped), then its `tool_result`, a user text "[Request interrupted by user for tool use]" and `result/error_during_execution`. The process lives on, and so do background shells and agents. Because we asked for it, `ClaudeSession` turns that error result into a `result` with `interrupted: true`, which the workspace renders as `*[interrupted]*`, not as an error.
- **stop_task** on a background task: `background_tasks_changed` (without it), `task_updated` (status killed), `task_notification` (stopped). A stopped background agent then reports back like any finished task: a wake-up turn whose result has `origin: {kind: "task-notification"}`.
- **Stop before any output** (fixture `claude/interrupt-early`): after `system/init` and before `message_start`, an interrupt yields a plain user text "[Request interrupted by user]", then `result/error_during_execution`. Arriving while we await the first output, that frame would read as a /skill expansion; `ClaudeSession` drops it while an interrupt is pending.
- **Wake-ups survive an idle interrupt** (fixture `claude/wakeup-interrupt`): a scheduled wake-up is no task, and interrupting with no turn running leaves it pending. It fires. Cancelling one therefore closes the CLI process (`cancelWake`); the session resumes on the next message. Its time comes from the `ScheduleWakeup` tool result ("Next wakeup scheduled for 12:51:00 (in 93s)"): the CLI rounds up to a minute boundary. A call whose result is an error schedules nothing.
- `step` is per content block, not per model step — never split step boxes on it.

## Event model

- `StreamEvent.kind`: `text_delta`, `thinking`, `tool_use`/`tool_result` (paired by `toolUseId`), `subagent_start`/`subagent_progress`/`subagent_done` (`subagent.taskId`, `taskType`, `description`, `prompt`, `_innerEvent` carrier), `notice` (levels incl. `wakeup`, `schedule`, `skill`), `retry`, `compact`, `error`, `result`, `usage`.
- `contentOffset`: where in the message text the event sits, so tools/steps interleave with prose. Missing offset → previous event's; no offsets at all → everything at 0 (legacy messages).
- **Cards** are only for agent tasks and backgrounded tasks (`taskType`); they are timeline boundaries (`timelineBlocks`) so step boxes split around them. Everything else lives in the folded step box.
- **Banners** (`BANNER_KINDS`): compact, notice, retry, error. Long ones fold (`bannerFolds`); truncated content records `contentLength` and is fetched on demand.
- **Summary pages**: the server sends `summarizeMessages` (`detail: "summary"`, 600-char cap) for history; details load lazily. On reconnect `mergeLatestPage` keeps the richer version; `downgradedMessageIds` triggers re-fetch so live messages never show "tap to load".
- **Normalisation** (`normalizeEvents` in workspace/workspace.ts): on load, missing content → "", running/status-less messages → stopped.

## Debugging recipe

1. Find the fixture that matches the symptom (`ls service/tests/snap/claude service/tests/snap/codex`, read the `.snap.md`); `npm run summarize -- <jsonl>` for the frames. None matches → capture-sdk skill.
2. Reproduce in the replay test (assert the expected card/banner/pairing), watch it fail.
3. Fix on the server side first; if the client aggregation now disagrees, fix it to match — never fork the logic.
4. UI: `webview/tests/events.test.ts` for block splitting, `components.test.tsx`/`ui.test.tsx` for rendering. A screenshot bug gets a test that renders the same events.
