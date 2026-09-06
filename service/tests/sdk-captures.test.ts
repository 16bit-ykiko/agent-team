import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import {
  ClaudeSession,
  StreamEvent,
  SessionConfig,
  SessionState,
  UsageStats,
} from "../src/claude-session";
import { Workspace, Message, WorkspaceCallbacks } from "../src/task";
import { HostRegistry, Host, HostSessionHandle, HostInfo } from "../src/host";
import { applyEventsToMessage } from "../../webview/src/stream";

// Real SDK streams recorded with scripts/capture-sdk.ts (claude-sonnet-5,
// bundled CLI). Each fixture is replayed through ClaudeSession and the
// Workspace aggregation, and the client-side aggregation is checked to
// converge on the same transcript.

const FIXTURES = path.join(__dirname, "fixtures", "sdk");

// A fixture may hold several sessions (a resume scenario); `session` picks
// one. Capture markers are not SDK frames.
function frames(name: string, session = 0): unknown[] {
  const all = fs
    .readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { msg: { type: string } }).msg);
  const starts = all.flatMap((m, i) => (m.type === "capture_session" ? [i] : []));
  const from = starts[session] ?? 0;
  const to = starts[session + 1] ?? all.length;
  return all.slice(from, to).filter((m) => !m.type.startsWith("capture_"));
}

// Everything the panel would see for one fixture: the StreamEvents the
// session emitted, and the messages the workspace built from them.
function replay(name: string, prompt: string, sessionIndex = 0) {
  const session = new ClaudeSession({ cwd: "/tmp/sdk-capture" });
  const s = session as unknown as {
    handleSDKMessage(m: unknown): void;
    lastPushed: string | null;
    expectingTurn: boolean;
    processing: boolean;
    awaitingFirstOutput: boolean;
  };
  // As after send(): our prompt is out, nothing came back yet.
  s.lastPushed = prompt;
  s.expectingTurn = true;
  s.processing = true;
  s.awaitingFirstOutput = true;

  const events: StreamEvent[] = [];
  session.on("event", (e: StreamEvent) => events.push(e));
  const states: string[] = [];
  session.on("runState", (st: string) => states.push(st));

  const { ws, fake } = makeWorkspace();
  session.on("event", (e: StreamEvent) => fake.emit("event", JSON.parse(JSON.stringify(e))));
  session.on("runState", (st: string) => fake.emit("runState", st));
  fake.isRunning = true;
  void ws.sendMessage(prompt);
  for (const f of frames(name, sessionIndex)) s.handleSDKMessage(f);
  return { session, events, states, ws, messages: ws.messages.filter((m) => m.kind === "agent") };
}

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
  send(): Promise<void> {
    this.isRunning = true;
    return Promise.resolve();
  }
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
  last: FakeSession | null = null;
  getInfo(): HostInfo {
    return { id: this.id, label: this.label, type: this.type, connected: this.connected };
  }
  createSession(_id: string, config: SessionConfig): HostSessionHandle {
    this.last = new FakeSession(config);
    return this.last;
  }
  destroySession(): void {}
  restoreSession(_id: string, state: SessionState): HostSessionHandle {
    this.last = new FakeSession(state.config);
    return this.last;
  }
}
function makeWorkspace() {
  const host = new FakeHost();
  const registry = new HostRegistry();
  registry.register(host);
  const cb: WorkspaceCallbacks = {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: () => {},
  };
  const ws = new Workspace("ws", "t", "p", "local", "/tmp/sdk-capture", registry, cb);
  ws.addAgent("A", "claude-sonnet-5", "🤖", "#888", {});
  const fake = host.last!;
  return { ws, fake };
}

