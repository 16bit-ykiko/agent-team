import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { App } from "../src/App";
import type { AgentInfo, Message } from "../src/useServer";

// The server end of the socket: the test opens it, feeds frames and reads
// what the app sent.
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
    act(() => this.onmessage?.({ data: JSON.stringify(frame) }));
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  drop() {
    this.readyState = FakeSocket.CLOSED;
    act(() => this.onclose?.());
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const AGENT: AgentInfo = {
  id: "a1",
  name: "Alice",
  model: "claude-opus-5-5",
  avatar: "🤖",
  color: "#888",
  isDefault: true,
};

const settled = (i: number): Message => ({
  id: `s${i}`,
  kind: "agent",
  agentId: "a1",
  content: `done ${i}`,
  timestamp: 1000 + i,
  status: "done",
  events: [{ kind: "tool_use", content: `**Read** f${i}`, toolUseId: `t${i}`, contentOffset: 0 }],
});

const live: Message = {
  id: "live",
  kind: "agent",
  agentId: "a1",
  content: "",
  timestamp: 5000,
  status: "streaming",
  events: [],
};

function openSocket(sock: FakeSocket, agents: AgentInfo[], others: string[] = []) {
  const workspace = (id: string, name: string) => ({
    id,
    name,
    project: "p",
    hostId: "local",
    cwd: "/tmp",
    agents,
    messages: [],
    createdAt: 1,
  });
  act(() => sock.open());
  sock.receive({
    type: "init",
    workspaces: [workspace("w1", "w"), ...others.map((id) => workspace(id, id))],
    config: { presets: [], models: [], commands: [], hosts: {} },
    hosts: [],
  });
}

// App connected to workspace w1 with `messages` as its newest page.
function boot(
  messages: Message[],
  { agents = [AGENT], hasMore = false, others = [] as string[] } = {},
) {
  render(<App />);
  const sock = FakeSocket.instances.at(-1)!;
  openSocket(sock, agents, others);
  sock.receive({ type: "workspace_messages", workspaceId: "w1", messages, hasMore });
  frame();
  return sock;
}

const frame = () =>
  act(() => {
    vi.advanceTimersByTime(20);
  });

const delta = (content: string) => ({
  type: "stream_event",
  workspaceId: "w1",
  messageId: "live",
  event: { kind: "text_delta", content },
});

const scroller = () => document.querySelector(".messages") as HTMLElement;
const composer = () => document.querySelector("textarea")!;
const selectWorkspace = (name: string) =>
  fireEvent.click(
    [...document.querySelectorAll(".task-item")].find(
      (el) => el.querySelector(".task-name-text")!.firstChild!.textContent === name,
    )!,
  );

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

// jsdom has no layout: give the scroller fixed geometry.
function fakeGeometry(el: HTMLElement, geo: { top: number; height: number; client: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => geo.height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => geo.client });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => geo.top,
    set: (v: number) => (geo.top = v),
  });
}

let scrollIntoView: MockInstance<(arg?: boolean | ScrollIntoViewOptions) => void>;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("render cost of a live transcript", () => {
  // MessageItem formats its timestamp once per render.
  const renders = () => {
    const spy = vi.spyOn(Date.prototype, "toLocaleTimeString");
    return () => {
      const n = spy.mock.calls.length;
      spy.mockClear();
      return n;
    };
  };

  it("re-renders only the message that changed", () => {
    const sock = boot([1, 2, 3, 4, 5].map(settled).concat(live));
    const count = renders();
    sock.receive(delta("x"));
    frame();
    expect(count()).toBe(1);

    // The 3 s status broadcast and typing touch no message.
    sock.receive({
      type: "system_status",
      osName: "linux",
      osArch: "x64",
      cpuModel: "cpu",
      cpuCores: 8,
      cpuUsage: 12,
      memTotal: 100,
      memUsed: 50,
      uptime: 1,
      hostname: "h",
      quota: [],
    });
    for (const text of ["f", "fix", "fix @", "fix @Al"]) {
      fireEvent.change(composer(), { target: { value: text, selectionStart: text.length } });
    }
    expect(count()).toBe(0);

    // The activity label ticks every second during a long tool: only the
    // streaming message shows it.
    sock.receive({
      type: "agent_activity",
      workspaceId: "w1",
      agentId: "a1",
      activity: "Bash · 3s",
    });
    expect(count()).toBe(1);
    expect(document.querySelector("#msg-live .activity-label")!.textContent).toBe("Bash · 3s");
  });
});

