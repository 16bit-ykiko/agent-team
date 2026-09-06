---
name: stream-debug
description: Frame semantics of the Claude SDK stream and the event model that turns frames into the transcript (cards, steps, banners, summary pages, client/server aggregation). Read BEFORE editing claude-session.ts, task.ts, stream.ts, events.ts or messages.tsx, or when a screenshot shows a rendering oddity.
---

# Stream debugging

Fixtures for every fact below live in `service/tests/snap/claude/` and `codex/` (capture-sdk skill); the `.snap.md` next to each recording is the transcript the pipeline produces from it.

Pipeline: SDK frames → `service/src/claude-session.ts` (frames → `StreamEvent`) → `service/src/task.ts` (`Workspace.applyInnerEvent`, message list, `contentOffset`) → WebSocket `stream_event` batches → `webview/src/stream.ts` (`applyEventsToMessage`, same aggregation client-side) → `webview/src/events.ts` (`timelineBlocks`, `foldSubagents`) → `webview/src/messages.tsx`. The server and client aggregations must produce the same transcript; `service/tests/snap/snap.test.ts` asserts that on every recorded fixture. Codex goes through `codex-session.ts` into the same event model.

## Frame facts (from recordings, not docs)

- **Quick Bash**: `assistant` tool_use → `user` tool_result. No task frames.
- **Long foreground Bash** (a few seconds or more): CLI still emits `system/task_started` with `is_backgrounded: false`, then `task_notification`. This is _not_ a background task — no card. Cards for non-agent tasks only when `is_backgrounded === true`, or a later `task_updated` patch sets it, or the task appears in `background_tasks_changed`.
- **Background Bash** (`run_in_background`): `system/background_tasks_changed` arrives **before** `task_started`. Card = the command (from the tool_use input, keyed by tool_use id), tool_use stays in the folded tools box.
- **Background completion**: the CLI starts a _new turn_ with a second `system/init` and no user frame; a `task_notification` carries the summary. That is a wake-up (banner `wakeup`), not a new user message.
- **Resume after a restart with an orphaned background task** (fixture `claude/resume-orphan-bg`, after its `end` step): the CLI emits `task_notification` (status `stopped`, unknown task id) _before_ `system/init`, then a phantom `result` with `num_turns: 0`, `origin: {kind: "task-notification"}`, then a second `init` and the real turn. That result must not end our turn (`handleResult` skips it while `expectingTurn && awaitingFirstOutput`), or the prompt renders as "no output" and the reply as a wake-up. Real results never carry `origin`.
- **Agent (Task tool)**: `task_started` with `task_type: "agent"` / `subagent_type`; agents always get a card, and the card replaces the spawning tool_use (`spawnToolUseIds`). Subagent frames carry `parent_tool_use_id`; depth-2 frames carry the child's tool_use id, so the session wraps them per ancestor (`wrapToRoot`) as `subagent_progress` carriers with `_innerEvent`. Both aggregations recurse into nested carriers.
- **Slash skill typed by the user** (`/hello`): no user frame at all. **Skill tool called by the model**: a `user` frame with `isSynthetic: true` containing the skill text — treat as a `skill` notice, never as a wake-up or a new user turn. `shouldQuery: false` frames append to the transcript without starting a turn.
- **Wake-up detection** (`claude-session.ts`): a user-shaped frame counts as a wake-up only when not processing, or while expecting a turn before any first output (`awaitingFirstOutput`), and it is not a tool_result, not synthetic, not `shouldQuery === false`.
- **Init frame**: carries `effort` and `fast_mode_state`; `/fast` sets `settings.fastMode`; warn when the state is not `on`.
- **Context stats**: from the last main-loop assistant `usage` (not the cumulative result usage). Codex: from the rollout's last `token_count` (`total_tokens - reasoning_output_tokens`, window from `model_context_window`).
- **Codex** (fixtures `codex/*`): commands are `item.started`/`item.completed` `command_execution` pairs by item id with `exit_code` and `aggregated_output`; a failure stream is `item.completed error` (non-fatal notice) → `error` → `turn.failed` → the SDK generator throws; `codex exec` keeps stdout open ~3 s after `turn.completed`; the terminal event waits for stream close, else the next send races a busy session.
- `step` is per content block, not per model step — never split step boxes on it.

## Event model

- `StreamEvent.kind`: `text_delta`, `thinking`, `tool_use`/`tool_result` (paired by `toolUseId`), `subagent_start`/`subagent_progress`/`subagent_done` (`subagent.taskId`, `taskType`, `description`, `prompt`, `_innerEvent` carrier), `notice` (levels incl. `wakeup`, `schedule`, `skill`), `retry`, `compact`, `error`, `result`, `usage`.
- `contentOffset`: where in the message text the event sits, so tools/steps interleave with prose. Missing offset → previous event's; no offsets at all → everything at 0 (legacy messages).
- **Cards** are only for agent tasks and backgrounded tasks (`taskType`); they are timeline boundaries (`timelineBlocks`) so step boxes split around them. Everything else lives in the folded step box.
- **Banners** (`BANNER_KINDS`): compact, notice, retry, error. Long ones fold (`bannerFolds`); truncated content records `contentLength` and is fetched on demand.
- **Summary pages**: the server sends `summarizeMessages` (`detail: "summary"`, 600-char cap) for history; details load lazily. On reconnect `mergeLatestPage` keeps the richer version; `downgradedMessageIds` triggers re-fetch so live messages never show "tap to load".
- **Normalisation** (`normalizeEvents` in task.ts): on load, missing content → "", running/status-less messages → stopped.

## Debugging recipe

1. Find the fixture that matches the symptom (`ls service/tests/snap/claude service/tests/snap/codex`, read the `.snap.md`); `npm run summarize -- <jsonl>` for the frames. None matches → capture-sdk skill.
2. Reproduce in the replay test (assert the expected card/banner/pairing), watch it fail.
3. Fix on the server side first; if the client aggregation now disagrees, fix it to match — never fork the logic.
4. UI: `webview/tests/events.test.ts` for block splitting, `components.test.tsx`/`ui.test.tsx` for rendering. A screenshot bug gets a test that renders the same events.
