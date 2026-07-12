import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { Workspace, Message, WorkspaceCallbacks } from "../src/task";
import { HostRegistry, Host, HostSessionHandle, HostInfo } from "../src/host";
import { SessionConfig, SessionState, StreamEvent, UsageStats } from "../src/session";

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

function makeWorkspace() {
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
  const agentInfo = ws.addAgent("A", "claude-fable-5", "🤖", "#888", {});
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
