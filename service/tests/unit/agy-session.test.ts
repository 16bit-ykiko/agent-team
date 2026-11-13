import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { AgySession, IDLE_TIMINGS } from "../../src/session/agy";
import type { RpcMessage, Transport } from "../../src/session/codex-rpc";
import type { StreamEvent } from "../../src/session/claude";

type Params = Record<string, unknown>;
type Update = Record<string, unknown>;

// An in-memory `agy acp`: answers the session's requests from per-method
// handlers (a throw is a JSON-RPC error), keeps the conversation a load
// replays, and lets a test stream updates into a running prompt. The
// recorded behaviour lives in tests/snap/agy; these are the cases no
// recording shows, or only with real time.
class FakeAgy {
  written: RpcMessage[] = [];
  connections = 0;
  stored: Update[] = [];
  private listeners: Array<(m: RpcMessage) => void> = [];
  private closers: Array<(r: string) => void> = [];
  private prompt: ((r: unknown) => void) | null = null;
  handlers: Record<string, (p: Params) => unknown> = {
    initialize: () => ({ protocolVersion: 1 }),
    "session/new": () => {
      this.update({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "goal" }, { name: "teamwork" }],
      });
      return { sessionId: "s1", configOptions: options("gemini-4-carbon", "medium") };
    },
    "session/resume": () => ({ configOptions: options("gemini-4-carbon", "medium") }),
    "session/set_config_option": (p) =>
      p.configId === "model"
        ? { configOptions: options(p.value as string, "medium") }
        : { configOptions: options("gemini-3.8-flash", p.value as string) },
    "session/load": () => {
      for (const u of this.stored) this.update(u);
      return {};
    },
    "session/prompt": () => new Promise((r) => (this.prompt = r)),
  };

  transport(pid?: number): Transport {
    this.connections++;
    const listeners: Array<(m: RpcMessage) => void> = [];
    const closers: Array<(r: string) => void> = [];
    this.listeners = listeners;
    this.closers = closers;
    return {
      write: (m) => {
        this.written.push(m);
        if (m.method && m.id != null) void this.answer(m, listeners);
      },
      onMessage: (cb) => listeners.push(cb),
      onClose: (cb) => closers.push(cb),
      close: () => setTimeout(() => closers.splice(0).forEach((cb) => cb("agy acp exited")), 1),
      pid,
    };
  }

  private async answer(m: RpcMessage, listeners: Array<(m: RpcMessage) => void>): Promise<void> {
    const handler = this.handlers[m.method!];
    let reply: RpcMessage;
    try {
      reply = { id: m.id, result: handler ? await handler((m.params ?? {}) as Params) : {} };
    } catch (e) {
      reply = { id: m.id, error: { code: -32603, message: (e as Error).message } };
    }
    for (const cb of listeners) cb(reply);
  }

  // The next load waits for the call returned; later ones answer at once.
  holdNextLoad(): () => void {
    const load = this.handlers["session/load"];
    let release: () => void = () => {};
    this.handlers["session/load"] = (p) => {
      this.handlers["session/load"] = load;
      return new Promise((r) => (release = () => r(load(p))));
    };
    return () => release();
  }

  update(update: Update): void {
    for (const cb of this.listeners)
      cb({ method: "session/update", params: { sessionId: "s1", update } });
  }

  // Streams updates into the running prompt (and the stored conversation),
  // then ends it.
  turn(updates: Update[], stopReason = "end_turn"): void {
    for (const u of updates) {
      this.update(u);
      const same = this.stored.findIndex((x) => x.toolCallId && x.toolCallId === u.toolCallId);
      if (same >= 0) this.stored[same] = u;
      else this.stored.push(u);
    }
    this.prompt?.({ stopReason, usage: { inputTokens: 100, outputTokens: 5 } });
    this.prompt = null;
  }

  exit(): void {
    this.closers.splice(0).forEach((cb) => cb("agy acp exited (1)"));
  }

  sent(method: string): Params[] {
    return this.written.filter((m) => m.method === method).map((m) => (m.params ?? {}) as Params);
  }
}

