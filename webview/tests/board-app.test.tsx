// The board page wired into the App: asking the lead, dialogs over it, and
// stream frames that must not re-render it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import * as board from "../src/project/board";
import { App } from "../src/App";
import type { Project, Workspace } from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";

vi.mock("../src/project/board", async (orig) => {
  const real = await orig<typeof import("../src/project/board")>();
  return { ...real, areaCounts: vi.fn(real.areaCounts) };
});

const NOW = Date.now();

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  project: "repo",
  hostId: "local",
  cwd: `/repo/${id}`,
  git: null,
  pr: null,
  agents: [],
  messages: [],
  createdAt: NOW - 5000,
  lastMessageAt: NOW - 5000,
  ...over,
});

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "clice",
  root: "/repo/clice",
  leadWorkspaceId: "lead",
  createdAt: NOW - 10_000,
  objectives: [
    {
      id: "core/modules",
      area: "core",
      title: "C++20 modules",
      goal: "Serve modules",
      status: "active",
      priority: "high",
      dependsOn: [],
      tasks: [],
      decisions: [],
      sessions: [],
      updatedAt: NOW,
    },
  ],
  ...over,
});

const lead = ws("lead", {
  name: "clice · lead",
  cwd: "/repo/clice",
  projectLink: { projectId: "p1", role: "lead" },
  lastMessageAt: NOW - 4000,
  agents: [{ id: "a-lead", name: "Lead", model: "m", avatar: "L", color: "#fff", isDefault: true }],
});
const worker = ws("w1", {
  name: "modules",
  cwd: "/wt/clice-modules",
  projectLink: { projectId: "p1", role: "worker" },
  lastMessageAt: NOW - 3000,
});

function boot(workspaces: Workspace[], projects: Project[], active: string) {
  localStorage.setItem("activeWsId", active);
  render(<App />);
  const sock = FakeSocket.instances.at(-1)!;
  const recv = (f: unknown) => act(() => sock.receive(f));
  act(() => sock.open());
  recv({
    type: "init",
    workspaces,
    config: { presets: [], models: [], commands: [], hosts: {} },
    hosts: [],
    projects,
  });
  return { sock, recv };
}

const frame = () =>
  act(() => {
    vi.advanceTimersByTime(20);
  });
const textarea = () => document.querySelector("textarea") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });
const openBoard = () =>
  fireEvent.click(document.querySelector('.side-rail [aria-label^="Objectives of"]')!);
const ask = () => {
  fireEvent.click(document.querySelector(".bp-card")!);
  fireEvent.click(document.querySelector(".bp-ask")!);
  frame();
};

beforeEach(() => {
  vi.useFakeTimers();
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Ask the lead", () => {
  it("adds the objective to the draft in the lead's composer", () => {
    boot([lead, worker], [project()], "lead");
    type("half-written question for the lead");
    openBoard();
    ask();
    expect(textarea().value).toBe("half-written question for the lead\nAbout core/modules: ");
  });

  it("adds it to the lead's saved draft from another session and focuses the composer", () => {
    boot([lead, worker], [project()], "lead");
    type("half-written question for the lead");
    fireEvent.click(
      [...document.querySelectorAll(".task-item")].find((e) => e.textContent.includes("modules"))!,
    );
    frame();
    expect(textarea().value).toBe("");
    openBoard();
    ask();
    expect(document.querySelector(".panel-title")!.textContent).toMatch(/^clice · lead/);
    expect(textarea().value).toBe("half-written question for the lead\nAbout core/modules: ");
    expect(document.activeElement).toBe(textarea());
  });

  it("is not offered when the project has no lead", () => {
    boot([worker], [project({ leadWorkspaceId: null })], "w1");
    openBoard();
    fireEvent.click(document.querySelector(".bp-card")!);
    expect(document.querySelector(".bp-ask")).toBeNull();
  });
});

describe("Delete project over the board", () => {
  it("Escape cancels the confirmation and leaves the board open", () => {
    boot([lead, worker], [project()], "w1");
    openBoard();
    fireEvent.click(document.querySelector(".bp-delete")!);
    expect(document.querySelector(".dialog-confirm")).not.toBeNull();
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    });
    expect(document.querySelector(".dialog-confirm")).toBeNull();
    expect(document.querySelector(".board-page")).not.toBeNull();
  });
});

describe("stream frames", () => {
  it("keeps BoardPage out of App re-renders", () => {
    const busy = ws("other", {
      name: "other",
      lastMessageAt: NOW - 2000,
      agents: [
        {
          id: "a1",
          name: "coder",
          model: "m",
          avatar: "C",
          color: "#fff",
          isDefault: true,
          busy: true,
        },
      ],
    });
    // The board is open from the lead while another workspace streams.
    const { recv } = boot([lead, worker, busy], [project()], "lead");
    recv({
      type: "new_message",
      workspaceId: "other",
      message: {
        id: "m1",
        kind: "agent",
        agentId: "a1",
        content: "",
        timestamp: NOW,
        status: "streaming",
      },
    });
    openBoard();
    frame();
    const areas = vi.mocked(board.areaCounts);
    const before = areas.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      recv({
        type: "stream_event",
        workspaceId: "other",
        messageId: "m1",
        event: { type: "text", text: `chunk ${i} ` },
      });
      recv({ type: "agent_activity", workspaceId: "other", agentId: "a1", activity: `step ${i}` });
      recv({
        type: "system_status",
        osName: "linux",
        osArch: "x64",
        cpuModel: "x",
        cpuCores: 8,
        cpuUsage: i,
        memTotal: 100,
        memUsed: 50,
        uptime: 1,
        hostname: "h",
        quota: [],
      });
      frame();
    }
    expect(areas.mock.calls.length - before).toBe(0);
  });
});
