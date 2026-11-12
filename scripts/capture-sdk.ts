// Record a snap fixture against the real backend: runs the fixture's steps
// (service/tests/snap/<backend>/<name>.ts) and writes the raw SDK frames,
// interleaved with step markers, to <name>.jsonl next to it.
//
// Usage: npm run capture -- <claude|codex|cursor|agy> <name...>
//
// Every run is a real session on the user's account. Bursts of sessions
// risk an account ban: at most a few fixtures per run, one at a time, with
// a pause between them. Never loop this.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Backend,
  type Entry,
  type Fixture,
  type Header,
  type Step,
  DEFAULT_MODEL,
  RECORD_CWD,
  RECORD_EFFORT,
  panelTools,
  tapeTrim,
} from "../service/tests/snap/fixture.ts";
import {
  AppServerClient,
  codexBinary,
  spawnAppServer,
  type Transport,
} from "../service/src/session/codex-rpc.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SNAP = path.join(ROOT, "service", "tests", "snap");
const PAUSE_MS = 30_000;
const MAX_PER_RUN = 4;
// A request can hang ~2 min before the CLI times it out and retries.
const STEP_DEADLINE_MS = 300_000;

const trim = tapeTrim;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Tape {
  entries: Entry[] = [];
  private t0 = Date.now();
  cli: string | undefined;
  add(e: Omit<Entry, "t">): void {
    this.entries.push({ t: Date.now() - this.t0, ...e } as Entry);
  }
  frame(f: unknown): void {
    this.add({ frame: trim(f) });
  }
}

interface Driver {
  send(text: string): Promise<void>;
  wait(until: "result" | "idle" | number | { frame: string }): Promise<void>;
  end(): Promise<void>;
  abort(): Promise<void>;
  interrupt(): Promise<void>;
  stopTask(match: { type?: string; ambient?: boolean }): Promise<void>;
  compact(): Promise<void>;
  cli(): string | undefined;
}

// --- claude -----------------------------------------------------------------

