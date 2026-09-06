---
name: capture-sdk
description: Record real Claude SDK streams for a scenario, inspect them, and turn them into replay fixtures and assertions. Read BEFORE changing how frames map to events, and whenever you are unsure what the CLI actually emits — record, don't guess.
---

# Capture real SDK streams

The Claude CLI's frame shapes and order are not documented well enough to code against from memory; several past bugs (foreground shells rendered as cards, Skill invocations shown as wake-ups, empty nested-subagent transcripts) came from guessing. The rule: **if a fix depends on what the stream looks like, capture it first.**

## Rate limit — read first

Every capture is a real session on the user's account. Bursts of sessions can get the account **banned**. Rules: capture only the scenarios the current bug needs (usually one or two), never all of them at once; one session at a time, never in parallel; the script waits 30 s between scenarios — do not shorten it; at most a handful of sessions per hour, and never loop captures to "try again". Reuse existing fixtures whenever one already shows the frame you need.

## Record

```bash
mkdir -p /tmp/sdk-capture/.claude/skills/hello
printf -- '---\nname: hello\ndescription: say hello\n---\nReply with the single word hello.\n' > /tmp/sdk-capture/.claude/skills/hello/SKILL.md
node scripts/capture-sdk.ts bash-long agent-bg        # only what you need, max 4 per run
```

- Uses the user's own Claude login; model `claude-sonnet-5` (`CAPTURE_MODEL` to override — Sonnet is cheap and emits the same frames).
- Scenarios live in `SCENARIOS` in `scripts/capture-sdk.ts`: `bash-quick`, `bash-long`, `bash-bg`, `agent`, `agent-bg`, `nested-agent`, `skill`, `skill-tool`, `image`, `two-turns`, `resume-orphan-bg` (two sessions: the first is ended right after its result with a background task still running, the second resumes it). Add a new one as a prompt list, or as `{ prompts, resume }` for a resume scenario; the prompt must force the exact tool usage (say "foreground" / "run_in_background true", "do not poll").
- Output: `~/.cache/agent-team-captures/<scenario>.jsonl`, one `{t, msg}` per frame, strings trimmed to 400 chars, base64 replaced. The watchdog ends the session 4 s after the last result once no non-ambient background tasks remain, 150 s hard cap.
- `image` needs `CAPTURE_IMAGE=<png>`; `skill*` need the hello skill above under the capture cwd.

## Inspect

```bash
node scripts/summarize-capture.ts ~/.cache/agent-team-captures/agent-bg.jsonl
```

One line per frame: time, `type/subtype`, `parent=` (last 6 chars of the parent tool_use id), content-block labels (`tool_use:Bash#id`, `tool_result->id`), `isSynthetic`/`shouldQuery`, task fields (`task_id`, `task_type`, `is_backgrounded`, `status`, `patch`, `tasks=[...]`). Read the whole thing before deciding what the mapping should do. Known facts are listed in the stream-debug skill; add newly learned ones there.

## Turn it into a test

1. Copy the capture into `service/tests/fixtures/sdk/<scenario>.jsonl`. Check it for anything private (paths, prompts) — fixtures are committed.
2. In `service/tests/sdk-captures.test.ts` add a case using the existing helpers: `replay(name)` feeds every frame through a real `ClaudeSession` (SDK mocked to the recording) into a `Workspace`, and through the client aggregation (`webview/src/stream.ts`). Assert on the _outcome_ (which cards exist, tool_use/tool_result pairing, banners, the final text), not on frame counts.
3. Keep the convergence assertion: the server-side and client-side transcripts must be equal for every fixture. If they diverge, the bug is in whichever side doesn't recurse/handle the new frame — fix the aggregation, not the assertion.
4. `npm test -w service`; the file is type-checked by the root `tsconfig.json` (`npm run typecheck`).

## Re-capture when

- The SDK/CLI is bumped (`package.json` `@anthropic-ai/claude-agent-sdk`).
- A scenario the fixtures don't cover shows up in a user screenshot.
- The mapping code needs a frame field you can't point to in an existing fixture.
