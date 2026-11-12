// Snap fixtures: a scripted interaction with a real backend, recorded once
// (scripts/capture-sdk.ts) and replayed here through the real session,
// workspace and client aggregation. One fixture = <name>.ts (script, intent,
// assertions) + <name>.jsonl (recording) + <name>.snap.md (pinned transcript).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, type StreamEvent } from "../../src/session/claude";
import { CodexSession } from "../../src/session/codex";
import type { RpcMessage, Transport } from "../../src/session/codex-rpc";
import { CursorSession, type CursorSdk } from "../../src/session/cursor";
import { AgySession } from "../../src/session/agy";
import { LocalHost, HostRegistry, type HostSessionHandle } from "../../src/session/host";
import type { PanelToolset } from "../../src/project/tools";
import { Workspace, type Message, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import { backendForModel } from "../../src/config/presets";
import { applyEventsToMessage } from "../../../webview/src/state/stream";

import {
  type Backend,
  type Entry,
  type Fixture,
  type Header,
  type Recording,
  type Replay as BaseReplay,
  DEFAULT_MODEL,
  RECORD_CWD,
  RECORD_EFFORT,
  panelTools,
  tapeTrim,
} from "./fixture.ts";

export * from "./fixture.ts";

export const SNAP_DIR = path.dirname(fileURLToPath(import.meta.url));

export function recordingPath(backend: Backend, name: string): string {
  return path.join(SNAP_DIR, backend, `${name}.jsonl`);
}

export function readRecording(file: string): Recording {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const header = (JSON.parse(lines[0]) as { header: Header }).header;
  const entries = lines.slice(1).map((l) => JSON.parse(l) as Entry);
  return { header, entries };
}

export function writeRecording(file: string, header: Header, entries: Entry[]): void {
  const out = [JSON.stringify({ header }), ...entries.map((e) => JSON.stringify(e))];
  fs.writeFileSync(file, out.join("\n") + "\n");
}

export function listFixtures(backend: Backend): string[] {
  const dir = path.join(SNAP_DIR, backend);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -3))
    .sort();
}

export async function loadFixture(backend: Backend, name: string): Promise<Fixture> {
  const mod = (await import(path.join(SNAP_DIR, backend, `${name}.ts`))) as { default: Fixture };
  return mod.default;
}

// --- replay -----------------------------------------------------------------

export interface Replay extends BaseReplay {
  sessions: HostSessionHandle[];
}

// Hands recorded frames to the session's for-await loop one at a time.
class Feeder<T> {
  private queue: T[] = [];
  private waiting: {
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  } | null = null;
  private done = false;
  private failure: unknown = null;

  next(): Promise<IteratorResult<T>> {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
    if (this.failure)
      return Promise.reject(
        this.failure instanceof Error ? this.failure : new Error(JSON.stringify(this.failure)),
      );
    if (this.done) return Promise.resolve({ value: undefined as T, done: true });
    return new Promise((resolve, reject) => (this.waiting = { resolve, reject }));
  }
  push(v: T): void {
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w.resolve({ value: v, done: false });
    } else this.queue.push(v);
  }
  end(): void {
    this.done = true;
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w.resolve({ value: undefined as T, done: true });
    }
  }
  fail(e: unknown): void {
    this.failure = e;
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w.reject(e);
    }
  }
  iterable(): AsyncIterable<T> {
    return { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) };
  }
}

// Let the session's async loop consume what was pushed.
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

// A codex or agy recording's backend, one connection per process the
// recorder started. Each line the recorder wrote is the next one the session must
// write: the same method (an answer to a server request: the same id) and
// the same thread and turn ids; the recorded responses go back under the
// session's request ids. Nothing else may be written.
class AppServerPlayer {
  private conn: {
    listeners: Array<(m: RpcMessage) => void>;
    closers: Array<(r: string) => void>;
  } | null = null;
  private written: RpcMessage[] = [];
  private ids = new Map<number | string, number | string>();
  // The recorder's steer tags and the session's, which codex echoes back
  // as a userMessage's clientId.
  private tags = new Map<unknown, unknown>();
  sent: RpcMessage[] = [];

  // agy: the requests' parameters must be the recorder's too, but for the
  // panel MCP server's command (its socket path is the recording's).
  constructor(private strict = false) {}