// The client folds the same events; its transcript must match the server's.
type ClientMessage = Parameters<typeof applyEventsToMessage>[0];
function clientView(prompt: string, events: StreamEvent[]): Message[] {
  const msgs: ClientMessage[] = [];
  let cur: ClientMessage | null = null;
  for (const e of events) {
    // The server does not broadcast whole-block text events (content
    // arrives as deltas), and the client drops thinking deltas.
    if (e.kind === "text") continue;
    if (!cur) {
      cur = {
        id: `m${msgs.length}`,
        kind: "agent",
        agentId: "a",
        content: "",
        timestamp: 0,
        status: "streaming",
        events: [],
      };
      msgs.push(cur);
    }
    if (e.kind === "result") {
      cur.status = "done";
      cur = null;
      continue;
    }
    const taskId = e.subagent?.taskId;
    const owner: ClientMessage | undefined =
      taskId && !cur.events!.some((x) => x.subagent?.taskId === taskId)
        ? msgs.find((m) => m.events!.some((x) => x.subagent?.taskId === taskId))
        : undefined;
    const target: ClientMessage = owner ?? cur;
    const next = applyEventsToMessage(target, [e]);
    msgs[msgs.indexOf(target)] = next;
    if (target === cur) cur = next;
  }
  void prompt;
  return msgs as unknown as Message[];
}

// Card lifecycle events fold into their start; the kinds a reader sees.
const kinds = (evs: StreamEvent[]) =>
  evs
    .filter((e) => e.kind !== "subagent_done" && e.kind !== "subagent_progress")
    .map((e) => e.kind);

const strip = (m: Message): unknown =>
  JSON.parse(
    JSON.stringify(m.events, (k: string, v: unknown) =>
      k === "_innerEvent" || k === "contentOffset" || k === "step" || k === "toolInput"
        ? undefined
        : v,
    ),
  ) as unknown;