function options(model: string, effort: string) {
  return [
    { id: "model", currentValue: model },
    { id: "thought_level", currentValue: effort },
  ];
}

const user = (text: string) => ({
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text },
});
const agent = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const command = (id: string, line: string, status: string, output?: string) => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  name: "run_command",
  kind: "execute",
  title: line,
  status,
  args: { CommandLine: line },
  ...(output && {
    rawOutput: { output, exit_code: 0 },
    content: [{ type: "content", content: { type: "text", text: output } }],
  }),
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
}

let fake: FakeAgy;
beforeEach(() => {
  fake = new FakeAgy();
  AgySession.hooks = {
    transport: () => fake.transport(),
    mcpServer: () => ({ name: "panel", command: "node", args: [], env: [] }),
    idleTimers: false,
  };
});
afterEach(() => {
  AgySession.hooks = null;
});

function session(model = "agy/gemini-3.8-flash", effort: string | undefined = "low") {
  const s = new AgySession({ cwd: "/tmp/x", backend: "agy", model, effort });
  const events: StreamEvent[] = [];
  const states: string[] = [];
  s.on("event", (e: StreamEvent) => events.push(e));
  s.on("runState", (st: string) => states.push(st));
  return { s, events, states };
}

describe("AgySession", () => {
  it("starts agy's session, sets the model and thought level, and maps a turn", async () => {
    const { s, events } = session();
    void s.send("hi");
    await flush();
    expect(fake.sent("session/set_config_option").map((p) => [p.configId, p.value])).toEqual([
      ["model", "gemini-3.8-flash"],
      ["thought_level", "low"],
    ]);
    fake.turn([user("hi"), agent("hel"), agent("lo")]);
    await flush();
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "text_delta", "result"]);
    expect(events.at(-1)).toMatchObject({ effort: "low" });
    expect(s.sessionId).toBe("s1");
    expect(s.usage.input_tokens).toBe(100);
    // The conversation as stored, for what agy does while idle.
    expect(fake.sent("session/load")).toHaveLength(1);
  });

  it("shows a background command's end and agy's wake-up turn found by a load", async () => {
    const { s, events, states } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), command("c1", "sleep 5", "in_progress"), agent("started")]);
    // How the load after the turn lists it (agy/background).
    fake.stored = [command("c1", "sleep 5", "in_progress"), user("go"), agent("started")];
    await flush();
    expect(s.runState).toBe("waiting");
    expect(s.backgroundTaskList.map((t) => t.description)).toEqual(["sleep 5"]);
    const card = events.find((e) => e.kind === "subagent_start");
    expect(card?.subagent).toMatchObject({
      taskId: "c1",
      taskType: "local_bash",
      status: "running",
    });

    // A load lists a command still running ahead of everything; once it
    // ended, in its place. agy woke meanwhile and replied.
    fake.stored = [
      user("go"),
      command(
        "c1",
        "sleep 5",
        "completed",
        "Command exited with code 0.\n\nCommand output:\nbg-finished\r\n",
      ),
      agent("started"),
    ];
    fake.stored.push(agent("It finished."));
    events.length = 0;
    s.checkIdle();
    await flush();
    expect(events.map((e) => e.kind)).toEqual([
      "tool_result",
      "subagent_done",
      "notice",
      "text_delta",
      "result",
    ]);
    expect(events[0]).toMatchObject({ toolUseId: "c1", content: "bg-finished" });
    expect(events[2]).toMatchObject({
      level: "wakeup",
      content: "`sleep 5` finished",
    });
    expect(events[3].content).toBe("It finished.");
    expect(s.runState).toBe("idle");
    expect(states.slice(-3)).toEqual(["waiting", "working", "idle"]);

    // Nothing new: nothing shown.
    events.length = 0;
    s.checkIdle();
    await flush();
    expect(events).toEqual([]);
  });

  it("cancels the running prompt on Stop and closes its open calls", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.update(user("go"));
    fake.update(command("c1", "sleep 30", "in_progress"));
    expect(await s.interrupt()).toBe(true);
    expect(fake.sent("session/cancel")).toEqual([{ sessionId: "s1" }]);
    fake.turn([], "cancelled");
    await flush();
    expect(events.filter((e) => e.kind === "tool_result")).toMatchObject([
      { toolUseId: "c1", content: "Interrupted", isError: true },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "result", interrupted: true });
    expect(s.runState).toBe("idle");
  });

  it("resumes the conversation in a new process, and loads it when agy cannot resume it", async () => {
    const restored = AgySession.fromState({
      sessionId: "s1",
      config: { cwd: "/tmp/x", backend: "agy", model: "agy/gemini-3.8-flash", effort: "low" },
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
    restored.on("event", (e: StreamEvent) => events.push(e));
    fake.handlers["session/resume"] = () => {
      throw new Error("Failed to read session s1; retry, or load it with session/load");
    };
    fake.stored = [user("earlier"), agent("reply")];
    void restored.send("again");
    await flush();
    expect(fake.sent("session/new")).toEqual([]);
    // The load instead of the resume; agy did nothing since: none before the
    // prompt.
    expect(fake.sent("session/load")).toHaveLength(1);
    expect(fake.sent("session/prompt")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "notice")).toEqual([]);
  });

  it("fails the turn when agy exits mid-turn and starts it again on the next message", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.exit();
    await flush();
    expect(events.at(-1)).toMatchObject({
      kind: "error",
      content: "[agy error] agy acp exited (1)",
    });
    expect(s.isRunning).toBe(false);
    void s.send("again");
    await flush();
    expect(fake.connections).toBe(2);
    expect(fake.sent("session/resume")).toEqual([expect.objectContaining({ sessionId: "s1" })]);
  });

  it("shows what a load finds first in the reply of a message that waited on it", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), command("c1", "sleep 5", "in_progress"), agent("started")]);
    fake.stored = [command("c1", "sleep 5", "in_progress"), user("go"), agent("started")];
    await flush();
    // agy woke while idle; a load is under way when the next message comes.
    fake.stored = [user("go"), command("c1", "sleep 5", "completed", "x"), agent("started")];
    fake.stored.push(agent("It finished."));
    const release = fake.holdNextLoad();
    s.checkIdle();
    await flush();
    void s.send("next");
    await flush();
    expect(fake.sent("session/prompt")).toHaveLength(1);
    events.length = 0;
    release();
    await flush();
    expect(fake.sent("session/prompt")).toHaveLength(2);
    fake.turn([user("next"), agent("ok")]);
    await flush();
    expect(events.map((e) => e.kind)).toEqual([
      "tool_result",
      "subagent_done",
      "notice",
      "text_delta",
      "text_delta",
      "result",
    ]);
    expect(events[3].content).toBe("It finished.");
    expect(events[4].content).toBe("\n\nok");
  });

  it("shows text agy streams before the prompt's echo when no load caught it", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), agent("one")]);
    await flush();
    void s.send("two");
    await flush();
    events.length = 0;
    fake.turn([agent("Woke up."), user("two"), agent("ok")]);
    await flush();
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["notice", "agy carried on while idle"],
      ["text_delta", "Woke up."],
      ["text_delta", "\n\nok"],
      ["result", ""],
    ]);
  });

  it("puts the panel's MCP answer on the call, as agy's update carries none", async () => {
    const { s, events } = session();
    s.setPanelTools({
      instructions: "Be brief.",
      tools: [{ name: "report", description: "", shape: {}, handler: () => Promise.resolve("") }],
    });
    void s.send("go");
    await flush();
    expect(fake.sent("session/new")[0]).toMatchObject({
      mcpServers: [{ name: "panel" }],
      _meta: { antigravity: { systemPrompt: { append: "Be brief." } } },
    });
    const call = {
      sessionUpdate: "tool_call",
      toolCallId: "m1",
      name: "mcp_panel_report",
      args: { text: "hi", toolSummary: "Report" },
      status: "in_progress",
    };
    fake.update(user("go"));
    fake.update(call);
    // The same tool answered for other arguments first (a call agy runs
    // alongside), then for this call's.
    s.noteToolAnswer("report", { text: "other" }, "Other.", false);
    s.noteToolAnswer("report", { text: "hi", toolSummary: "Report" }, "Reported.", false);
    fake.update({ ...call, sessionUpdate: "tool_call_update", status: "completed" });
    const use = events.find((e) => e.kind === "tool_use");
    expect(use?.toolName).toBe("mcp__panel__report");
    expect(use?.content).not.toContain("toolSummary");
    expect(events.find((e) => e.kind === "tool_result")).toMatchObject({
      toolUseId: "m1",
      content: "Reported.",
    });
  });

  it("drops a stopped process's open calls and panel answers: the next turn sends none to the background", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.update(user("go"));
    fake.update(command("c1", "sleep 30", "in_progress"));
    s.noteToolAnswer("report", {}, "Refused.", true);
    s.abort();
    await flush();
    void s.send("next");
    await flush();
    const call = {
      sessionUpdate: "tool_call",
      toolCallId: "m1",
      name: "mcp_panel_report",
      status: "in_progress",
    };
    fake.update(user("next"));
    fake.update(call);
    s.noteToolAnswer("report", {}, "Reported.", false);
    fake.update({ ...call, sessionUpdate: "tool_call_update", status: "completed" });
    fake.turn([agent("ok")]);
    await flush();
    expect(s.runState).toBe("idle");
    expect(s.backgroundTaskList).toEqual([]);
    expect(events.filter((e) => e.kind === "tool_result").map((e) => e.content)).toEqual([
      "(stopped)",
      "Reported.",
    ]);
  });

  it("closes a background command that ended before the load after its turn", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), command("c1", "sleep 1", "in_progress"), agent("started")]);
    fake.stored = [user("go"), command("c1", "sleep 1", "completed", "x"), agent("started")];
    await flush();
    expect(s.runState).toBe("idle");
    expect(events.find((e) => e.kind === "subagent_done")?.subagent?.status).toBe("completed");
  });

  it("shows a later wake-up's text agy streams before the prompt's echo, after one a load showed, once", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), agent("one")]);
    await flush();
    fake.stored.push(agent("First wake."));
    s.checkIdle();
    await flush();
    void s.send("two");
    await flush();
    events.length = 0;
    fake.turn([agent("First "), agent("wake."), agent("Second wake."), user("two"), agent("ok")]);
    // As agy stores it: each message once, whole.
    fake.stored = [
      user("go"),
      agent("one"),
      agent("First wake."),
      agent("Second wake."),
      user("two"),
      agent("ok"),
    ];
    await flush();
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["notice", "agy carried on while idle"],
      ["text_delta", "Second wake."],
      ["text_delta", "\n\nok"],
      ["result", ""],
    ]);
  });

  it("closes the turn's open calls when agy exits mid-turn", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.update(user("go"));
    fake.update(command("c2", "make", "in_progress"));
    fake.exit();
    await flush();
    expect(events.map((e) => e.kind)).toEqual(["tool_use", "tool_result", "error"]);
    expect(events[1]).toMatchObject({ toolUseId: "c2", content: "(stopped)", isError: true });
  });

  it("keeps a session id only from the process it still talks to", async () => {
    const { s } = session();
    let answer: (v: unknown) => void = () => {};
    fake.handlers["session/new"] = () => new Promise((r) => (answer = r));
    void s.send("go");
    await flush();
    const first = answer;
    s.abort();
    fake.handlers["session/new"] = () => ({ sessionId: "s1", configOptions: [] });
    void s.send("again");
    await flush();
    first({ sessionId: "stale", configOptions: [] });
    await flush();
    expect(s.sessionId).toBe("s1");
  });

  it("does not let a load left on a stopped process take a new process's replay", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), agent("a")]);
    await flush();
    // A load agy never answers before it is stopped.
    const load = fake.handlers["session/load"];
    let stuck: () => void = () => {};
    fake.handlers["session/load"] = () => {
      fake.handlers["session/load"] = load;
      return new Promise<unknown>((r) => (stuck = () => r({})));
    };
    s.checkIdle();
    await flush();
    s.abort();
    fake.handlers["session/resume"] = () => {
      throw new Error("Failed to read session s1; retry, or load it with session/load");
    };
    const replayed = fake.holdNextLoad();
    void s.send("next");
    await flush();
    stuck();
    await flush();
    replayed();
    await flush();
    expect(events.filter((e) => e.kind === "notice")).toEqual([]);
    expect(fake.sent("session/prompt")).toHaveLength(2);
  });

  it("loads before a prompt while a background command may have ended unseen", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), command("c1", "sleep 5", "in_progress"), agent("started")]);
    fake.stored = [command("c1", "sleep 5", "in_progress"), user("go"), agent("started")];
    await flush();
    // It ended and agy replied; no load has seen it when the next message comes.
    fake.stored = [user("go"), command("c1", "sleep 5", "completed", "x"), agent("started")];
    fake.stored.push(agent("It finished."));
    events.length = 0;
    void s.send("next");
    await flush();
    fake.turn([user("next"), agent("ok")]);
    await flush();
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["tool_result", "x"],
      ["subagent_done", "x"],
      ["notice", "`sleep 5` finished"],
      ["text_delta", "It finished."],
      ["text_delta", "\n\nok"],
      ["result", ""],
    ]);
  });

  it("shows what agy stored during a turn past the turn's own reply, after it", async () => {
    const { s, events } = session();
    void s.send("one");
    await flush();
    fake.turn([user("one"), agent("a")]);
    await flush();
    void s.send("two");
    await flush();
    events.length = 0;
    fake.turn([user("two"), agent("he"), agent("re")]);
    // agy's own turn, going on meanwhile, replied after the prompt's.
    fake.stored = [user("one"), agent("a"), user("two"), agent("here"), agent("woken")];
    await flush();
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["text_delta", "he"],
      ["text_delta", "re"],
      ["result", ""],
      ["notice", "agy carried on by itself"],
      ["text_delta", "woken"],
      ["result", ""],
    ]);
  });

  it("closes a background card once a load no longer lists its command", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), command("c1", "sleep 99", "in_progress"), agent("started")]);
    fake.stored = [command("c1", "sleep 99", "in_progress"), user("go"), agent("started")];
    await flush();
    expect(s.runState).toBe("waiting");
    fake.stored = [user("Summary of the conversation so far.")];
    s.checkIdle();
    await flush();
    expect(s.runState).toBe("idle");
    expect(events.find((e) => e.kind === "subagent_done")?.subagent?.status).toBe("failed");
  });

  it("takes the reply to a slash command agy does not echo for the reply", async () => {
    const { s, events } = session();
    void s.send("/goal finish it");
    await flush();
    fake.turn([agent("Goal set.")]);
    await flush();
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["text_delta", "Goal set."],
      ["result", ""],
    ]);
  });

  it("stops a background command's card by ending the process group agy runs it in", async () => {
    // This process stands in for agy: each command is its child leading a
    // process group of its own, as `bash -c` or, for a lone command, what
    // bash execed in its place.
    AgySession.hooks = { ...AgySession.hooks, transport: () => fake.transport(process.pid) };
    const run = (line: string) => {
      const child = spawn("bash", ["-c", line], { detached: true, stdio: "ignore" });
      return {
        child,
        exited: new Promise<string | null>((r) => child.on("exit", (_c, sig) => r(sig))),
      };
    };
    const lone = run("sleep 31");
    await new Promise((r) => setTimeout(r, 50));
    const list = run("sleep 33 && echo late");
    const { s } = session();
    void s.send("go");
    await flush();
    fake.turn([
      user("go"),
      command("c1", "sleep 31", "in_progress"),
      command("c2", "sleep 33 && echo late", "in_progress"),
      agent("started"),
    ]);
    await flush();
    try {
      await s.stopTask("c1");
      expect(await lone.exited).toBe("SIGTERM");
      expect(list.child.exitCode).toBeNull();
      await s.stopTask("c2");
      expect(await list.exited).toBe("SIGTERM");
      await expect(s.stopTask("nope")).rejects.toThrow("No such command");
    } finally {
      lone.child.kill();
      list.child.kill();
    }
  });

  it("starts a message sent during a turn with no copy of that turn's reply", async () => {
    const { s, events } = session();
    void s.send("one");
    await flush();
    fake.turn([user("one"), agent("first reply")]);
    // The queue sends the next message while the load after the turn runs.
    const release = fake.holdNextLoad();
    await new Promise((r) => setImmediate(r));
    void s.send("two");
    await flush();
    release();
    await flush();
    fake.turn([user("two"), agent("second")]);
    await flush();
    expect(events.filter((e) => e.kind === "text_delta").map((e) => e.content)).toEqual([
      "first reply",
      "second",
    ]);
    expect(events.some((e) => e.kind === "notice")).toBe(false);
  });

  it("takes Stop during the load before the prompt: no prompt goes out", async () => {
    const { s, events } = session();
    void s.send("one");
    await flush();
    fake.turn([user("one"), agent("a")]);
    await flush();
    s.logActivity();
    const release = fake.holdNextLoad();
    void s.send("two");
    await flush();
    expect(await s.interrupt()).toBe(true);
    release();
    await flush();
    expect(fake.sent("session/prompt")).toHaveLength(1);
    expect(fake.sent("session/cancel")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "result", interrupted: true });
    expect(s.interruptPending).toBe(false);
  });

  it("loads before a prompt only when agy may have worked since the last load", async () => {
    const { s } = session();
    const loads = () => fake.sent("session/load").length;
    void s.send("one");
    await flush();
    fake.turn([user("one"), agent("a")]);
    await flush();
    expect(loads()).toBe(1);
    // Nothing since the load after that turn: the prompt goes out at once.
    void s.send("two");
    await flush();
    expect(loads()).toBe(1);
    fake.turn([user("two"), agent("b")]);
    await flush();
    expect(loads()).toBe(2);
    // agy's log showed a model call while idle.
    s.logActivity();
    void s.send("three");
    await flush();
    expect(loads()).toBe(3);
    fake.turn([user("three"), agent("c")]);
    await flush();
    // That load cleared it.
    void s.send("four");
    await flush();
    expect(loads()).toBe(4);
  });

  it("shows what agy streams before the prompt's echo once, when no load came before it", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), agent("one")]);
    await flush();
    // agy carried on unseen (its log told nothing): the next prompt's stream
    // starts with that, as agy streams a backlog.
    void s.send("two");
    await flush();
    events.length = 0;
    const idle = command(
      "c9",
      "ls",
      "completed",
      "Command exited with code 0.\n\nCommand output:\na.txt\r\n",
    );
    fake.turn([idle, agent("Woke up."), user("two"), agent("ok")]);
    fake.stored = [user("go"), agent("one"), idle, agent("Woke up."), user("two"), agent("ok")];
    await flush();
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["notice", "agy carried on while idle"],
      ["tool_use", "**Bash**\n```bash\nls\n```"],
      ["tool_result", "a.txt"],
      ["text_delta", "Woke up."],
      ["text_delta", "\n\nok"],
      ["result", ""],
    ]);
  });

  it("loads before a prompt while a panel call agy made while idle is open", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), agent("one")]);
    await flush();
    const call = {
      sessionUpdate: "tool_call",
      toolCallId: "m1",
      name: "mcp_panel_report",
      args: { text: "built" },
      status: "in_progress",
    };
    fake.stored.push(call);
    s.checkIdle();
    await flush();
    s.noteToolAnswer("report", { text: "built" }, "Reported to the lead.", false);
    fake.stored = [user("go"), agent("one"), { ...call, status: "completed" }];
    void s.send("two");
    await flush();
    expect(fake.sent("session/load")).toHaveLength(3);
    expect(events.find((e) => e.kind === "tool_result")).toMatchObject({
      toolUseId: "m1",
      content: "Reported to the lead.",
    });
  });

  it("loads before a prompt when the load after the last turn failed", async () => {
    const { s, events } = session();
    void s.send("one");
    await flush();
    fake.turn([user("one"), agent("a")]);
    await flush();
    void s.send("two");
    await flush();
    const load = fake.handlers["session/load"];
    fake.handlers["session/load"] = () => {
      fake.handlers["session/load"] = load;
      throw new Error("busy");
    };
    fake.turn([user("two"), agent("second reply")]);
    await flush();
    void s.send("three");
    await flush();
    fake.turn([user("three"), agent("third")]);
    await flush();
    expect(events.some((e) => e.kind === "notice")).toBe(false);
    expect(events.filter((e) => e.content === "second reply")).toHaveLength(1);
  });

  it("switches agy's model and thought level before the next prompt, and only then", async () => {
    const { s } = session();
    void s.send("one");
    await flush();
    fake.turn([user("one"), agent("a")]);
    await flush();
    void s.send("two");
    await flush();
    fake.turn([user("two"), agent("b")]);
    await flush();
    expect(fake.sent("session/set_config_option")).toHaveLength(2);
    s.setModel("agy/gemini-4-hydrogen", "xhigh");
    void s.send("three");
    await flush();
    expect(
      fake
        .sent("session/set_config_option")
        .slice(2)
        .map((p) => [p.configId, p.value]),
    ).toEqual([
      ["model", "gemini-4-hydrogen"],
      ["thought_level", "xhigh"],
    ]);
  });
});

