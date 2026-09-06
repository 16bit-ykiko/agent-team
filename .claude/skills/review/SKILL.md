---
name: review
description: Independent multi-reviewer pass over a change — parallel reviewer subagents (and codex when available) with disjoint focus, every finding verified before it is fixed. Read BEFORE committing a non-trivial change or when the user asks for a deep audit.
---

# Review

Reviews caught real defects here that the author session was blind to (rendering pipeline: three independent reviews found different bugs). The value is independence: reviewers must not share the writer's assumptions, so give them the diff and the rules, not your reasoning.

## When

- Any change to the event pipeline, WebSocket protocol, persistence format, or session lifecycle.
- Anything the user calls "彻底" / "深入" — they want the audit, not a quick look.
- Before pushing a batch of fixes that touched more than two of: `claude-session.ts`, `task.ts`, `stream.ts`, `events.ts`, `messages.tsx`, `useServer.ts`.

## How

Commit first (`git status` clean) so reviewers see the real diff: `git diff <base>...HEAD`.

Launch reviewers in parallel with the Agent tool, each with one focus and the same output contract:

- **correctness** — logic, races (rAF batching, reconnect resync, busy sessions), off-by-one in `contentOffset`, pairing of tool_use/tool_result, nested carriers.
- **protocol/state** — server and client aggregation still agree; summary vs detail pages; persistence/normalisation; what a reconnect or restart mid-turn does.
- **tests** — what the change should have covered; run `npm test` and `npm run check`; write the missing test and report whether it fails on the old code.
- **UI** (when webview changed) — render the affected events in jsdom, mobile layout classes, folding/expansion states.

Prompt shape: "Read `.claude/CLAUDE.md` and the stream-debug skill. Review `git diff <base>...HEAD` for <focus>. Report ranked findings, each with `file:line`, a concrete failure scenario (inputs → wrong output), and the smallest test that would expose it. No style comments." Ask for a digest, not prose.

Codex, when installed, is a good extra reviewer with different blind spots:

```bash
codex exec -m gpt-6-astra -c model_reasoning_effort=xhigh \
  --dangerously-bypass-approvals-and-sandbox -o /tmp/codex-review-<topic>.md \
  "Read .claude/CLAUDE.md and .claude/skills/stream-debug/SKILL.md. Review 'git diff <base>...HEAD' for correctness and test coverage. Ranked findings with file:line and a concrete failure scenario." < /dev/null
```

Always `-o` and `< /dev/null` (a non-TTY stdin blocks forever); run in the background; kill by PID, never `pkill -f 'codex exec'`.

## Discipline

- **Findings are hypotheses.** Reproduce each one (a failing test, or a replay against a fixture) before changing code. Refuted findings are recorded in the report, not silently dropped.
- Fix root causes; a test that only encodes the reviewer's expectation without a failing case is not a fix.
- Rerun `npm run check && npm test` after the fixes; a second, smaller review round when the fixes touched the same files.
- Report to the user: what was found, what was confirmed vs refuted, what changed. The user does not see the reviewers' output.