  connect(): Transport {
    const conn = {
      listeners: [] as Array<(m: RpcMessage) => void>,
      closers: [] as Array<(r: string) => void>,
    };
    this.conn = conn;
    return {
      write: (m) => {
        if (this.conn !== conn) return;
        this.written.push(m);
        this.sent.push(m);
      },
      onMessage: (cb) => conn.listeners.push(cb),
      onClose: (cb) => conn.closers.push(cb),
      close: () => {},
    };
  }

  // The recorder wrote `rec`: the session's next line must be its like.
  async expect(rec: RpcMessage, where: string): Promise<void> {
    // The session may write it from a timer (the queue moves on a setTimeout).
    for (let i = 0; i < 40 && this.written.length === 0; i++) {
      await flush();
      if (i >= 10) await new Promise((r) => setTimeout(r, 2));
    }
    const m = this.written.shift();
    const what = (x: RpcMessage | undefined) =>
      !x ? "nothing" : (x.method ?? `the answer to request ${String(x.id)}`);
    const same = m && (rec.method ? m.method === rec.method : !m.method && m.id === rec.id);
    if (!same) {
      throw new Error(
        `replay: the session wrote ${what(m)} where the recorder wrote ${what(rec)} (${where}); re-record if the session's requests changed`,
      );
    }
    const ids = (x: RpcMessage) => {
      const p = (x.params ?? {}) as Record<string, unknown>;
      return [p.threadId, p.turnId, p.expectedTurnId, p.sessionId];
    };
    expect(ids(m), `ids of ${what(m)} (${where})`).toEqual(ids(rec));
    if (this.strict && rec.method) {
      const params = (x: RpcMessage) => {
        const p = tapeTrim(JSON.parse(JSON.stringify(x.params ?? {}))) as Record<string, unknown>;
        if (Array.isArray(p.mcpServers)) {
          p.mcpServers = p.mcpServers.map((s: { name?: string }) => ({ name: s.name }));
        }
        return p;
      };
      expect(params(m), `params of ${what(m)} (${where})`).toEqual(params(rec));
    }
    if (rec.method && rec.id != null && m.id != null) this.ids.set(rec.id, m.id);
    const tag = (x: RpcMessage) =>
      (x.params as { clientUserMessageId?: unknown })?.clientUserMessageId;
    if (tag(rec) !== undefined) this.tags.set(tag(rec), tag(m));
  }

  // The recording is over: the session wrote nothing the recorder did not.
  finish(): void {
    expect(
      this.written.map((m) => m.method ?? `answer ${String(m.id)}`),
      "unrecorded writes",
    ).toEqual([]);
  }

  play(frame: RpcMessage): void {
    let m =
      !frame.method && frame.id != null
        ? { ...frame, id: this.ids.get(frame.id) ?? frame.id }
        : frame;
    const params = m.params as { item?: { clientId?: unknown } } | undefined;
    const clientId = params?.item?.clientId;
    if (clientId != null && this.tags.has(clientId)) {
      m = {
        ...m,
        params: { ...params, item: { ...params!.item, clientId: this.tags.get(clientId) } },
      };
    }
    for (const cb of this.conn?.listeners ?? []) cb(m);
  }

  close(): void {
    const conn = this.conn;
    this.conn = null;
    for (const cb of conn?.closers ?? []) cb("the backend exited (recording)");
  }
}

class SnapHost extends LocalHost {
  created: HostSessionHandle[] = [];
  createSession(agentId: string, config: Parameters<LocalHost["createSession"]>[1]) {
    const s = super.createSession(agentId, config);
    this.created.push(s);
    return s;
  }
}

function makeWorkspace(model: string) {
  const host = new SnapHost("local", "Local");
  const registry = new HostRegistry();
  registry.register(host);
  const cb: WorkspaceCallbacks = {
    onNewMessage: () => {},
    onStreamEvent: () => {},
    onMessageDone: () => {},
  };
  const ws = new Workspace("ws", "t", "p", "local", RECORD_CWD, registry, cb);
  const backend = backendForModel(model);
  // The recording's agent stands in for the SDK, so no real key is read.
  const providerEnv = backend === "cursor" ? { CURSOR_API_KEY: "replay" } : undefined;
  ws.addAgent("A", model, "🤖", "#888", { backend, providerEnv, effort: RECORD_EFFORT[backend] });
  return { ws, host };
}