describe("AgySession while idle, on real timers", () => {
  const saved = { ...IDLE_TIMINGS };
  let log = "";
  beforeEach(() => {
    Object.assign(IDLE_TIMINGS, { settleMs: 150, followUpMs: 200, pollMs: 250 });
    AgySession.hooks = {
      transport: (_s, args) => {
        log = args[args.indexOf("--log-file") + 1];
        fs.writeFileSync(log, "");
        return fake.transport();
      },
      mcpServer: () => ({ name: "panel", command: "node", args: [], env: [] }),
    };
  });
  afterEach(() => {
    Object.assign(IDLE_TIMINGS, saved);
    fs.rmSync(log, { force: true });
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond: () => boolean, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await sleep(10);
    }
  };
  const loads = () => fake.sent("session/load").length;
  const modelCall = () =>
    fs.appendFileSync(
      log,
      "I1113 04:00:00.000000 1 http_helpers.go:658] URL: https://x/v1internal:streamGenerateContent?alt=sse\n",
    );

  it("loads once agy's log shows a model call while idle and has been quiet", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), agent("a")]);
    await until(() => loads() === 1);
    // Nothing runs in the background: no polling.
    await sleep(400);
    expect(loads()).toBe(1);
    fake.stored.push(agent("Scheduled check done."));
    modelCall();
    await sleep(30);
    modelCall();
    expect(loads()).toBe(1);
    await until(() => loads() === 2);
    expect(events.filter((e) => e.kind === "notice").map((e) => e.content)).toEqual([
      "agy carried on by itself",
    ]);
    expect(events.some((e) => e.content === "Scheduled check done.")).toBe(true);
    s.abort();
  });

  it("keeps looking for agy's reply to a background command's end for a while", async () => {
    const { s, events } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), command("c1", "sleep 5", "in_progress"), agent("started")]);
    fake.stored = [command("c1", "sleep 5", "in_progress"), user("go"), agent("started")];
    await until(() => loads() === 1);
    fake.stored = [user("go"), command("c1", "sleep 5", "completed", "x"), agent("started")];
    modelCall();
    await until(() => s.runState === "idle");
    // The reply is stored well after the command's end was seen.
    await sleep(300);
    fake.stored.push(agent("It is done."));
    await until(() => events.some((e) => e.content === "It is done."));
    s.abort();
  });

  it("polls while a background command runs, and stops once it ended", async () => {
    const { s } = session();
    void s.send("go");
    await flush();
    fake.turn([user("go"), command("c1", "sleep 5", "in_progress"), agent("started")]);
    fake.stored = [command("c1", "sleep 5", "in_progress"), user("go"), agent("started")];
    await until(() => loads() >= 3);
    fake.stored = [user("go"), command("c1", "sleep 5", "completed", "x"), agent("started")];
    await until(() => s.runState === "idle");
    // A few follow-ups wait for agy's reply to it, then nothing more.
    await sleep(1_600);
    const settled = loads();
    await sleep(600);
    expect(loads()).toBe(settled);
    s.abort();
  });
});
