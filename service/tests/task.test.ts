import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { Workspace, Message, WorkspaceCallbacks } from "../src/task";
import { HostRegistry, Host, HostSessionHandle, HostInfo } from "../src/host";
import { SessionConfig, SessionState, StreamEvent, UsageStats } from "../src/claude-session";

const emptyUsage: UsageStats = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  turns: 0,
  duration_ms: 0,
};

class FakeSession extends EventEmitter implements HostSessionHandle {
  sessionId: string | null = null;
  usage: UsageStats = { ...emptyUsage };
  isRunning = false;
  stoppedTasks: string[] = [];
  constructor(private config: SessionConfig) {
    super();
  }
  sent: string[] = [];
  async send(prompt: string): Promise<void> {
    this.sent.push(prompt);
    this.isRunning = true;
  }
  abort(): void {}
  async stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId);
  }
  setFastMode(on: boolean): void {
    this.config.fast = on || undefined;
  }
  setGoal(goal: string | null): void {
    this.config.goal = goal ?? undefined;
  }
  getState(): SessionState {
    return { sessionId: this.sessionId, config: this.config, usage: this.usage };
  }
}

class FakeHost implements Host {
  readonly id = "local";
  readonly label = "Local";
  readonly type = "local" as const;
  readonly connected = true;
  lastSession: FakeSession | null = null;
  getInfo(): HostInfo {
    return { id: this.id, label: this.label, type: this.type, connected: this.connected };
  }
  createSession(_agentId: string, config: SessionConfig): HostSessionHandle {
    this.lastSession = new FakeSession(config);
    return this.lastSession;
  }
  destroySession(): void {}
  restoreSession(_agentId: string, state: SessionState): HostSessionHandle {
    this.lastSession = new FakeSession(state.config);
    return this.lastSession;
  }
}

function makeWorkspace(model = "claude-fable-5") {
  const host = new FakeHost();
  const registry = new HostRegistry();
  registry.register(host);
  const done: Array<{ msgId: string; status: string }> = [];
  const cb: WorkspaceCallbacks = {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: (_wsId, msgId, status) => done.push({ msgId, status }),
  };
  const ws = new Workspace("ws-1", "test", "proj", "local", "/tmp", registry, cb);
  const agentInfo = ws.addAgent("A", model, "🤖", "#888", {
    backend: model.startsWith("gpt-") ? "codex" : "claude",
  });
  const session = host.lastSession!;
  const emit = (e: Partial<StreamEvent>) => session.emit("event", e as StreamEvent);
  const agentMsgs = () => ws.messages.filter((m): m is Message => m.kind === "agent");
  return { ws, emit, done, agentMsgs, agentInfo, session };
}

const subagentStart = (taskId: string): Partial<StreamEvent> => ({
  kind: "subagent_start",
  content: "desc",
  toolUseId: `tool-${taskId}`,
  subagent: { taskId, description: "desc", status: "running", events: [] },
});