describe("composer", () => {
  it("keeps the draft when the message could not be sent", async () => {
    const sock = boot([settled(1)]);
    sock.drop();
    fireEvent.change(composer(), { target: { value: "a long prompt" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(async () => {});
    expect(composer().value).toBe("a long prompt");
    expect(document.querySelector(".error-toast")!.textContent).toMatch(/not connected/i);
    expect(sock.frames().filter((f) => f.type === "send_message")).toEqual([]);
  });

  it("leaves another workspace's draft alone when a held send completes", async () => {
    const sock = boot([], { others: ["w2"] });
    selectWorkspace("w2");
    fireEvent.change(composer(), { target: { value: "w2 draft" } });
    selectWorkspace("w");
    // The phone wakes: a liveness probe is in flight when send is tapped.
    setVisibility("hidden");
    setVisibility("visible");
    expect(sock.frames().at(-1)).toEqual({ type: "ping" });
    fireEvent.change(composer(), { target: { value: "hello" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(async () => {});
    selectWorkspace("w2");
    sock.receive({ type: "pong" });
    await act(async () => {});
    expect(sock.frames()).toContainEqual(
      expect.objectContaining({ type: "send_message", workspaceId: "w1", content: "hello" }),
    );
    expect(composer().value).toBe("w2 draft");
    // The sent text does not come back with its workspace.
    selectWorkspace("w");
    expect(composer().value).toBe("");
  });

  it("keeps what was typed while a send was held", async () => {
    const sock = boot([]);
    setVisibility("visible");
    fireEvent.change(composer(), { target: { value: "hello" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(async () => {});
    fireEvent.change(composer(), { target: { value: "hello, and one more thing" } });
    sock.receive({ type: "pong" });
    await act(async () => {});
    expect(composer().value).toBe("hello, and one more thing");
  });

  it("clears the draft once the message is sent", async () => {
    const sock = boot([settled(1)]);
    fireEvent.change(composer(), { target: { value: "go" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await act(async () => {});
    expect(composer().value).toBe("");
    expect(sock.frames().filter((f) => f.type === "send_message")).toMatchObject([
      { content: "go" },
    ]);
  });
});

describe("scrolling", () => {
  it("follows a growing reply while the reader is at the bottom", () => {
    const sock = boot([settled(1), live]);
    const geo = { top: 1000, height: 1500, client: 500 };
    fakeGeometry(scroller(), geo);
    fireEvent.scroll(scroller());
    for (let i = 0; i < 3; i++) {
      geo.height += 100;
      sock.receive(delta(`line ${i}\n\n`));
      frame();
      expect(geo.top).toBe(geo.height);
    }
  });

  it("lets a reader drag back up a little while a reply streams", () => {
    const sock = boot([live]);
    const geo = { top: 1000, height: 1500, client: 500 };
    fakeGeometry(scroller(), geo);
    fireEvent.scroll(scroller());
    // One touch-move step up: far less than "scrolled up".
    geo.top = 960;
    fireEvent.scroll(scroller());
    geo.height += 20;
    sock.receive(delta("more "));
    frame();
    expect(geo.top).toBe(960);
    // Back at the bottom, it follows again.
    geo.top = geo.height - geo.client;
    fireEvent.scroll(scroller());
    geo.height += 20;
    sock.receive(delta("again "));
    frame();
    expect(geo.top).toBe(geo.height);
  });

  it("does not pull an opened step box away when its details arrive", () => {
    const last: Message = { ...settled(1), detail: "summary" };
    const sock = boot([last]);
    const geo = { top: 1000, height: 1500, client: 500 };
    fakeGeometry(scroller(), geo);
    fireEvent.scroll(scroller());
    fireEvent.click(document.querySelector(".step-header")!);
    expect(sock.frames()).toContainEqual(
      expect.objectContaining({ type: "load_message_details", messageId: "s1" }),
    );
    // The full body makes the opened box taller.
    geo.height += 800;
    sock.receive({
      type: "message_details",
      workspaceId: "w1",
      messageId: "s1",
      events: [
        {
          kind: "tool_use",
          content: "**Bash**\n```bash\n" + "echo x\n".repeat(40) + "```",
          toolUseId: "t1",
          contentOffset: 0,
        },
      ],
    });
    frame();
    expect(geo.top).toBe(1000);
  });

  it("leaves a reader who scrolled up where they are", () => {
    const sock = boot([settled(1), live]);
    const geo = { top: 200, height: 3000, client: 500 };
    fakeGeometry(scroller(), geo);
    fireEvent.scroll(scroller());
    scrollIntoView.mockClear();
    sock.receive(delta("more"));
    frame();
    expect(geo.top).toBe(200);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps the reader's place and the draft's caret across a reconnect", () => {
    const sock = boot([settled(1)]);
    const geo = { top: 200, height: 3000, client: 500 };
    fakeGeometry(scroller(), geo);
    fireEvent.scroll(scroller());
    fireEvent.change(composer(), { target: { value: "half a thought" } });
    composer().setSelectionRange(4, 4);
    scrollIntoView.mockClear();

    sock.drop();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const next = FakeSocket.instances.at(-1)!;
    openSocket(next, [AGENT]);
    frame();

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(composer().value).toBe("half a thought");
    expect(composer().selectionStart).toBe(4);
    // The newest page is still resynced on the new socket.
    expect(next.frames()).toContainEqual(
      expect.objectContaining({ type: "load_messages", workspaceId: "w1" }),
    );
  });
});

describe("search jumps", () => {
  function searchAndOpen(sock: FakeSocket, hit: { messageId: string; timestamp: number }) {
    fireEvent.change(document.querySelector(".search-bar input")!, {
      target: { value: "needle" },
    });
    sock.receive({
      type: "search_results",
      query: "needle",
      hits: [{ workspaceId: "w1", workspaceName: "w", snippet: "needle", ...hit }],
    });
    fireEvent.click(document.querySelector(".search-result-item")!);
    frame();
  }

  const page = (ids: number[]): Message[] =>
    ids.map((i) => ({ ...settled(i), id: `m${i}`, timestamp: i }));

  it("pages back to a hit older than the loaded window, then highlights it", () => {
    const sock = boot(page([100, 101, 102]), { hasMore: true });
    searchAndOpen(sock, { messageId: "m10", timestamp: 10 });
    const asked = sock.frames().filter((f) => f.type === "load_messages" && f.before != null);
    expect(asked).toMatchObject([{ workspaceId: "w1", before: 100 }]);
    sock.receive({
      type: "workspace_messages",
      workspaceId: "w1",
      before: 100,
      hasMore: true,
      messages: page([10, 11, 99]),
    });
    frame();
    expect(document.querySelector("#msg-m10")!.classList).toContain("message-highlight");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: "smooth", block: "center" });
  });

  it("is dropped when the reader leaves the workspace before it lands", () => {
    const sock = boot(page([100, 101]), { hasMore: true, others: ["w2"] });
    searchAndOpen(sock, { messageId: "m10", timestamp: 10 });
    selectWorkspace("w2");
    sock.receive({
      type: "workspace_messages",
      workspaceId: "w1",
      before: 100,
      hasMore: true,
      messages: page([50, 51]),
    });
    frame();
    const olderAsks = () =>
      sock.frames().filter((f) => f.type === "load_messages" && f.before != null).length;
    const asked = olderAsks();
    selectWorkspace("w");
    frame();
    expect(olderAsks()).toBe(asked);
  });

  it("gives up after a bounded number of pages", () => {
    const sock = boot(page([10_000]), { hasMore: true });
    searchAndOpen(sock, { messageId: "ancient", timestamp: 1 });
    let asks = 0;
    for (;;) {
      const older = sock.frames().filter((f) => f.type === "load_messages" && f.before != null);
      if (older.length === asks) break;
      const before = older[asks++].before as number;
      sock.receive({
        type: "workspace_messages",
        workspaceId: "w1",
        before,
        hasMore: true,
        messages: page([before - 2, before - 1]),
      });
      frame();
      if (asks > 50) throw new Error("never gives up");
    }
    expect(asks).toBe(10);
    expect(document.querySelector(".info-toast")!.textContent).toMatch(/no longer/);
  });

  it("says so when the hit is no longer in the history", () => {
    const sock = boot(page([100]), { hasMore: true });
    searchAndOpen(sock, { messageId: "gone", timestamp: 10 });
    sock.receive({
      type: "workspace_messages",
      workspaceId: "w1",
      before: 100,
      hasMore: false,
      messages: page([5]),
    });
    frame();
    expect(document.querySelector(".info-toast")!.textContent).toMatch(/no longer/);
  });
});

describe("agent avatars", () => {
  it("shows the quoted agent's avatar as an image, not its file path", () => {
    boot([settled(1)], { agents: [{ ...AGENT, avatar: "avatars/Alice.jpg" }] });
    fireEvent.click(document.querySelector(".btn-quote")!);
    const who = document.querySelector(".quote-bar-agent")!;
    expect(who.textContent).not.toContain("avatars/");
    expect(who.querySelector("img")!.getAttribute("src")).toBe("avatars/Alice.jpg");
  });
});

describe("viewport diagnostics", () => {
  it("is only mounted while the sidebar drawer is open", () => {
    boot([settled(1)]);
    expect(document.querySelector(".viewport-info")).toBeNull();
    fireEvent.click(document.querySelector(".mobile-menu-btn")!);
    expect(document.querySelector(".viewport-info")).not.toBeNull();
    fireEvent.click(document.querySelector(".sidebar-overlay")!);
    expect(document.querySelector(".viewport-info")).toBeNull();
  });
});

// A server that pages exactly like index.ts: `limit` messages older than
// `before` plus every message tied at `before`; hasMore when older remain.
describe("search jumps against the server's paging", () => {
  const message = (i: number, ts: number): Message => ({
    id: `m${i}`,
    kind: "agent",
    agentId: "a1",
    content: `needle ${i}`,
    timestamp: ts,
    status: "done",
  });

  function serve(all: Message[], req: Record<string, unknown>) {
    const before = (req.before as number) ?? Infinity;
    const limit = Math.min((req.limit as number) ?? 50, 200);
    const older = before === Infinity ? all : all.filter((m) => m.timestamp < before);
    const tied = before === Infinity ? [] : all.filter((m) => m.timestamp === before);
    return {
      type: "workspace_messages",
      workspaceId: "w1",
      messages: [...older.slice(-limit), ...tied],
      hasMore: older.length > limit,
      before: before === Infinity ? null : before,
    };
  }

  // Answers, in order, every load_messages sent on `sock` and not answered
  // yet, including the ones sent in reaction, until the app stops asking.
  function answerAll(sock: FakeSocket, all: () => Message[]) {
    let answered = 0;
    for (let rounds = 0; ; rounds++) {
      const asks = sock.frames().filter((f) => f.type === "load_messages");
      if (answered === asks.length) return;
      if (rounds > 50) throw new Error("the app never stops paging");
      sock.receive(serve(all(), asks[answered++]));
      frame();
    }
  }

  function searchAndOpen(sock: FakeSocket, hit: Message) {
    fireEvent.change(document.querySelector(".search-bar input")!, {
      target: { value: "needle" },
    });
    sock.receive({
      type: "search_results",
      query: "needle",
      hits: [
        {
          workspaceId: "w1",
          workspaceName: "w",
          snippet: "needle",
          messageId: hit.id,
          timestamp: hit.timestamp,
        },
      ],
    });
    fireEvent.click(document.querySelector(".search-result-item")!);
    frame();
  }

  const renderedIds = () =>
    [...document.querySelectorAll("[id^=msg-]")].map((e) => e.id.slice("msg-".length));

  it("reaches an old hit through tie groups split across pages, with no gap or duplicate", () => {
    // Three messages per millisecond: page edges fall inside groups.
    const all = Array.from({ length: 1000 }, (_, i) => message(i, 1000 + Math.floor(i / 3)));
    render(<App />);
    const sock = FakeSocket.instances.at(-1)!;
    openSocket(sock, [AGENT]);
    answerAll(sock, () => all);
    searchAndOpen(sock, all[5]);
    answerAll(sock, () => all);
    expect(renderedIds()).toEqual(all.map((m) => m.id));
    expect(document.querySelector("#msg-m5")!.classList).toContain("message-highlight");
  }, 30_000);

  it("keeps the history in order when an older page is answered after a resync", () => {
    // Loaded m100..m149; the jump's older-page request goes out, then the
    // socket drops before the reply and 100 more messages are written.
    let all = Array.from({ length: 150 }, (_, i) => message(i, 1000 + i));
    render(<App />);
    const first = FakeSocket.instances.at(-1)!;
    openSocket(first, [AGENT]);
    answerAll(first, () => all);
    searchAndOpen(first, all[10]);
    expect(first.frames()).toContainEqual(
      expect.objectContaining({ type: "load_messages", before: 1100 }),
    );
    first.drop();
    all = [...all, ...Array.from({ length: 100 }, (_, i) => message(150 + i, 1150 + i))];
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const next = FakeSocket.instances.at(-1)!;
    openSocket(next, [AGENT]);
    frame();
    // The newest page, then the jump's now stale older page.
    expect(
      next
        .frames()
        .filter((f) => f.type === "load_messages")
        .map((f) => f.before ?? null),
    ).toEqual([null, 1100]);
    answerAll(next, () => all);
    expect(renderedIds()).toEqual(all.map((m) => m.id));
  });
});
