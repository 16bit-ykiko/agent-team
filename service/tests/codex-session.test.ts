import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CodexSession, findRollout, readRolloutContext } from "../src/codex-session";
import { StreamEvent } from "../src/claude-session";

// handleThreadEvent maps @openai/codex-sdk ThreadEvents onto our StreamEvent
// protocol. The constructor is inert, so we drive it directly.
function makeSession() {
  const session = new CodexSession({ cwd: "/tmp", backend: "codex", model: "gpt-5.5" });
  const events: StreamEvent[] = [];
  session.on("event", (e: StreamEvent) => events.push(e));
  const dispatch = (ev: unknown) =>
    (session as unknown as { handleThreadEvent(e: unknown): void }).handleThreadEvent(ev);
  return { session, events, dispatch };
}

describe("codex thread event mapping", () => {
  it("captures the thread id for resume", () => {
    const { session, dispatch } = makeSession();
    dispatch({ type: "thread.started", thread_id: "thr_123" });
    expect(session.sessionId).toBe("thr_123");
    expect(session.getState().sessionId).toBe("thr_123");
  });

  it("emits agent messages as text deltas and finalizes on turn.completed", () => {
    const { session, events, dispatch } = makeSession();
    dispatch({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "Here is the answer." },
    });
    dispatch({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 25,
        reasoning_output_tokens: 5,
      },
    });

    // text_delta is what task.ts accumulates into message content; the
    // "result" event is what flips the message out of the streaming state.
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "result"]);
    expect(events[0].content).toBe("Here is the answer.");
    expect(session.usage.input_tokens).toBe(100);
    expect(session.usage.cache_read_tokens).toBe(40);
    expect(session.usage.output_tokens).toBe(25);
  });

  it("surfaces turn.failed and stream errors instead of swallowing them", () => {
    const { events, dispatch } = makeSession();
    dispatch({ type: "turn.failed", error: { message: "usage limit reached" } });
    expect(events.map((e) => e.kind)).toEqual(["error"]);
    expect(events[0].content).toContain("usage limit reached");
  });

  it("emits a single error for a real failure stream (error + turn.failed pair)", () => {
    // Captured live from codex-cli 0.144.1 with a revoked auth token: the
    // stream reports the same fault twice, then the SDK generator throws.
    const { events, dispatch } = makeSession();
    dispatch({ type: "thread.started", thread_id: "thr_live" });
    dispatch({ type: "turn.started" });
    dispatch({ type: "error", message: "Your session has ended. Please log in again." });
    dispatch({
      type: "turn.failed",
      error: { message: "Your session has ended. Please log in again." },
    });

    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].content).toContain("log in again");
  });

  it("pairs command executions as tool_use/tool_result by item id", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "item.started",
      item: {
        id: "cmd1",
        type: "command_execution",
        command: "ls -la",
        aggregated_output: "",
        status: "in_progress",
      },
    });
    dispatch({
      type: "item.completed",
      item: {
        id: "cmd1",
        type: "command_execution",
        command: "ls -la",
        aggregated_output: "file.txt\n",
        exit_code: 0,
        status: "completed",
      },
    });

    expect(events[0].kind).toBe("tool_use");
    expect(events[0].toolUseId).toBe("cmd1");
    expect(events[0].content).toContain("ls -la");
    expect(events[1].kind).toBe("tool_result");
    expect(events[1].toolUseId).toBe("cmd1");
    expect(events[1].content).toBe("file.txt\n");
  });

  it("flags non-zero exit codes in the command result", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "item.completed",
      item: {
        id: "cmd2",
        type: "command_execution",
        command: "false",
        aggregated_output: "boom",
        exit_code: 1,
        status: "failed",
      },
    });
    expect(events[0].content).toContain("(exit code 1)");
  });

  it("maps reasoning to thinking and file changes to an edit summary", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "item.completed",
      item: { id: "r1", type: "reasoning", text: "Let me look." },
    });
    dispatch({
      type: "item.completed",
      item: {
        id: "f1",
        type: "file_change",
        status: "completed",
        changes: [
          { path: "src/a.ts", kind: "update" },
          { path: "src/b.ts", kind: "add" },
        ],
      },
    });

    expect(events[0].kind).toBe("thinking");
    expect(events[1].kind).toBe("tool_use");
    expect(events[1].content).toContain("~ src/a.ts");
    expect(events[1].content).toContain("+ src/b.ts");
  });

  it("keeps non-fatal item errors from finalizing the turn", () => {
    const { events, dispatch } = makeSession();
    dispatch({
      type: "item.completed",
      item: { id: "e1", type: "error", message: "transient thing" },
    });
    expect(events[0].kind).toBe("notice");
    expect(events[0].level).toBe("warning");
    expect(events[0].content).toContain("transient thing");
  });
});