describe("Workspace event aggregation", () => {
  it("accumulates text deltas into message content", () => {
    const { emit, agentMsgs } = makeWorkspace();
    emit({ kind: "text_delta", content: "Hello " });
    emit({ kind: "text_delta", content: "world" });

    expect(agentMsgs()).toHaveLength(1);
    expect(agentMsgs()[0].content).toBe("Hello world");
  });

  it("pairs a tool_result onto its tool_use event", () => {
    const { emit, agentMsgs } = makeWorkspace();
    emit({ kind: "tool_use", content: "Read /a", toolUseId: "t1" });
    emit({ kind: "tool_result", content: "file contents", toolUseId: "t1" });

    const events = agentMsgs()[0].events!;
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("tool_use");
    expect(events[0].toolResult).toBe("file contents");
  });

  it("merges the subagent lifecycle onto the start event", () => {
    const { emit, agentMsgs } = makeWorkspace();
    emit(subagentStart("task-1"));
    emit({
      kind: "subagent_progress",
      content: "",
      subagent: {
        taskId: "task-1",
        description: "",
        _innerEvent: { kind: "tool_use", content: "Grep foo", toolUseId: "inner-1" } as StreamEvent,
      },
    });
    emit({
      kind: "subagent_progress",
      content: "",
      subagent: {
        taskId: "task-1",
        description: "",
        _innerEvent: {
          kind: "tool_result",
          content: "matches",
          toolUseId: "inner-1",
        } as StreamEvent,
      },
    });
    emit({
      kind: "subagent_done",
      content: "",
      subagent: { taskId: "task-1", description: "", status: "completed", summary: "found it" },
    });

    const events = agentMsgs()[0].events!;
    const start = events.find((e) => e.kind === "subagent_start")!;
    expect(start.subagent?.status).toBe("completed");
    expect(start.subagent?.summary).toBe("found it");
    // Inner tool_use/tool_result were paired inside the start event.
    expect(start.subagent?.events).toHaveLength(1);
    expect(start.subagent?.events?.[0].toolResult).toBe("matches");
    // No dangling standalone progress entry remains.
    expect(events.some((e) => e.kind === "subagent_progress")).toBe(false);
  });

  it("routes late subagent events to the finalized owner message", () => {
    const { emit, done, agentMsgs } = makeWorkspace();
    emit(subagentStart("task-1"));
    emit({ kind: "result", content: "" });
    expect(done).toHaveLength(1);

    // Subagent finishes after the turn was finalized.
    emit({
      kind: "subagent_done",
      content: "",
      subagent: { taskId: "task-1", description: "", status: "completed", summary: "late" },
    });

    // No new agent message bubble was created for the late event.
    expect(agentMsgs()).toHaveLength(1);
    const start = agentMsgs()[0].events!.find((e) => e.kind === "subagent_start")!;
    expect(start.subagent?.status).toBe("completed");
    expect(start.subagent?.summary).toBe("late");
  });

  it("records the account an agent was created with", () => {
    const host = new FakeHost();
    const registry = new HostRegistry();
    registry.register(host);
    const ws = new Workspace("ws-acct", "t", "p", "local", "/tmp", registry, {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
    });
    const info = ws.addAgent(
      "B",
      "claude-fable-5",
      "🤖",
      "#888",
      { providerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" } },
      "work",
    );
    expect(info.account).toBe("work");
    // Persisted state keeps the account so restore can re-resolve the token.
    expect(ws.getState().agents[0].account).toBe("work");
  });

  it("cancelSubagent delegates to the owning session's stopTask", () => {
    const { ws, agentInfo, session } = makeWorkspace();
    ws.cancelSubagent(agentInfo.id, "task-42");
    expect(session.stoppedTasks).toEqual(["task-42"]);
    expect(() => ws.cancelSubagent("nonexistent", "task-42")).toThrow(/Agent not found/);
  });

  it("finalizes the message on result and starts a fresh one on the next event", () => {
    const { emit, done, agentMsgs } = makeWorkspace();
    emit({ kind: "text_delta", content: "first turn" });
    emit({ kind: "result", content: "" });
    emit({ kind: "text_delta", content: "second turn" });

    expect(done).toHaveLength(1);
    expect(done[0].status).toBe("done");
    expect(agentMsgs()).toHaveLength(2);
    expect(agentMsgs()[1].content).toBe("second turn");
  });
});

describe("message queue", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("dispatches immediately when the agent is idle", async () => {
    const { ws, session, agentMsgs } = makeWorkspace();
    await ws.sendMessage("first task");
    expect(session.sent).toEqual(["first task"]);
    expect(ws.messages.find((m) => m.kind === "user")!.status).toBe("done");
    expect(agentMsgs()).toHaveLength(1);
  });

  it("queues messages for a busy agent and drains FIFO on idle", async () => {
    const { ws, emit, session, agentMsgs } = makeWorkspace();
    session.isRunning = true;
    await ws.sendMessage("second");
    await ws.sendMessage("third");
    expect(session.sent).toEqual([]);
    const queued = ws.messages.filter((m) => m.status === "queued");
    expect(queued).toHaveLength(2);
    expect(queued[0].queuedFor).toBeTruthy();
    expect(agentMsgs()).toHaveLength(0);

    // The running turn ends: only the first queued message dispatches,
    // because dispatch marks the session busy again.
    session.isRunning = false;
    emit({ kind: "result", content: "" });
    await tick();
    expect(session.sent).toEqual(["second"]);
    expect(ws.messages.filter((m) => m.status === "queued")).toHaveLength(1);
    expect(ws.messages.find((m) => m.content === "second")!.status).toBe("done");

    // Second turn ends: the next one drains.
    session.isRunning = false;
    emit({ kind: "result", content: "" });
    await tick();
    expect(session.sent).toEqual(["second", "third"]);
    expect(ws.messages.filter((m) => m.status === "queued")).toHaveLength(0);
  });

  it("drains the queue after an aborted turn too", async () => {
    const { ws, session } = makeWorkspace();
    session.isRunning = true;
    await ws.sendMessage("after abort");
    session.isRunning = false;
    ws.abortAll();
    await new Promise((r) => setTimeout(r, 5));
    expect(session.sent).toEqual(["after abort"]);
  });

  it("cancelQueued removes a pending message so it never runs", async () => {
    const { ws, emit, session } = makeWorkspace();
    session.isRunning = true;
    await ws.sendMessage("doomed");
    const queued = ws.messages.find((m) => m.status === "queued")!;
    expect(ws.cancelQueued(queued.id)).toBe(true);
    expect(ws.cancelQueued(queued.id)).toBe(false);
    expect(ws.messages.find((m) => m.id === queued.id)).toBeUndefined();

    session.isRunning = false;
    emit({ kind: "result", content: "" });
    await new Promise((r) => setTimeout(r, 5));
    expect(session.sent).toEqual([]);
  });

  it("preserves the built prompt for queued messages with quotes", async () => {
    const { ws, emit, session } = makeWorkspace();
    session.isRunning = true;
    await ws.sendMessage("follow-up", undefined, undefined, {
      messageId: "m0",
      agentId: null,
      content: "original text",
    });
    session.isRunning = false;
    emit({ kind: "result", content: "" });
    await new Promise((r) => setTimeout(r, 5));
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]).toContain("original text");
    expect(session.sent[0]).toContain("follow-up");
  });
});

