import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { Workspace, WorkspaceCallbacks } from "../../src/workspace/workspace";
import { HostRegistry, Host, HostSessionHandle, HostInfo, LocalHost } from "../../src/session/host";
import { SessionConfig, SessionState, UsageStats } from "../../src/session/claude";

const emptyUsage: UsageStats = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  turns: 0,
  duration_ms: 0,
};

// Like ClaudeSession: abort() clears the running flag synchronously.
class FakeSession extends EventEmitter implements HostSessionHandle {
  sessionId: string | null = null;
  usage: UsageStats = { ...emptyUsage };
  isRunning = false;
  sent: string[] = [];
  constructor(private config: SessionConfig) {
    super();
  }
  send(prompt: string): Promise<void> {
    this.sent.push(prompt);
    this.isRunning = true;
    return Promise.resolve();
  }
  abort(): void {
    this.isRunning = false;
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
  sessions = new Map<string, FakeSession>();
  getInfo(): HostInfo {
    return { id: this.id, label: this.label, type: this.type, connected: this.connected };
  }
  createSession(agentId: string, config: SessionConfig): HostSessionHandle {
    const s = new FakeSession(config);
    this.sessions.set(agentId, s);
    return s;
  }
  destroySession(agentId: string): void {
    this.sessions.get(agentId)?.abort();
    this.sessions.delete(agentId);
  }
  restoreSession(agentId: string, state: SessionState): HostSessionHandle {
    return this.createSession(agentId, state.config);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function makeWorkspace(cb: Partial<WorkspaceCallbacks> = {}) {
  const host = new FakeHost();
  const registry = new HostRegistry();
  registry.register(host);
  const ws = new Workspace("ws-1", "t", "p", "local", "/tmp", registry, {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: () => {},
    ...cb,
  });
  const agent = ws.addAgent("A", "claude-fable-5", "a", "#888", {
    backend: "claude",
    providerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "sk-secret" },
  });
  const session = host.sessions.get(agent.id)!;
  return { ws, host, agent, session };
}

describe("Workspace teardown", () => {
  it("dispose does not start a queued prompt and releases the sessions", async () => {
    const { ws, host, session } = makeWorkspace();
    await ws.sendMessage("running");
    await ws.sendMessage("queued");
    ws.dispose();
    await tick();
    expect(session.sent).toEqual(["running"]);
    expect(host.sessions.size).toBe(0);
    expect(session.listenerCount("event")).toBe(0);
  });

  it("a real LocalHost forgets the sessions of a disposed workspace", () => {
    const host = new LocalHost("local", "Local");
    const registry = new HostRegistry();
    registry.register(host);
    const ws = new Workspace("ws-d", "d", "p", "local", "/tmp", registry);
    ws.addAgent("A", "claude-fable-5", "a", "#888", { backend: "claude" });
    ws.dispose();
    expect((host as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });

  it("removing an agent mid-turn finishes its reply and drops its queue", async () => {
    const done: string[] = [];
    const { ws, agent } = makeWorkspace({
      onMessageDone: (_ws, id, status) => done.push(`${id}:${status}`),
    });
    await ws.sendMessage("go");
    await ws.sendMessage("later");
    const reply = ws.messages.find((m) => m.kind === "agent")!;
    const queued = ws.messages.find((m) => m.status === "queued")!;

    expect(ws.removeAgent(agent.id)).toEqual([queued.id]);
    expect(reply.status).toBe("done");
    expect(done).toContain(`${reply.id}:done`);
    expect(ws.messages.some((m) => m.id === queued.id)).toBe(false);
    expect(ws.isIdle).toBe(true);
    expect(ws.removeAgent(agent.id)).toBeNull();
  });
});

describe("Workspace persistence", () => {
  it("never writes account tokens into the state", () => {
    const { ws } = makeWorkspace();
    expect(JSON.stringify(ws.getState())).not.toContain("sk-secret");
  });

  it("background-task churn is reported as transient", () => {
    const updates: Array<boolean | undefined> = [];
    const { session } = makeWorkspace({
      onAgentUpdated: (_ws, _agent, transient) => updates.push(transient),
    });
    session.emit("backgroundTasks", []);
    expect(updates).toEqual([true]);
  });

  it("a reply cut off by a restart is marked interrupted, and orphaned queue entries go", () => {
    const registry = new HostRegistry();
    registry.register(new FakeHost());
    const agent = {
      id: "agent-1",
      name: "A",
      model: "claude-fable-5",
      avatar: "a",
      color: "#888",
      isDefault: true,
      session: {
        sessionId: null,
        config: { cwd: "/tmp", backend: "claude" as const },
        usage: emptyUsage,
      },
    };
    const ws = Workspace.fromState(
      {
        id: "ws-r",
        name: "r",
        project: "p",
        hostId: "local",
        cwd: "/tmp",
        createdAt: 1,
        agents: [agent],
        messages: [
          { id: "u", kind: "user", agentId: null, content: "go", timestamp: 2, status: "done" },
          {
            id: "r",
            kind: "agent",
            agentId: "agent-1",
            content: "half",
            timestamp: 3,
            status: "streaming",
          },
          {
            id: "q1",
            kind: "user",
            agentId: null,
            content: "next",
            timestamp: 4,
            status: "queued",
            queuedFor: "agent-1",
          },
          {
            id: "q2",
            kind: "user",
            agentId: null,
            content: "lost",
            timestamp: 5,
            status: "queued",
            queuedFor: "agent-gone",
          },
        ],
      },
      registry,
    );
    const reply = ws.messages.find((m) => m.id === "r")!;
    expect(reply.status).toBe("done");
    expect(reply.content).toBe("half\n\n*\\[interrupted\\]*");
    expect(ws.messages.map((m) => m.id)).toEqual(["u", "r", "q1"]);
  });
});
