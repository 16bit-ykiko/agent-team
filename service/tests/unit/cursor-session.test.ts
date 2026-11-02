import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import type { AgentOptions, RunResult, SDKCustomTool, SendOptions } from "@cursor/sdk";
import { CursorSession, type CursorSdk } from "../../src/session/cursor";
import type { StreamEvent } from "../../src/session/claude";
import type { PanelToolset } from "../../src/project/tools";
import { backendForModel, cursorModel, supportsFastMode } from "../../src/config/presets";

// A stand-in SDK: each create/resume and send is recorded; a run ends when
// the test finishes it.
function fakeSdk() {
  const calls: Array<{ op: string; id?: string; options?: Partial<AgentOptions> }> = [];
  const sends: Array<{ prompt: string; options: SendOptions }> = [];
  type Ending = Pick<RunResult, "status"> & Partial<RunResult>;
  const runs: Array<{ finish(r: Ending): void; cancelled: number }> = [];
  const closed: string[] = [];
  let created = 0;
  const agent = (agentId: string) => ({
    agentId,
    [Symbol.asyncDispose]: () => {
      closed.push(agentId);
      return Promise.resolve();
    },
    send: (prompt: string, options: SendOptions) => {
      sends.push({ prompt, options });
      let finish!: (r: Ending) => void;
      const done = new Promise<RunResult>((r) => (finish = (x) => r({ id: "run", ...x })));
      const run = {
        finish,
        cancelled: 0,
      };
      runs.push(run);
      return Promise.resolve({
        id: "run",
        wait: () => done,
        cancel: () => {
          run.cancelled++;
          finish({ status: "cancelled" });
          return Promise.resolve();
        },
      });
    },
  });
  const sdk = {
    Agent: {
      create: (options: AgentOptions) => {
        calls.push({ op: "create", options });
        return Promise.resolve(agent(`agent-${++created}`));
      },
      resume: (id: string, options?: Partial<AgentOptions>) => {
        calls.push({ op: "resume", id, options });
        return Promise.resolve(agent(id));
      },
    },
  } as unknown as CursorSdk;
  return { sdk, calls, sends, runs, closed };
}

const tick = () => new Promise((r) => setImmediate(r));

function makeSession(model = "cursor/composer-2.5") {
  const session = new CursorSession({
    cwd: "/tmp/w",
    backend: "cursor",
    model,
    providerEnv: { CURSOR_API_KEY: "key-1" },
  });
  const events: StreamEvent[] = [];
  session.on("event", (e: StreamEvent) => events.push(e));
  return { session, events };
}

let fake: ReturnType<typeof fakeSdk>;
beforeEach(() => {
  fake = fakeSdk();
  CursorSession.sdk = fake.sdk;
});
afterEach(() => {
  CursorSession.sdk = null;
});

describe("cursor models", () => {
  it("are their own backend by the cursor/ prefix, even with an id Claude has too", () => {
    expect(backendForModel("cursor/composer-2.5")).toBe("cursor");
    expect(backendForModel("cursor/claude-opus-5-5")).toBe("cursor");
    expect(backendForModel("claude-opus-5-5")).toBe("claude");
  });

  it("send effort and fast mode as the model's parameters, effort defaulting to the catalog's", () => {
    expect(cursorModel("cursor/composer-2.5", undefined, undefined)).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "false" }],
    });
    expect(cursorModel("cursor/grok-4.7", undefined, true)).toEqual({
      id: "grok-4.7",
      params: [
        { id: "reasoning_effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
    expect(cursorModel("cursor/kimi-k3", "low", undefined)).toEqual({
      id: "kimi-k3",
      params: [{ id: "reasoning", value: "low" }],
    });
    expect(cursorModel("cursor/unlisted-1", "high", true)).toEqual({ id: "unlisted-1" });
    expect(supportsFastMode("cursor/composer-2.5")).toBe(true);
    expect(supportsFastMode("cursor/gemini-4-argon")).toBe(false);
  });
});