async function claudeDriver(
  tape: Tape,
  model: string,
  extra: Record<string, unknown> = {},
): Promise<Driver> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  type UserMsg = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;
  let sessionId: string | undefined;
  let cli: string | undefined;
  let active: {
    push(m: UserMsg): void;
    endInput(): void;
    abort: AbortController;
    finished: Promise<void>;
    ended: boolean;
    query: import("@anthropic-ai/claude-agent-sdk").Query;
  } | null = null;
  let results = 0;
  let bg = 0;
  let lastAt = Date.now();
  // Every task the CLI listed, latest last, for stopTask steps.
  const tasks: Array<{ id: string; type: string; ambient: boolean }> = [];
  const seen: string[] = [];

  const start = () => {
    // A new process runs none of the last one's background tasks; it may
    // only report them stopped (snap fixture claude/resume-orphan-bg).
    bg = 0;
    let resolve: ((r: IteratorResult<UserMsg>) => void) | null = null;
    const buffer: UserMsg[] = [];
    let done = false;
    const wake = (r: IteratorResult<UserMsg>) => {
      const fn = resolve;
      resolve = null;
      fn?.(r);
    };
    const input: AsyncIterable<UserMsg> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const head = buffer.shift();
          if (head) return Promise.resolve({ value: head, done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => (resolve = r));
        },
      }),
    };
    const abort = new AbortController();
    const q = query({
      prompt: input,
      options: {
        cwd: RECORD_CWD,
        model,
        abortController: abort,
        ...(sessionId && { resume: sessionId }),
        systemPrompt: { type: "preset", preset: "claude_code" },
        skills: "all",
        includePartialMessages: true,
        forwardSubagentText: true,
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        disallowedTools: ["AskUserQuestion", "CronCreate", "CronDelete", "CronList"],
        ...extra,
      },
    });
    const self = {
      push: (m: UserMsg) => (resolve ? wake({ value: m, done: false }) : buffer.push(m)),
      endInput: () => {
        done = true;
        wake({ value: undefined, done: true });
      },
      abort,
      ended: false,
      finished: Promise.resolve(),
      query: q,
    };
    self.finished = (async () => {
      try {
        for await (const msg of q) {
          lastAt = Date.now();
          tape.frame(msg);
          if ("session_id" in msg && msg.session_id) sessionId = msg.session_id;
          if (msg.type === "system" && msg.subtype === "init") cli = msg.claude_code_version;
          seen.push(JSON.stringify(msg));
          if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
            bg = msg.tasks.filter((t) => !t.ambient).length;
            for (const t of msg.tasks) {
              const task = t as { task_id: string; task_type?: string; ambient?: boolean };
              tasks.push({ id: task.task_id, type: task.task_type ?? "", ambient: !!task.ambient });
            }
          }
          if (msg.type === "result") results++;
        }
      } catch (e) {
        if (!self.ended) tape.add({ error: e instanceof Error ? e.message : String(e) });
      }
      tape.add({ close: true });
      active = null;
    })();
    return self;
  };

  return {
    async send(text) {
      active ??= start();
      results = 0;
      active.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
      await sleep(50);
    },
    async wait(until) {
      if (typeof until === "number") return sleep(until);
      const deadline = Date.now() + STEP_DEADLINE_MS;
      while (Date.now() < deadline) {
        if (typeof until === "object") {
          if (seen.some((f) => f.includes(until.frame))) return;
          await sleep(200);
          continue;
        }
        const quiet = Date.now() - lastAt;
        if (until === "result" && results > 0 && quiet > 300) return;
        if (until === "idle" && results > 0 && bg === 0 && quiet > 4000) return;
        await sleep(200);
      }
      throw new Error(`wait(${JSON.stringify(until)}) timed out`);
    },
    // `active` is cleared when the stream closes, which can happen while
    // these wait: hold on to the query they started with.
    async end() {
      const a = active;
      if (!a) return;
      a.ended = true;
      a.endInput();
      await sleep(500);
      a.abort.abort();
      await a.finished;
    },
    async abort() {
      const a = active;
      if (!a) return;
      a.ended = true;
      a.abort.abort();
      await a.finished;
    },
    async interrupt() {
      if (!active) return tape.add({ control: { op: "interrupt", error: "no query" } });
      try {
        tape.add({ control: { op: "interrupt", response: trim(await active.query.interrupt()) } });
      } catch (e) {
        tape.add({
          control: { op: "interrupt", error: e instanceof Error ? e.message : String(e) },
        });
      }
    },
    async stopTask(match) {
      const task = [...tasks]
        .reverse()
        .find(
          (t) =>
            (match.type === undefined || t.type === match.type) &&
            (match.ambient === undefined || t.ambient === match.ambient),
        );
      if (!active || !task) {
        return tape.add({
          control: { op: "stop_task", error: `no task matching ${JSON.stringify(match)}` },
        });
      }
      try {
        await active.query.stopTask(task.id);
        tape.add({ control: { op: "stop_task", taskId: task.id, response: "ok" } });
      } catch (e) {
        tape.add({
          control: {
            op: "stop_task",
            taskId: task.id,
            error: e instanceof Error ? e.message : String(e),
          },
        });
      }
    },
    compact: () => Promise.reject(new Error("claude fixtures compact by sending /compact")),
    cli: () => cli,
  };
}

// --- codex ------------------------------------------------------------------

// What a recording must not carry: the account's identity and the machine's.
const REDACT = new Set(["email", "accountId", "installationId", "serverName"]);
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = REDACT.has(k) ? "<redacted>" : redact(val);
    return o;
  }
  return v;
}

// The session's own connection to `codex app-server`, every line both ways
// on the tape.
function tapedAppServer(tape: Tape, args: string[], ended: () => boolean): Transport {
  const t = spawnAppServer({ cwd: RECORD_CWD, args });
  return {
    write: (m) => {
      tape.add({ sent: trim(m) });
      t.write(m);
    },
    onMessage: (cb) =>
      t.onMessage((m) => {
        tape.frame(redact(m));
        cb(m);
      }),
    onClose: (cb) =>
      t.onClose((reason) => {
        if (!ended()) tape.add({ error: reason });
        tape.add({ close: true });
        cb(reason);
      }),
    close: () => t.close(),
  };
}