// A server restart: the process is gone and the session comes back from
// its persisted state, exactly as Workspace.fromState rebuilds it (and the
// project manager gives it its tools again).
function restart(ws: Workspace, host: SnapHost, tools: PanelToolset | null): void {
  const attach = (
    ws as unknown as {
      attachSession(id: string, s: HostSessionHandle): (e: StreamEvent) => void;
    }
  ).attachSession.bind(ws);
  for (const [id, entry] of ws.agents) {
    const session = host.restoreSession(id, entry.session.getState());
    session.setPanelTools?.(tools);
    host.created.push(session);
    entry.handler = attach(id, session);
    entry.session = session;
  }
}

export async function replay(backend: Backend, rec: Recording, fixture: Fixture): Promise<Replay> {
  const model = rec.header.model || DEFAULT_MODEL[backend];
  const { ws, host } = makeWorkspace(model);
  const tools = fixture.tools ? panelTools(fixture.tools, fixture.instructions) : null;
  for (const entry of ws.agents.values()) entry.session.setPanelTools?.(tools);
  const events: StreamEvent[] = [];
  const states: string[] = [];
  const limits: Replay["limits"] = [];
  const seen = new Set<HostSessionHandle>();
  const attach = () => {
    for (const s of host.created) {
      if (seen.has(s)) continue;
      seen.add(s);
      s.on("event", (e: StreamEvent) => events.push(JSON.parse(JSON.stringify(e)) as StreamEvent));
      s.on("runState", (st: string) => states.push(st));
      s.on("rateLimit", (info: Replay["limits"][number]) => limits.push(info));
      // Where the workspace starts the reply to a steered message.
      s.on("steered", () => events.push({ kind: "steered" as StreamEvent["kind"], content: "" }));
    }
  };

  const live = { feeder: null as Feeder<unknown> | null };
  const player = new AppServerPlayer(backend === "agy");
  if (backend === "agy" && rec.entries.some((e) => "error" in e)) {
    throw new Error(
      `the recording of ${rec.header.fixture} failed (it has an error entry): re-record it`,
    );
  }
  const cursor = new CursorPlayer();
  // The recording's own clock, so times in the transcript (wake-ups) are
  // the same on every run. recordedAt is stamped when the capture ends.
  const end = rec.entries.at(-1)?.t ?? 0;
  const base = (Date.parse(rec.header.recordedAt) || Date.now()) - end;
  const at = (t: number) => {
    if (vi.isFakeTimers()) vi.setSystemTime(base + t);
  };

  if (backend === "claude") {
    ClaudeSession.sdk = {
      query: () => {
        const feeder = new Feeder<unknown>();
        live.feeder = feeder;
        const it = feeder.iterable() as AsyncIterable<SDKMessage>;
        const q = {
          [Symbol.asyncIterator]: () => it[Symbol.asyncIterator](),
          close: () => feeder.end(),
          supportedCommands: () => Promise.resolve([]),
          stopTask: () => Promise.resolve(),
          getContextUsage: () => Promise.resolve(null),
          interrupt: () => Promise.resolve(),
        };
        return q as unknown as Query;
      },
    };
  } else if (backend === "cursor") {
    CursorSession.sdk = cursor.sdk;
  } else if (backend === "agy") {
    AgySession.hooks = {
      transport: (session) => {
        if (!host.created.includes(session)) throw new Error("a session from another replay");
        return player.connect();
      },
      mcpServer: () => ({ name: "panel", command: "node", args: [], env: [] }),
      idleTimers: false,
    };
  } else {
    // Only this replay's sessions: one a failed replay left behind must not
    // write into the next one's recording.
    CodexSession.hooks = {
      transport: (session) => {
        if (!host.created.includes(session)) throw new Error("a session from another replay");
        return player.connect();
      },
    };
  }

  // The user's controls, as the panel sends them: Stop (the turn only) and a
  // background task's own stop. Applied at their step, when the request went
  // out: frames the CLI sent before acknowledging it come after.
  const control = async (c: Extract<Entry, { control: unknown }>["control"]) => {
    if (c.error) return;
    if (c.op === "interrupt") await ws.interruptAll();
    if (c.op === "stop_task" && c.taskId) ws.cancelSubagent([...ws.agents.keys()][0], c.taskId);
    await flush();
  };
  let pending: Promise<void> | null = null;
  try {
    if (backend === "codex" || backend === "agy") {
      await replayRpc(rec, ws, host, player, tools, at, attach);
      return {
        messages: ws.messages,
        events,
        states,
        limits,
        sessions: host.created,
        sent: player.sent,
        sdkCalls: [],
        sends: [],
      };
    }
    for (const [i, e] of rec.entries.entries()) {
      at(e.t);
      if ("step" in e) {
        if (e.step.op === "send") {
          pending = ws.sendMessage(e.step.text);
          // Claude's send resolves once the query is up, cursor's only
          // when its run has ended.
          if (backend === "claude") await pending;
          await flush();
          attach();
        } else if (e.step.op === "end") {
          live.feeder?.end();
          await flush();
          restart(ws, host, null);
        } else if (e.step.op === "abort") {
          for (const s of host.created) s.abort();
          await flush();
        } else if (e.step.op === "interrupt" || e.step.op === "stopTask") {
          const next = rec.entries.slice(i + 1).find((x) => "control" in x || "step" in x);
          if (next && "control" in next) await control(next.control);
        }
      } else if ("frame" in e) {
        if (backend === "cursor") cursor.play(e.frame as Record<string, unknown>);
        else live.feeder?.push(e.frame);
        await flush();
        // The queue moves on a timer after a turn ends: a message it sends
        // reaches the CLI before the next turn's frames, as it did live.
        if ((e.frame as { type?: string }).type === "result") {
          await new Promise((r) => setTimeout(r, 2));
          await flush();
        }
      } else if ("error" in e) {
        live.feeder?.fail(new Error(e.error));
        await flush();
      } else if ("close" in e) {
        live.feeder?.end();
        await flush();
        if (pending) await pending;
      }
    }
    await flush();
  } finally {
    // A wake-up still pending when the recording ends must not be sent once
    // its time comes: through the real SDK, or the next replay's player.
    for (const s of host.created) s.removeAllListeners("wakeDue");
    ClaudeSession.sdk = null;
    CodexSession.hooks = null;
    CursorSession.sdk = null;
    AgySession.hooks = null;
  }
  return {
    messages: ws.messages,
    events,
    states,
    limits,
    sessions: host.created,
    sent: [],
    sdkCalls: cursor.calls.filter((c) => c !== "wait"),
    sends: cursor.sends,
  };
}