describe("cursor session", () => {
  it("creates the agent once with full access, and a restored session resumes it", async () => {
    const { session } = makeSession();
    const first = session.send("one");
    await tick();
    fake.runs[0].finish({ status: "finished", result: "1" });
    await first;
    const second = session.send("two");
    await tick();
    fake.runs[1].finish({ status: "finished", result: "2" });
    await second;
    expect(fake.calls.map((c) => c.op)).toEqual(["create"]);
    expect(fake.calls[0].options).toMatchObject({
      apiKey: "key-1",
      model: { id: "composer-2.5" },
      local: { cwd: "/tmp/w", sandboxOptions: { enabled: false }, autoReview: false },
    });
    expect(session.sessionId).toBe("agent-1");

    const restored = CursorSession.fromState(session.getState());
    const third = restored.send("three");
    await tick();
    fake.runs[2].finish({ status: "finished" });
    await third;
    expect(fake.calls.at(-1)).toMatchObject({ op: "resume", id: "agent-1" });
  });

  it("sends the model selection with every message, so /effort and /fast apply next turn", async () => {
    const { session } = makeSession("cursor/grok-4.7");
    session.setEffort("xhigh");
    session.setFastMode(true);
    const sent = session.send("go");
    await tick();
    fake.runs[0].finish({ status: "finished" });
    await sent;
    expect(fake.sends[0].options.model).toEqual({
      id: "grok-4.7",
      params: [
        { id: "reasoning_effort", value: "xhigh" },
        { id: "fast", value: "true" },
      ],
    });
  });

  it("sends nothing when stopped while its agent was still being created", async () => {
    const { session, events } = makeSession();
    const sent = session.send("long");
    expect(await session.interrupt()).toBe(true);
    await sent;
    expect(fake.sends).toHaveLength(0);
    expect(events).toEqual([{ kind: "result", content: "", interrupted: true }]);
    expect(session.isRunning).toBe(false);
  });

  it("cancels a run stopped once it is running", async () => {
    const { session, events } = makeSession();
    const sent = session.send("long");
    await tick();
    expect(await session.interrupt()).toBe(true);
    await sent;
    expect(fake.runs[0].cancelled).toBe(1);
    expect(events.at(-1)).toMatchObject({ kind: "result", interrupted: true });
  });

  it("reports nothing for an aborted run, and cancels it or never starts it", async () => {
    const { session, events } = makeSession();
    const starting = session.send("x");
    session.abort();
    await starting;
    expect(fake.sends).toHaveLength(0);
    const running = session.send("y");
    await tick();
    session.abort();
    await running;
    expect(fake.runs[0].cancelled).toBe(1);
    expect(events).toEqual([]);
    expect(session.isRunning).toBe(false);
  });

  it("names a usage limit and a missing key", async () => {
    const { session, events } = makeSession();
    const sent = session.send("x");
    await tick();
    fake.runs[0].finish({ status: "error", error: { message: "Usage limit exceeded" } });
    await sent;
    expect(events.at(-1)).toMatchObject({ kind: "error" });

    fake.sdk.Agent.create = () =>
      Promise.reject(Object.assign(new Error("Usage limit exceeded"), { name: "RateLimitError" }));
    const other = makeSession();
    await other.session.send("y");
    expect(other.events.at(-1)?.content).toBe("Cursor usage limit: Usage limit exceeded");

    const keyless = new CursorSession({ cwd: "/tmp", backend: "cursor", model: "cursor/x" });
    const seen: StreamEvent[] = [];
    keyless.on("event", (e: StreamEvent) => seen.push(e));
    const env = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      await keyless.send("z");
    } finally {
      if (env !== undefined) process.env.CURSOR_API_KEY = env;
    }
    expect(seen.at(-1)?.content).toContain("[cursor] api_key");
  });

  it("forgets an agent the store no longer has, so the next message starts fresh", async () => {
    const { session, events } = makeSession();
    session.sessionId = "agent-gone";
    fake.sdk.Agent.resume = () =>
      Promise.reject(
        Object.assign(new Error("Agent not found"), {
          name: "AgentNotFoundError",
          code: "agent_not_found",
        }),
      );
    await session.send("x");
    expect(events.at(-1)?.kind).toBe("error");
    expect(session.sessionId).toBeNull();
  });
});

