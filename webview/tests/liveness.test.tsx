import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StrictMode, type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { useServer, PROBE_TIMEOUT_MS, HEARTBEAT_MS, HIDDEN_FLUSH_MS } from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";

const init = {
  type: "init",
  workspaces: [],
  config: { presets: [], models: [], commands: [], hosts: {} },
  hosts: [],
};

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

const W = { id: "w", name: "w", project: "p", hostId: "h", cwd: "/", agents: [], messages: [] };

// A hook connected to a fake server that has sent `init` with workspace "w".
function connected(wrapper?: ({ children }: { children: ReactNode }) => ReactNode) {
  const hook = renderHook(() => useServer(), wrapper ? { wrapper } : undefined);
  const ws = FakeSocket.instances.at(-1)!;
  act(() => {
    ws.open();
    ws.receive({ ...init, workspaces: [{ ...W, createdAt: 0 }] });
  });
  return { result: hook.result, unmount: hook.unmount, ws };
}

const streamEvent = (event: Record<string, unknown>) => ({
  type: "stream_event",
  workspaceId: "w",
  messageId: "m1",
  event,
});

const liveMessage = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  kind: "agent",
  agentId: "a",
  content: "Hello",
  timestamp: 1,
  status: "streaming",
  events: [],
  ...over,
});

const frame = () =>
  act(() => {
    vi.advanceTimersByTime(32);
  });

describe("connection liveness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("replaces a socket that stops answering when the app returns to the foreground", () => {
    const { result } = renderHook(() => useServer());
    const first = FakeSocket.instances[0];
    act(() => {
      first.open();
      first.receive(init);
    });
    expect(result.current.connected).toBe(true);

    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    expect(first.frames().at(-1)).toEqual({ type: "ping" });

    // No pong: the socket is dead even though the browser never said so.
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    expect(first.readyState).toBe(FakeSocket.CLOSED);
    expect(result.current.connected).toBe(false);
    expect(FakeSocket.instances).toHaveLength(2);

    act(() => {
      FakeSocket.instances[1].open();
    });
    expect(result.current.connected).toBe(true);
  });

  it("keeps a healthy socket when the server answers the probe", () => {
    renderHook(() => useServer());
    const ws = FakeSocket.instances[0];
    act(() => {
      ws.open();
      ws.receive(init);
    });
    act(() => setVisibility("visible"));
    act(() => ws.receive({ type: "pong" }));
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    expect(ws.readyState).toBe(FakeSocket.OPEN);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("probes on a timer while visible", () => {
    renderHook(() => useServer());
    const ws = FakeSocket.instances[0];
    act(() => {
      ws.open();
      ws.receive(init);
    });
    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS);
    });
    expect(ws.frames().filter((f) => f.type === "ping")).toHaveLength(1);
  });

  it("reconnects immediately on foreground instead of waiting out the back-off", () => {
    renderHook(() => useServer());
    const first = FakeSocket.instances[0];
    act(() => {
      first.open();
      first.onclose?.();
    });
    expect(FakeSocket.instances).toHaveLength(1);
    act(() => setVisibility("visible"));
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => {
      FakeSocket.instances[1].open();
      FakeSocket.instances[1].receive(init);
    });
    // The back-off timer was cancelled, so no third socket appears.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("resyncs the newest page in place after a reconnect", () => {
    const { result } = renderHook(() => useServer());
    const ws = FakeSocket.instances[0];
    const w = { id: "w", name: "w", project: "p", hostId: "h", cwd: "/", agents: [], messages: [] };
    act(() => {
      ws.open();
      ws.receive({ ...init, workspaces: [{ ...w, createdAt: 0 }] });
      ws.receive({
        type: "workspace_messages",
        workspaceId: "w",
        hasMore: false,
        before: null,
        messages: [
          { id: "m1", kind: "agent", agentId: "a", content: "", timestamp: 1, status: "streaming" },
        ],
      });
    });
    expect(result.current.workspaces[0].messages[0].status).toBe("streaming");
    act(() => {
      ws.receive({
        type: "workspace_messages",
        workspaceId: "w",
        hasMore: false,
        before: null,
        messages: [
          { id: "m1", kind: "agent", agentId: "a", content: "ok", timestamp: 1, status: "done" },
          { id: "m2", kind: "user", agentId: null, content: "next", timestamp: 2, status: "done" },
        ],
      });
    });
    const msgs = result.current.workspaces[0].messages;
    expect(msgs.map((m) => [m.id, m.status])).toEqual([
      ["m1", "done"],
      ["m2", "done"],
    ]);
  });
});

