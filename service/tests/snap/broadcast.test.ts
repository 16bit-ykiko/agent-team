// Replays the recorded Claude fixtures through the real session and
// workspace, captures what index.ts broadcasts (new_message, stream_event,
// message_done + patch), and folds those frames with the client's own
// functions the way useServer does. Unlike snap.test.ts it compares whole
// messages (content, status, thinking stats) and the live thinking view.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, type StreamEvent } from "../../src/session/claude";
import { LocalHost, HostRegistry, type HostSessionHandle } from "../../src/session/host";
import { Workspace, type WorkspaceCallbacks } from "../../src/workspace/workspace";
import { summarizeMessages } from "../../src/workspace/summary";
import { readRecording, recordingPath, RECORD_CWD, DEFAULT_MODEL } from "./harness";
import {
  applyStreamBatch,
  mergeDetailEvents,
  withoutLiveThinking,
  type PendingEvent,
} from "../../../webview/src/state/stream";
import type { Message as ClientMessage } from "../../../webview/src/state/useServer";

const noSdk = {
  query: (): Query => {
    throw new Error("real Claude SDK reached from a unit test");
  },
};

class Feeder<T> {
  private queue: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private done = false;
  next(): Promise<IteratorResult<T>> {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
    if (this.done) return Promise.resolve({ value: undefined as T, done: true });
    return new Promise((resolve) => (this.waiting = resolve));
  }
  push(v: T): void {
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w({ value: v, done: false });
    } else this.queue.push(v);
  }
  end(): void {
    this.done = true;
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w({ value: undefined as T, done: true });
    }
  }
  iterable(): AsyncIterable<T> {
    return { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) };
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

function stripEventsInnerEvents(events: StreamEvent[]): StreamEvent[] {
  return events.map((e) => {
    if (!e.subagent?.events?.length) return e;
    return {
      ...e,
      subagent: { ...e.subagent, eventCount: e.subagent.events.length, events: undefined },
    };
  });
}

type Frame = Record<string, unknown> & { type: string; t: number };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function replayBroadcast(name: string) {
  const rec = readRecording(recordingPath("claude", name));
  const frames: Frame[] = [];
  let now = 0;
  const cb: WorkspaceCallbacks = {
    onNewMessage: (_ws, message) =>
      frames.push({ type: "new_message", t: now, message: clone(message) }),
    onStreamEvent: (_ws, msg, event) =>
      frames.push({ type: "stream_event", t: now, messageId: msg.id, event: clone(event) }),
    onMessageDone: (_ws, messageId, status, content, events, patch) =>
      frames.push({
        type: "message_done",
        t: now,
        messageId,
        status,
        content,
        events: events ? clone(stripEventsInnerEvents(events)) : undefined,
        ...clone(patch ?? {}),
      }),
  };
  const host = new LocalHost("local", "Local");
  const registry = new HostRegistry();
  registry.register(host);
  const ws = new Workspace("ws", "t", "p", "local", RECORD_CWD, registry, cb);
  const model = rec.header.model || DEFAULT_MODEL.claude;
  ws.addAgent("A", model, "🤖", "#888", { backend: "claude" });

  const live = { feeder: null as Feeder<unknown> | null };
  ClaudeSession.sdk = {
    query: () => {
      const feeder = new Feeder<unknown>();
      live.feeder = feeder;
      const it = feeder.iterable() as AsyncIterable<SDKMessage>;
      return {
        [Symbol.asyncIterator]: () => it[Symbol.asyncIterator](),
        close: () => feeder.end(),
        supportedCommands: () => Promise.resolve([]),
        stopTask: () => Promise.resolve(),
        getContextUsage: () => Promise.resolve(null),
        interrupt: () => Promise.resolve(),
      } as unknown as Query;
    },
  };
  const base = Date.now();
  for (const e of rec.entries) {
    now = e.t;
    vi.setSystemTime(base + e.t);
    if ("step" in e) {
      if (e.step.op === "send") {
        await ws.sendMessage(e.step.text);
        await flush();
      } else if (e.step.op === "end") {
        live.feeder?.end();
        await flush();
        const attach = (
          ws as unknown as {
            attachSession(id: string, s: HostSessionHandle): (e: StreamEvent) => void;
          }
        ).attachSession.bind(ws);
        for (const [id, entry] of ws.agents) {
          const session = host.restoreSession(id, entry.session.getState());
          entry.handler = attach(id, session);
          entry.session = session;
        }
      }
    } else if ("frame" in e) {
      live.feeder?.push(e.frame);
      await flush();
    } else if ("close" in e) {
      live.feeder?.end();
      await flush();
    }
  }
  await flush();
  // Let the setTimeout(dequeueNext) timers run.
  await new Promise((r) => setTimeout(r, 5));
  return { frames, messages: ws.messages };
}