function codexDriver(tape: Tape, model: string, fixture: Fixture, api?: { url: string }): Driver {
  const version = execFileSync(codexBinary(), ["--version"], { encoding: "utf-8" }).trim();
  // The stand-in is a provider of its own, whatever the user's config.toml
  // picks; the ChatGPT login still signs its requests.
  const args = api
    ? [
        "-c",
        'model_provider="capture"',
        "-c",
        `model_providers.capture={ name = "capture", base_url = "${api.url}", wire_api = "responses", requires_openai_auth = true, supports_websockets = false }`,
      ]
    : [];
  const tools = fixture.tools ?? [];
  const namespaces = new Map<string, typeof tools>();
  for (const t of tools) {
    if (!t.namespace) continue;
    namespaces.set(t.namespace, [...(namespaces.get(t.namespace) ?? []), t]);
  }
  const spec = (t: (typeof tools)[number]) => ({
    type: "function",
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  });
  const dynamicTools = [
    ...tools.filter((t) => !t.namespace).map(spec),
    ...[...namespaces].map(([name, ts]) => ({
      type: "namespace",
      name,
      description: `The ${name} tools.`,
      tools: ts.map(spec),
    })),
  ];

  let server: { client: AppServerClient; closed: Promise<void>; ended: boolean } | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let completed = 0;
  let steers = 0;
  let lastAt = Date.now();
  let seen: string[] = [];

  const onNotification = (method: string, p: Record<string, unknown>) => {
    lastAt = Date.now();
    seen.push(JSON.stringify({ method, params: p }));
    // A subagent's turns run on threads of their own.
    if (p.threadId !== threadId) return;
    if (method === "turn/started") turnId = (p.turn as { id: string }).id;
    if (method === "turn/completed") {
      turnId = null;
      completed++;
    }
  };
  const onRequest = (method: string, p: Record<string, unknown>): Promise<unknown> => {
    lastAt = Date.now();
    seen.push(JSON.stringify({ method, params: p }));
    if (method !== "item/tool/call") {
      return Promise.reject(new Error(`the recorder does not handle ${method}`));
    }
    const tool = tools.find(
      (t) => t.name === p.tool && (t.namespace ?? null) === (p.namespace ?? null),
    );
    return Promise.resolve({
      contentItems: [{ type: "inputText", text: tool?.reply ?? "unknown tool" }],
      success: tool ? (tool.success ?? true) : false,
    });
  };

  const ensure = async (): Promise<AppServerClient> => {
    if (server) return server.client;
    let close!: () => void;
    const s = {
      client: null as unknown as AppServerClient,
      closed: new Promise<void>((r) => (close = r)),
      ended: false,
    };
    s.client = new AppServerClient(
      tapedAppServer(tape, args, () => s.ended),
      {
        notification: onNotification,
        request: onRequest,
        close: () => {
          if (server === s) server = null;
          turnId = null;
          close();
        },
      },
    );
    server = s;
    await s.client.initialize();
    // What CodexSession sends, at the standard tier whatever config.toml says.
    const thread = {
      cwd: RECORD_CWD,
      model,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      serviceTier: "default",
      ...fixture.options,
    };
    const res = threadId
      ? await s.client.request<{ thread: { id: string } }>("thread/resume", {
          threadId,
          ...thread,
          excludeTurns: true,
        })
      : await s.client.request<{ thread: { id: string } }>("thread/start", {
          ...thread,
          ...(tools.length && {
            developerInstructions: "Panel tools of a recorded fixture.",
            dynamicTools,
          }),
        });
    threadId = res.thread.id;
    return s.client;
  };

  return {
    async send(text) {
      const client = await ensure();
      const input = [{ type: "text", text, text_elements: [] }];
      seen = [];
      if (turnId) {
        await client.request("turn/steer", {
          threadId,
          input,
          expectedTurnId: turnId,
          clientUserMessageId: `steer-${++steers}`,
        });
        return;
      }
      completed = 0;
      // Low effort at the standard tier, whatever config.toml says: a
      // recording needs the frames, not the model's best.
      const res = await client.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input,
        summary: "detailed",
        effort: "low",
        serviceTier: "default",
      });
      if (completed === 0) turnId = res.turn.id;
    },
    async wait(until) {
      if (typeof until === "number") return sleep(until);
      const deadline = Date.now() + STEP_DEADLINE_MS;
      while (Date.now() < deadline) {
        const quiet = Date.now() - lastAt;
        if (typeof until === "object" && seen.some((f) => f.includes(until.frame))) return;
        if (until === "result" && completed > 0 && !turnId && quiet > 300) return;
        if (until === "idle" && completed > 0 && !turnId && quiet > 4000) return;
        if (!server && typeof until !== "object") return;
        await sleep(200);
      }
      throw new Error(`wait(${JSON.stringify(until)}) timed out`);
    },
    async end() {
      const s = server;
      if (!s) return;
      s.ended = true;
      s.client.close();
      await s.closed;
    },
    async abort() {
      if (server && turnId) await server.client.request("turn/interrupt", { threadId, turnId });
    },
    async interrupt() {
      if (!server || !turnId) return tape.add({ control: { op: "interrupt", error: "no turn" } });
      await server.client.request("turn/interrupt", { threadId, turnId });
    },
    stopTask: () => Promise.reject(new Error("codex fixtures have no stopTask")),
    async compact() {
      const client = await ensure();
      completed = 0;
      await client.request("thread/compact/start", { threadId });
    },
    cli: () => version,
  };
}

