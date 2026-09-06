import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CodexSession, findRollout, readRolloutContext } from "../src/codex-session";
import { StreamEvent } from "../src/claude-session";

// handleThreadEvent maps @openai/codex-sdk ThreadEvents onto our StreamEvent
// protocol. The constructor is inert, so we drive it directly; `run` plays a
// whole stream through send() with a stand-in client, which is where the
// terminal result/error is released (only once the stream has closed).
function makeSession(model = "gpt-5.5") {
  const session = new CodexSession({ cwd: "/tmp", backend: "codex", model });
  const events: StreamEvent[] = [];
  session.on("event", (e: StreamEvent) => events.push(e));
  const dispatch = (ev: unknown) =>
    (session as unknown as { handleThreadEvent(e: unknown): void }).handleThreadEvent(ev);
  const run = async (stream: unknown[] | (() => Iterable<unknown> | AsyncIterable<unknown>)) => {
    const thread = {
      runStreamed: () =>
        Promise.resolve({
          events:
            typeof stream === "function"
              ? stream()
              : (function* () {
                  for (const ev of stream) yield ev;
                })(),
        }),
    };
    (session as unknown as { codex: unknown }).codex = {
      startThread: () => thread,
      resumeThread: () => thread,
    };
    await session.send("prompt");
  };
  return { session, events, dispatch, run };
}

describe("codex thread event mapping", () => {
  it("releases the result only once the stream has closed, with isRunning already false", async () => {
    const { session, events, run } = makeSession();
    let runningAtResult: boolean | null = null;
    session.on("event", (e: StreamEvent) => {
      if (e.kind === "result") runningAtResult = session.isRunning;
    });
    let drained = false;
    await run(function* () {
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
      // codex exec keeps stdout open a while after turn.completed.
      expect(events.some((e) => e.kind === "result")).toBe(false);
      drained = true;
    });
    expect(drained).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(["result"]);
    expect(runningAtResult).toBe(false);
  });

  it("surfaces turn.failed and stream errors instead of swallowing them", async () => {
    const { events, run } = makeSession();
    await run([{ type: "turn.failed", error: { message: "usage limit reached" } }]);
    expect(events.map((e) => e.kind)).toEqual(["error"]);
    expect(events[0].content).toContain("usage limit reached");
  });

  it("closes the message when the stream ends without a terminal event", async () => {
    const { events, run } = makeSession();
    await run([{ type: "thread.started", thread_id: "thr_x" }]);
    expect(events.map((e) => e.kind)).toEqual(["result"]);
  });

  it("resets the thread when a resume fails so the next message starts fresh", async () => {
    const { session, events, run } = makeSession();
    session.sessionId = "thr_gone";
    await run(function* () {
      throw new Error("thread not found");
      yield undefined;
    });
    expect(session.sessionId).toBeNull();
    expect(events[0].kind).toBe("error");
    expect(events[0].content).toContain("fresh session");
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

  it("attaches context and the model's default effort to the result", async () => {
    writeRollout("thr_1", [
      tokenCount({ total_tokens: 4_000, reasoning_output_tokens: 0 }, 264_600),
    ]);
    process.env.CODEX_HOME = home;
    const { session, events, run } = makeSession("gpt-6-astra");
    await run([
      { type: "thread.started", thread_id: "thr_1" },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const res = events.find((e) => e.kind === "result")!;
    expect(res.context).toEqual({ tokens: 4_000, window: 264_600 });
    expect(res.effort).toBe("medium");
    expect(session.effectiveEffort).toBe("medium");
    session.setEffort("xhigh");
    expect(session.effectiveEffort).toBe("xhigh");
  });
});

describe("codex item edge cases", () => {
  it("keeps an error terminal when turn.completed follows it", async () => {
    const { events, run } = makeSession();
    await run([
      { type: "error", message: "boom" },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(events.map((e) => e.kind)).toEqual(["error"]);
  });
});