describe("rate-limit retry mechanics", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("records the last prompt and retryLast re-dispatches it", async () => {
    const { ws, session } = makeWorkspace();
    await ws.sendMessage("do the thing");
    expect(session.sent).toEqual(["do the thing"]);

    session.isRunning = false;
    expect(ws.retryLast(session ? (ws.getState().agents[0].id as string) : "")).toBe(true);
    await tick();
    expect(session.sent).toEqual(["do the thing", "do the thing"]);
  });

  it("abort before retryLast ensures fresh dispatch after credential switch", async () => {
    const { ws, emit, session } = makeWorkspace();
    const agentId = ws.getState().agents[0].id;
    await ws.sendMessage("rate limited prompt");
    expect(session.sent).toEqual(["rate limited prompt"]);

    // Simulate the turn ending after a rate limit (error → result).
    emit({ kind: "error", content: "Usage limit reached" });
    session.isRunning = false;

    // The server's handleRateLimit would abort then retry.
    session.abort();
    expect(ws.retryLast(agentId)).toBe(true);
    await tick();
    expect(session.sent).toEqual(["rate limited prompt", "rate limited prompt"]);
  });

  it("pauseAgent holds the queue until the deadline, retryLast clears it", async () => {
    const { ws, emit, session } = makeWorkspace();
    const agentId = ws.getState().agents[0].id;
    session.isRunning = true;
    await ws.sendMessage("queued work");

    ws.pauseAgent(agentId, Date.now() + 60_000);
    session.isRunning = false;
    emit({ kind: "result", content: "" });
    await tick();
    // Paused: the queued message must NOT dispatch.
    expect(session.sent).toEqual([]);

    // Recovery path: retryLast clears the pause; with no lastPrompt it
    // returns false and the caller falls back to dequeueNext.
    expect(ws.retryLast(agentId)).toBe(false);
    ws.dequeueNext(agentId);
    await tick();
    expect(session.sent).toEqual(["queued work"]);
  });
});

