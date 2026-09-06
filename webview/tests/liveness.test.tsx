import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useServer, PROBE_TIMEOUT_MS, HEARTBEAT_MS } from "../src/useServer";

// Minimal WebSocket stand-in: the test opens it, feeds frames, and watches
// what the hook sends. Never closes on its own, like a socket whose peer
// vanished without a FIN.
class FakeSocket {
  static instances: FakeSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

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

  it("re-fetches bodies for a message the user was watching live", async () => {
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