describe("resync detail refetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("re-fetches bodies for a message the user was watching live", () => {
    const { result } = renderHook(() => useServer());
    const ws = FakeSocket.instances[0];
    const w = { id: "w", name: "w", project: "p", hostId: "h", cwd: "/", agents: [], messages: [] };
    const page = (messages: unknown[]) => ({
      type: "workspace_messages",
      workspaceId: "w",
      hasMore: false,
      before: null,
      messages,
    });
    act(() => {
      ws.open();
      ws.receive({ ...init, workspaces: [{ ...w, createdAt: 0 }] });
      ws.receive(
        page([
          { id: "m1", kind: "agent", agentId: "a", content: "", timestamp: 1, status: "streaming" },
        ]),
      );
      // Streamed live: full thinking body on the client.
      ws.receive({
        type: "stream_event",
        workspaceId: "w",
        messageId: "m1",
        event: { kind: "thinking", content: "long reasoning" },
      });
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(result.current.workspaces[0].messages[0].events?.[0].content).toBe("long reasoning");

    // Reconnect resync: the server sends the same message as a summary.
    act(() => {
      ws.receive(
        page([
          {
            id: "m1",
            kind: "agent",
            agentId: "a",
            content: "",
            timestamp: 1,
            status: "streaming",
            events: [{ kind: "thinking", content: "", contentLength: 14 }],
            detail: "summary",
          },
        ]),
      );
    });
    expect(ws.frames().at(-1)).toEqual({
      type: "load_message_details",
      workspaceId: "w",
      messageId: "m1",
    });

    act(() => {
      ws.receive({
        type: "message_details",
        workspaceId: "w",
        messageId: "m1",
        events: [{ kind: "thinking", content: "long reasoning" }],
      });
    });
    const m = result.current.workspaces[0].messages[0];
    expect(m.detail).toBeUndefined();
    expect(m.events?.[0].content).toBe("long reasoning");
  });
});

describe("message_done status patch", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("applies the effort and context reported at the end of the turn", () => {
    const { result } = renderHook(() => useServer());
    const ws = FakeSocket.instances[0];
    const w = { id: "w", name: "w", project: "p", hostId: "h", cwd: "/", agents: [], messages: [] };
    act(() => {
      ws.open();
      ws.receive({ ...init, workspaces: [{ ...w, createdAt: 0 }] });
      ws.receive({
        type: "new_message",
        workspaceId: "w",
        message: {
          id: "m1",
          kind: "agent",
          agentId: "a",
          content: "",
          timestamp: 1,
          status: "streaming",
        },
      });
      ws.receive({
        type: "message_done",
        workspaceId: "w",
        messageId: "m1",
        status: "done",
        content: "ok",
        effort: "medium",
        context: { tokens: 4000, window: 264600 },
      });
    });
    const m = result.current.workspaces[0].messages[0];
    expect(m.effort).toBe("medium");
    expect(m.context).toEqual({ tokens: 4000, window: 264600 });
  });

  it("ends a live thinking block and records the turn's thinking", () => {
    const { result, ws } = connected();
    act(() => {
      ws.receive({ type: "new_message", workspaceId: "w", message: liveMessage() });
      ws.receive(streamEvent({ kind: "thinking_delta", content: "" }));
      ws.receive(streamEvent({ kind: "thinking_delta", content: "weighing it" }));
      ws.receive({
        type: "message_done",
        workspaceId: "w",
        messageId: "m1",
        status: "done",
        content: "ok",
        thinking: { tokens: 1200, durationMs: 45_000 },
      });
    });
    const m = result.current.workspaces[0].messages[0];
    expect(m.liveThinking).toBeUndefined();
    expect(m.liveThinkingSince).toBeUndefined();
    expect(m.thinking).toEqual({ tokens: 1200, durationMs: 45_000 });
  });
});