describe("silent-turn diagnostics", () => {
  it("renders a diagnostic instead of an empty bubble when a turn produces nothing", async () => {
    const { ws, emit, agentMsgs } = makeWorkspace();
    await ws.sendMessage("hello");
    // The turn dies without any event (network drop / CLI crash), then ends.
    emit({ kind: "result", content: "" });

    const msg = agentMsgs()[0];
    expect(msg.status).toBe("done");
    expect(msg.content).toContain("no output");
  });

  it("leaves real replies untouched", async () => {
    const { ws, emit, agentMsgs } = makeWorkspace();
    await ws.sendMessage("hello");
    emit({ kind: "text_delta", content: "real answer" });
    emit({ kind: "result", content: "" });
    expect(agentMsgs()[0].content).toBe("real answer");
  });

  it("keeps tool-only turns silent-but-visible (events present, no diagnostic)", async () => {
    const { ws, emit, agentMsgs } = makeWorkspace();
    await ws.sendMessage("hello");
    emit({ kind: "tool_use", content: "Bash ls", toolUseId: "t1" });
    emit({ kind: "result", content: "" });
    expect(agentMsgs()[0].content).toBe("");
    expect(agentMsgs()[0].events).toHaveLength(1);
  });
});

describe("banners, retries and activity", () => {
  it("keeps a single retry event per turn, updated in place", () => {
    const { ws, emit } = makeWorkspace();
    emit({ kind: "text_delta", content: "hi" });
    emit({ kind: "retry", level: "warning", content: "API retry 1/10" });
    emit({ kind: "retry", level: "warning", content: "API retry 2/10" });
    emit({ kind: "notice", level: "notice", content: "fyi" });
    const events = ws.messages.filter((m) => m.kind === "agent")[0].events!;
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["retry", "API retry 2/10"],
      ["notice", "fyi"],
    ]);
    expect(events[0].contentOffset).toBe(2);
  });

  it("forwards session activity to the callback and exposes it on getInfo", () => {
    const host = new FakeHost();
    const registry = new HostRegistry();
    registry.register(host);
    const seen: Array<[string, string | null]> = [];
    const cb: WorkspaceCallbacks = {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
      onAgentActivity: (_ws, agentId, activity) => seen.push([agentId, activity]),
    };
    const ws = new Workspace("ws-1", "test", "proj", "local", "/tmp", registry, cb);
    const agent = ws.addAgent("A", "claude-fable-5", "🤖", "#888", {});
    host.lastSession!.emit("activity", "compacting context");
    expect(seen).toEqual([[agent.id, "compacting context"]]);
    expect(ws.getInfo(false).agents[0].activity).toBe("compacting context");
    host.lastSession!.emit("activity", null);
    expect(ws.getInfo(false).agents[0].activity).toBeNull();
  });

  it("forwards unhandled SDK messages for logging", () => {
    const host = new FakeHost();
    const registry = new HostRegistry();
    registry.register(host);
    const seen: unknown[] = [];
    const cb: WorkspaceCallbacks = {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
      onUnhandled: (_ws, _agent, msg) => seen.push(msg),
    };
    const ws = new Workspace("ws-1", "test", "proj", "local", "/tmp", registry, cb);
    ws.addAgent("A", "claude-fable-5", "🤖", "#888", {});
    host.lastSession!.emit("unhandled", { type: "mystery" });
    expect(seen).toEqual([{ type: "mystery" }]);
  });

  it("restores the pinned account of a persisted agent", () => {
    const { ws } = makeWorkspace();
    const state = ws.getState();
    state.agents[0].account = "work";
    const registry = new HostRegistry();
    registry.register(new FakeHost());
    const restored = Workspace.fromState(state, registry);
    expect(restored.getInfo(false).agents[0].account).toBe("work");
  });
});

