import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, within, act, cleanup } from "@testing-library/react";
import { AgentsPanel, type AgentsPanelActions } from "../src/panels/AgentsPanel";
import { workCount } from "../src/panels/SessionTasks";
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

const actions = (): AgentsPanelActions => ({
  onOpen: vi.fn(),
  onStop: vi.fn(),
  onArchive: vi.fn(),
  onRestore: vi.fn(),
  onAddAgent: vi.fn(),
  onClearContext: vi.fn(),
  onRemoveAgent: vi.fn(),
  onSetModel: vi.fn(),
  onStopTask: vi.fn(),
  onCancelWake: vi.fn(),
  onStopAll: vi.fn(),
});
const panel = (sessions: Workspace[], a = actions(), overview = false) =>
  render(
    <AgentsPanel
      sessions={sessions}
      project={undefined}
      activeWsId={sessions[0].id}
      connected
      models={[]}
      actions={a}
      overview={overview}
    />,
  ).container;

describe("a session's background work, in its card", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("is listed by agent, with its age or its time", () => {
    const container = panel([busy]);
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
    // Each agent's under its own row, not under a name of its own again.
    expect(
      [...container.querySelectorAll(".tp-tasks")].map(
        (t) => t.previousElementSibling!.querySelector(".ap-agent-name")!.textContent,
      ),
    ).toEqual(["kisara", "isla"]);
    expect(workCount([busy, quiet])).toBe(3);
    // A quiet session has none to list.
    expect(panel([quiet]).querySelector(".tp-tasks")).toBeNull();
  });

  it("stops one task, cancels a wake-up, or stops everything of the session", () => {
    const a = actions();
    const card = within(panel([busy], a));
    fireEvent.click(card.getByLabelText("Stop npm run build"));
    fireEvent.click(card.getByText("Cancel"));
    fireEvent.click(card.getByText("Stop everything"));
    expect(a.onStopTask).toHaveBeenCalledWith("indexer", "kisara", "b1");
    expect(a.onCancelWake).toHaveBeenCalledWith("indexer", "isla");
    expect(a.onStopAll).toHaveBeenCalledWith("indexer");
  });

  it("shows in a folded card as how much runs and when it wakes", () => {
    const container = panel([busy, quiet], actions(), true);
    const tag = (id: string) =>
      container.querySelector(`[aria-label="${id}"] .ap-brief-tasks`)?.textContent ?? null;
    expect(tag("indexer")).toBe("2 in background · wake in 12m");
    expect(tag("docs")).toBeNull();
    expect(container.querySelector(".tp-tasks")).toBeNull();
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

  it("leaves an agent that only waits on background work to its card's own stops", () => {
    const waiting = agent("a", {
      state: "waiting",
      backgroundTasks: [{ id: "b1", type: "local_bash", description: "sleep", since: NOW }],
    });
    const sock = boot([ws("w", [waiting])]);
    expect(document.querySelector(".btn-abort")).toBeNull();
    // The agents button counts it.
    const agents = document.querySelector('.side-rail [aria-label="Agents and sessions"]')!;
    expect(agents.textContent).toBe("1");
    fireEvent.click(agents);
    fireEvent.click(within(document.querySelector(".tp-tasks") as HTMLElement).getByText("Stop"));
    expect(sock.frames().at(-1)).toEqual({
      type: "cancel_subagent",
      workspaceId: "w",
      agentId: "a",
      taskId: "b1",
    });
  });
});

describe("cancelling a wake-up", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  const wake = { at: NOW + 60_000, reason: "check CI" };
  const cancels = (a: AgentInfo) => {
    const container = panel([ws("w", [a])]);
    const tasks = container.querySelector(".tp-tasks") as HTMLElement;
    const offered = within(tasks).queryByRole("button", { name: "Cancel" }) !== null;
    cleanup();
    return offered;
  };

  it("is offered only when closing the process takes nothing else with it", () => {
    expect(cancels(agent("a", { state: "sleeping", wake }))).toBe(true);
    expect(cancels(agent("a", { state: "working", busy: true, wake }))).toBe(false);
    expect(
      cancels(
        agent("a", {
          state: "waiting",
          wake,
          backgroundTasks: [{ id: "b1", type: "local_bash", description: "sleep", since: NOW }],
        }),
      ),
    ).toBe(false);
  });
});