describe("cursor session lifecycle", () => {
  // A deferred SDK call: the test decides when it settles.
  function gate<T>() {
    let open!: (v: T) => void;
    const promise = new Promise<T>((r) => (open = r));
    return { promise, open };
  }

  it("forces every send, so a run a crashed server left active cannot wedge the agent", async () => {
    const { session } = makeSession();
    const sent = session.send("x");
    await tick();
    fake.runs[0].finish({ status: "finished" });
    await sent;
    expect(fake.sends[0].options.local).toMatchObject({ force: true });
  });

  it("keeps the agent through a credential refresh with the same key, even mid-run", async () => {
    const { session } = makeSession();
    const sent = session.send("x");
    await tick();
    session.setProviderEnv({ CURSOR_API_KEY: "key-1" });
    expect(fake.closed).toEqual([]);
    session.setProviderEnv({ CURSOR_API_KEY: "key-2" });
    // A new key waits for the run to end.
    expect(fake.closed).toEqual([]);
    fake.runs[0].finish({ status: "finished" });
    await sent;
    expect(fake.closed).toEqual(["agent-1"]);
  });

  it("waits for its run when the panel tools go away while the run starts", async () => {
    const { session, events } = makeSession();
    session.setPanelTools({ instructions: "lead", tools: [] });
    const sending = gate<void>();
    const send = fake.sdk.Agent.create.bind(fake.sdk.Agent);
    fake.sdk.Agent.create = async (o) => {
      const agent = await send(o);
      const real = agent.send.bind(agent);
      agent.send = async (p, opts) => {
        await sending.promise;
        return real(p, opts);
      };
      return agent;
    };
    const sent = session.send("x");
    await tick();
    session.setPanelTools(null);
    sending.open();
    await tick();
    expect(session.isRunning).toBe(true);
    fake.runs[0].finish({ status: "finished", result: "ok" });
    await sent;
    expect(events.map((e) => e.kind)).toEqual(["result"]);
  });

  it("drops a stopped run's late updates instead of putting them in the next turn", async () => {
    const { session, events } = makeSession();
    const first = session.send("one");
    await tick();
    const late = fake.sends[0].options.onDelta!;
    fake.runs[0].finish({ status: "finished" });
    await first;
    const second = session.send("two");
    await tick();
    void late({ update: { type: "text-delta", text: "from run one" } });
    fake.runs[1].finish({ status: "finished" });
    await second;
    expect(events.filter((e) => e.kind === "text_delta")).toEqual([]);
  });

  it("closes an agent whose creation an abort overtook, once it exists", async () => {
    const created = gate<void>();
    const create = fake.sdk.Agent.create.bind(fake.sdk.Agent);
    fake.sdk.Agent.create = async (o) => {
      await created.promise;
      return create(o);
    };
    const { session, events } = makeSession();
    const sent = session.send("x");
    await tick();
    session.abort();
    created.open();
    await sent;
    expect(fake.sends).toHaveLength(0);
    expect(fake.closed).toEqual(["agent-1"]);
    expect(events).toEqual([]);
  });

  it("keeps a thought that Stop cut short", async () => {
    const { session, events } = makeSession();
    const sent = session.send("x");
    await tick();
    await fake.sends[0].options.onDelta!({ update: { type: "thinking-delta", text: "Half a" } });
    await session.interrupt();
    await sent;
    expect(events.map((e) => [e.kind, e.content])).toEqual([
      ["thinking_delta", "Half a"],
      ["thinking", "Half a"],
      ["result", ""],
    ]);
  });

  it("starts a new paragraph after a thought that streamed no text", async () => {
    const { session, events } = makeSession();
    const sent = session.send("x");
    await tick();
    const { onDelta } = fake.sends[0].options;
    await onDelta!({ update: { type: "text-delta", text: "First." } });
    await onDelta!({ update: { type: "thinking-completed", thinkingDurationMs: 5 } });
    await onDelta!({ update: { type: "text-delta", text: "Second." } });
    fake.runs[0].finish({ status: "finished" });
    await sent;
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => e.content)
      .join("");
    expect(text).toBe("First.\n\nSecond.");
  });
});