describe("message_done ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("applies events still waiting for a frame before finishing the message", () => {
    const { result } = renderHook(() => useServer());
    const ws = FakeSocket.instances[0];
    const w = { id: "w", name: "w", project: "p", hostId: "h", cwd: "/", agents: [], messages: [] };
    act(() => {
      ws.open();
      ws.receive({ ...init, workspaces: [{ ...w, createdAt: 0 }] });
      ws.receive({
        type: "new_message",
        workspaceId: "w",
        message: {
          id: "m1",
          kind: "agent",
          agentId: "a",
          content: "",
          timestamp: 1,
          status: "streaming",
        },
      });
      ws.receive({
        type: "stream_event",
        workspaceId: "w",
        messageId: "m1",
        event: {
          kind: "subagent_start",
          content: "",
          subagent: { taskId: "t", description: "d", events: [] },
        },
      });
      ws.receive({
        type: "stream_event",
        workspaceId: "w",
        messageId: "m1",
        event: {
          kind: "subagent_progress",
          content: "",
          subagent: {
            taskId: "t",
            description: "",
            _innerEvent: { kind: "tool_use", content: "**Read** `a`" },
          },
        },
      });
      // No animation frame yet: message_done arrives with the stripped copy.
      ws.receive({
        type: "message_done",
        workspaceId: "w",
        messageId: "m1",
        status: "done",
        content: "ok",
        events: [
          {
            kind: "subagent_start",
            content: "",
            subagent: { taskId: "t", description: "d", eventCount: 1 },
          },
        ],
      });
    });
    const m = result.current.workspaces[0].messages[0];
    expect(m.status).toBe("done");
    expect(m.events?.[0].subagent?.events?.map((e) => e.kind)).toEqual(["tool_use"]);
  });
});