describe("archiving", () => {
  it("tracks lastActivityAt from pushed messages and survives unloading", async () => {
    const { ws, emit } = makeWorkspace();
    const before = ws.lastActivityAt;
    await ws.sendMessage("hello");
    emit({ kind: "text_delta", content: "hi" });
    emit({ kind: "result", content: "" });
    expect(ws.lastActivityAt).toBeGreaterThanOrEqual(before);
    const stamp = ws.lastActivityAt;

    ws.unloadMessages();
    expect(ws.messages).toEqual([]);
    expect(ws.messagesLoaded).toBe(false);
    expect(ws.lastActivityAt).toBe(stamp);
    expect(ws.getInfo(false).lastMessageAt).toBe(stamp);
    // Persisting an unloaded workspace must not claim an empty history.
    expect(ws.getState().messages).toBeUndefined();
  });

  it("is idle only when no agent runs and nothing is queued", async () => {
    const { ws, emit, session } = makeWorkspace();
    expect(ws.isIdle).toBe(true);
    await ws.sendMessage("go");
    expect(ws.isIdle).toBe(false);
    await ws.sendMessage("and this");
    session.isRunning = false;
    emit({ kind: "result", content: "" });
    // The queued message is still pending until the next tick dispatches it.
    expect(ws.isIdle).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(session.isRunning).toBe(true);
    session.isRunning = false;
    emit({ kind: "result", content: "" });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.isIdle).toBe(true);
  });

  it("round-trips archivedAt and lastActivityAt through state", () => {
    const { ws } = makeWorkspace();
    ws.createdAt = 100;
    ws.archivedAt = 123;
    ws.lastActivityAt = 456;
    const state = ws.getState();
    expect(state).toMatchObject({ archivedAt: 123, lastActivityAt: 456 });
    const registry = new HostRegistry();
    registry.register(new FakeHost());
    const restored = Workspace.fromState({ ...state, messages: undefined }, registry);
    expect(restored.isArchived).toBe(true);
    expect(restored.lastActivityAt).toBe(456);
    expect(restored.getInfo(false).archivedAt).toBe(123);
  });

  it("derives lastActivityAt from messages for states written before the field existed", () => {
    const { ws, emit } = makeWorkspace();
    emit({ kind: "text_delta", content: "x" });
    const state = ws.getState();
    delete state.lastActivityAt;
    const registry = new HostRegistry();
    registry.register(new FakeHost());
    const restored = Workspace.fromState(state, registry);
    expect(restored.lastActivityAt).toBe(state.messages![state.messages!.length - 1].timestamp);
  });
});

describe("error events", () => {
  it("get a contentOffset so the interleaved view can place them", () => {
    const { ws, emit } = makeWorkspace();
    emit({ kind: "text_delta", content: "partial" });
    emit({ kind: "error", content: "boom" });
    const m = ws.messages.filter((x) => x.kind === "agent")[0];
    expect(m.events![0]).toMatchObject({ kind: "error", contentOffset: m.content.length });
  });
});

describe("effort on the wire", () => {
  it("exposes the session's effort level and announces /effort changes", async () => {
    const host = new FakeHost();
    const registry = new HostRegistry();
    registry.register(host);
    const updates: Array<{ id: string; effort: string | null }> = [];
    const cb: WorkspaceCallbacks = {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
      onAgentUpdated: (_ws, a) => updates.push({ id: a.id, effort: a.effort }),
    };
    const ws = new Workspace("ws-1", "test", "proj", "local", "/tmp", registry, cb);
    const agent = ws.addAgent("A", "claude-fable-5-1", "🤖", "#888", { effort: "high" });
    expect(ws.getInfo(false).agents[0].effort).toBe("high");

    const session = host.lastSession! as FakeSession & { setEffort?: (l: string) => void };
    session.setEffort = (l: string) => {
      (session.getState().config as { effort?: string }).effort = l;
    };
    await ws.sendMessage("/effort max");
    expect(updates).toEqual([{ id: agent.id, effort: "max" }]);
    expect(ws.getInfo(false).agents[0].effort).toBe("max");
  });
});

