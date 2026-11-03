import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { CodexSession } from "../../src/session/codex";
import type { RpcMessage, Transport } from "../../src/session/codex-rpc";
import type { StreamEvent } from "../../src/session/claude";
import { HostRegistry, LocalHost } from "../../src/session/host";
import { Workspace } from "../../src/workspace/workspace";
import type { PanelToolset } from "../../src/project/tools";

// An in-memory `codex app-server`: answers the session's requests from
// per-method handlers (a throw is a JSON-RPC error), and lets the test send
// notifications and requests of its own. The recorded behaviour lives in
// tests/snap/codex; these are the cases no recording shows.
class FakeServer {
  written: RpcMessage[] = [];
  connections = 0;
  private listeners: Array<(m: RpcMessage) => void> = [];
  private closers: Array<(r: string) => void> = [];
  private answers = new Map<number | string, (result: unknown) => void>();
  private nextId = 1000;
  // Requests of these methods are never answered.
  hold = new Set<string>();
  // Lines sent right after the answer to a method, in the same tick.
  after: Record<string, RpcMessage[]> = {};
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    initialize: () => ({}),
    "thread/start": () => ({ thread: { id: "thr_1" } }),
    "thread/resume": (p) => ({ thread: { id: p.threadId } }),
    "turn/start": () => ({
      turn: { id: `turn_${this.turns()}`, status: "inProgress", error: null },
    }),
    "turn/steer": (p) => ({ turnId: p.expectedTurnId }),
    "turn/interrupt": () => ({}),
    "thread/compact/start": () => ({}),
  };

  transport(): Transport {
    this.connections++;
    this.listeners = [];
    this.closers = [];
    const listeners = this.listeners;
    const closers = this.closers;
    return {
      write: (m) => {
        this.written.push(m);
        if (m.method && m.id != null) void this.answer(m, listeners);
        else if (!m.method && m.id != null) this.answers.get(m.id)?.(m.error ?? m.result);
      },
      onMessage: (cb) => listeners.push(cb),
      onClose: (cb) => closers.push(cb),
      // A real child exits a moment after SIGTERM.
      close: () =>
        setTimeout(() => this.exitConnection(closers, "codex app-server exited (SIGTERM)"), 5),
    };
  }

  private async answer(m: RpcMessage, listeners: Array<(m: RpcMessage) => void>): Promise<void> {
    if (this.hold.has(m.method!)) return;
    const handler = this.handlers[m.method!];
    let reply: RpcMessage;
    try {
      reply = {
        id: m.id,
        result: handler ? await handler((m.params ?? {}) as Record<string, unknown>) : {},
      };
    } catch (e) {
      reply = { id: m.id, error: { code: -32600, message: (e as Error).message } };
    }
    for (const cb of listeners) cb(reply);
    for (const line of this.after[m.method!] ?? []) for (const cb of listeners) cb(line);
  }

  turns(): number {
    return this.written.filter((m) => m.method === "turn/start").length;
  }

  notify(method: string, params: Record<string, unknown>): void {
    for (const cb of this.listeners) cb({ method, params });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.answers.set(id, resolve);
      for (const cb of this.listeners) cb({ id, method, params });
    });
  }

  exit(reason: string): void {
    this.exitConnection(this.closers, reason);
  }

  private exitConnection(closers: Array<(r: string) => void>, reason: string): void {
    for (const cb of closers.splice(0)) cb(reason);
  }

  sent(method: string): Array<Record<string, unknown>> {
    return this.written
      .filter((m) => m.method === method)
      .map((m) => (m.params ?? {}) as Record<string, unknown>);
  }

  // The notifications of a turn's start, on thread thr_1.
  startTurn(id = `turn_${this.turns()}`): void {
    this.notify("turn/started", {
      threadId: "thr_1",
      turn: { id, status: "inProgress", error: null },
    });
  }

  completeTurn(status = "completed", error: unknown = null, id = `turn_${this.turns()}`): void {
    this.notify("turn/completed", { threadId: "thr_1", turn: { id, status, error } });
  }

  item(phase: "started" | "completed", item: Record<string, unknown>, threadId = "thr_1"): void {
    this.notify(`item/${phase}`, { threadId, turnId: "t", item });
  }
}

// The workspace moves its queue on a setTimeout(0), which can outlast any
// number of setImmediate rounds.
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 5));
};

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer();
  CodexSession.hooks = { transport: () => server.transport() };
});
afterEach(() => {
  CodexSession.hooks = null;
});

function makeSession(config: Partial<ConstructorParameters<typeof CodexSession>[0]> = {}) {
  const session = new CodexSession({
    cwd: "/tmp",
    backend: "codex",
    model: "gpt-6-astra",
    ...config,
  });
  const events: StreamEvent[] = [];
  const states: string[] = [];
  session.on("event", (e: StreamEvent) => events.push(e));
  session.on("runState", (s: string) => states.push(s));
  return { session, events, states };
}