describe("panel tools on a cursor agent", () => {
  const handled: unknown[] = [];
  const tools: PanelToolset = {
    instructions: "You are a lead.",
    tools: [
      {
        name: "read_session",
        description: "Read a session.",
        shape: { session_id: z.string(), last: z.number().int().optional() },
        handler: (args) => {
          handled.push(args);
          if (args.session_id === "bad") throw new Error("No session bad");
          return Promise.resolve("read");
        },
      },
      {
        name: "finish_task",
        description: "Finish.",
        shape: { summary: z.string() },
        handler: () => Promise.resolve("done"),
        subagentRefusal: "Only the session itself finishes its task.",
      },
    ],
  };

  async function sendWithTools(session: CursorSession, prompt: string, n: number) {
    const sent = session.send(prompt);
    await tick();
    fake.runs[n].finish({ status: "finished" });
    await sent;
    return fake.sends[n];
  }

  it("go with each run as custom tools, checked and answered here", async () => {
    const { session } = makeSession();
    session.setPanelTools(tools);
    const { options } = await sendWithTools(session, "hi", 0);
    const custom = options.local!.customTools as Record<string, SDKCustomTool>;
    expect(Object.keys(custom)).toEqual(["read_session", "finish_task"]);
    expect(custom.read_session.inputSchema).toMatchObject({
      type: "object",
      properties: { session_id: { type: "string" }, last: { type: "integer" } },
      required: ["session_id"],
    });
    expect(custom.read_session.inputSchema).not.toHaveProperty("$schema");
    const main = { sessionId: "agent-1" };
    expect(await custom.read_session.execute({ session_id: "ws-1" }, main)).toBe("read");
    expect(await custom.read_session.execute({ session_id: "bad" }, main)).toEqual({
      content: [{ type: "text", text: "No session bad" }],
      isError: true,
    });
    const invalid = (await custom.read_session.execute({ last: "3" }, main)) as {
      isError: boolean;
    };
    expect(invalid.isError).toBe(true);
    expect(handled).toEqual([{ session_id: "ws-1" }, { session_id: "bad" }]);
    expect(await custom.finish_task.execute({ summary: "s" }, { sessionId: "sub-1" })).toEqual({
      content: [{ type: "text", text: "Only the session itself finishes its task." }],
      isError: true,
    });
    expect(await custom.finish_task.execute({ summary: "s" }, main)).toBe("done");
  });

  it("send instructions changed while a prompt was being sent with the next one", async () => {
    let release!: () => void;
    const sending = new Promise<void>((r) => (release = r));
    const create = fake.sdk.Agent.create.bind(fake.sdk.Agent);
    fake.sdk.Agent.create = async (o) => {
      const agent = await create(o);
      const real = agent.send.bind(agent);
      agent.send = async (p, opts) => {
        const run = real(p, opts);
        await sending;
        return run;
      };
      return agent;
    };
    const { session } = makeSession();
    session.setPanelTools(tools);
    const sent = session.send("one");
    await tick();
    session.setPanelTools({ ...tools, instructions: "You are a worker." });
    release();
    await tick();
    fake.runs[0].finish({ status: "finished" });
    await sent;
    expect(fake.sends[0].prompt).toContain("You are a lead.");
    expect((await sendWithTools(session, "two", 1)).prompt).toContain("You are a worker.");
  });

  it("are not given again to the same agent after a restart", async () => {
    const { session } = makeSession();
    session.setPanelTools(tools);
    await sendWithTools(session, "one", 0);
    const restored = CursorSession.fromState(session.getState());
    restored.setPanelTools(tools);
    expect((await sendWithTools(restored, "two", 1)).prompt).toBe("two");
    restored.abort();
    restored.sessionId = null;
    expect((await sendWithTools(restored, "three", 2)).prompt).toContain("You are a lead.");
  });

  it("send the instructions with the first prompt, and again only once they change", async () => {
    const { session } = makeSession();
    session.setPanelTools(tools);
    expect((await sendWithTools(session, "one", 0)).prompt).toBe(
      "<panel_instructions>\nYou are a lead.\n</panel_instructions>\n\none",
    );
    expect((await sendWithTools(session, "two", 1)).prompt).toBe("two");
    session.setPanelTools({ ...tools, instructions: "You are a worker." });
    expect((await sendWithTools(session, "three", 2)).prompt).toContain("You are a worker.");
  });
});