// Plays a cursor recording to the session: each SDK call it makes waits for
// the frame that answered it (created/resumed, run, result) or threw, and a
// frame answers only the call that produced it in the recording.
class CursorPlayer {
  readonly calls: string[] = [];
  readonly sends: Array<{ model?: unknown; local?: Record<string, unknown> }> = [];
  private pending: Partial<
    Record<
      "agent" | "run" | "wait",
      { op: string; resolve(v: unknown): void; reject(e: unknown): void }
    >
  > = {};
  private onDelta: ((args: { update: never }) => unknown) | undefined;

  private call<T>(slot: "agent" | "run" | "wait", op: string): Promise<T> {
    this.calls.push(op);
    return new Promise<T>((resolve, reject) => {
      this.pending[slot] = { op, resolve, reject };
    });
  }

  private settle(slot: "agent" | "run" | "wait", value: unknown, failed = false): void {
    const p = this.pending[slot];
    delete this.pending[slot];
    if (failed) p?.reject(value);
    else p?.resolve(value);
  }

  readonly sdk: CursorSdk = {
    Agent: {
      create: () => this.call("agent", "create"),
      resume: (id: string) => this.call("agent", `resume ${id}`),
    },
  };

  private agent(agentId: string) {
    return {
      agentId,
      [Symbol.asyncDispose]: () => Promise.resolve(),
      send: (
        _message: unknown,
        options?: {
          model?: unknown;
          local?: Record<string, unknown>;
          onDelta?: (args: { update: never }) => unknown;
        },
      ) => {
        this.onDelta = options?.onDelta;
        const { customTools: _, ...local } = options?.local ?? {};
        this.sends.push({ model: options?.model, local });
        return this.call("run", "send");
      },
    };
  }