const echoTools = (handler: (args: Record<string, unknown>) => Promise<string>): PanelToolset => ({
  instructions: "You are a session of the project.",
  tools: [{ name: "echo", description: "Echo the text.", shape: { text: z.string() }, handler }],
});

describe("codex app-server session", () => {
  it("declares the panel tools when the thread starts and answers their calls", async () => {
    const { session } = makeSession();
    session.setPanelTools(
      echoTools((args) =>
        args.text === "boom"
          ? Promise.reject(new Error("it broke"))
          : Promise.resolve(`echo ${String(args.text)}`),
      ),
    );
    await session.send("hi");
    const [start] = server.sent("thread/start");
    expect(start.developerInstructions).toBe("You are a session of the project.");
    expect(start.dynamicTools).toEqual([
      {
        type: "namespace",
        name: "panel",
        description: expect.any(String) as string,
        tools: [
          {
            type: "function",
            name: "echo",
            description: "Echo the text.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
      },
    ]);
    const call = (args: unknown, extra: Record<string, unknown> = {}) =>
      server.request("item/tool/call", {
        threadId: "thr_1",
        turnId: "turn_1",
        callId: "c",
        namespace: "panel",
        tool: "echo",
        arguments: args,
        ...extra,
      });
    expect(await call({ text: "hi" })).toEqual({
      contentItems: [{ type: "inputText", text: "echo hi" }],
      success: true,
    });
    expect(await call({ text: "boom" })).toMatchObject({
      success: false,
      contentItems: [{ text: "it broke" }],
    });
    const invalid = (await call({ text: 3 })) as {
      success: boolean;
      contentItems: Array<{ text: string }>;
    };
    expect(invalid.success).toBe(false);
    expect(invalid.contentItems[0].text).toContain("text");
    expect(await call({ text: "hi" }, { tool: "start_session" })).toMatchObject({ success: false });
    // A subagent's thread has none of them.
    expect(await call({ text: "hi" }, { threadId: "thr_sub" })).toMatchObject({ success: false });
  });

  it("sends model, effort and Fast with every turn, changing them without a restart", async () => {
    const { session } = makeSession({ model: "gpt-6-astra[1m]" });
    await session.send("one");
    server.startTurn();
    server.completeTurn();
    session.setEffort("high");
    session.setFastMode(true);
    await session.send("two");
    const [start] = server.sent("thread/start");
    expect(start).toMatchObject({
      model: "gpt-6-astra",
      serviceTier: "default",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      config: { model_context_window: 872_000 },
    });
    const [first, second] = server.sent("turn/start");
    expect(first).toMatchObject({
      model: "gpt-6-astra",
      serviceTier: "default",
      summary: "detailed",
    });
    expect(first).not.toHaveProperty("effort");
    expect(second).toMatchObject({ effort: "high", serviceTier: "priority" });
    expect(server.connections).toBe(1);
  });

  it("restarts the process for a new provider env and resumes the thread in it", async () => {
    const { session } = makeSession();
    await session.send("one");
    server.startTurn();
    server.completeTurn();
    session.setProviderEnv({ OPENAI_BASE_URL: "http://proxy" });
    await session.send("two");
    expect(server.connections).toBe(2);
    expect(server.sent("thread/resume")).toEqual([
      expect.objectContaining({ threadId: "thr_1", excludeTurns: true }),
    ]);
  });

  it("starts a fresh thread, saying so, when the stored one is gone", async () => {
    server.handlers["thread/resume"] = (p) => {
      throw new Error(`no rollout found for thread id ${String(p.threadId)}`);
    };
    server.handlers["thread/start"] = () => ({ thread: { id: "thr_new" } });
    const session = CodexSession.fromState({
      sessionId: "thr_gone",
      config: { cwd: "/tmp", backend: "codex", model: "gpt-6-astra" },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turns: 0,
        duration_ms: 0,
      },
    });
    const events: StreamEvent[] = [];
    session.on("event", (e: StreamEvent) => events.push(e));
    await session.send("hi");
    expect(session.sessionId).toBe("thr_new");
    expect(events[0]).toMatchObject({ kind: "notice", level: "warning" });
    expect(events[0].content).toContain("fresh thread");
    expect(session.isRunning).toBe(true);
  });

  it("keeps the thread when the resume fails for another reason", async () => {
    server.handlers["thread/resume"] = () => {
      throw new Error("permission denied");
    };
    const session = CodexSession.fromState({
      sessionId: "thr_kept",
      config: { cwd: "/tmp", backend: "codex" },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turns: 0,
        duration_ms: 0,
      },
    });
    const events: StreamEvent[] = [];
    session.on("event", (e: StreamEvent) => events.push(e));
    await session.send("hi");
    expect(session.sessionId).toBe("thr_kept");
    expect(events).toEqual([{ kind: "error", content: "[Codex error] permission denied" }]);
    expect(session.isRunning).toBe(false);
  });

  it("ends a turn its app-server died in, and resumes in a new one next time", async () => {
    const { session, events } = makeSession();
    await session.send("one");
    server.startTurn();
    server.item("started", {
      type: "commandExecution",
      id: "c1",
      command: "sleep 9",
      commandActions: [],
    });
    server.exit("codex app-server exited (9)");
    expect(session.isRunning).toBe(false);
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["tool_use", "**Bash**\n```bash\nsleep 9\n```"],
      ["tool_result", "(stopped)"],
      ["error", "[Codex error] codex app-server exited (9)"],
    ]);
    await session.send("two");
    expect(server.connections).toBe(2);
    expect(server.sent("thread/resume")).toHaveLength(1);
  });

  it("interrupts a turn stopped before turn/start answered, once codex started it", async () => {
    let answer!: () => void;
    server.handlers["turn/start"] = () =>
      new Promise(
        (r) => (answer = () => r({ turn: { id: "turn_9", status: "inProgress", error: null } })),
      );
    const { session } = makeSession();
    const sending = session.send("hi");
    await flush();
    expect(await session.interrupt()).toBe(true);
    expect(session.interruptPending).toBe(true);
    expect(server.sent("turn/interrupt")).toEqual([]);
    answer();
    await sending;
    expect(server.sent("turn/interrupt")).toEqual([]);
    server.startTurn("turn_9");
    await flush();
    expect(server.sent("turn/interrupt")).toEqual([{ threadId: "thr_1", turnId: "turn_9" }]);
  });

  it("steers only into a running turn, and tells which steered message the model read", async () => {
    const { session } = makeSession();
    const steered: string[] = [];
    session.on("steered", (id: string) => steered.push(id));
    expect(await session.steer("early", "m0")).toBe(false);
    await session.send("hi");
    server.startTurn();
    expect(await session.steer("a", "m1")).toBe(true);
    expect(await session.steer("b", "m2")).toBe(true);
    expect(server.sent("turn/steer")[0]).toMatchObject({
      expectedTurnId: "turn_1",
      clientUserMessageId: "m1",
    });
    server.item("started", { type: "userMessage", id: "u0", clientId: null, content: [] });
    expect(steered).toEqual([]);
    // Tagged with the panel's id, in any order; untagged, in order sent.
    server.item("started", { type: "userMessage", id: "u2", clientId: "m2", content: [] });
    server.item("started", { type: "userMessage", id: "u1", clientId: null, content: [] });
    expect(steered).toEqual(["m2", "m1"]);
    server.handlers["turn/steer"] = () => {
      throw new Error("no active turn to steer");
    };
    expect(await session.steer("late", "m3")).toBe(false);
  });

  it("shows a retried error as a retry and a usage limit by its spent window", async () => {
    const { session, events } = makeSession();
    const limits: unknown[] = [];
    session.on("rateLimit", (l: unknown) => limits.push(l));
    const quota: unknown[] = [];
    session.on("quota", (q: unknown) => quota.push(q));
    await session.send("hi");
    server.startTurn();
    server.notify("error", {
      threadId: "thr_1",
      turnId: "turn_1",
      willRetry: true,
      error: { message: "stream disconnected" },
    });
    server.notify("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 100 },
        secondary: null,
        planType: "pro",
      },
    });
    // Sparse: the primary window stands.
    server.notify("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        primary: null,
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 900 },
        planType: null,
      },
    });
    const error = {
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: null,
    };
    server.completeTurn("failed", error);
    expect(events.map((e) => e.kind)).toEqual(["retry", "error"]);
    expect(events[1].content).toMatch(/^Usage limit reached \(seven-day\)\. Resets at /);
    expect(limits).toEqual([{ rateLimitType: "seven_day", resetsAt: 900 }]);
    expect(quota.at(-1)).toEqual({
      limitId: "codex",
      primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 100 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 900 },
      planType: "pro",
    });
    expect(await session.getUsageInfo()).toEqual({
      rate_limits: {
        five_hour: { utilization: 40, resets_at: new Date(100_000).toISOString() },
        seven_day: { utilization: 100, resets_at: new Date(900_000).toISOString() },
      },
      subscription_type: "pro",
    });
  });

  const overloaded = {
    message: "Selected model is at capacity. Please try a different model.",
    codexErrorInfo: "serverOverloaded",
    additionalDetails: null,
  };

  it("carries on in a new turn when the model's capacity failed one, without resending the prompt", async () => {
    CodexSession.hooks = { ...CodexSession.hooks, capacityRetryDelaysMs: [0, 0] };
    const { session, events, states } = makeSession();
    const steered: string[] = [];
    session.on("steered", (id: string) => steered.push(id));
    await session.send("hi");
    server.startTurn();
    server.item("started", { type: "userMessage", id: "u1", clientId: null, content: [] });
    server.notify("item/agentMessage/delta", { threadId: "thr_1", itemId: "m1", delta: "Half" });
    server.completeTurn("failed", overloaded);
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "retry"]);
    expect(events[1].content).toBe(`${overloaded.message} Retrying in 0s (1/2).`);
    expect(session.isRunning).toBe(true);

    await flush();
    const turns = server.sent("turn/start");
    expect(turns).toHaveLength(2);
    expect((turns[1].input as Array<{ text: string }>)[0].text).toMatch(
      /^Continue from where you left off\. The previous turn was interrupted because the selected model was at capacity\./,
    );
    server.startTurn();
    server.item("started", { type: "userMessage", id: "u2", clientId: null, content: [] });
    server.notify("item/agentMessage/delta", { threadId: "thr_1", itemId: "m2", delta: "done" });
    server.completeTurn();
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "retry", "text_delta", "result"]);
    expect(events[2].content).toBe("\n\ndone");
    expect(steered).toEqual([]);
    expect(states).toEqual(["working", "idle"]);
  });

  it("gives up on capacity after the last retry, and a Stop while it waits ends the turn", async () => {
    CodexSession.hooks = { ...CodexSession.hooks, capacityRetryDelaysMs: [0] };
    const { session, events } = makeSession();
    await session.send("hi");
    server.startTurn();
    server.completeTurn("failed", overloaded);
    await flush();
    server.startTurn();
    server.completeTurn("failed", overloaded);
    expect(events.map((e) => e.kind)).toEqual(["retry", "error"]);
    expect(events[1].content).toBe(`[Codex error] ${overloaded.message}`);
    expect(session.isRunning).toBe(false);

    // A new turn starts counting again.
    CodexSession.hooks = { ...CodexSession.hooks, capacityRetryDelaysMs: [60_000] };
    await session.send("again");
    server.startTurn();
    server.completeTurn("failed", overloaded);
    expect(events.at(-1)?.kind).toBe("retry");
    expect(await session.interrupt()).toBe(true);
    expect(session.isRunning).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "result", interrupted: true });
    await flush();
    expect(server.sent("turn/start")).toHaveLength(3);
    expect(server.sent("turn/interrupt")).toEqual([]);
  });

  it("gives a capacity retry's unread steers back to the queue, and takes none while it waits", async () => {
    CodexSession.hooks = { ...CodexSession.hooks, capacityRetryDelaysMs: [0] };
    const { session } = makeSession();
    const unread: string[][] = [];
    session.on("unread", (ids: string[]) => unread.push(ids));
    await session.send("hi");
    server.startTurn();
    server.item("started", { type: "userMessage", id: "u1", clientId: null, content: [] });
    expect(await session.steer("also this", "m1")).toBe(true);
    server.completeTurn("failed", overloaded);
    expect(unread).toEqual([["m1"]]);
    expect(await session.steer("and this", "m2")).toBe(false);
    await flush();
    expect(server.sent("turn/start")).toHaveLength(2);
    expect(server.sent("turn/steer")).toHaveLength(1);
  });

  it("retries no compaction, and no turn when codex carried on by itself meanwhile", async () => {
    CodexSession.hooks = { ...CodexSession.hooks, capacityRetryDelaysMs: [20] };
    const { session, events } = makeSession();
    await session.send("hi");
    server.startTurn();
    server.completeTurn("failed", overloaded);
    server.startTurn("turn_goal");
    await new Promise((r) => setTimeout(r, 40));
    expect(server.sent("turn/start")).toHaveLength(1);
    server.completeTurn("completed", null, "turn_goal");
    expect(events.map((e) => e.kind)).toEqual(["retry", "result"]);

    await session.send("/compact");
    server.startTurn("turn_c");
    server.completeTurn("failed", overloaded, "turn_c");
    expect(events.at(-1)).toEqual({
      kind: "error",
      content: `[Codex error] ${overloaded.message}`,
    });
    expect(session.isRunning).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(server.sent("turn/start")).toHaveLength(1);
  });

  it("retries a turn codex started itself after a compaction", async () => {
    CodexSession.hooks = { ...CodexSession.hooks, capacityRetryDelaysMs: [60_000] };
    const { session, events } = makeSession();
    await session.send("/compact");
    server.startTurn("turn_c");
    server.completeTurn("completed", null, "turn_c");
    server.startTurn("turn_goal");
    server.completeTurn("failed", overloaded, "turn_goal");
    expect(events.at(-1)?.kind).toBe("retry");
    session.abort();
  });

  it("restarts the process before a capacity retry when its env changed during the wait", async () => {
    CodexSession.hooks = { ...CodexSession.hooks, capacityRetryDelaysMs: [0] };
    const { session } = makeSession();
    await session.send("hi");
    server.startTurn();
    server.completeTurn("failed", overloaded);
    session.setProviderEnv({ OPENAI_BASE_URL: "http://proxy" });
    await flush();
    expect(server.connections).toBe(2);
    expect(server.sent("thread/resume")).toHaveLength(1);
    expect(server.sent("turn/start")).toHaveLength(2);
  });

  it("goes idle without a terminal event when the process is killed mid-turn", async () => {
    const { session, events, states } = makeSession();
    await session.send("hi");
    server.startTurn();
    session.abort();
    expect(session.isRunning).toBe(false);
    expect(states).toEqual(["working", "idle"]);
    expect(events).toEqual([]);
  });

  it("runs /compact as compaction, not as a prompt", async () => {
    const { session, events } = makeSession();
    await session.send("/compact");
    expect(server.sent("turn/start")).toEqual([]);
    expect(server.sent("thread/compact/start")).toEqual([{ threadId: "thr_1" }]);
    server.startTurn("turn_c");
    server.item("started", { type: "contextCompaction", id: "k" });
    server.item("completed", { type: "contextCompaction", id: "k" });
    server.notify("thread/tokenUsage/updated", {
      threadId: "thr_1",
      turnId: "turn_c",
      tokenUsage: {
        total: {
          totalTokens: 9000,
          inputTokens: 8000,
          cachedInputTokens: 6000,
          cacheWriteInputTokens: 0,
          outputTokens: 1000,
          reasoningOutputTokens: 400,
        },
        last: {
          totalTokens: 5000,
          inputTokens: 4500,
          cachedInputTokens: 4000,
          cacheWriteInputTokens: 0,
          outputTokens: 500,
          reasoningOutputTokens: 200,
        },
        modelContextWindow: 258400,
      },
    });
    server.completeTurn("completed", null, "turn_c");
    expect(events.map((e) => e.kind)).toEqual(["compact", "result"]);
    expect(events[1].context).toEqual({ tokens: 4800, window: 258400 });
    expect(session.usage).toMatchObject({
      input_tokens: 500,
      cache_read_tokens: 4000,
      output_tokens: 500,
      turns: 1,
    });
    expect(await session.getContextUsage()).toMatchObject({ totalTokens: 4800, maxTokens: 258400 });
  });

  it("takes a turn codex starts itself as a wake-up", async () => {
    const { session, events } = makeSession();
    await session.send("hi");
    server.startTurn();
    server.completeTurn();
    server.startTurn("turn_goal");
    expect(session.isRunning).toBe(true);
    server.completeTurn("completed", null, "turn_goal");
    expect(events.map((e) => [e.kind, e.level])).toEqual([
      ["result", undefined],
      ["notice", "wakeup"],
      ["result", undefined],
    ]);
  });

  it("keeps an agent message whose text came without deltas, and each warning once", async () => {
    const { session, events } = makeSession();
    await session.send("hi");
    server.startTurn();
    server.notify("warning", { threadId: "thr_1", message: "Model metadata not found." });
    server.notify("item/agentMessage/delta", { threadId: "thr_1", itemId: "a1", delta: "Hel" });
    server.item("completed", { type: "agentMessage", id: "a1", text: "Hello." });
    server.item("completed", { type: "agentMessage", id: "a2", text: "Second." });
    server.notify("warning", { threadId: "thr_1", message: "Model metadata not found." });
    server.completeTurn();
    expect(events.filter((e) => e.kind === "notice")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "text_delta").map((e) => e.content)).toEqual([
      "Hel",
      "lo.",
      "\n\nSecond.",
    ]);
  });
});