describe("setProviderEnv", () => {
  it("rebuilds the cached Codex client on the next turn", () => {
    const session = new CodexSession({ cwd: "/tmp", backend: "codex" });
    (session as unknown as { codex: unknown }).codex = { fake: true };
    session.setProviderEnv({ OPENAI_API_KEY: "sk-x" });
    expect((session as unknown as { codex: unknown }).codex).toBeNull();
    expect(session.config.providerEnv?.OPENAI_API_KEY).toBe("sk-x");
  });
});

describe("codex CLI configuration", () => {
  type Internals = { threadOptions(): { model?: string } };
  it("strips the 1M suffix from the model and configures the window instead", () => {
    const session = new CodexSession({ cwd: "/tmp", backend: "codex", model: "gpt-6-astra[1m]" });
    expect((session as unknown as Internals).threadOptions().model).toBe("gpt-6-astra");
    expect(session.codexConfig()).toEqual({ model_context_window: 872_000 });
  });

  it("leaves the default window alone for plain ids", () => {
    const session = new CodexSession({ cwd: "/tmp", backend: "codex", model: "gpt-6-astra" });
    expect((session as unknown as Internals).threadOptions().model).toBe("gpt-6-astra");
    expect(session.codexConfig()).toEqual({});
  });

  it("switches the service tier with fast mode and persists it in the state", () => {
    const session = new CodexSession({ cwd: "/tmp", backend: "codex", model: "gpt-5.5" });
    session.setFastMode(true);
    expect(session.codexConfig()).toEqual({ service_tier: "priority" });
    expect(session.getState().config.fast).toBe(true);
    session.setFastMode(false);
    expect(session.codexConfig()).toEqual({});
    expect(session.getState().config.fast).toBeUndefined();
  });

  it("remembers the goal objective for display", () => {
    const session = new CodexSession({ cwd: "/tmp", backend: "codex", model: "gpt-5.5" });
    session.setGoal("ship the release");
    expect(CodexSession.fromState(session.getState()).getState().config.goal).toBe(
      "ship the release",
    );
    session.setGoal(null);
    expect(session.getState().config.goal).toBeUndefined();
  });
});

describe("codex context from the rollout", () => {
  const tokenCount = (last: Record<string, number>, window: number) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 9_999_999 },
          last_token_usage: last,
          model_context_window: window,
        },
      },
    });
  let home: string;
  afterEach(() => {
    delete process.env.CODEX_HOME;
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });
  const writeRollout = (threadId: string, lines: string[]) => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    const day = path.join(home, "sessions", "2026", "09", "05");
    fs.mkdirSync(day, { recursive: true });
    const file = path.join(day, `rollout-2026-09-05T12-41-28-${threadId}.jsonl`);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
  };

  it("finds the thread's rollout and reads the last request's usage", () => {
    const file = writeRollout("thr_abc", [
      JSON.stringify({ type: "session_meta", payload: {} }),
      tokenCount({ total_tokens: 50_000, reasoning_output_tokens: 1_000 }, 264_600),
      tokenCount({ total_tokens: 111_036, reasoning_output_tokens: 460 }, 828_400),
    ]);
    expect(findRollout(home, "thr_abc")).toBe(file);
    expect(findRollout(home, "thr_missing")).toBeNull();
    expect(readRolloutContext(file)).toEqual({ tokens: 110_576, window: 828_400 });
  });

  it("attaches context and the model's default effort to the result", () => {
    writeRollout("thr_1", [
      tokenCount({ total_tokens: 4_000, reasoning_output_tokens: 0 }, 264_600),
    ]);
    process.env.CODEX_HOME = home;
    const session = new CodexSession({ cwd: "/tmp", backend: "codex", model: "gpt-6-astra" });
    const events: StreamEvent[] = [];
    session.on("event", (e: StreamEvent) => events.push(e));
    const dispatch = (ev: unknown) =>
      (session as unknown as { handleThreadEvent(e: unknown): void }).handleThreadEvent(ev);
    dispatch({ type: "thread.started", thread_id: "thr_1" });
    dispatch({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    const res = events.find((e) => e.kind === "result")!;
    expect(res.context).toEqual({ tokens: 4_000, window: 264_600 });
    expect(res.effort).toBe("medium");
    expect(session.effectiveEffort).toBe("medium");
    session.setEffort("xhigh");
    expect(session.effectiveEffort).toBe("xhigh");
  });
});