  private run(id: string) {
    return {
      id,
      wait: () => this.call("wait", "wait"),
      cancel: () => {
        this.calls.push("cancel");
        return Promise.resolve();
      },
    };
  }

  play(frame: Record<string, unknown>): void {
    const [source] = Object.keys(frame);
    const v = frame[source] as Record<string, unknown>;
    switch (source) {
      case "created":
      case "resumed": {
        const asked = this.pending.agent?.op;
        const recorded = source === "created" ? "create" : `resume ${v.agentId as string}`;
        if (asked !== recorded) {
          this.settle("agent", new Error(`recorded ${recorded}, the session asked ${asked}`), true);
          return;
        }
        return this.settle("agent", this.agent(v.agentId as string));
      }
      case "run":
        return this.settle("run", this.run(v.id as string));
      case "delta":
        void this.onDelta?.({ update: v as never });
        return;
      case "result":
        return this.settle("wait", v);
      case "thrown": {
        const error = Object.assign(new Error(v.message as string), v);
        const slot = v.where === "send" ? "run" : v.where === "wait" ? "wait" : "agent";
        return this.settle(slot, error, true);
      }
    }
  }
}

// A codex or agy recording through the workspace: each step as the panel
// takes it, without waiting on what it starts (the answers are later lines).
// An agy session's look at what agy did while idle comes where the recorder's
// did: its timers do not run here.
async function replayRpc(
  rec: Recording,
  ws: Workspace,
  host: SnapHost,
  player: AppServerPlayer,
  tools: PanelToolset | null,
  at: (t: number) => void,
  attach: () => void,
): Promise<void> {
  const running: Promise<unknown>[] = [];
  for (const [i, e] of rec.entries.entries()) {
    at(e.t);
    if ("step" in e) {
      const op = e.step.op;
      if (op === "send" && !e.step.requeued) running.push(ws.sendMessage(e.step.text));
      else if (op === "compact") running.push(ws.sendMessage("/compact"));
      else if (op === "interrupt" || op === "abort") running.push(ws.interruptAll());
      else if (op === "end") restart(ws, host, tools);
      await flush();
      attach();
    } else if ("sent" in e) {
      await player.expect(e.sent as RpcMessage, `entry ${i + 1}`);
    } else if ("frame" in e) {
      player.play(e.frame as RpcMessage);
      await flush();
    } else if ("close" in e) {
      player.close();
      await flush();
    } else if ("control" in e && (e.control.op === "idleCheck" || e.control.op === "toolAnswer")) {
      const session = host.created.at(-1);
      if (!(session instanceof AgySession)) throw new Error(`${e.control.op} outside agy`);
      if (e.control.op === "idleCheck") session.checkIdle();
      else {
        const answer = e.control.response as { args: unknown; text: string; isError: boolean };
        session.noteToolAnswer(e.control.taskId ?? "", answer.args, answer.text, answer.isError);
      }
      await flush();
    }
  }
  await Promise.all(running);
  await flush();
  player.finish();
}

// --- transcript -------------------------------------------------------------

const q = (s: string | undefined, max = 100): string => {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return JSON.stringify(one.length > max ? one.slice(0, max) + "…" : one);
};

function renderEvents(events: StreamEvent[], indent: string, out: string[]): void {
  for (const e of events) {
    switch (e.kind) {
      case "subagent_progress":
      case "subagent_done":
        // Folded into their start by the aggregation.
        continue;
      case "subagent_start": {
        const sa = e.subagent!;
        const label = [sa.agentType, sa.taskType].filter(Boolean).join("/");
        const ran = sa.durationMs != null ? ` ${sa.durationMs}ms` : "";
        out.push(
          `${indent}card ${label} ${sa.status ?? "?"}${ran} ${q(sa.prompt ?? sa.description)}`,
        );
        renderEvents(sa.events ?? [], indent + "  ", out);
        if (sa.summary) out.push(`${indent}  summary ${q(sa.summary)}`);
        continue;
      }
      case "tool_use": {
        const result =
          e.toolResult == null
            ? " → (pending)"
            : ` → ${e.toolResultIsError ? "error " : ""}${q(e.toolResult, 80)}`;
        const took = e.durationMs != null ? ` ${e.durationMs}ms` : "";
        out.push(`${indent}tool ${e.toolName ?? "?"} ${q(e.content)}${result}${took}`);
        continue;
      }
      case "tool_result":
        out.push(`${indent}orphan tool_result ${e.isError ? "error " : ""}${q(e.content, 80)}`);
        continue;
      case "notice":
        out.push(`${indent}notice:${e.level ?? "info"} ${q(e.content)}`);
        continue;
      case "text":
      case "text_delta":
      case "thinking_delta":
        continue;
      default:
        out.push(`${indent}${e.kind} ${q(e.content, 80)}`);
    }
  }
}

