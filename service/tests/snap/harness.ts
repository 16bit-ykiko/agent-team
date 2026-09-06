// Snap fixtures: a scripted interaction with a real backend, recorded once
// (scripts/capture-sdk.ts) and replayed here through the real session,
// workspace and client aggregation. One fixture = <name>.ts (script, intent,
// assertions) + <name>.jsonl (recording) + <name>.snap.md (pinned transcript).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Codex, ThreadEvent } from "@openai/codex-sdk";
import { ClaudeSession, type StreamEvent } from "../../src/claude-session";
import { CodexSession } from "../../src/codex-session";
import type { ContextUsage } from "../../src/claude-session";
import { LocalHost, HostRegistry, type HostSessionHandle } from "../../src/host";
import { Workspace, type Message, type WorkspaceCallbacks } from "../../src/task";
import { backendForModel } from "../../src/presets";
import { applyEventsToMessage } from "../../../webview/src/stream";

import {
  type Backend,
  type Entry,
  type Fixture,
  type Header,
  type Recording,
  type Replay as BaseReplay,
  DEFAULT_MODEL,
  RECORD_CWD,
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
  ws.addAgent("A", model, "🤖", "#888", { backend: backendForModel(model) });
  return { ws, host };
}

// A server restart: the process is gone and the session comes back from
// its persisted state, exactly as Workspace.fromState rebuilds it.
function restart(ws: Workspace, host: SnapHost): void {
  const attach = (
    ws as unknown as {
      attachSession(id: string, s: HostSessionHandle): (e: StreamEvent) => void;
    }
  ).attachSession.bind(ws);
  for (const [id, entry] of ws.agents) {
    const session = host.restoreSession(id, entry.session.getState());
    host.created.push(session);
    entry.handler = attach(id, session);
    entry.session = session;
  }
}

export async function replay(backend: Backend, rec: Recording): Promise<Replay> {
  const model = rec.header.model || DEFAULT_MODEL[backend];
  const { ws, host } = makeWorkspace(model);
  const events: StreamEvent[] = [];
  const states: string[] = [];
  const seen = new Set<HostSessionHandle>();
  const attach = () => {
    for (const s of host.created) {
      if (seen.has(s)) continue;
      seen.add(s);
      s.on("event", (e: StreamEvent) => events.push(JSON.parse(JSON.stringify(e)) as StreamEvent));
      s.on("runState", (st: string) => states.push(st));
    }
  };

  const live = { feeder: null as Feeder<unknown> | null };
  const rollouts = new Map<string, ContextUsage>();
  const base = Date.now();
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
  } else {
    const thread = {
      runStreamed: () => {
        const feeder = new Feeder<unknown>();
        live.feeder = feeder;
        return Promise.resolve({ events: feeder.iterable() as AsyncIterable<ThreadEvent> });
      },
    };
    CodexSession.hooks = {
      codex: () => ({ startThread: () => thread, resumeThread: () => thread }) as unknown as Codex,
      readContext: (id) => rollouts.get(id),
    };
  }

  let pending: Promise<void> | null = null;
  try {
    for (const [i, e] of rec.entries.entries()) {
      at(e.t);
      if ("step" in e && e.step.op === "send" && backend === "codex") {
        // Codex writes the turn's token_count to the rollout before
        // turn.completed; the recorder only reads it after the stream
        // closed, so make it visible for the whole turn.
        const next = rec.entries.slice(i + 1).find((x) => "rollout" in x);
        if (next && "rollout" in next)
          rollouts.set(next.rollout.threadId, {
            tokens: next.rollout.tokens,
            window: next.rollout.window,
          });
      }
      if ("step" in e) {
        if (e.step.op === "send") {
          pending = ws.sendMessage(e.step.text);
          // Claude's send resolves once the query is up; codex's only when
          // the turn's stream closes.
          if (backend === "claude") await pending;
          await flush();
          attach();
        } else if (e.step.op === "end") {
          live.feeder?.end();
          await flush();
          restart(ws, host);
        } else if (e.step.op === "abort") {
          for (const s of host.created) s.abort();
          await flush();
        }
      } else if ("frame" in e) {
        live.feeder?.push(e.frame);
        await flush();
      } else if ("error" in e) {
        live.feeder?.fail(new Error(e.error));
        await flush();
      } else if ("close" in e) {
        live.feeder?.end();
        await flush();
        if (backend === "codex" && pending) await pending;
      } else if ("rollout" in e) {
        rollouts.set(e.rollout.threadId, { tokens: e.rollout.tokens, window: e.rollout.window });
      }
    }
    await flush();
  } finally {
    ClaudeSession.sdk = null;
    CodexSession.hooks = null;
  }
  return { messages: ws.messages, events, states, sessions: host.created };
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
        out.push(`${indent}card ${label} ${sa.status ?? "?"} ${q(sa.prompt ?? sa.description)}`);
        renderEvents(sa.events ?? [], indent + "  ", out);
        if (sa.summary) out.push(`${indent}  summary ${q(sa.summary)}`);
        continue;
      }
      case "tool_use": {
        const result = e.toolResult != null ? ` → ${q(e.toolResult, 80)}` : " → (pending)";
        out.push(`${indent}tool ${e.toolName ?? "?"} ${q(e.content)}${result}`);
        continue;
      }
      case "tool_result":
        out.push(`${indent}orphan tool_result ${q(e.content, 80)}`);
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
    const meta = [m.kind, m.status, m.context && `ctx ${m.context.tokens}/${m.context.window}`]
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
  for (const e of events) {
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
      // message_done follows with the server's final events, which no
      // longer carry a retry banner once the retried call succeeded.
      cur.events = cur.events!.filter((x) => x.kind !== "retry");
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
