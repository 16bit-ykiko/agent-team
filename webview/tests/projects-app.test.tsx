import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { App } from "../src/App";
import type { Message, Project, Workspace } from "../src/state/useServer";
import { FakeSocket } from "./fakeSocket";

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
  objectives: [],
  ...over,
});

const lead = ws("lead", {
  name: "clice · lead",
  cwd: "/repo/clice",
  projectLink: { projectId: "p1", role: "lead" },
  lastMessageAt: NOW - 4000,
});
const worker = ws("w1", {
  name: "modules",
  cwd: "/wt/clice-modules",
  projectLink: { projectId: "p1", role: "worker" },
  lastMessageAt: NOW - 3000,
});

const fromMsg = (from: Message["from"]): Message => ({
  id: "m1",
  kind: "user",
  agentId: null,
  content: "do it",
  timestamp: NOW - 1000,
  status: "done",
  from,
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
const title = () => document.querySelector(".panel-title")!.textContent;

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

describe("opening a project session from a link", () => {
  it("re-expands its collapsed folder group", () => {
    const other = ws("other", { lastMessageAt: NOW });
    const plain = ws("plain", { cwd: "/repo/plain" });
    localStorage.setItem("wsGroupOverrides", JSON.stringify({ "/repo/plain": false }));
    const { recv } = boot([other, plain], [], "other");
    recv({
      type: "workspace_messages",
      workspaceId: "other",
      messages: [fromMsg({ workspaceId: "plain", name: "plain", role: "worker" })],
    });
    frame();
    fireEvent.click(document.querySelector(".from-author")!);
    frame();
    expect(title()).toMatch(/^plain/);
    expect(document.querySelector(".task-item.active")).not.toBeNull();
  });

  it("re-expands its collapsed project group", () => {
    const other = ws("other", { lastMessageAt: NOW });
    localStorage.setItem("wsGroupOverrides", JSON.stringify({ "project:p1": false }));
    const { recv } = boot([other, lead, worker], [project()], "other");
    recv({
      type: "workspace_messages",
      workspaceId: "other",
      messages: [fromMsg({ workspaceId: "w1", name: "modules", role: "worker" })],
    });
    frame();
    fireEvent.click(document.querySelector(".from-author")!);
    frame();
    expect(title()).toMatch(/^modules/);
    expect(document.querySelector(".task-item.active")).not.toBeNull();
    expect(JSON.parse(localStorage.getItem("wsGroupOverrides")!)).toEqual({ "project:p1": true });
  });
});

describe("a sender that no longer exists", () => {
  it("stays put and says so instead of jumping to an unrelated workspace", () => {
    const other = ws("other", { name: "unrelated", lastMessageAt: NOW });
    const { recv } = boot([other, worker], [project({ leadWorkspaceId: null })], "w1");
    recv({
      type: "workspace_messages",
      workspaceId: "w1",
      messages: [fromMsg({ workspaceId: "gone-lead", name: "clice", role: "lead" })],
    });
    frame();
    expect(title()).toMatch(/^modules/);
    const sender = document.querySelector(".from-author") as HTMLButtonElement;
    expect(sender.tagName).toBe("BUTTON");
    fireEvent.click(sender);
    frame();
    expect(title()).toMatch(/^modules/);
    expect(document.querySelector(".info-toast")!.textContent).toBe(
      "That session no longer exists.",
    );
  });
});

describe("purging archived workspaces", () => {
  it("does not count archived project leads, which are kept", () => {
    const archivedLead = { ...lead, archivedAt: NOW - 100 };
    const archivedPlain = ws("old", { archivedAt: NOW - 100 });
    const live = ws("live", { lastMessageAt: NOW });
    boot([live, archivedLead, archivedPlain], [project()], "live");
    fireEvent.click(document.querySelector(".ws-archived-purge")!);
    expect(document.querySelector(".dialog-body")!.textContent).toBe(
      "Permanently delete 1 archived workspace(s), including their message history and logs. Archived project leads (1) are kept.",
    );
  });
});

describe("deleting a project", () => {
  it("mentions the sessions it keeps only when there are some", () => {
    boot([lead], [project()], "lead");
    fireEvent.click(document.querySelector('[title="Delete project"]')!);
    expect(document.querySelector(".dialog-body")!.textContent).toBe(
      "Deletes its lead session, objectives and notes.",
    );
  });

  it("names a lead shown outside its project's group", () => {
    boot([lead], [], "lead");
    expect(document.querySelector(".task-item .task-name-text")!.textContent).toBe(
      "leadclice · lead",
    );
  });
});

describe("the board page", () => {
  const withBoard = project({
    objectives: [
      {
        id: "core/modules",
        area: "core",
        title: "C++20 modules",
        goal: "Serve modules",
        status: "active",
        priority: "high",
        dependsOn: [],
        tasks: [{ id: "t1", text: "scan", state: "doing", session: "w1" }],
        decisions: [],
        sessions: ["w1"],
        updatedAt: NOW,
      },
    ],
  });

  it("opens over any workspace from the header or the sidebar, and closes", () => {
    boot([lead, worker], [withBoard], "w1");
    fireEvent.click(document.querySelector('.side-rail [aria-label="Objectives of clice"]')!);
    expect(document.querySelector("[role='dialog'][aria-label='clice objectives']")).not.toBeNull();
    fireEvent.click(document.querySelector(".bp-close")!);
    expect(document.querySelector(".board-page")).toBeNull();
    // On a phone the sidebar is a drawer over the page: it gets out of the way.
    fireEvent.click(document.querySelector(".mobile-menu-btn")!);
    expect(document.querySelector(".sidebar-open")).not.toBeNull();
    fireEvent.click(document.querySelector(".ws-group-board")!);
    expect(document.querySelector(".board-page")).not.toBeNull();
    expect(document.querySelector(".sidebar-open")).toBeNull();
  });

  it("opens a working session from an objective and closes itself", () => {
    boot([lead, worker], [withBoard], "lead");
    fireEvent.click(document.querySelector(".ws-group-board")!);
    fireEvent.click(document.querySelector(".bp-card")!);
    fireEvent.click(document.querySelector(".bp-session")!);
    expect(document.querySelector(".board-page")).toBeNull();
    expect(title()).toMatch(/^modules/);
  });

  it("hands the question to the lead with the objective named in the composer", () => {
    boot([lead, worker], [withBoard], "w1");
    fireEvent.click(document.querySelector(".ws-group-board")!);
    fireEvent.click(document.querySelector(".bp-card")!);
    fireEvent.click(document.querySelector(".bp-ask")!);
    frame();
    expect(title()).toMatch(/^clice · lead/);
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "About core/modules: ",
    );
  });
});

describe("the open workspace archived while in view", () => {
  it("reloads its history instead of spinning, then shows the delivered turn", () => {
    const plain = ws("plain", { lastMessageAt: NOW });
    const { sock, recv } = boot([plain], [], "plain");
    recv({ type: "workspace_messages", workspaceId: "plain", messages: [] });
    frame();
    const loads = () => sock.frames().filter((f) => f.type === "load_messages").length;
    const before = loads();
    recv({ type: "workspace_archived", workspaceId: "plain", archivedAt: NOW });
    frame();
    expect(loads()).toBe(before + 1);
    recv({ type: "workspace_messages", workspaceId: "plain", messages: [] });
    recv({ type: "workspace_unarchived", workspaceId: "plain" });
    recv({
      type: "new_message",
      workspaceId: "plain",
      message: { ...fromMsg({ workspaceId: "lead", name: "lead", role: "lead" }), id: "m2" },
    });
    frame();
    expect(document.querySelector(".history-loading")).toBeNull();
    expect(document.querySelector(".from-author")!.textContent).toBe("Lead");
  });
});

describe("quoting a delivered message", () => {
  it("names its sender, not the user", () => {
    const plain = ws("plain", { lastMessageAt: NOW });
    const { recv } = boot([plain], [], "plain");
    recv({
      type: "workspace_messages",
      workspaceId: "plain",
      messages: [
        fromMsg({ workspaceId: "w1", name: "modules", role: "worker" }),
        { id: "a1", kind: "agent", agentId: "x", content: "ok", timestamp: NOW, status: "done" },
      ],
    });
    frame();
    expect(document.querySelector(".from-author")!.textContent).toBe("modules");
  });
});

describe("a lead whose project the server could not read", () => {
  const orphan = ws("lead", {
    name: "clice · lead",
    projectLink: { projectId: "p-unreadable", role: "lead" },
  });

  it("is deleted like any workspace", () => {
    const { sock } = boot([orphan], [], "lead");
    fireEvent.click(document.querySelector('.task-item [title="Delete"]')!);
    expect(sock.frames().filter((f) => f.type === "delete_workspace")).toEqual([
      { type: "delete_workspace", workspaceId: "lead" },
    ]);
  });

  it("is purged with the other archived workspaces", () => {
    boot([{ ...orphan, archivedAt: NOW - 100 }], [], "lead");
    fireEvent.click(document.querySelector(".ws-archived-purge")!);
    expect(document.querySelector(".dialog-body")!.textContent).toBe(
      "Permanently delete 1 archived workspace(s), including their message history and logs.",
    );
  });
});

describe("the files panel in a project", () => {
  const fetchMock = vi.fn((url: string) => {
    const path = new URLSearchParams(url.split("?")[1]).get("path")!;
    const abs = path.startsWith("/") ? path : `/repo/clice/${path}`;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ kind: "text", path: abs, size: 3, content: "x\n", truncated: false }),
    });
  });
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));

  it("keeps a file opened from the lead while a worker is open, offering both folders", async () => {
    const reply: Message = {
      id: "r1",
      kind: "agent",
      agentId: "a1",
      content: "See `src/x.cpp:5`.",
      timestamp: NOW - 500,
      status: "done",
    };
    const { recv } = boot([lead, worker], [project()], "lead");
    recv({ type: "workspace_messages", workspaceId: "lead", messages: [reply], hasMore: false });
    frame();
    fireEvent.click(document.querySelector(".message-content .file-ref")!);
    await act(async () => {});
    const panel = () => document.querySelector('aside[aria-label="Files"]')!;
    expect(panel().querySelector(".fp-path")!.textContent).toBe("src/x.cpp");
    expect(panel().querySelector(".fp-path")!.getAttribute("title")).toBe("/repo/clice/src/x.cpp");
    const folders = () =>
      [...panel().querySelectorAll(".fp-roots option")].map((o) => o.textContent);
    expect(folders()).toEqual(["clice", "clice-modules"]);

    const calls = fetchMock.mock.calls.length;
    fireEvent.click(
      [...document.querySelectorAll(".task-item")].find(
        (el) => el.querySelector(".task-name-text")!.textContent === "modules",
      )!,
    );
    await act(async () => {});
    expect(title()).toContain("modules");
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(panel().querySelector(".fp-path")!.getAttribute("title")).toBe("/repo/clice/src/x.cpp");
  });
});

