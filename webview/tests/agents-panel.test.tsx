import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, within, act } from "@testing-library/react";
import { AgentsPanel, type AgentsPanelActions } from "../src/panels/AgentsPanel";
import {
  scopeSessions,
  scopeSummary,
  sessionState,
  sessionWork,
  stateSummary,
} from "../src/panels/scope";
import { App } from "../src/App";
import type { AgentInfo, Objective, Project, Workspace } from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";

const NOW = Date.now();
const agent = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name: id,
  model: "claude-opus-5-5[1m]",
  avatar: "A",
  color: "#fff",
  isDefault: true,
  ...over,
});
const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  project: "repo",
  hostId: "local",
  cwd: `/home/me/work/${id}`,
  git: null,
  pr: null,
  agents: [agent(`${id}-a`)],
  messages: [],
  createdAt: NOW - 50_000,
  lastMessageAt: NOW - 50_000,
  ...over,
});
const objective = (over: Partial<Objective>): Objective => ({
  id: "core/modules",
  area: "core",
  title: "C++20 modules",
  goal: "g",
  status: "active",
  priority: "normal",
  dependsOn: [],
  tasks: [],
  decisions: [],
  sessions: [],
  updatedAt: NOW,
  ...over,
});
const project: Project = {
  id: "p1",
  name: "clice",
  root: "/repo",
  leadWorkspaceId: "lead",
  createdAt: 0,
  objectives: [
    objective({
      sessions: ["w1"],
      tasks: [{ id: "t1", text: "scan imports", state: "doing", session: "w1" }],
    }),
  ],
};
const lead = ws("lead", {
  name: "clice · lead",
  projectLink: { projectId: "p1", role: "lead" },
  lastMessageAt: NOW - 90_000,
});
const w1 = ws("w1", {
  name: "modules",
  projectLink: { projectId: "p1", role: "worker" },
  git: { branch: "feat/modules", dirty: 2, ahead: 0, behind: 0 },
  lastMessageAt: NOW - 1000,
  agents: [
    agent("kisara", {
      busy: true,
      state: "working",
      activity: "running tests",
      context: { tokens: 850_000, window: 1_000_000 },
      effort: "high",
    }),
  ],
});
const w2 = ws("w2", {
  name: "docs",
  projectLink: { projectId: "p1", role: "worker" },
  archivedAt: NOW - 10,
});
const other = ws("other");

describe("panel scope", () => {
  it("covers the project's sessions, lead first, or the open workspace alone", () => {
    const all = [other, w2, w1, lead];
    expect(scopeSessions(w1, all, project).map((w) => w.id)).toEqual(["lead", "w1", "w2"]);
    expect(scopeSessions(other, all, undefined).map((w) => w.id)).toEqual(["other"]);
    expect(scopeSessions(undefined, all, undefined)).toEqual([]);
  });

  it("names a session by its busiest agent and links it to its task", () => {
    expect(sessionState(w1)).toBe("working");
    expect(sessionState(w2)).toBe("archived");
    expect(sessionState(ws("s", { agents: [agent("x", { state: "sleeping" })] }))).toBe("sleeping");
    expect(stateSummary(["working", "idle", "working", "waiting"])).toBe("2 working · 1 waiting");
    expect(stateSummary(["idle"])).toBe("idle");
    const [work] = sessionWork("w1", project.objectives);
    expect([work.objective.id, work.task?.id]).toEqual(["core/modules", "t1"]);
  });
});