describe("per-message effort and context", () => {
  it("stamps the effort on new agent messages and the context on completion", async () => {
    const host = new FakeHost();
    const registry = new HostRegistry();
    registry.register(host);
    const patches: unknown[] = [];
    const cb: WorkspaceCallbacks = {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: (_ws, _id, _status, _content, _events, patch) => patches.push(patch),
    };
    const ws = new Workspace("ws-1", "test", "proj", "local", "/tmp", registry, cb);
    ws.addAgent("A", "claude-fable-5-1", "🤖", "#888", { effort: "xhigh" });
    await ws.sendMessage("hi");
    const session = host.lastSession!;
    session.emit("event", { kind: "text_delta", content: "yo" } as StreamEvent);
    session.emit("event", {
      kind: "result",
      content: "",
      context: { tokens: 42000, window: 200000 },
    } as StreamEvent);
    const m = ws.messages.filter((x) => x.kind === "agent")[0];
    expect(m.effort).toBe("xhigh");
    expect(m.context).toEqual({ tokens: 42000, window: 200000 });
    expect(patches).toEqual([{ context: { tokens: 42000, window: 200000 } }]);
  });
});

describe("agent run state on the wire", () => {
  it("exposes the session state, falls back to busy, and blocks archiving while waiting", () => {
    const host = new FakeHost();
    const registry = new HostRegistry();
    registry.register(host);
    const seen: string[] = [];
    const cb: WorkspaceCallbacks = {
      onNewMessage: () => {},
      onStreamEvent: () => {},
      onMessageDone: () => {},
      onAgentState: (_ws, _id, state) => seen.push(state),
    };
    const ws = new Workspace("ws-1", "test", "proj", "local", "/tmp", registry, cb);
    ws.addAgent("A", "claude-fable-5-1", "🤖", "#888", {});
    expect(ws.getInfo(false).agents[0].state).toBe("idle");
    host.lastSession!.isRunning = true;
    expect(ws.getInfo(false).agents[0].state).toBe("working");
    host.lastSession!.isRunning = false;

    host.lastSession!.emit("runState", "waiting");
    expect(seen).toEqual(["waiting"]);
    expect(ws.getInfo(false).agents[0].state).toBe("waiting");
    expect(ws.isIdle).toBe(false);
    host.lastSession!.emit("runState", "idle");
    expect(ws.isIdle).toBe(true);
  });
});

describe("fast mode and goal commands", () => {
  const lastReply = (ws: Workspace) => ws.messages.filter((m) => m.kind === "agent").at(-1)!;

  it("/fast toggles the session and marks the following turns", async () => {
    const { ws, session, emit, agentMsgs } = makeWorkspace("gpt-6-astra[1m]");
    await ws.sendMessage("/fast");
    expect(lastReply(ws).content).toContain("turned **on**");
    expect(session.getState().config.fast).toBe(true);
    expect(ws.agentInfo(ws.resolveAgent("A")!).fast).toBe(true);

    await ws.sendMessage("hello");
    emit({ kind: "text_delta", content: "hi" });
    expect(agentMsgs().at(-1)!.fast).toBe(true);

    await ws.sendMessage("/fast off");
    expect(lastReply(ws).content).toContain("turned **off**");
    expect(session.getState().config.fast).toBeUndefined();
    await ws.sendMessage("/fast off");
    expect(lastReply(ws).content).toContain("already **off**");
  });

  it("/fast is refused for models without fast mode", async () => {
    const { ws, session } = makeWorkspace("deepseek-v4-pro");
    await ws.sendMessage("/fast on");
    expect(lastReply(ws).content).toContain("does not support fast mode");
    expect(session.sent).toEqual([]);
  });

  it("/goal records the objective and asks the codex agent to create it", async () => {
    const { ws, session } = makeWorkspace("gpt-6-astra");
    await ws.sendMessage("/goal");
    expect(lastReply(ws).content).toContain("no active goal");

    await ws.sendMessage("/goal make the tests green");
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]).toContain("create_goal");
    expect(session.sent[0]).toContain("make the tests green");
    expect(session.getState().config.goal).toBe("make the tests green");
    expect(ws.agentInfo(ws.resolveAgent("A")!).goal).toBe("make the tests green");
    // The visible user message keeps what was typed, not the rewritten prompt.
    expect(ws.messages.filter((m) => m.kind === "user").at(-1)!.content).toBe(
      "/goal make the tests green",
    );

    session.isRunning = false;
    await ws.sendMessage("/goal show");
    expect(lastReply(ws).content).toContain("make the tests green");

    await ws.sendMessage("/goal clear");
    expect(session.sent).toHaveLength(2);
    expect(session.sent[1]).toContain("update_goal");
    expect(session.getState().config.goal).toBeUndefined();
  });

  it("/goal is a codex feature", async () => {
    const { ws, session } = makeWorkspace();
    await ws.sendMessage("/goal anything");
    expect(lastReply(ws).content).toContain("Codex feature");
    expect(session.sent).toEqual([]);
  });
});