describe("snapshot replies after events still waiting for a frame", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not apply them again on top of a page that already has them", () => {
    const { result, ws } = connected();
    act(() =>
      ws.receive({ type: "workspace_messages", workspaceId: "w", messages: [liveMessage()] }),
    );
    // Same frame: a delta, a tool call, then a resync page that has both.
    act(() => {
      ws.receive(streamEvent({ kind: "text_delta", content: " world" }));
      ws.receive(streamEvent({ kind: "tool_use", content: "**Read** a", toolUseId: "t1" }));
      ws.receive({
        type: "workspace_messages",
        workspaceId: "w",
        before: null,
        messages: [
          liveMessage({
            content: "Hello world",
            events: [{ kind: "tool_use", content: "**Read** a", toolUseId: "t1" }],
          }),
        ],
      });
    });
    frame();
    const m = result.current.workspaces[0].messages[0];
    expect(m.content).toBe("Hello world");
    expect(m.events).toHaveLength(1);
  });

  it("does not repeat them on top of fetched details", () => {
    const { result, ws } = connected();
    act(() =>
      ws.receive({ type: "workspace_messages", workspaceId: "w", messages: [liveMessage()] }),
    );
    const call = { kind: "tool_use", content: "**Read** a", toolUseId: "t1" };
    act(() => {
      ws.receive(streamEvent(call));
      ws.receive({ type: "message_details", workspaceId: "w", messageId: "m1", events: [call] });
    });
    frame();
    expect(result.current.workspaces[0].messages[0].events).toHaveLength(1);
  });

  it("does not duplicate a subagent transcript the user just opened", () => {
    const { result, ws } = connected();
    const start = {
      kind: "subagent_start",
      content: "d",
      subagent: { taskId: "T", description: "d", status: "running", eventCount: 1 },
    };
    act(() =>
      ws.receive({
        type: "workspace_messages",
        workspaceId: "w",
        messages: [liveMessage({ events: [start] })],
      }),
    );
    const i1 = { kind: "tool_use", content: "**Read** a", toolUseId: "i1" };
    const i2 = { kind: "tool_use", content: "**Read** b", toolUseId: "i2" };
    act(() => {
      ws.receive(
        streamEvent({
          kind: "subagent_progress",
          content: "",
          subagent: { taskId: "T", description: "", _innerEvent: i2 },
        }),
      );
      // Reply to load_subagent_events: the server's copy already has i2.
      ws.receive({
        type: "subagent_events",
        workspaceId: "w",
        messageId: "m1",
        taskId: "T",
        events: [i1, i2],
      });
    });
    frame();
    act(() =>
      ws.receive({
        type: "message_done",
        workspaceId: "w",
        messageId: "m1",
        status: "done",
        content: "Hello",
        events: [{ ...start, subagent: { ...start.subagent, eventCount: 2 } }],
      }),
    );
    const sa = result.current.workspaces[0].messages[0].events![0].subagent!;
    expect(sa.events!.map((e) => e.toolUseId)).toEqual(["i1", "i2"]);
  });

  it("gives a card one inner event under StrictMode when its start shares the frame", () => {
    const { result, ws } = connected(({ children }) => <StrictMode>{children}</StrictMode>);
    act(() =>
      ws.receive({ type: "workspace_messages", workspaceId: "w", messages: [liveMessage()] }),
    );
    act(() => {
      ws.receive(
        streamEvent({
          kind: "subagent_start",
          content: "d",
          subagent: { taskId: "T", description: "d", status: "running", events: [] },
        }),
      );
      ws.receive(
        streamEvent({
          kind: "subagent_progress",
          content: "",
          subagent: {
            taskId: "T",
            description: "",
            _innerEvent: { kind: "tool_use", content: "**Read** a", toolUseId: "i1" },
          },
        }),
      );
    });
    frame();
    expect(result.current.workspaces[0].messages[0].events![0].subagent!.events).toHaveLength(1);
  });

  it("ignores a stream_event without an event", () => {
    const { result, ws } = connected();
    act(() =>
      ws.receive({ type: "workspace_messages", workspaceId: "w", messages: [liveMessage()] }),
    );
    act(() => ws.receive({ type: "stream_event", workspaceId: "w" }));
    frame();
    expect(result.current.workspaces[0].messages[0].content).toBe("Hello");
  });

  it("keeps applying events while the tab is hidden and gets no frames", () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    const { result, ws } = connected();
    act(() =>
      ws.receive({ type: "workspace_messages", workspaceId: "w", messages: [liveMessage()] }),
    );
    // Scheduled for a frame, then the tab hides before one comes.
    act(() => ws.receive(streamEvent({ kind: "text_delta", content: " a" })));
    act(() => setVisibility("hidden"));
    act(() => ws.receive(streamEvent({ kind: "text_delta", content: " b" })));
    act(() => {
      vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
    });
    expect(result.current.workspaces[0].messages[0].content).toBe("Hello a b");
  });
});

describe("sending", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const sentMessages = () =>
    FakeSocket.instances.flatMap((s) => s.frames()).filter((f) => f.type === "send_message");

  it("reports a message it could not send instead of dropping it silently", async () => {
    const { result, ws } = connected();
    act(() => ws.drop());
    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.sendMessage("w", "a long prompt");
    });
    expect(sent).toBe(false);
    expect(sentMessages()).toEqual([]);
    expect(result.current.lastError).toMatch(/not connected/i);
  });

  it("holds a send until a pending probe is answered", async () => {
    const { result, ws } = connected();
    act(() => setVisibility("visible"));
    expect(ws.frames().at(-1)).toEqual({ type: "ping" });
    let sent: Promise<boolean> | undefined;
    act(() => {
      sent = result.current.sendMessage("w", "hi");
    });
    expect(sentMessages()).toEqual([]);
    await act(async () => {
      ws.receive({ type: "pong" });
      await sent;
    });
    expect(await sent).toBe(true);
    expect(sentMessages()).toMatchObject([{ content: "hi" }]);
  });

  it("does not write into a socket the probe finds dead (phone just woke up)", async () => {
    const { result, ws } = connected();
    act(() => setVisibility("visible"));
    let sent: Promise<boolean> | undefined;
    act(() => {
      sent = result.current.sendMessage("w", "hi");
    });
    await act(async () => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
      await sent;
    });
    expect(await sent).toBe(false);
    expect(ws.readyState).toBe(FakeSocket.CLOSED);
    expect(sentMessages()).toEqual([]);
  });
});