describe("AgentsPanel", () => {
  const actions = (): AgentsPanelActions => ({
    onOpen: vi.fn(),
    onStop: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onAddAgent: vi.fn(),
    onClearContext: vi.fn(),
    onRemoveAgent: vi.fn(),
  });
  const panel = (a = actions()) => {
    const utils = render(
      <AgentsPanel
        sessions={[lead, w1, w2]}
        project={project}
        activeWsId="w1"
        connected
        actions={a}
      />,
    );
    return { ...utils, a };
  };

  it("shows each session with where it works, what it works on and its agents", () => {
    const { container } = panel();
    expect(scopeSummary([lead, w1, w2], project)).toBe("clice · 2 sessions · 1 working");
    const card = within(container.querySelector('[aria-label="modules"]') as HTMLElement);
    expect(card.getByText("feat/modules")).toBeTruthy();
    expect(card.getByText("2 changed")).toBeTruthy();
    expect(container.querySelector('[aria-label="modules"] .ap-work')!.textContent).toBe(
      "◆ C++20 modules · scan imports",
    );
    expect(card.getByText("running tests")).toBeTruthy();
    expect(card.getByText("opus 5.5 [1m] · high")).toBeTruthy();
    expect(card.getByText("850k / 1M")).toBeTruthy();
    expect(container.querySelector(".ap-context-bar span")!.className).toBe("high");
    expect(container.querySelector('[aria-label="modules"]')!.className).toContain("active");
  });

  it("acts on the session and agent it was asked from", () => {
    const { container, a } = panel();
    const card = within(container.querySelector('[aria-label="modules"]') as HTMLElement);
    fireEvent.click(card.getByTitle("Open this session"));
    fireEvent.click(card.getByText("Stop"));
    fireEvent.click(card.getByText("+ Agent"));
    fireEvent.click(card.getByLabelText("Clear kisara's context"));
    fireEvent.click(card.getByLabelText("Remove kisara"));
    expect(a.onOpen).toHaveBeenCalledWith("w1");
    expect(a.onStop).toHaveBeenCalledWith("w1");
    expect(a.onAddAgent).toHaveBeenCalledWith("w1");
    expect(a.onClearContext).toHaveBeenCalledWith("w1", "kisara");
    expect(a.onRemoveAgent).toHaveBeenCalledWith("w1", "kisara");
    const leadCard = within(container.querySelector('[aria-label="clice · lead"]') as HTMLElement);
    expect(leadCard.queryByText("Stop")).toBeNull();
    fireEvent.click(leadCard.getByText("Archive"));
    expect(a.onArchive).toHaveBeenCalledWith("lead");
  });

  it("keeps archived sessions folded away, restorable", () => {
    const { container, a } = panel();
    const archived = container.querySelector(".ap-archived")!;
    expect(archived.querySelector("summary")!.textContent).toBe("Archived · 1");
    fireEvent.click(within(archived as HTMLElement).getByText("Restore"));
    expect(a.onRestore).toHaveBeenCalledWith("w2");
  });
});

describe("a session's actions by its state", () => {
  const buttons = (state: AgentInfo["state"]) => {
    const { container, unmount } = render(
      <AgentsPanel
        sessions={[ws("s", { agents: [agent("a", { state })] })]}
        project={undefined}
        activeWsId="s"
        connected
        actions={{
          onOpen: vi.fn(),
          onStop: vi.fn(),
          onArchive: vi.fn(),
          onRestore: vi.fn(),
          onAddAgent: vi.fn(),
          onClearContext: vi.fn(),
          onRemoveAgent: vi.fn(),
        }}
      />,
    );
    const names = [...container.querySelectorAll(".ap-actions button")].map((b) => b.textContent);
    unmount();
    return names;
  };

  it("stops only a running turn, and archives a sleeping session like an idle one", () => {
    expect(buttons("working")).toEqual(["+ Agent", "Stop"]);
    expect(buttons("waiting")).toEqual(["+ Agent"]);
    expect(buttons("sleeping")).toEqual(["+ Agent", "Archive"]);
    expect(buttons("idle")).toEqual(["+ Agent", "Archive"]);
  });
});