describe("events between turns and late results", () => {
  it("turns a banner that arrives while idle into a system line, not a streaming bubble", () => {
    const { ws, emit, session } = makeWorkspace();
    session.isRunning = false;
    emit({ kind: "notice", level: "notice", content: "Session compacted" });
    const last = ws.messages[ws.messages.length - 1];
    expect(last.kind).toBe("system");
    expect(last.status).toBe("done");
    expect(last.content).toContain("Session compacted");
    expect(ws.messages.some((m) => m.status === "streaming")).toBe(false);
  });

  it("attaches a late tool result to the call that made it", async () => {
    const { ws, emit, session, agentMsgs, done } = makeWorkspace();
    await ws.sendMessage("run it");
    emit({ kind: "tool_use", content: "**Bash** sleep", toolUseId: "t1", toolName: "Bash" });
    emit({ kind: "result", content: "" });
    session.isRunning = false;
    const first = agentMsgs()[0];
    expect(first.status).toBe("done");
    emit({ kind: "tool_result", content: "finished", toolUseId: "t1" });
    expect(agentMsgs()).toHaveLength(1);
    expect(first.events![0].toolResult).toBe("finished");
    // The owner is re-announced so open clients pick up the result.
    expect(done.filter((d) => d.msgId === first.id).length).toBeGreaterThanOrEqual(2);
  });

  it("drops the retry banner once the turn finishes and keeps errors out of the text", async () => {
    const { ws, emit, agentMsgs } = makeWorkspace();
    await ws.sendMessage("go");
    emit({ kind: "retry", content: "API retry 1/10 in 1s" });
    emit({ kind: "text_delta", content: "answer" });
    emit({ kind: "result", content: "" });
    expect(agentMsgs()[0].events!.some((e) => e.kind === "retry")).toBe(false);
    await ws.sendMessage("again");
    emit({ kind: "text_delta", content: "partial" });
    emit({ kind: "error", content: "boom" });
    const failed = agentMsgs()[1];
    expect(failed.status).toBe("error");
    expect(failed.content).toBe("partial");
    expect(failed.events!.at(-1)).toMatchObject({ kind: "error", content: "boom" });
  });

  it("applies a grandchild's events inside the nested card and drops ownerless carriers", async () => {
    const { ws, emit, agentMsgs } = makeWorkspace();
    await ws.sendMessage("go");
    emit(subagentStart("outer"));
    emit({
      kind: "subagent_progress",
      content: "",
      subagent: {
        taskId: "outer",
        description: "",
        _innerEvent: subagentStart("inner") as StreamEvent,
      },
    });
    emit({
      kind: "subagent_progress",
      content: "",
      subagent: {
        taskId: "outer",
        description: "",
        _innerEvent: {
          kind: "subagent_progress",
          content: "",
          subagent: {
            taskId: "inner",
            description: "",
            _innerEvent: { kind: "tool_use", content: "**Read** `/a`", toolUseId: "r1" },
          },
        } as StreamEvent,
      },
    });
    // A carrier for a task nobody started: dropped, no phantom card.
    emit({
      kind: "subagent_progress",
      content: "",
      subagent: {
        taskId: "ghost",
        description: "",
        _innerEvent: { kind: "thinking", content: "…" },
      },
    });
    const events = agentMsgs()[0].events!;
    expect(events.map((e) => e.kind)).toEqual(["subagent_start"]);
    const inner = events[0].subagent!.events!;
    expect(inner.map((e) => e.kind)).toEqual(["subagent_start"]);
    expect(inner[0].subagent!.events!.map((e) => e.kind)).toEqual(["tool_use"]);
  });
});