// --- cursor -----------------------------------------------------------------

// Frames are tagged by where they came from: `delta` (onDelta), `step`
// (onStep), `message` (run.stream()), `status` (onDidChangeStatus), `result`
// (run.wait()), `tool` (a custom tool's execute), `thrown` (an SDK call that
// threw: create, resume, send, stream, wait, cancel).
async function cursorDriver(
  tape: Tape,
  model: string,
  extra: Record<string, unknown> = {},
): Promise<Driver> {
  const { Agent, Cursor } = await import("@cursor/sdk");
  const { AGENT_DEFAULTS } = await import("../service/src/session/cursor.ts");
  const { cursorModel } = await import("../service/src/config/presets.ts");
  type SDKAgent = import("@cursor/sdk").SDKAgent;
  type Run = import("@cursor/sdk").Run;
  type SDKCustomTool = import("@cursor/sdk").SDKCustomTool;
  const apiKey = fs.readFileSync(path.join(os.homedir(), ".cursor", "api_key.txt"), "utf8").trim();
  // The SDK runs in this process: fetch and https only use the proxy when
  // told to, and its HTTP/2 agent stream never does.
  http.setGlobalProxyFromEnv();
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    Cursor.configure({ local: { useHttp1ForAgent: true } });
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "node_modules", "@cursor", "sdk", "package.json"), "utf8"),
  ) as { version: string };
  const { local: extraLocal, ...extraRest } = extra as {
    local?: { customTools?: Record<string, SDKCustomTool> };
  };
  const customTools = Object.fromEntries(
    Object.entries(extraLocal?.customTools ?? {}).map(([name, t]) => [
      name,
      {
        ...t,
        execute: async (args: Parameters<SDKCustomTool["execute"]>[0], ctx) => {
          const result = await t.execute(args, ctx);
          tape.frame({ tool: { name, args, context: ctx, result } });
          return result;
        },
      } satisfies SDKCustomTool,
    ]),
  );
  const options = {
    ...AGENT_DEFAULTS,
    ...extraRest,
    apiKey,
    model: { id: model.replace(/^cursor\//, "") },
    local: { ...AGENT_DEFAULTS.local, ...extraLocal, cwd: RECORD_CWD, customTools },
  };
  const seen: string[] = [];
  const frame = (f: Record<string, unknown>) => {
    seen.push(JSON.stringify(f));
    tape.frame(f);
  };
  const thrown = (where: string, e: unknown) => {
    const err = e as { name?: string; code?: string; status?: number; isRetryable?: boolean };
    frame({
      thrown: {
        where,
        name: err?.name,
        code: err?.code,
        status: err?.status,
        isRetryable: err?.isRetryable,
        message: e instanceof Error ? e.message : String(e),
      },
    });
  };
  let agentId: string | null = null;
  let agent: SDKAgent | null = null;
  let run: Run | null = null;
  let finished: Promise<void> = Promise.resolve();

  const open = async (): Promise<SDKAgent | null> => {
    if (agent) return agent;
    try {
      agent = agentId ? await Agent.resume(agentId, options) : await Agent.create(options);
      frame({ [agentId ? "resumed" : "created"]: { agentId: agent.agentId } });
      agentId = agent.agentId;
      return agent;
    } catch (e) {
      thrown(agentId ? "resume" : "create", e);
      return null;
    }
  };

  return {
    async send(text) {
      const a = await open();
      if (!a) return;
      let r: Run;
      try {
        // As CursorSession sends: the model's parameters and force.
        r = await a.send(text, {
          model: cursorModel(model, undefined, undefined),
          local: { force: true },
          onDelta: ({ update }) => frame({ delta: update }),
          onStep: ({ step }) => frame({ step }),
        });
      } catch (e) {
        thrown("send", e);
        return;
      }
      run = r;
      frame({ run: { id: r.id, requestId: r.requestId, status: r.status } });
      r.onDidChangeStatus((status) => frame({ status }));
      finished = (async () => {
        try {
          for await (const message of r.stream()) frame({ message });
        } catch (e) {
          thrown("stream", e);
        }
        try {
          frame({ result: await r.wait() });
        } catch (e) {
          thrown("wait", e);
        }
        tape.add({ close: true });
      })();
    },
    async wait(until) {
      if (typeof until === "number") return sleep(until);
      if (typeof until === "object") {
        const deadline = Date.now() + STEP_DEADLINE_MS;
        while (Date.now() < deadline) {
          if (seen.some((f) => f.includes(until.frame))) return;
          await sleep(200);
        }
        throw new Error(`wait(${JSON.stringify(until)}) timed out`);
      }
      await finished;
    },
    // A server restart: the handle goes, the agent is resumed by id.
    async end() {
      await finished;
      agent?.close();
      agent = null;
    },
    async abort() {
      await run?.cancel();
      await finished;
      agent?.close();
      agent = null;
    },
    async interrupt() {
      if (!run) return tape.add({ control: { op: "interrupt", error: "no run" } });
      try {
        await run.cancel();
        tape.add({ control: { op: "interrupt", response: "ok" } });
      } catch (e) {
        thrown("cancel", e);
        tape.add({
          control: { op: "interrupt", error: e instanceof Error ? e.message : String(e) },
        });
      }
    },
    stopTask: () => Promise.reject(new Error("cursor has no background tasks to stop")),
    compact: () => Promise.reject(new Error("cursor compaction is not recorded")),
    cli: () => `@cursor/sdk ${pkg.version}`,
  };
}

// --- agy --------------------------------------------------------------------

// The server's own AgySession drives `agy acp`, so the recording holds the
// requests the replayed session must write: every line both ways, and each
// time the session looked at what agy did while idle (its log watch and
// timers fire it live; the replay calls it at these marks).
async function agyDriver(tape: Tape, model: string, fixture: Fixture): Promise<Driver> {
  const { AgySession } = await import("../service/src/session/agy.ts");
  const { agyBinary, spawnAgy } = await import("../service/src/session/acp.ts");
  const version = `agy ${execFileSync(agyBinary(), ["--version"], { encoding: "utf-8" }).trim()}`;
  let lastAt = Date.now();
  let results = 0;
  let closed: (() => void) | null = null;
  const seen: string[] = [];
  AgySession.hooks = {
    transport: (_session, args) => {
      const t = spawnAgy({ cwd: RECORD_CWD, args });
      return {
        write: (m) => {
          tape.add({ sent: trim(m) });
          t.write(m);
        },
        onMessage: (cb) =>
          t.onMessage((m) => {
            lastAt = Date.now();
            seen.push(JSON.stringify(m));
            tape.frame(redact(m));
            cb(m);
          }),
        onClose: (cb) =>
          t.onClose((reason) => {
            if (!closed) tape.add({ error: reason });
            tape.add({ close: true });
            closed?.();
            cb(reason);
          }),
        close: () => t.close(),
        pid: t.pid,
      };
    },
    onIdleCheck: () => tape.add({ control: { op: "idleCheck" } }),
    onToolAnswer: (tool, args, text, isError) =>
      tape.add({ control: { op: "toolAnswer", taskId: tool, response: { args, text, isError } } }),
  };
  const session = new AgySession({
    cwd: RECORD_CWD,
    backend: "agy",
    model,
    effort: RECORD_EFFORT.agy,
  });
  if (fixture.tools) session.setPanelTools(panelTools(fixture.tools, fixture.instructions));
  session.on("event", (e: { kind: string }) => {
    lastAt = Date.now();
    if (e.kind === "result" || e.kind === "error") results++;
  });
  const stop = async () => {
    const done = new Promise<void>((r) => (closed = r));
    session.abort();
    await Promise.race([done, sleep(10_000)]);
    closed = null;
  };
  return {
    async send(text) {
      results = 0;
      void session.send(text);
      await sleep(50);
    },
    async wait(until) {
      if (typeof until === "number") return sleep(until);
      const deadline = Date.now() + STEP_DEADLINE_MS;
      while (Date.now() < deadline) {
        const quiet = Date.now() - lastAt;
        if (typeof until === "object" && seen.some((f) => f.includes(until.frame))) return;
        if (until === "result" && results > 0 && !session.isRunning && quiet > 300) return;
        if (until === "idle" && results > 0 && session.runState === "idle" && quiet > 4000) return;
        await sleep(200);
      }
      throw new Error(`wait(${JSON.stringify(until)}) timed out`);
    },
    end: stop,
    async abort() {
      await session.interrupt();
    },
    async interrupt() {
      tape.add({ control: { op: "interrupt", response: await session.interrupt() } });
    },
    // The latest background command; the kill is outside the protocol, so
    // the replay sees only what agy reports of it.
    async stopTask() {
      const task = session.backgroundTaskList.at(-1);
      if (!task) return tape.add({ control: { op: "stop_task", error: "no background command" } });
      try {
        await session.stopTask(task.id);
        tape.add({ control: { op: "stop_task", taskId: task.id, response: "ok" } });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        tape.add({ control: { op: "stop_task", taskId: task.id, error } });
      }
    },
    compact: () => Promise.reject(new Error("agy fixtures compact by sending /compact")),
    cli: () => version,
  };
}

// --- local API stand-in ------------------------------------------------------

// Refuses every request as the five-hour limit does: a 429 with the unified
// rate-limit headers of a claude.ai subscription, resetting in half an hour.
async function usageLimitApi(): Promise<{ url: string; close(): void }> {
  const resetsAt = Math.ceil(Date.now() / 600_000) * 600 + 1800;
  const server = http.createServer((req, res) => {
    console.log(`api: ${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(429, {
        "content-type": "application/json",
        "request-id": `req_capture_${Date.now()}`,
        "x-should-retry": "false",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(resetsAt),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-utilization": "1.0",
        "anthropic-ratelimit-unified-5h-reset": String(resetsAt),
        "anthropic-ratelimit-unified-overage-status": "rejected",
        "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
      });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Rate limited" },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// Refuses every Responses request as a spent Codex limit does: a 429 whose
// body names usage_limit_reached, with the x-codex-* rate-limit headers
// (names from the codex binary; the body's fields are the documented ones,
// not seen from the real backend).
async function codexUsageLimitApi(): Promise<{ url: string; close(): void }> {
  const resetsAt = Math.ceil(Date.now() / 600_000) * 600 + 1800;
  const server = http.createServer((req, res) => {
    console.log(`api: ${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(429, {
        "content-type": "application/json",
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(resetsAt),
        "x-codex-secondary-used-percent": "41",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": String(resetsAt + 6 * 86400),
      });
      res.end(
        JSON.stringify({
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
            plan_type: "pro",
            resets_at: resetsAt,
            resets_in_seconds: resetsAt - Math.floor(Date.now() / 1000),
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// --- run --------------------------------------------------------------------

// agy writes in its folder unasked: it starts from an empty one.
function materialize(backend: Backend, files: Fixture["files"]): void {
  if (backend === "agy") fs.rmSync(RECORD_CWD, { recursive: true, force: true });
  fs.mkdirSync(RECORD_CWD, { recursive: true });
  for (const [rel, content] of Object.entries(files ?? {})) {
    const file = path.join(RECORD_CWD, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof content === "string") fs.writeFileSync(file, content);
    else fs.writeFileSync(file, Buffer.from(content.base64, "base64"));
  }
}

async function record(backend: Backend, name: string): Promise<void> {
  const file = path.join(SNAP, backend, `${name}.ts`);
  const fixture = ((await import(file)) as { default: Fixture }).default;
  const model = fixture.model ?? DEFAULT_MODEL[backend];
  materialize(backend, fixture.files);
  const tape = new Tape();
  const api =
    fixture.api !== "usage-limit"
      ? undefined
      : backend === "claude"
        ? await usageLimitApi()
        : await codexUsageLimitApi();
  const driver =
    backend === "claude"
      ? await claudeDriver(
          tape,
          model,
          api
            ? { ...fixture.options, env: { ...process.env, ANTHROPIC_BASE_URL: api.url } }
            : fixture.options,
        )
      : backend === "cursor"
        ? await cursorDriver(tape, model, fixture.options)
        : backend === "agy"
          ? await agyDriver(tape, model, fixture)
          : codexDriver(tape, model, fixture, api);
  const run = async (step: Step) => {
    switch (step.op) {
      case "send":
        return driver.send(step.text);
      case "wait":
        return driver.wait(step.for);
      case "end":
        return driver.end();
      case "abort":
        return driver.abort();
      case "interrupt":
        return driver.interrupt();
      case "stopTask":
        return driver.stopTask(step.match);
      case "compact":
        return driver.compact();
    }
  };
  // A failed run still leaves its tape (as <name>.failed.jsonl), so the
  // session it cost is not wasted.
  let failure: Error | undefined;
  try {
    for (const [i, step] of fixture.steps.entries()) {
      tape.add({ step: { i, ...step } });
      await run(step);
    }
  } catch (e) {
    failure = e instanceof Error ? e : new Error(JSON.stringify(e));
    tape.add({ error: failure.message });
  }
  try {
    await driver.end();
  } catch (e) {
    failure ??= e instanceof Error ? e : new Error(JSON.stringify(e));
    tape.add({ error: failure.message });
  }
  api?.close();
  const header: Header = {
    backend,
    fixture: name,
    description: fixture.description,
    model,
    cli: driver.cli(),
    recordedAt: new Date().toISOString(),
  };
  const out = path.join(SNAP, backend, failure ? `${name}.failed.jsonl` : `${name}.jsonl`);
  fs.writeFileSync(
    out,
    [JSON.stringify({ header }), ...tape.entries.map((e) => JSON.stringify(e))].join("\n") + "\n",
  );
  console.log(`${backend}/${name}: ${tape.entries.length} entries -> ${path.relative(ROOT, out)}`);
  if (failure) throw failure;
}

const [backend, ...names] = process.argv.slice(2);
if (!["claude", "codex", "cursor", "agy"].includes(backend) || names.length === 0) {
  console.error("usage: npm run capture -- <claude|codex|cursor|agy> <name...>");
  process.exit(2);
}
if (names.length > MAX_PER_RUN) {
  console.error(`too many fixtures (${names.length}); record at most ${MAX_PER_RUN} per run`);
  process.exit(2);
}
for (const [i, name] of names.entries()) {
  if (i > 0) {
    console.log(`pausing ${PAUSE_MS / 1000}s before ${name}`);
    await sleep(PAUSE_MS);
  }
  await record(backend as Backend, name);
}
process.exit(0);