export function transcript(messages: Message[]): string {
  const out: string[] = [];
  messages.forEach((m, i) => {
    const meta = [
      m.kind,
      m.status,
      m.context && `ctx ${m.context.tokens}/${m.context.window}`,
      m.thinking && `thought ${m.thinking.tokens} tokens`,
    ]
      .filter(Boolean)
      .join(" ");
    out.push(`## ${i + 1} ${meta}`);
    if (m.content) out.push(`  text ${q(m.content, 200)}`);
    renderEvents(m.events ?? [], "  ", out);
  });
  return out.join("\n") + "\n";
}

// --- client convergence -----------------------------------------------------

type ClientMessage = Parameters<typeof applyEventsToMessage>[0];

// The client rebuilds the transcript from broadcast events; it must match
// what the workspace built server-side.
export function clientView(events: StreamEvent[]): Message[] {
  const msgs: ClientMessage[] = [];
  let cur: ClientMessage | null = null;
  // The reply an error finished; the turn's result has nothing left to end.
  let failed = false;
  for (const e of events) {
    if (e.kind === "text") continue;
    if (e.kind === "result" && !cur && failed) {
      failed = false;
      continue;
    }
    failed = false;
    // The workspace settled the reply and opened one under the steered
    // message; the client learns that from the messages themselves.
    if ((e.kind as string) === "steered") {
      if (cur) cur.status = "done";
      cur = null;
      continue;
    }
    // A card update goes to the newest message holding the card, as the
    // workspace routes it; a resumed agent has a card in an older one too.
    const taskId = e.subagent?.taskId;
    const holds = (m: ClientMessage) =>
      m.events!.some((x) => x.kind === "subagent_start" && x.subagent?.taskId === taskId);
    const owner =
      taskId && (e.kind === "subagent_progress" || e.kind === "subagent_done")
        ? [...msgs].reverse().find(holds)
        : undefined;
    if (owner && owner !== cur) {
      msgs[msgs.indexOf(owner)] = applyEventsToMessage(owner, [e]);
      continue;
    }
    // A result for a call an earlier reply made, as the workspace routes it.
    const caller =
      e.kind === "tool_result" &&
      !cur?.events!.some((x) => x.kind === "tool_use" && x.toolUseId === e.toolUseId)
        ? [...msgs]
            .reverse()
            .find((m) =>
              m.events!.some((x) => x.kind === "tool_use" && x.toolUseId === e.toolUseId),
            )
        : undefined;
    if (caller) {
      msgs[msgs.indexOf(caller)] = applyEventsToMessage(caller, [e]);
      continue;
    }
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
      // message_done follows with the server's final events, which no
      // longer carry a retry banner once the retried call succeeded.
      cur.events = cur.events!.filter((x) => x.kind !== "retry");
      cur.status = "done";
      cur = null;
      continue;
    }
    const next = applyEventsToMessage(cur, [e]);
    msgs[msgs.indexOf(cur)] = next;
    // An error ends the reply, as the workspace finishes it.
    failed = e.kind === "error";
    cur = failed ? null : next;
  }
  return msgs as unknown as Message[];
}

export const strip = (m: Message): unknown =>
  JSON.parse(
    JSON.stringify(m.events, (k: string, v: unknown) =>
      k === "_innerEvent" || k === "contentOffset" || k === "step" || k === "toolInput"
        ? undefined
        : v,
    ),
  ) as unknown;