describe("codex session races", () => {
  it("does not let a stopped turn's late failure fail the next one", async () => {
    const { session, events } = makeSession();
    server.hold.add("turn/start");
    void session.send("one");
    await flush();
    session.abort();
    server.hold.clear();
    await session.send("two");
    server.startTurn();
    // The first process exits now: its turn/start fails.
    await flush();
    expect(session.isRunning).toBe(true);
    expect(events).toEqual([]);
    expect(server.connections).toBe(2);
    server.completeTurn();
    expect(events.map((e) => e.kind)).toEqual(["result"]);
  });

  it("interrupts only once codex started the turn, and a refused interrupt leaves it running", async () => {
    const { session, events } = makeSession();
    await session.send("hi");
    expect(await session.interrupt()).toBe(true);
    expect(server.sent("turn/interrupt")).toEqual([]);
    server.handlers["turn/interrupt"] = () => {
      throw new Error("no active turn");
    };
    server.startTurn();
    await flush();
    expect(server.sent("turn/interrupt")).toHaveLength(1);
    expect(session.isRunning).toBe(true);
    expect(session.interruptPending).toBe(false);
    expect(events).toEqual([]);
  });

  it("keeps the next turn's Stop when the stopped turn's interrupt fails late", async () => {
    const { session } = makeSession();
    await session.send("one");
    server.startTurn();
    server.hold.add("turn/interrupt");
    void session.interrupt();
    await flush();
    session.abort();
    server.hold.clear();
    await session.send("two");
    await session.interrupt();
    // The first process exits now: its turn/interrupt fails.
    await flush();
    expect(session.interruptPending).toBe(true);
    server.startTurn();
    await flush();
    expect(server.sent("turn/interrupt").map((p) => p.turnId)).toEqual(["turn_1", "turn_2"]);
  });

  it("steers a message sent before turn/start answered once the turn is known", async () => {
    let answer!: () => void;
    server.handlers["turn/start"] = () =>
      new Promise(
        (r) => (answer = () => r({ turn: { id: "turn_1", status: "inProgress", error: null } })),
      );
    const { session } = makeSession();
    void session.send("hi");
    await flush();
    const steering = session.steer("more", "m1");
    await flush();
    expect(server.sent("turn/steer")).toEqual([]);
    answer();
    expect(await steering).toBe(true);
    expect(server.sent("turn/steer")).toEqual([
      expect.objectContaining({ expectedTurnId: "turn_1" }),
    ]);
  });

  it("does not take a userMessage tagged with an id it never sent for a steered one", async () => {
    const { session } = makeSession();
    const steered: string[] = [];
    session.on("steered", (id: string) => steered.push(id));
    await session.send("hi");
    server.startTurn();
    server.item("started", { type: "userMessage", id: "u0", clientId: null, content: [] });
    await session.steer("more", "m1");
    server.item("started", { type: "userMessage", id: "u1", clientId: "other", content: [] });
    expect(steered).toEqual([]);
    server.item("started", { type: "userMessage", id: "u2", clientId: null, content: [] });
    expect(steered).toEqual(["m1"]);
  });

  it("splits at a steered message read in the same tick as the steer's answer", async () => {
    const { session } = makeSession();
    const steered: string[] = [];
    session.on("steered", (id: string) => steered.push(id));
    await session.send("hi");
    server.startTurn();
    server.item("started", { type: "userMessage", id: "u0", clientId: null, content: [] });
    server.after["turn/steer"] = [
      {
        method: "item/started",
        params: {
          threadId: "thr_1",
          item: { type: "userMessage", id: "u1", clientId: "m1", content: [] },
        },
      },
    ];
    expect(await session.steer("more", "m1")).toBe(true);
    expect(steered).toEqual(["m1"]);
  });

  it("reports the steered messages a turn ended without reading, and never steers /compact", async () => {
    const { session } = makeSession();
    const unread: string[][] = [];
    session.on("unread", (ids: string[]) => unread.push(ids));
    await session.send("hi");
    server.startTurn();
    expect(await session.steer("/compact", "m0")).toBe(false);
    expect(await session.steer("more", "m1")).toBe(true);
    server.completeTurn("interrupted");
    expect(unread).toEqual([["m1"]]);
  });

  it("keeps other backends' credentials out of codex and does not restart for them", async () => {
    const { session } = makeSession();
    await session.send("one");
    server.startTurn();
    server.completeTurn();
    session.setProviderEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-claude", OPENAI_API_KEY: "sk-openai" });
    const env = (session as unknown as { env(): NodeJS.ProcessEnv }).env();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(process.env.CLAUDE_CODE_OAUTH_TOKEN);
    expect([env.OPENAI_API_KEY, env.CODEX_API_KEY]).toEqual(["sk-openai", "sk-openai"]);
    session.setProviderEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-claude" });
    await session.send("two");
    expect(server.connections).toBe(1);
  });

  it("answers no tool call from a process it is replacing, and stops its subagents' cards", async () => {
    const { session, events } = makeSession();
    session.setPanelTools(echoTools(() => Promise.resolve("ran")));
    await session.send("hi");
    server.startTurn();
    server.item("started", {
      type: "subAgentActivity",
      id: "s1",
      kind: "started",
      agentThreadId: "thr_sub",
      agentPath: "/root/helper",
    });
    const call = server.request("item/tool/call", {
      threadId: "thr_1",
      turnId: "turn_1",
      callId: "c",
      namespace: "panel",
      tool: "echo",
      arguments: { text: "x" },
    });
    session.abort();
    const late = server.request("item/tool/call", {
      threadId: "thr_1",
      turnId: "turn_1",
      callId: "c2",
      namespace: "panel",
      tool: "echo",
      arguments: { text: "x" },
    });
    expect(await call).toMatchObject({ success: true });
    expect(await late).toMatchObject({
      message: expect.stringContaining("shutting down") as string,
    });
    expect(events.find((e) => e.kind === "subagent_done")?.subagent).toMatchObject({
      taskId: "thr_sub",
      status: "stopped",
    });
  });
});

