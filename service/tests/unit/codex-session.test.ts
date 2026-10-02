import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Codex } from "@openai/codex-sdk";
import { CodexSession, findRollout, readRolloutContext } from "../../src/session/codex";
import { StreamEvent } from "../../src/session/claude";
import { HostRegistry, LocalHost } from "../../src/session/host";
import { Workspace } from "../../src/workspace/workspace";

// A real client spawns `codex exec` on the user's account: sessions without
// a stand-in client of their own get one that throws.
const noCodex = {
  codex: (): Codex => {
    throw new Error("real Codex SDK reached from a unit test");
  },
};
beforeEach(() => {
  CodexSession.hooks = noCodex;
});
afterEach(() => {
  CodexSession.hooks = noCodex;
});

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

  // Missing-thread messages from the codex 0.153 binary (strings), not yet
  // seen in a capture.
  it.each([
    "Codex Exec exited with code 1: Error: No saved session found with ID thr_gone",
    "Codex Exec exited with code 1: Error: no rollout found for thread id thr_gone",
  ])("resets the thread on %s", async (message) => {
    const { session, run } = makeSession();
    session.sessionId = "thr_gone";
    await run(function* () {
      throw new Error(message);
      yield undefined;
    });
    expect(session.sessionId).toBeNull();
  });

  it("keeps the thread when codex fails for another reason", async () => {
    const panic =
      "Codex Exec exited with code 101: thread 'main' panicked at core/src/session.rs:1:1";
    const { session, events, run } = makeSession();
    session.sessionId = "thr_keep";
    // After the resumed thread started (codex/two-turns: a resume reports it).
    await run(function* () {
      yield { type: "thread.started", thread_id: "thr_keep" };
      yield { type: "turn.started" };
      throw new Error(panic);
    });
    expect(session.sessionId).toBe("thr_keep");
    expect(events.at(-1)!.content).not.toContain("fresh session");
    // Before it started, but nothing says the thread is missing.
    await run(function* () {
      throw new Error(panic);
      yield undefined;
    });
    expect(session.sessionId).toBe("thr_keep");
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
  it("times a call within its turn: item ids repeat every turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(0);
      const { events, run } = makeSession();
      // Stopped mid-command: item_1 never completes in this turn.
      await run([
        {
          type: "item.started",
          item: {
            id: "item_1",
            type: "command_execution",
            command: "sleep 600",
            status: "in_progress",
          },
        },
      ]);
      vi.setSystemTime(3_600_000);
      // A later turn's item_1 that completes without being started.
      await run([
        { type: "item.completed", item: { id: "item_1", type: "web_search", query: "x" } },
      ]);
      const results = events.filter((e) => e.kind === "tool_result");
      expect(results.map((e) => e.durationMs)).toEqual([undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an error terminal when turn.completed follows it", async () => {
    const { events, run } = makeSession();
    await run([
      { type: "error", message: "boom" },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(events.map((e) => e.kind)).toEqual(["error"]);
  });
});

describe("Stop during a codex turn", () => {
  // Thread events the test pushes, pulled by the session's for-await loop.
  function feeder() {
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    let end: Error | null = null;
    return {
      push(ev: unknown) {
        queue.push(ev);
        wake?.();
      },
      fail(err: Error) {
        end = err;
        wake?.();
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length) yield queue.shift();
          else if (end) throw end;
          else await new Promise<void>((r) => (wake = r));
        }
      },
    };
  }

  // Stand-in client. A stopped run's stream fails only once the killed
  // child has exited (the SDK reads its stdout to EOF), modelled as a delay.
  function fakeCodex() {
    const runs: ReturnType<typeof feeder>[] = [];
    const thread = {
      runStreamed: (_input: string, { signal }: { signal?: AbortSignal } = {}) => {
        const run = feeder();
        signal?.addEventListener("abort", () => {
          const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
          setTimeout(() => run.fail(err), 20);
        });
        runs.push(run);
        return Promise.resolve({ events: run });
      },
    };
    CodexSession.hooks = {
      codex: () => ({ startThread: () => thread, resumeThread: () => thread }) as unknown as Codex,
      readContext: () => undefined,
    };
    return runs;
  }

  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };

  it("dispatches the queued message once the stopped turn's process has exited", async () => {
    const runs = fakeCodex();
    const registry = new HostRegistry();
    registry.register(new LocalHost("local", "Local"));
    const ws = new Workspace("ws", "t", "p", "local", "/tmp", registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
    });
    const { id } = ws.addAgent("A", "gpt-6-astra", "🤖", "#888", { backend: "codex" });
    const session = ws.agents.get(id)!.session;
    const first = ws.sendMessage("first");
    await flush();
    runs[0].push({ type: "thread.started", thread_id: "thr_1" });
    runs[0].push({
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "partial" },
    });
    await flush();
    await ws.sendMessage("second");
    const second = ws.messages.find((m) => m.content === "second")!;
    expect(second.status).toBe("queued");

    ws.abortAgent(id);
    // What the child still flushes before it exits belongs to the closed turn.
    runs[0].push({
      type: "item.completed",
      item: { id: "m2", type: "agent_message", text: "late" },
    });
    await flush();
    expect(session.isRunning).toBe(true);
    expect(second.status).toBe("queued");

    await new Promise((r) => setTimeout(r, 40));
    await first;
    await flush();
    expect(second.status).toBe("done");
    expect(runs).toHaveLength(2);
    const replies = ws.messages.filter((m) => m.kind === "agent");
    expect(replies.map((m) => [m.content, m.status])).toEqual([
      ["partial\n\n*\\[interrupted\\]*", "done"],
      ["", "streaming"],
    ]);
  });
});