describe("real SDK streams", () => {
  it("bash-quick: one paired tool call, no cards", () => {
    const { messages, events } = replay("bash-quick", "Run echo hi");
    expect(messages).toHaveLength(1);
    const evs = messages[0].events!;
    // (No thinking text: the capture did not ask for summarized thinking.)
    expect(kinds(evs)).toEqual(["tool_use"]);
    expect(evs[0].toolResult).toContain("hi");
    expect(events.some((e) => e.kind.startsWith("subagent"))).toBe(false);
    expect(messages[0].status).toBe("done");
    expect(messages[0].content).toBe("done");
  });

  it("bash-long: a foreground command that the CLI registers as a task is still just a tool call", () => {
    const { messages, events } = replay("bash-long", "Run sleep 8");
    expect(events.some((e) => e.kind.startsWith("subagent"))).toBe(false);
    const evs = messages[0].events!;
    expect(kinds(evs)).toEqual(["tool_use"]);
    expect(evs[0].toolResult).toContain("slow");
  });

  it("bash-bg: a background command is a shell card that closes, then the agent is woken up", () => {
    const { messages, events, states } = replay("bash-bg", "Run sleep 6 in the background");
    expect(messages).toHaveLength(2);
    const first = messages[0].events!;
    expect(kinds(first)).toEqual(["tool_use", "subagent_start"]);
    // The tool call keeps its own result; the card carries the command.
    expect(first[0].toolResult).toContain("background");
    const card = first[1].subagent!;
    expect(card).toMatchObject({ taskType: "local_bash", agentType: "shell", status: "completed" });
    expect(card.prompt).toContain("sleep 6; echo finished");
    expect(card.summary).toContain("completed");
    expect(messages[0].status).toBe("done");
    // Waiting while it ran, then the notification turn with its banner.
    expect(states).toContain("waiting");
    const second = messages[1].events!;
    expect(second[0]).toMatchObject({ kind: "notice", level: "wakeup" });
    expect(second[0].content).toContain("background task");
    expect(messages[1].status).toBe("done");
    expect(events.filter((e) => e.kind === "result")).toHaveLength(2);
  });

  it("agent: a foreground subagent card with its transcript; the spawning call is linked, not duplicated", () => {
    const { messages } = replay("agent", "Use the Agent tool");
    const evs = messages[0].events!;
    expect(kinds(evs)).toEqual(["tool_use", "subagent_start"]);
    expect(evs[1].toolUseId).toBe(evs[0].toolUseId);
    const card = evs[1].subagent!;
    expect(card).toMatchObject({
      agentType: "general-purpose",
      taskType: "local_agent",
      status: "completed",
    });
    expect(card.prompt).toContain("echo sub");
    expect(card.events!.map((e) => e.kind)).toEqual(["tool_use", "text"]);
    expect(card.events![0].toolResult).toContain("sub");
    expect(card.summary).toContain("sub");
    expect(messages[0].status).toBe("done");
  });

  it("agent-bg: the card finishes on its own message after the turn ended, then a wake-up turn follows", () => {
    const { messages } = replay("agent-bg", "Use the Agent tool in the background");
    expect(messages).toHaveLength(2);
    const card = messages[0].events!.find((e) => e.kind === "subagent_start")!.subagent!;
    expect(card.status).toBe("completed");
    expect(card.events!.map((e) => e.kind)).toEqual(["tool_use", "text"]);
    // Its inner foreground command did not become a nested card.
    expect(card.events!.some((e) => e.kind.startsWith("subagent"))).toBe(false);
    expect(messages[0].status).toBe("done");
    expect(messages[1].events![0]).toMatchObject({ kind: "notice", level: "wakeup" });
  });

  it("nested-agent: a subagent's own subagent nests inside its card with its transcript", () => {
    const { messages, events } = replay("nested-agent", "nested");
    const evs = messages[0].events!;
    expect(kinds(evs)).toEqual(["tool_use", "subagent_start"]);
    const outer = evs[1].subagent!;
    expect(outer.status).toBe("completed");
    expect(kinds(outer.events!)).toEqual(["tool_use", "subagent_start", "text"]);
    const inner = outer.events![1].subagent!;
    expect(inner).toMatchObject({ agentType: "Explore", status: "completed" });
    expect(kinds(inner.events!)).toEqual(["tool_use", "text"]);
    expect(inner.events![0].toolResult).toContain("drwx");
    // No phantom top-level card for the grandchild.
    expect(
      events.filter((e) => e.kind === "subagent_start" && e.subagent?.taskId === inner.taskId),
    ).toHaveLength(0);
  });

  it("skill: a /skill prompt and a Skill tool call never show up as wake-ups", () => {
    for (const [name, prompt] of [
      ["skill", "/hello"],
      ["skill-tool", "Use the Skill tool"],
    ] as const) {
      const { events, messages } = replay(name, prompt);
      expect(events.filter((e) => e.level === "wakeup")).toHaveLength(0);
      expect(messages[0].content).toContain("Hello from the skill.");
    }
  });

  it("image: reading an image is a plain tool call", () => {
    const { messages, events } = replay("image", "Read the image");
    expect(events.filter((e) => e.kind === "notice")).toHaveLength(0);
    expect(kinds(messages[0].events!)).toEqual(["tool_use"]);
    expect(messages[0].content.length).toBeGreaterThan(0);
  });

  it("resume-orphan-bg: resuming past a stopped background task does not end our turn early", () => {
    const { messages, events } = replay("resume-orphan-bg", "Reply with the single word two.", 1);
    // One reply to our prompt, not an empty one plus a wake-up.
    expect(messages).toHaveLength(1);
    expect(messages[0].content.trim()).toBe("two");
    expect(messages[0].status).toBe("done");
    expect(events.filter((e) => e.kind === "result")).toHaveLength(1);
    expect(events.some((e) => e.kind === "notice" && e.level === "wakeup")).toBe(false);
    // The orphaned task is mentioned, folded, not a card.
    const notice = messages[0].events!.find((e) => e.kind === "notice")!;
    expect(notice).toMatchObject({ level: "warning" });
    expect(notice.content).toContain("previous session");
    expect(messages[0].events!.some((e) => e.kind === "subagent_start")).toBe(false);
  });

  it("the client aggregation converges on the server transcript for every fixture", () => {
    for (const [name, prompt, session] of [
      ["bash-quick", "a", 0],
      ["bash-long", "b", 0],
      ["bash-bg", "c", 0],
      ["agent", "d", 0],
      ["agent-bg", "e", 0],
      ["nested-agent", "f", 0],
      ["resume-orphan-bg", "g", 1],
    ] as const) {
      const { messages, events } = replay(name, prompt, session);
      const client = clientView(prompt, events);
      expect(client.length, name).toBe(messages.length);
      messages.forEach((m, i) => {
        expect(strip(client[i]), `${name} message ${i}`).toEqual(strip(m));
      });
    }
  });
});