describe("codex steering through the workspace", () => {
  const removed: string[] = [];
  function makeWorkspace() {
    removed.length = 0;
    const registry = new HostRegistry();
    registry.register(new LocalHost("local", "Local"));
    const ws = new Workspace("ws", "t", "p", "local", "/tmp", registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
      onMessageRemoved: (_ws, id) => removed.push(id),
    });
    ws.addAgent("A", "gpt-6-astra", "🤖", "#888", { backend: "codex" });
    return ws;
  }
  const userMessage = (id: string, clientId: string | null) =>
    server.item("started", { type: "userMessage", id, clientId, content: [] });
  const summary = (ws: Workspace) =>
    ws.messages.filter((m) => m.kind !== "system").map((m) => `${m.kind} ${m.status} ${m.content}`);

  it("steers a message into the running turn and answers it in a reply of its own", async () => {
    const ws = makeWorkspace();
    await ws.sendMessage("first");
    server.startTurn();
    server.notify("item/agentMessage/delta", {
      threadId: "thr_1",
      itemId: "a1",
      delta: "Working.",
    });
    await ws.sendMessage("also this");
    const steered = ws.messages.find((m) => m.content === "also this")!;
    // Handed over, not read yet: still queued, and no longer cancellable.
    expect(steered.status).toBe("queued");
    expect(ws.cancelQueued(steered.id)).toBe(false);
    expect(server.sent("turn/steer")).toEqual([
      expect.objectContaining({ clientUserMessageId: steered.id, expectedTurnId: "turn_1" }),
    ]);
    server.item("started", { type: "userMessage", id: "u1", clientId: null, content: [] });
    server.item("started", { type: "userMessage", id: "u2", clientId: steered.id, content: [] });
    expect(steered.status).toBe("done");
    server.notify("item/agentMessage/delta", {
      threadId: "thr_1",
      itemId: "a2",
      delta: "Done both.",
    });
    server.completeTurn();
    await flush();
    expect(summary(ws)).toEqual([
      "user done first",
      "agent done Working.",
      "user done also this",
      "agent done Done both.",
    ]);
  });

  it("queues a message, cancellable, while a capacity retry waits", async () => {
    CodexSession.hooks = { ...CodexSession.hooks, capacityRetryDelaysMs: [60_000] };
    const shown: Array<{ content: string; steering?: boolean }> = [];
    const registry = new HostRegistry();
    registry.register(new LocalHost("local", "Local"));
    const ws = new Workspace("ws", "t", "p", "local", "/tmp", registry, {
      onNewMessage: (_ws, m) => shown.push({ content: m.content, steering: m.steering }),
      onStreamEvent: () => {},
      onMessageDone: () => {},
    });
    ws.addAgent("A", "gpt-6-astra", "🤖", "#888", { backend: "codex" });
    await ws.sendMessage("first");
    server.startTurn();
    server.completeTurn("failed", {
      message: "Selected model is at capacity. Please try a different model.",
      codexErrorInfo: "serverOverloaded",
      additionalDetails: null,
    });
    await ws.sendMessage("also this");
    const waiting = ws.messages.find((m) => m.content === "also this")!;
    expect(shown.find((m) => m.content === "also this")?.steering).toBeUndefined();
    expect(server.sent("turn/steer")).toEqual([]);
    expect(ws.cancelQueued(waiting.id)).toBe(true);
    ws.agents.values().next().value!.session.abort();
  });

  it("queues a message the turn would not take, and runs it when the turn ends", async () => {
    const ws = makeWorkspace();
    await ws.sendMessage("first");
    server.startTurn();
    server.handlers["turn/steer"] = () => {
      throw new Error("activeTurnNotSteerable");
    };
    await ws.sendMessage("second");
    const second = ws.messages.find((m) => m.content === "second")!;
    expect(second.status).toBe("queued");
    server.completeTurn();
    await flush();
    expect(second.status).toBe("done");
    expect(
      server.sent("turn/start").map((p) => (p.input as Array<{ text: string }>)[0].text),
    ).toEqual(["first", "second"]);
  });

  it("tells another session its message went into the running turn", async () => {
    const ws = makeWorkspace();
    await ws.sendMessage("first");
    server.startTurn();
    const from = { workspaceId: "lead", name: "lead", role: "lead" as const };
    expect(ws.deliver("note", from, "[From the project lead] note")).toBe("steered");
    await flush();
    expect(server.sent("turn/steer")[0]).toMatchObject({
      input: [{ type: "text", text: "[From the project lead] note", text_elements: [] }],
    });
  });

  it("stops a turn by interrupt and runs the steered message it never read after it", async () => {
    const ws = makeWorkspace();
    const [id] = ws.agents.keys();
    await ws.sendMessage("first");
    server.startTurn();
    server.item("started", {
      type: "commandExecution",
      id: "c1",
      command: "sleep 30",
      commandActions: [],
    });
    // Steered, but the command still runs: the model has not read it.
    await ws.sendMessage("second");
    const second = ws.messages.find((m) => m.content === "second")!;
    await ws.interruptAgent(id);
    expect(server.sent("turn/interrupt")).toEqual([{ threadId: "thr_1", turnId: "turn_1" }]);
    // codex drops it with the turn (codex/steer-interrupt): the panel runs it.
    server.completeTurn("interrupted");
    await flush();
    expect(second.status).toBe("done");
    expect(
      server.sent("turn/start").map((p) => (p.input as Array<{ text: string }>)[0].text),
    ).toEqual(["first", "second"]);
    const [reply] = ws.messages.filter((m) => m.kind === "agent");
    expect(reply.content).toBe("*\\[interrupted\\]*");
    expect(reply.events!.find((e) => e.kind === "tool_use")).toMatchObject({
      toolResult: "(interrupted)",
      toolResultIsError: true,
    });
    expect(server.connections).toBe(1);
  });

  it("drops the empty reply when the steered message is read with the prompt", async () => {
    const ws = makeWorkspace();
    await ws.sendMessage("first");
    server.startTurn();
    await ws.sendMessage("second");
    const second = ws.messages.find((m) => m.content === "second")!;
    const [empty] = ws.messages.filter((m) => m.kind === "agent");
    userMessage("u1", null);
    userMessage("u2", second.id);
    server.notify("item/agentMessage/delta", { threadId: "thr_1", itemId: "a1", delta: "Both." });
    server.completeTurn();
    await flush();
    expect(removed).toEqual([empty.id]);
    expect(summary(ws)).toEqual(["user done first", "user done second", "agent done Both."]);
  });

  it("carries on rather than resending a prompt when a limit refuses the turn after a steer", async () => {
    const ws = makeWorkspace();
    const [id] = ws.agents.keys();
    await ws.sendMessage("first");
    server.startTurn();
    server.notify("item/agentMessage/delta", { threadId: "thr_1", itemId: "a1", delta: "On it." });
    await ws.sendMessage("second");
    const second = ws.messages.find((m) => m.content === "second")!;
    userMessage("u1", null);
    userMessage("u2", second.id);
    // The request that read it is the one the limit refuses.
    ws.pauseAgent(id, Date.now() + 60_000, true);
    server.completeTurn("failed", {
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: null,
    });
    await flush();
    expect(ws.retryLast(id)).toBe(true);
    await flush();
    const inputs = server
      .sent("turn/start")
      .map((p) => (p.input as Array<{ text: string }>)[0].text);
    expect(inputs).toEqual([
      "first",
      "[From the panel] A usage limit cut your turn off. Carry on where you left off.",
    ]);
  });

  it("closes a call the earlier reply made when its result comes after a steered message", async () => {
    const ws = makeWorkspace();
    await ws.sendMessage("first");
    server.startTurn();
    server.item("started", {
      type: "commandExecution",
      id: "c1",
      command: "make",
      commandActions: [],
    });
    await ws.sendMessage("second");
    const second = ws.messages.find((m) => m.content === "second")!;
    userMessage("u1", null);
    userMessage("u2", second.id);
    server.item("completed", {
      type: "commandExecution",
      id: "c1",
      command: "make",
      commandActions: [],
      status: "completed",
      aggregatedOutput: "built\n",
      exitCode: 0,
      durationMs: 900,
    });
    server.completeTurn();
    await flush();
    const [before, after] = ws.messages.filter((m) => m.kind === "agent");
    expect(before.events!.find((e) => e.kind === "tool_use")).toMatchObject({
      toolResult: "built\n",
      durationMs: 900,
    });
    expect(after.events ?? []).toEqual([]);
  });

  it("does not steer past a waiting message or a rate-limit hold", async () => {
    const ws = makeWorkspace();
    const [id] = ws.agents.keys();
    await ws.sendMessage("first");
    server.startTurn();
    ws.pauseAgent(id, Date.now() + 60_000);
    await ws.sendMessage("held");
    ws.pauseAgent(id, 0);
    await ws.sendMessage("behind");
    expect(server.sent("turn/steer")).toEqual([]);
    expect(ws.messages.filter((m) => m.status === "queued").map((m) => m.content)).toEqual([
      "held",
      "behind",
    ]);
  });

  it("gives a message caught mid-steer by a restart back to the queue", async () => {
    const ws = makeWorkspace();
    await ws.sendMessage("first");
    server.startTurn();
    server.hold.add("turn/steer");
    void ws.sendMessage("second");
    await flush();
    const state = ws.getState();
    const restored = Workspace.fromState(
      state,
      (() => {
        const registry = new HostRegistry();
        registry.register(new LocalHost("local", "Local"));
        return registry;
      })(),
      { onNewMessage: () => {}, onStreamEvent: () => {}, onMessageDone: () => {} },
    );
    const second = restored.messages.find((m) => m.content === "second")!;
    expect(second).toMatchObject({ status: "queued" });
    expect(second.steering).toBeUndefined();
    expect(restored.cancelQueued(second.id)).toBe(true);
  });

  it("makes a steered message from another session the one its sender waits on once read", async () => {
    const ws = makeWorkspace();
    const [entry] = ws.agents.values();
    await ws.sendMessage("first");
    server.startTurn();
    const from = { workspaceId: "lead", name: "lead", role: "lead" as const };
    ws.deliver("note", from, "[From the project lead] note");
    await flush();
    const note = ws.messages.find((m) => m.content === "note")!;
    userMessage("u1", null);
    userMessage("u2", note.id);
    expect(entry.delivered?.id).toBe(note.id);
    expect(entry.input?.id).toBe(note.id);
  });
});
