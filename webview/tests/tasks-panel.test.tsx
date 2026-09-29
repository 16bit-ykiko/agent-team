import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, within, act } from "@testing-library/react";
import { TasksPanel, workCount, type TasksPanelActions } from "../src/panels/TasksPanel";
import { App } from "../src/App";
import type { AgentInfo, Workspace } from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";

const NOW = 1_800_000_000_000;
const agent = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name: id,
  model: "claude-opus-5-5",
  avatar: "A",
  color: "#fff",
  isDefault: true,
  ...over,
});
const ws = (id: string, agents: AgentInfo[], over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  project: "repo",
  hostId: "local",
  cwd: `/w/${id}`,
  git: null,
  pr: null,
  agents,
  messages: [],
  createdAt: NOW - 1000,
  lastMessageAt: NOW - 1000,
  ...over,
});

const busy = ws("indexer", [
  agent("kisara", {
    state: "waiting",
    backgroundTasks: [
      { id: "b1", type: "local_bash", description: "npm run build", since: NOW - 95_000 },
      { id: "a1", type: "local_agent", description: "Profile the indexer", since: NOW - 5_000 },
    ],
  }),
  agent("isla", {
    state: "sleeping",
    wake: { at: NOW + 12 * 60_000, reason: "check the CI run" },
  }),
  agent("alice"),
]);
const quiet = ws("docs", [agent("bob")]);

describe("TasksPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const actions = (): TasksPanelActions => ({
    onOpen: vi.fn(),
    onStopTask: vi.fn(),
    onCancelWake: vi.fn(),
    onStopAll: vi.fn(),
  });

  it("lists background work by session and agent, with its age or its time", () => {
    const { container } = render(<TasksPanel sessions={[busy, quiet]} actions={actions()} />);
    expect(
      [...container.querySelectorAll(".tp-session")].map((s) => s.getAttribute("aria-label")),
    ).toEqual(["indexer"]);
    const rows = [...container.querySelectorAll(".tp-task")].map((r) =>
      [...r.querySelectorAll(".tp-type, .tp-desc, .tp-when")].map((e) => e.textContent),
    );
    const at = new Date(NOW + 12 * 60_000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(rows).toEqual([
      ["shell", "npm run build", "1m 35s"],
      ["agent", "Profile the indexer", "5s"],
      ["wake-up", "check the CI run", "in 12m"],
    ]);
    expect(container.querySelector(".tp-wake .tp-when")!.getAttribute("title")).toBe(`at ${at}`);
    expect(container.querySelectorAll(".tp-agent")).toHaveLength(2);
    expect(workCount([busy, quiet])).toBe(3);
  });

  it("stops one task, cancels a wake-up, or stops everything of a session", () => {
    const a = actions();
    const { container } = render(<TasksPanel sessions={[busy]} actions={a} />);
    const panel = within(container);
    fireEvent.click(panel.getByLabelText("Stop npm run build"));
    fireEvent.click(panel.getByText("Cancel"));
    fireEvent.click(panel.getByText("Stop everything"));
    fireEvent.click(panel.getByTitle("Open this session"));
    expect(a.onStopTask).toHaveBeenCalledWith("indexer", "kisara", "b1");
    expect(a.onCancelWake).toHaveBeenCalledWith("indexer", "isla");
    expect(a.onStopAll).toHaveBeenCalledWith("indexer");
    expect(a.onOpen).toHaveBeenCalledWith("indexer");
  });

  it("says when nothing runs in the background", () => {
    const { container } = render(<TasksPanel sessions={[quiet]} actions={actions()} />);
    expect(container.querySelector(".tp-empty")!.textContent).toContain(
      "Nothing runs in the background",
    );
  });
});

describe("Stop in the app", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => vi.unstubAllGlobals());

  const boot = (workspaces: Workspace[]) => {
    localStorage.setItem("activeWsId", workspaces[0].id);
    render(<App />);
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());
    act(() =>
      sock.receive({
        type: "init",
        workspaces,
        config: { presets: [], models: [], commands: [], hosts: {} },
        hosts: [],
        projects: [],
      }),
    );
    return sock;
  };

  it("stops only the turn of a working agent", () => {
    const sock = boot([ws("w", [agent("a", { busy: true, state: "working" })])]);
    fireEvent.click(document.querySelector(".btn-abort")!);
    expect(sock.frames().filter((f) => f.type === "interrupt" || f.type === "abort")).toEqual([
      { type: "interrupt", workspaceId: "w", agentId: "a" },
    ]);
  });

  it("leaves an agent that only waits on background work to the tasks panel", () => {
    const waiting = agent("a", {
      state: "waiting",
      backgroundTasks: [{ id: "b1", type: "local_bash", description: "sleep", since: NOW }],
    });
    const sock = boot([ws("w", [waiting])]);
    expect(document.querySelector(".btn-abort")).toBeNull();
    fireEvent.click(document.querySelector('.side-rail [aria-label="Background tasks"]')!);
    expect(document.querySelector(".side-panel")!.getAttribute("aria-label")).toBe(
      "Background tasks",
    );
    expect(document.querySelector('.side-rail [aria-label="Background tasks"]')!.textContent).toBe(
      "◷1",
    );
    fireEvent.click(
      within(document.querySelector(".tasks-panel") as HTMLElement).getByText("Stop"),
    );
    expect(sock.frames().at(-1)).toEqual({
      type: "cancel_subagent",
      workspaceId: "w",
      agentId: "a",
      taskId: "b1",
    });
  });
});