describe("the agents panel in the app", () => {
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

  const boot = () => {
    localStorage.setItem("activeWsId", "w1");
    render(<App />);
    const sock = FakeSocket.instances.at(-1)!;
    act(() => sock.open());
    act(() =>
      sock.receive({
        type: "init",
        workspaces: [lead, w1, w2],
        config: {
          presets: [{ name: "Isla", avatar: "I", color: "#ccc" }],
          models: [{ id: "claude-opus-5-5", label: "Opus", backend: "claude" }],
          commands: [],
          hosts: {},
        },
        hosts: [],
        projects: [project],
      }),
    );
    return sock;
  };

  it("opens from the header chip, which sums up the open session's agents", () => {
    boot();
    const chip = document.querySelector(".agents-chip")!;
    expect(chip.textContent).toBe("Arunning tests");
    fireEvent.click(chip);
    expect(document.querySelector(".side-panel")!.getAttribute("aria-label")).toBe("Agents");
    expect(document.querySelector(".side-panel-sub")!.textContent).toBe(
      "clice · 2 sessions · 1 working",
    );
    expect(
      document.querySelector('.side-rail [aria-label="Agents and sessions"]')!.textContent,
    ).toBe("1");
    fireEvent.click(chip);
    expect(document.querySelector(".side-panel")).toBeNull();
  });

  it("pins beside the chat and remembers it", () => {
    boot();
    fireEvent.click(document.querySelector('.side-rail [aria-label="Agents and sessions"]')!);
    expect(document.querySelector(".side-panel")!.className).toContain("floating");
    fireEvent.click(document.querySelector(".side-panel-pin")!);
    expect(document.querySelector(".side-panel")!.className).toContain("docked");
    expect(localStorage.getItem("panelDock")).toBe("1");
    fireEvent.keyDown(document.querySelector(".side-panel-body")!, { key: "Escape" });
    expect(document.querySelector(".side-panel")).toBeNull();
  });

  it("opens beside the chat on a wide window, where floating would cut its lines", () => {
    vi.stubGlobal("innerWidth", 1440);
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    expect(document.querySelector(".side-panel")!.className).toContain("docked");
    expect(localStorage.getItem("panelDock")).toBeNull();
  });

  it("names project sessions without the project's name, the lead once", () => {
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    const names = [...document.querySelectorAll(".ap-session-name")].map((n) => n.textContent);
    expect(names).toContain("lead");
    expect(names.some((n) => n?.includes("clice"))).toBe(false);
  });

  it("takes focus when opened, and leaves Escape in a dialog to the dialog", () => {
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    const panel = document.querySelector(".side-panel")!;
    expect(document.activeElement).toBe(panel);
    const leadCard = within(document.querySelector('[aria-label="clice · lead"]') as HTMLElement);
    fireEvent.click(leadCard.getByText("+ Agent"));
    expect(document.querySelector(".dialog")!.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.querySelector(".dialog")).toBeNull();
    expect(document.querySelector(".side-panel")).not.toBeNull();
  });

  it("fits a width saved on a wider screen, leaving the chat its room", () => {
    localStorage.setItem("listPanelWidth", "5000");
    vi.stubGlobal("innerWidth", 1000);
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    // 1000 - 260 (sidebar) - 44 (rail) - 360 (the chat's least).
    expect((document.querySelector(".side-panel") as HTMLElement).style.width).toBe("336px");
  });

  it("grows with the window until dragged, and goes back to that on a double-click", () => {
    vi.stubGlobal("innerWidth", 2560);
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    const panel = () => document.querySelector(".side-panel") as HTMLElement;
    expect(panel().style.width).toBe("560px");
    expect(localStorage.getItem("listPanelWidth")).toBeNull();
    const edge = document.querySelector(".side-panel-resize")!;
    fireEvent.pointerDown(edge, { clientX: 2000, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 1800, pointerId: 1 });
    fireEvent.pointerUp(edge, { pointerId: 1 });
    expect(panel().style.width).toBe("760px");
    expect(localStorage.getItem("listPanelWidth")).toBe("760");
    fireEvent.doubleClick(edge);
    expect(panel().style.width).toBe("560px");
    expect(localStorage.getItem("listPanelWidth")).toBeNull();
  });

  it("puts the phone's rail on the branch line, not a line of its own", () => {
    boot();
    const rail = document.querySelector(".header-rail")!;
    expect(rail.parentElement!.className).toBe("workspace-info-bar");
    expect(rail.querySelectorAll(".rail-btn")).toHaveLength(4);
  });

  it("maximises over the chat until closed", () => {
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    fireEvent.click(document.querySelector(".side-panel-max")!);
    const panel = () => document.querySelector(".side-panel") as HTMLElement;
    expect(panel().className).toContain("maximized");
    expect(panel().style.left).toBe("260px");
    expect(panel().style.width).toBe("");
    expect(document.querySelector(".side-panel-pin")).toBeNull();
    expect(document.querySelector(".side-panel-resize")).toBeNull();
    fireEvent.click(document.querySelector(".side-panel-max")!);
    expect(panel().className).not.toContain("maximized");
    fireEvent.click(document.querySelector(".side-panel-max")!);
    fireEvent.click(document.querySelector(".side-panel-close")!);
    fireEvent.click(document.querySelector(".agents-chip")!);
    expect(panel().className).not.toContain("maximized");
  });

  it("steps aside for a session opened on a phone held sideways", () => {
    vi.stubGlobal(
      "matchMedia",
      (q: string) => ({ matches: q.includes("(max-height: 500px)") }) as MediaQueryList,
    );
    boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    fireEvent.click(document.querySelector('[aria-label="clice · lead"] .ap-session-name')!);
    expect(document.querySelector(".side-panel")).toBeNull();
  });

  it("adds an agent to the session it was asked from", () => {
    const sock = boot();
    fireEvent.click(document.querySelector(".agents-chip")!);
    const leadCard = within(document.querySelector('[aria-label="clice · lead"]') as HTMLElement);
    fireEvent.click(leadCard.getByText("+ Agent"));
    fireEvent.click(document.querySelector(".dialog .btn-primary")!);
    expect(sock.frames().find((f) => f.type === "add_agent")).toMatchObject({
      workspaceId: "lead",
      model: "claude-opus-5-5",
    });
  });
});

