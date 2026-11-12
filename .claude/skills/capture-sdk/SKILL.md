---
name: capture-sdk
description: Snap fixtures — script a real Claude, Codex, Cursor or agy interaction, record it once, replay it as a test with a pinned transcript. Read BEFORE changing how backend frames map to events, and whenever you are unsure what a backend actually emits — record, don't guess.
---

# Snap fixtures: record real backend streams

Frame shapes and order from the Claude CLI, `codex app-server`, the Cursor SDK and `agy acp` are not documented well enough to code against from memory; past bugs (foreground shells rendered as cards, Skill invocations shown as wake-ups, a phantom result on resume) all came from guessing. **If a fix depends on what the stream looks like, record it first.**

## Rate limit — read first

Every recording is a real session on the user's account. Bursts of sessions can get the account **banned**. Record only the fixture the current bug needs (one or two), never "all of them"; the recorder refuses more than 4 per run and pauses 30 s between them — do not shorten that; never loop recordings to "try again". Reuse an existing recording whenever one shows the frames you need (`ls service/tests/snap/{claude,codex,cursor,agy}`).

agy recordings spend the user's limited Gemini quota (Google AI Ultra, shared with other projects' agy runs and the user's own): before each, `pgrep -a agy` in a call of its own, and wait while another `agy -p`/`--print` run is going; recordings run on `agy/gemini-3.8-flash` at thought level low.

## Anatomy

One fixture = three files in `service/tests/snap/<backend>/`:

- `<name>.ts` — the script and the intent. Steps drive the recorder _and_ the replay; `description` is the test name; `verify()` states why the fixture exists.
- `<name>.jsonl` — the recording: a header line (backend, model, CLI version, date) then `{t, frame}` entries with `{t, step}` markers between them, plus `{t, close}` (stream closed) and `{t, error}`. Codex recordings hold the JSON-RPC lines both ways: `{t, frame}` from the app-server, `{t, sent}` from the recorder.
- `<name>.snap.md` — the transcript the replay produced, pinned by vitest (`toMatchFileSnapshot`). Reviewed like code; regenerate with `npm test -w service -- -u` only after you understand every changed line.

`service/tests/snap/snap.test.ts` globs the fixtures. For each: replay through the real session (`ClaudeSession.sdk` / `CodexSession.hooks` / `CursorSession.sdk` / `AgySession.hooks` swapped for a player of the recorded frames, `Date` advanced per frame; the codex and agy player answers each request the session writes with the recorded response to the recorder's request of the same method, and fails when the session never writes one the recorder did), the real `Workspace`, then `verify()`, the snapshot, and the client/server transcript convergence. A fixture without a `.jsonl` fails with the record command.

```ts
export default fixture({
  description: "resuming past a stopped background task must not end our turn early",
  steps: [
    send("Run `sleep 120; echo late` … run_in_background …"),
    wait("result"), // the turn's result frame; "idle" = result + no background task + 4 s quiet
    end(), // kill the backend process (a server restart); the replay restores the session from state
    send("Reply with the single word two."),
    wait("idle"),
  ],
  files: { ".claude/skills/hello/SKILL.md": "…" }, // materialised in the recording cwd
  verify(r) {
    expect(agentMessages(r)[1].content.trim()).toBe("two");
  },
});
```

Steps: `send`, `wait`, `end`, `abort` (the user's Stop), `interrupt`, `stopTask`, and for codex `compact` (`thread/compact/start`) and `requeued` (a message the panel sends by itself, such as a steered one its stopped turn never read: the recorder sends it, the replay only expects the session to). Codex: a `send` while a turn runs is `turn/steer`, `interrupt` is `turn/interrupt`, `end` stops the app-server and the next step resumes the thread in a new one. `tools` declares client-defined tools (`dynamicTools`) the recorder answers with each one's `reply` (`success: false` for a refusal); the replay serves the same replies as the session's panel tools. Cursor: `end` closes the agent handle and the next `send` resumes the agent by id; `interrupt` is `run.cancel()`. agy: the recorder drives the server's own `AgySession` (its requests are the recording's `sent` lines), `interrupt` is `session/cancel`, `end` kills `agy acp` and the next `send` resumes the conversation in a new one; `tools` (and `instructions`) are served by the session's panel MCP server, each answer taped as a `toolAnswer` control (agy's update for an MCP call carries no result); each time the session looks at what agy did while idle (its log watch and timers) the tape has an `idleCheck` control, where the replay calls `checkIdle()`.

## Record

```bash
npm run capture -- claude resume-orphan-bg      # writes service/tests/snap/claude/resume-orphan-bg.jsonl
npm run capture -- codex commands
npm run summarize -- service/tests/snap/codex/commands.jsonl   # one line per entry
npm run capture -- cursor shell                                # key from ~/.cursor/api_key.txt
npm run capture -- agy background                              # empties /tmp/sdk-capture first: agy writes there unasked
```

A Cursor frame is tagged by where it came from: `delta` (onDelta), `step` (onStep), `message` (run.stream()), `status`, `result` (run.wait()), `tool` (a fixture's custom tool ran), `created`/`resumed` (the agent id), `thrown` (an SDK call threw, with the error's name and code). A fixture's `options.local.customTools` are passed to the agent; each send carries the model parameters and `force`, as `CursorSession` sends. In the replay a frame answers only the SDK call that produced it (a `resumed` frame only a `resume` of that id), and `verify()` sees `r.sdkCalls` (create / resume / send / cancel, in order) and `r.sends` (each send's model and local options).

- `api: "usage-limit"` points the backend at a local stand-in that refuses every request as a spent limit does: Claude's CLI through `ANTHROPIC_BASE_URL` (the five-hour limit), codex through a provider of its own (`usage_limit_reached` and the `x-codex-*` rate-limit headers). A limit recorded without spending any quota. Never hit a real limit on purpose.
- Uses the user's own logins (Cursor: the key file, billed to the user's plan); default models `claude-sonnet-5` / `gpt-6-luna` / `cursor/composer-2.5` / `agy/gemini-3.8-flash` (`model:` in the fixture overrides, e.g. a bad model for a failure recording). Codex turns run at low effort on the standard tier, whatever `~/.codex/config.toml` says.
- Recording cwd is `/tmp/sdk-capture`; `files` are written there first. Strings are trimmed to 400 chars and base64 payloads replaced, so recordings are safe to commit — still read the transcript before committing.
- Prompts must force the exact behaviour ("foreground", "run_in_background set to true", "do not poll", "each as its own command"). Claude CLI 2.1.319 refuses a foreground Bash command that starts with `sleep` ("Blocked: standalone sleep …"): a foreground wait is `python3 -c 'import time; time.sleep(90)'`; `sleep` with `run_in_background` still runs.

## Workflow for a stream bug

1. Find or write the fixture; `verify()` states the expected outcome; run `npm test -w service`.
2. No recording → record it (rate limit above). Read the summary end to end; add newly learned frame facts to the stream-debug skill.
3. Watch it fail, fix the server side, then make the client aggregation agree if the convergence check complains — never fork the logic.
4. Review the `.snap.md` diff; accept with `-u` only for lines you can explain.

## Re-record when

- The SDK/CLI is bumped (`@anthropic-ai/claude-agent-sdk`, `@openai/codex` or `@cursor/sdk` in `service/package.json`), or agy updates itself (`agy --version`, in each agy recording's header).
- A user screenshot shows a scenario no fixture covers.
- The mapping needs a frame field you cannot point to in an existing recording.