describe("connection attempts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("replaces an attempt that hangs in CONNECTING (network switch)", () => {
    const { ws } = connected();
    act(() => ws.drop());
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const attempt = FakeSocket.instances.at(-1)!;
    expect(attempt).not.toBe(ws);
    expect(attempt.readyState).toBe(FakeSocket.CONNECTING);
    act(() => setVisibility("visible"));
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    expect(attempt.readyState).toBe(FakeSocket.CLOSED);
    expect(FakeSocket.instances.at(-1)).not.toBe(attempt);
  });

  it("keeps an attempt that opens within the deadline", () => {
    const { ws } = connected();
    act(() => ws.drop());
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const attempt = FakeSocket.instances.at(-1)!;
    act(() => setVisibility("visible"));
    act(() => {
      attempt.open();
      attempt.receive(init);
    });
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    expect(FakeSocket.instances.at(-1)).toBe(attempt);
    expect(attempt.readyState).toBe(FakeSocket.OPEN);
  });

  it("gives the attempt that replaces a dead socket the same deadline", () => {
    const { ws } = connected();
    act(() => setVisibility("visible"));
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    // Replaced; on the phone's new network the replacement hangs too.
    const replacement = FakeSocket.instances.at(-1)!;
    expect(replacement).not.toBe(ws);
    act(() => {
      vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    });
    expect(replacement.readyState).toBe(FakeSocket.CLOSED);
    expect(FakeSocket.instances.at(-1)).not.toBe(replacement);
  });

  it("does not reconnect after unmounting", () => {
    const { ws, unmount } = connected();
    unmount();
    // The browser reports the close asynchronously.
    act(() => ws.onclose?.());
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe("history pages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const page = (a: number, b: number, extra: Record<string, unknown> = {}) => ({
    type: "workspace_messages",
    workspaceId: "w",
    hasMore: true,
    before: null,
    messages: Array.from({ length: b - a + 1 }, (_, k) => ({
      id: `m${a + k}`,
      kind: "agent",
      agentId: "a",
      content: "",
      timestamp: a + k,
      status: "done",
    })),
    ...extra,
  });
  const ids = (r: { current: ReturnType<typeof useServer> }) =>
    r.current.workspaces[0].messages.map((m) => m.id);

  it("leaves no hole when a message came live before the resync reply", () => {
    const { result, ws } = connected();
    act(() => ws.receive(page(1, 50)));
    act(() => {
      // Written while away (m51..m110) and just now (m111).
      ws.receive({ type: "new_message", workspaceId: "w", message: page(111, 111).messages[0] });
      ws.receive(page(62, 111));
    });
    expect(ids(result)).toEqual(page(62, 111).messages.map((m) => m.id));
    expect(result.current.workspaces[0].hasMore).toBe(true);
  });

  it("drops an older page asked for before a resync replaced the list", () => {
    const { result, ws } = connected();
    act(() => ws.receive(page(100, 149)));
    act(() => result.current.loadMessages("w", 100));
    // The resync lands first and replaces the list (no overlap)...
    act(() => ws.receive(page(200, 249)));
    // ...then the stale reply for "before m100".
    act(() => ws.receive(page(0, 99, { before: 100 })));
    expect(ids(result)).toEqual(page(200, 249).messages.map((m) => m.id));
  });

  it("does not take an older page as the history of an archived workspace", () => {
    const { result, ws } = connected();
    act(() => ws.receive(page(51, 100)));
    act(() => result.current.loadMessages("w", 51));
    act(() => ws.receive({ type: "workspace_archived", workspaceId: "w", archivedAt: 5 }));
    act(() => ws.receive(page(1, 50, { before: 51, hasMore: false })));
    const w = result.current.workspaces[0];
    expect(w.messagesLoaded).toBe(false);
    expect(w.messages).toEqual([]);
  });
});