describe("an agent's state line", () => {
  const task = { id: "t1", type: "local_bash", description: "build", since: 1 };
  const lines = (session: Workspace, connected = true) => {
    const { container, unmount } = render(
      <AgentsPanel
        sessions={[session]}
        project={undefined}
        activeWsId={session.id}
        connected={connected}
        actions={{
          onOpen: vi.fn(),
          onStop: vi.fn(),
          onArchive: vi.fn(),
          onRestore: vi.fn(),
          onAddAgent: vi.fn(),
          onClearContext: vi.fn(),
          onRemoveAgent: vi.fn(),
        }}
      />,
    );
    const out = Object.fromEntries(
      [...container.querySelectorAll(".ap-agent")].map((row) => [
        row.querySelector(".ap-agent-name")!.textContent,
        row.querySelector(".ap-agent-state")?.textContent ?? null,
      ]),
    );
    unmount();
    return out;
  };

  it("is left out for an idle agent, kept for anything worth knowing", () => {
    expect(
      lines(
        ws("s", {
          agents: [
            agent("idle"),
            agent("busy", { state: "working", activity: "running tests" }),
            agent("bg", { state: "waiting", backgroundTasks: [task] }),
            agent("nap", { state: "sleeping", backgroundTasks: [task] }),
          ],
        }),
      ),
    ).toEqual({
      idle: null,
      busy: "running tests",
      bg: "waiting on background work",
      nap: "sleeping · 1 in background",
    });
    expect(lines(ws("s", { agents: [agent("idle")] }), false)).toEqual({ idle: "offline" });
    expect(lines(ws("s", { agents: [agent("idle")], archivedAt: 1 }))).toEqual({
      idle: "archived",
    });
  });
});

describe("the summary of a workspace on its own", () => {
  it("counts its agents, not its one session", () => {
    const solo = ws("solo", {
      agents: [agent("a", { state: "working" }), agent("b", { state: "working" })],
    });
    expect(scopeSummary([solo], undefined)).toBe("solo · 2 agents · 2 working");
    expect(scopeSummary([{ ...solo, archivedAt: 1 }], undefined)).toBe("solo · archived");
  });
});