describe("files named in a delivered message", () => {
  const fetchMock = vi.fn((url: string) => {
    const q = new URLSearchParams(url.split("?")[1]);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          kind: "text",
          path: `/${q.get("ws")}/${q.get("path")}`,
          size: 2,
          content: "x\n",
          truncated: false,
        }),
    });
  });
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  const delivered = (from: Message["from"]): Message => ({
    ...fromMsg(from),
    content: "Fixed in `src/a.ts:12`.",
  });

  it("open in the sender's folder, which may be another checkout", async () => {
    const { recv } = boot([lead, worker], [project()], "lead");
    recv({
      type: "workspace_messages",
      workspaceId: "lead",
      messages: [delivered({ workspaceId: "w1", name: "modules", role: "worker" })],
      hasMore: false,
    });
    frame();
    fireEvent.click(document.querySelector(".file-ref")!);
    await act(async () => {});
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("api/file?ws=w1&path=src%2Fa.ts");
  });

  it("stay open when the sender is another project's lead", async () => {
    const other = ws("olead", {
      name: "other · lead",
      projectLink: { projectId: "p2", role: "lead" },
    });
    const { recv } = boot(
      [lead, worker, other],
      [project(), project({ id: "p2", name: "other", leadWorkspaceId: "olead" })],
      "lead",
    );
    recv({
      type: "workspace_messages",
      workspaceId: "lead",
      messages: [delivered({ workspaceId: "olead", name: "other · lead", role: "peer" })],
      hasMore: false,
    });
    frame();
    fireEvent.click(document.querySelector(".file-ref")!);
    await act(async () => {});
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("api/file?ws=olead&path=src%2Fa.ts");
    expect(document.querySelector('aside[aria-label="Files"] .fp-path')!.textContent).toBe(
      "/olead/src/a.ts",
    );
  });
});