interface LiveSpan {
  messageId: string;
  openedAt: number;
  closedAt: number | null;
  closedBy: string | null;
}

// Mirrors useServer: stream events wait for a flush; message_done flushes
// first, then replaces status/content/events and applies the stats patch.
function clientFold(frames: Frame[], mode: "each" | "hidden") {
  let msgs: ClientMessage[] = [];
  let pending: PendingEvent[] = [];
  const spans: LiveSpan[] = [];
  const open = new Map<string, LiveSpan>();
  const observe = (t: number, by: string) => {
    for (const m of msgs) {
      const o = open.get(m.id);
      if (m.liveThinking != null && !o) {
        const s = { messageId: m.id, openedAt: t, closedAt: null, closedBy: null };
        open.set(m.id, s);
        spans.push(s);
      } else if (m.liveThinking == null && o) {
        o.closedAt = t;
        o.closedBy = by;
        open.delete(m.id);
      }
    }
  };
  const flushPending = (t: number, by: string) => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    msgs = applyStreamBatch([{ id: "ws", messages: msgs }], batch)[0].messages;
    observe(t, by);
  };
  for (const f of frames) {
    if (f.type === "new_message") {
      msgs = [...msgs, f.message as ClientMessage];
    } else if (f.type === "stream_event") {
      pending.push({ wsId: "ws", messageId: f.messageId as string, event: f.event as never });
      if (mode === "each") flushPending(f.t, (f.event as StreamEvent).kind);
    } else if (f.type === "message_done") {
      flushPending(f.t, "flush-before-done");
      msgs = msgs.map((m) => {
        if (m.id !== f.messageId) return m;
        const events = f.events as ClientMessage["events"];
        const merged = events ? mergeDetailEvents(m.events, events) : undefined;
        return {
          ...withoutLiveThinking(m),
          status: f.status as ClientMessage["status"],
          content: f.content as string,
          ...(merged ? { events: merged } : {}),
          ...(f.context ? { context: f.context as ClientMessage["context"] } : {}),
          ...(f.effort ? { effort: f.effort as string } : {}),
          ...(f.thinking ? { thinking: f.thinking as ClientMessage["thinking"] } : {}),
        };
      });
      observe(f.t, "message_done");
    }
  }
  flushPending(Infinity, "end");
  return { msgs, spans };
}

const norm = (m: unknown) =>
  JSON.parse(
    JSON.stringify(m, (k: string, v: unknown) =>
      k === "_innerEvent" || k === "eventCount" ? undefined : v,
    ),
  ) as unknown;

const FIXTURES = ["bash-quick", "agent-bg", "resume-orphan-bg", "skill-tool"];

describe("broadcast parity", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    ClaudeSession.sdk = noSdk;
  });
  afterEach(() => {
    vi.useRealTimers();
    ClaudeSession.sdk = noSdk;
  });

  for (const name of FIXTURES) {
    for (const mode of ["each", "hidden"] as const) {
      it(`${name} (${mode} flush): client converges on the whole message, live view closed`, async () => {
        const { frames, messages } = await replayBroadcast(name);
        // Thinking deltas are relayed, never persisted.
        const deltas = frames.filter(
          (f) => f.type === "stream_event" && (f.event as StreamEvent).kind === "thinking_delta",
        );
        expect(deltas.length).toBeGreaterThan(0);
        for (const m of messages) {
          expect(m.events?.some((e) => e.kind === "thinking_delta") ?? false).toBe(false);
        }
        const { msgs, spans } = clientFold(frames, mode);
        expect(msgs.map((m) => m.id)).toEqual(messages.map((m) => m.id));
        for (const m of msgs) expect(m.liveThinking, `${m.id} liveThinking`).toBeUndefined();
        messages.forEach((sm, i) => {
          const cm = msgs[i];
          expect(cm.status, `status ${i}`).toBe(sm.status);
          expect(cm.content, `content ${i}`).toBe(sm.content);
          expect(cm.thinking, `thinking ${i}`).toEqual(sm.thinking);
          expect(norm(cm.events ?? []), `events ${i}`).toEqual(norm(sm.events ?? []));
        });
        // Every live view ends with its thinking block, not at a later event.
        for (const span of spans) expect(span.closedBy, span.messageId).toBe("thinking_delta");
        // Summary pages keep the stats.
        const summary = summarizeMessages(messages);
        summary.forEach((m, i) => expect(m.thinking).toEqual(messages[i].thinking));
      });
    }
  }
});
