import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { Workspace, Message, WorkspaceCallbacks } from "./task";
import { HostRegistry, Host, HostSessionHandle, HostInfo } from "./host";
import { SessionConfig, SessionState, StreamEvent, UsageStats } from "./session";

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
  constructor(private config: SessionConfig) {
    super();
  }
  async send(): Promise<void> {}
  abort(): void {}
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
  ws.addAgent("A", "claude-fable-5", "🤖", "#888", {});
  const session = host.lastSession!;
  const emit = (e: Partial<StreamEvent>) => session.emit("event", e as StreamEvent);
  const agentMsgs = () => ws.messages.filter((m): m is Message => m.kind === "agent");
  return { ws, emit, done, agentMsgs };
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
